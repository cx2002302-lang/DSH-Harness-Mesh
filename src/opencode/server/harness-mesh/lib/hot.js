/** 热逻辑层:http.js 只是固定路由壳,这里承载全部请求处理。
 *  改本文件保存即生效(每请求时间戳破缓存动态 import),服务端改动零重启。
 *
 *  deps: { ctx, mesh, nodes, json, readJson }
 */
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { validateNode } from "./config.js";

const AI_SYSTEM = [
  "你是 harness 组网节点的配置生成器。根据用户的自然语言描述,产出一个节点配置 JSON。",
  "字段:name(节点名,1-32 位字母/数字/_/-)、type(acp-plug 插头协议连被控机 harnessd,最常用 / acp-stdio 本机直连 / acp-ssh 跨机 SSH 隧道 / cli-oneshot 无 ACP 的 CLI 兜底)、",
  "command(启动命令,如 opencode;acp-plug 类型可填空串)、args(参数数组,如 [\"acp\"])、ssh(acp-ssh 必填,用户@主机)、",
  "address(acp-plug 必填,被控机 harnessd 地址 host:port)、plugId(acp-plug 必填,被控机 plugs.json 里的插头名)、socks(acp-plug 可选,本机 SOCKS5 如 127.0.0.1:11080)、",
  "cwd(默认工作目录)、model(固定模型,可空)、env(环境变量对象)、description(中文描述)。",
  "只输出 JSON 对象本身,不要 markdown 代码块,不要任何解释。信息不足时合理补默认值。",
].join("\n");

const TERMINAL_STATES = new Set(["succeeded", "failed", "timeout", "cancelled"]);

// ---- MCP 工具清单(Streamable HTTP) ----
const CLIENT_TOOLS = [
  { name: "harness_list", description: "列出可派活的节点(名称/类型/健康/在跑任务数)", inputSchema: { type: "object", properties: {} } },
  { name: "harness_dispatch", description: "派发任务到指定节点,返回 task_id。prompt 必须自包含(对端看不到你的对话上下文)", inputSchema: { type: "object", properties: { harness: { type: "string", description: "节点名" }, prompt: { type: "string", description: "任务内容(自包含)" }, cwd: { type: "string", description: "工作目录(可选)" }, model: { type: "string", description: "指定模型(可选,覆盖节点默认)" }, timeoutMs: { type: "number" } }, required: ["harness", "prompt"] } },
  { name: "harness_status", description: "查询任务状态和最近进度(含是否在等你批权限)", inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } },
  { name: "harness_result", description: "任务成功后取结构化汇报(summary/changes/tests)", inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } },
  { name: "harness_cancel", description: "停止一个运行中的任务", inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } },
  { name: "harness_config", description: "持久设置某个节点的默认模型(写节点表,重启不丢);model 传空串或 default 恢复被控默认", inputSchema: { type: "object", properties: { harness: { type: "string", description: "节点名" }, model: { type: "string", description: "模型标识(provider/model);空串或 default = 恢复被控默认" } }, required: ["harness", "model"] } },
  { name: "harness_help", description: "按需获取某个工具的完整用法(参数/示例/SOP/排错);不带参数则返回全部工具的速览。首次使用某工具前建议先查它", inputSchema: { type: "object", properties: { tool: { type: "string", description: "工具名,如 harness_dispatch;空=全部速览" } } } },
  { name: "harness_tools", description: "查看某个 harness 的专属工具(如 workbuddy 的 wb_info):返回工具名+参数格式;查不存在的 harness 会返回已支持的列表", inputSchema: { type: "object", properties: { harness: { type: "string", description: "harness 名:workbuddy/kimi/zcode/opencode/dsh;空=返回全部已配专属工具的 harness" } } } },
];

/** 渐进披露内容库:工具的完整用法(不在 tools/list 里常驻,靠 harness_help 按需拉)。
 *  这样客户端每会话只背 6 个一句话定义,重内容按需加载——省 token、减幻觉。 */
const HELP_DOCS = {
  harness_list: "列出可派活节点。无参数。返回[{name,type,target,health,running}];health=unknown 不一定不可用,失败以 error 为准。",
  harness_dispatch: "派发任务。参数:{harness(必填,节点名), prompt(必填,必须自包含:对端看不到你的对话上下文,任务背景/输入/输出要求全写进去), cwd(可选,工作目录), model(可选,如 opencode/deepseek-v4.1-flash,覆盖节点默认), timeoutMs(可选)}。返回{task_id,state:queued}。之后用 harness_status 跟进,终态 succeeded 后 harness_result 取汇报。",
  harness_status: "查任务。参数:{task_id(必填,dispatch 返回的原值,不要拼装)}。返回{state,progress[],pending_permission,error}。state: queued→running→succeeded/failed/cancelled/timeout。pending_permission 非空=在等主控侧批权,等几秒再看,不要反复重派。",
  harness_result: "取结构化汇报。参数:{task_id}。仅 state=succeeded 后调(提前调报错)。返回{summary,changes,tests,artifacts,next_hint,duration_ms}。",
  harness_cancel: "停止运行中任务。参数:{task_id}。仅对 running/queued 有效;返回{state:cancelling}。停止后未保存进度丢失。",
  harness_config: "持久设置节点默认模型。参数:{harness(必填,节点名), model(必填,模型标识如 opencode/deepseek-v4.1-flash;空串或 default = 恢复被控 harness 自己的默认)}。写节点表,重启不丢,对后续 dispatch 立即生效。注意:模型是否真生效取决于被控 harness 是否实现 session/set_model(有的实现对不认识的方法/模型 ID 会报错,任务会失败——设完先派个小任务验证)。",
  harness_help: "本工具。带 tool 参数返回该工具完整用法;不带则返回全部速览。",
  _sop: "标准流程:harness_list 选节点 → harness_dispatch(拿 task_id)→ 每隔几秒 harness_status 到终态 → harness_result 拿汇报 → 汇总给你的用户。纪律:task_id 原样传;prompt 自包含;pending_permission 等待而非重派;一次派一个(要多节点并行找主控侧开团)。",
};

/** 服务端扩展工具(开团/查询/会话控制):仅 /api/mcp/harness-mesh-admin 入口可见可调 */
const ADMIN_EXT_TOOLS = [
  { name: "harness_team", description: "开团:一个任务并行派给多个节点(可带角色),返回 team_id 和各成员 task_id", inputSchema: { type: "object", properties: { task: { type: "string", description: "任务内容(自包含)" }, members: { type: "array", items: { type: "object", properties: { harness: { type: "string" }, role: { type: "string", description: "角色,如 前端/审查/测试" } }, required: ["harness"] } }, cwd: { type: "string" }, timeoutMs: { type: "number" } }, required: ["task", "members"] } },
  { name: "harness_team_result", description: "开团聚合汇报:按 team_id 收齐所有成员任务的结构化结果", inputSchema: { type: "object", properties: { team_id: { type: "string" } }, required: ["team_id"] } },
  { name: "harness_tasks", description: "查询任务列表(默认在跑的):可按节点/状态过滤,返回进度/耗时/待批权", inputSchema: { type: "object", properties: { harness: { type: "string", description: "按节点名过滤;不填=全部" }, state: { type: "string", description: "running/queued/succeeded/failed/cancelled/timeout;默认 running" }, limit: { type: "number", description: "默认 20" } } } },
  { name: "harness_session", description: "会话控制(危险操作,两段式确认防误操):stop 结束/pause 暂停(留现场)/resume 恢复/start 开启。首次调用返回 needs_confirm+token(60s),带 confirm_token 再次调用才执行;全程审计", inputSchema: { type: "object", properties: { harness: { type: "string" }, action: { type: "string", enum: ["stop", "pause", "resume", "start"] }, task_id: { type: "string", description: "stop/pause 必填;resume 填原 task_id" }, prompt: { type: "string", description: "start 用" }, cwd: { type: "string" }, confirm_token: { type: "string", description: "二次确认 token" } }, required: ["harness", "action"] } },
];

/** 客户端入口工具集 = 5 核心 + help;服务端入口 = 5 核心 + help + 4 扩展 */
const MCP_TOOLS = CLIENT_TOOLS;
const ADMIN_ONLY = new Set(ADMIN_EXT_TOOLS.map((t) => t.name));

/** 开团角色映射:team_id -> [{harness, role, task_id}]。
 *  hot.js 每请求重导(缓存破坏带 Date.now),模块状态不跨请求——必须落盘。
 *  mesh.teamResult 从任务 store 只能拿 harness/state,role 从这里补。 */
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { loadHarnessTools, availableHarnesses, resolveTool } from "./harness-tools/index.js";
import { join } from "node:path";

const TEAM_FILE = join(process.env.DSH_HOME ?? "/root/.dreamx", "harness-mesh", "team-roles.json");
const CONFIRM_FILE = join(process.env.DSH_HOME ?? "/root/.dreamx", "harness-mesh", "session-confirms.json");
const CONTROL_LOG = join(process.env.DSH_HOME ?? "/root/.dreamx", "harness-mesh", "session-control.log");
const CONFIRM_TTL_MS = 60_000;   // 确认 token 60 秒有效,防"过期确认"

function confirmLoad() { try { return JSON.parse(readFileSync(CONFIRM_FILE, "utf8")); } catch { return {}; } }
function confirmSave(all) { try { writeFileSync(CONFIRM_FILE, JSON.stringify(all), "utf8"); } catch (e) { console.log(`[harness-mesh] confirm 落盘失败: ${e}`); } }
function controlAudit(line) {
  try { appendFileSync(CONTROL_LOG, `[${new Date().toISOString()}] ${line}\n`); } catch (e) { console.log(`[harness-mesh] AUDIT-FAIL: ${e}`); }
}

function teamLoad() {
  try { return JSON.parse(readFileSync(TEAM_FILE, "utf8")); } catch { return {}; }
}
function teamSave(teamId, tasks) {
  try {
    mkdirSync(join(TEAM_FILE, ".."), { recursive: true });
    const all = teamLoad();
    all[teamId] = tasks;
    writeFileSync(TEAM_FILE, JSON.stringify(all), "utf8");
  } catch (error) { console.log(`[harness-mesh] team-roles 落盘失败: ${error}`); }
}
function teamRoles(teamId) {
  return new Map((teamLoad()[teamId] ?? []).map((t) => [t.task_id, t.role]));
}

/** 主入口:按 pathname 分发。 */
export async function handle(request, { ctx, mesh, nodes, json, readJson }) {
  const path = new URL(request.url).pathname;

  // ---- 节点 CRUD ----
  if (path === "/api/harness-mesh/nodes") {
    if (request.method === "POST") {
      const body = await readJson(request);
      try {
        const node = nodes.save(body.node ?? body);
        return json({ ok: true, node });
      } catch (error) {
        return json({ ok: false, error: String(error?.message ?? error) }, 400);
      }
    }
    // GET:原始节点(表单编辑用)+ 健康/在跑标注
    // 健康语义(2026-10-17 08:58 修正):acp-plug 的 adapter.alive 只在会话中为真,
    // 任务间隙恒为 false——原来直接映射成 unknown 导致哨兵误报(链路好着呢)。
    // 新语义:up=会话中 / idle=插头节点任务间隙且最近任务成功 / down=最近任务连接类失败 / unknown=没用过
    const healthOf = (name) => {
      if (mesh.adapters.get(name)?.alive) return "up";
      const last = mesh.store.list()
        .filter((t) => t.harness === name)
        .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))[0];
      if (!last) return "unknown";
      if (last.state === "succeeded") return "idle";
      if (["failed", "timeout"].includes(last.state)) return "down";
      return "idle";
    };
    return json({
      ok: true,
      // target 与 mesh.listNodes 同规则(2026-10-19 补):原始 nodes.list() 没有 target,
      // 客户端节点列表/@ 菜单直接显示 n.target,缺了会渲染成 "undefined"
      nodes: nodes.list().map((n) => ({
        ...n,
        target: n.type === "acp-ssh" ? n.ssh : n.type === "acp-plug" ? `${n.address}#${n.plugId}` : "local",
        health: healthOf(n.name),
        running: mesh.store.countRunning(n.name),
      })),
    });
  }

  if (path === "/api/harness-mesh/node" && request.method === "DELETE") {
    const name = new URL(request.url).searchParams.get("name") ?? "";
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) return json({ ok: false, error: "invalid name" }, 400);
    return json({ ok: nodes.remove(name), name });
  }

  // ---- 派发 / 跟进 ----
  if (path === "/api/harness-mesh/dispatch" && request.method === "POST") {
    const body = await readJson(request);
    if (!body.prompt || typeof body.prompt !== "string") return json({ ok: false, error: "缺少 prompt" }, 400);
    try {
      const task = await mesh.dispatch({
        harness: String(body.harness ?? ""),
        prompt: body.prompt,
        cwd: body.cwd,
        timeoutMs: body.timeoutMs,
        model: typeof body.model === "string" ? body.model : undefined,
        deny: body.deny,
        origin: typeof body.origin === "string" ? body.origin : undefined,
      });
      return json({ ok: true, task_id: task.task_id, state: task.state, harness: task.harness });
    } catch (error) {
      return json({ ok: false, error: String(error?.message ?? error) }, 400);
    }
  }

  if (path === "/api/harness-mesh/task" && request.method === "GET") {
    const taskId = new URL(request.url).searchParams.get("task_id") ?? "";
    try {
      const status = mesh.status(taskId);
      const terminal = TERMINAL_STATES.has(status.state);
      return json({ ok: true, status, result: terminal ? mesh.result(taskId) : null });
    } catch (error) {
      return json({ ok: false, error: String(error?.message ?? error) }, 404);
    }
  }

  if (path === "/api/harness-mesh/tasks" && request.method === "GET") {
    const q = new URL(request.url).searchParams;
    const fH = q.get("harness"), fS = q.get("state"), fLimit = Math.min(Number(q.get("limit")) || 30, 100);
    const tasks = mesh.store.list()
      .filter((t) => (!fH || t.harness === fH) && (!fS || t.state === fS))
      .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
      .slice(0, fLimit)
      .map((t) => ({
        task_id: t.task_id,
        harness: t.harness,
        state: t.state,
        prompt: t.prompt,
        summary: t.summary ?? null,
        error: t.error ?? null,
        duration_ms: t.duration_ms ?? null,
        created_at: t.created_at ?? null,
        origin: t.origin ?? null,
      }));
    return json({ ok: true, tasks });
  }

  if (path === "/api/harness-mesh/cancel" && request.method === "POST") {
    const body = await readJson(request);
    try {
      return json({ ok: true, ...(await mesh.cancel(String(body.task_id ?? ""))) });
    } catch (error) {
      return json({ ok: false, error: String(error?.message ?? error) }, 400);
    }
  }

  if (path === "/api/harness-mesh/permission" && request.method === "POST") {
    const body = await readJson(request);
    if (!body.task_id) return json({ ok: false, error: "缺少 task_id" }, 400);
    const ok = mesh.resolvePendingPermission(String(body.task_id ?? ""), body.allow === true);
    return json({ ok });
  }

  // ---- AI 辅助配置(主对话模型,零额外配置) ----
  if (path === "/api/harness-mesh/ai-config" && request.method === "POST") {
    const body = await readJson(request);
    const description = String(body.description ?? "").trim();
    if (!description) return json({ ok: false, error: "缺少 description" }, 400);
    try {
      const options = {
        provider: body.provider || undefined,
        model: body.model || undefined,
        messages: [createUserMessage({ content: [{ type: "text", text: description }], source: { kind: "harness-mesh-ai-config" } })],
        system: AI_SYSTEM,
        maxTokens: 1200,
        purpose: "harness-mesh-ai-config",
        signal: AbortSignal.timeout(60_000),
      };
      const assembler = new BlockAssembler();
      for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
      const error = assembler.finish?.error;
      if (error) throw error;
      const text = assembler.blocks().filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start < 0 || end <= start) return json({ ok: false, error: `AI 未返回 JSON,原文: ${text.slice(0, 300)}` }, 422);
      const draft = JSON.parse(text.slice(start, end + 1));
      // 只验证不落盘:草案回表单,用户确认后才保存(validateNode 会规范化和查错)
      const node = validateNode(String(draft.name ?? "").trim(), draft);
      return json({ ok: true, node, raw: text });
    } catch (error) {
      return json({ ok: false, error: String(error?.message ?? error) }, 422);
    }
  }

  // ---- 插头热重载(REST):POST /api/harness-mesh/plug-reload {harness} ----
  // 改了 plugs.json(启用插头/改 command)后调它——对端 harnessd 重载配置,
  // 不用重启进程(重启会让 ANN 节点抖)。适配器不在时先 ensureRunning。
  if (path === "/api/harness-mesh/plug-reload" && request.method === "POST") {
    const body = await readJson(request);
    const name = String(body.harness ?? "");
    const adapter = mesh.adapters.get(name);
    if (!adapter?.reloadPlugs) return json({ ok: false, error: `节点 ${name} 的适配器不在(先 dispatch 一次或它不是 acp-plug)` }, 400);
    try {
      const r = await adapter.reloadPlugs();
      return json({ ok: true, reload: r });
    } catch (error) {
      return json({ ok: false, error: String(error?.message ?? error) }, 400);
    }
  }

  // ---- 开团(REST):POST /api/harness-mesh/team {task, members, cwd?, timeoutMs?} ----
  if (path === "/api/harness-mesh/team" && request.method === "POST") {
    const body = await readJson(request);
    try {
      const team = await mesh.dispatchTeam({
        task: String(body.task ?? ""),
        members: body.members,
        cwd: body.cwd,
        timeoutMs: body.timeoutMs,
      });
      teamSave(team.team_id, team.tasks);
      return json({ ok: true, ...team });
    } catch (error) {
      return json({ ok: false, error: String(error?.message ?? error) }, 400);
    }
  }
  if (path === "/api/harness-mesh/team" && request.method === "GET") {
    const teamId = new URL(request.url).searchParams.get("team_id") ?? "";
    try {
      const agg = mesh.teamResult(teamId);
      const roles = teamRoles(teamId);
      agg.members = agg.members.map((m) => ({ ...m, role: roles.get(m.task_id) ?? null }));
      return json({ ok: true, ...agg });
    } catch (error) {
      return json({ ok: false, error: String(error?.message ?? error) }, 404);
    }
  }

  // ---- MCP(Streamable HTTP)入口:任何 MCP host 可直接召唤节点网格 ----
  const mcpAdmin = path === "/api/mcp/harness-mesh-admin";
  if (path === "/api/mcp/harness-mesh" || mcpAdmin) {
    if (request.method !== "POST") return json({ jsonrpc: "2.0", error: { code: -32000, message: "仅支持 POST(Streamable HTTP,无 SSE 流)" } }, 405);
    let msg;
    try { msg = await readJson(request); } catch { return json({ jsonrpc: "2.0", error: { code: -32700, message: "parse error" } }, 400); }
    const { id, method, params } = msg ?? {};
    console.log(`[harness-mesh] MCP${mcpAdmin ? "-admin" : ""} <- ${params?.clientInfo?.name ?? request.headers.get("user-agent") ?? "unknown-agent"}(v${params?.clientInfo?.version ?? "?"}) | ${method ?? "?"}${params?.name ? ` tool=${params.name}` : ""}`);
    const reply = (result) => json({ jsonrpc: "2.0", id: id ?? null, result });
    const fail = (code, message) => json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
    const mcpText = (t) => ({ content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t, null, 2) }] });
    const mcpCall = async (name, args) => {
      if (name === "harness_list") return mesh.listNodes();
      if (name === "harness_dispatch") {
        const task = await mesh.dispatch({ harness: String(args.harness ?? ""), prompt: String(args.prompt ?? ""), cwd: args.cwd, timeoutMs: args.timeoutMs, model: typeof args.model === "string" ? args.model : undefined, origin: typeof args.origin === "string" ? args.origin : undefined });
        return { task_id: task.task_id, state: task.state, model: task.model ?? null, hint: "用 harness_status 跟进,终态后用 harness_result 取汇报" };
      }
      if (name === "harness_tasks") {
        const wantState = typeof args.state === "string" && args.state ? args.state : "running";
        const limit = Math.min(Number(args.limit ?? 20) || 20, 100);
        const live = mesh.live;  // task_id → 运行时(进度/待批权在这)
        const rows = mesh.store.list()
          .filter((t) => (!args.harness || t.harness === args.harness) && t.state === wantState)
          .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
          .slice(0, limit)
          .map((t) => {
            const rt = live.get(t.task_id);
            const perm = rt?.pendingPermission;
            return {
              task_id: t.task_id, harness: t.harness, state: t.state,
              prompt: (t.prompt ?? "").slice(0, 120),
              model: t.model ?? null,
              started_at: t.started_at ?? null,
              duration_ms: t.duration_ms ?? (t.started_at ? Date.now() - Date.parse(t.started_at) : null),
              pending_permission: perm ? { title: perm.title } : null,
              last_progress: rt?.events?.length ? rt.events[rt.events.length - 1].title : null,
            };
          });
        return { state: wantState, count: rows.length, tasks: rows, hint: "用 harness_status 看单个任务详情,harness_result 取终态汇报" };
      }
      if (name === "harness_session") {
        const harness = String(args.harness ?? "");
        const action = String(args.action ?? "");
        const taskId = args.task_id ? String(args.task_id) : null;
        const token = args.confirm_token ? String(args.confirm_token) : null;
        if (!["stop", "pause", "resume", "start"].includes(action)) {
          return { error: `unknown action: ${action}(stop/pause/resume/start)` };
        }
        // ---- 有 token:校验并执行 ----
        if (token) {
          const all = confirmLoad();
          const rec = all[token];
          if (!rec) return { error: "confirm_token 无效(不存在或已用过)" };
          if (Date.now() > rec.expires_at) { delete all[token]; confirmSave(all); return { error: "confirm_token 已过期(60s),请重新发起" }; }
          if (rec.harness !== harness || rec.action !== action || rec.task_id !== taskId) {
            return { error: "confirm_token 与请求不匹配(harness/action/task_id 必须一致)" };
          }
          delete all[token]; confirmSave(all);   // 一次性
          try {
            if (action === "stop") {
              await mesh.cancel(taskId);
              controlAudit(`STOP harness=${harness} task=${taskId} by=MCP`);
              return { ok: true, action, task_id: taskId, note: "已发送停止(cancel+3s 强杀兜底);对端 run 取消情况可用 harness_tasks 跟踪" };
            }
            if (action === "pause") {
              const st = mesh.store.get(taskId);
              if (!st) return { error: `任务 ${taskId} 不存在` };
              if (!["running", "queued"].includes(st.state)) return { error: `任务状态 ${st.state},仅 running/queued 可暂停` };
              await mesh.cancel(taskId);
              mesh.store.update(taskId, { paused: true, error: "paused by harness_session(现场已保留,resume 可恢复)" });
              controlAudit(`PAUSE harness=${harness} task=${taskId} by=MCP`);
              return { ok: true, action, task_id: taskId, note: "已暂停(取消执行+保留现场);用 resume + 原 task_id 恢复" };
            }
            if (action === "resume") {
              const st = mesh.store.get(taskId);
              if (!st) return { error: `任务 ${taskId} 不存在` };
              const t = await mesh.dispatch({
                harness, prompt: `[恢复暂停的任务 ${taskId}]\n${st.prompt ?? ""}`,
                cwd: args.cwd ?? st.cwd ?? undefined, origin: st.origin ?? undefined,
              });
              mesh.store.update(t.task_id, { resumed_from: taskId });
              controlAudit(`RESUME harness=${harness} from=${taskId} new=${t.task_id} by=MCP`);
              return { ok: true, action, from_task: taskId, new_task_id: t.task_id, note: "已按原 prompt 重新派发;用 harness_status 跟进新任务" };
            }
            // start
            const t = await mesh.dispatch({ harness, prompt: String(args.prompt ?? ""), cwd: args.cwd });
            controlAudit(`START harness=${harness} task=${t.task_id} by=MCP`);
            return { ok: true, action, task_id: t.task_id, note: "会话/任务已开启,用 harness_status 跟进" };
          } catch (error) {
            controlAudit(`FAIL action=${action} harness=${harness} task=${taskId} err=${String(error?.message ?? error)} by=MCP`);
            return { error: String(error?.message ?? error) };
          }
        }
        // ---- 无 token:生成确认单 ----
        if (action === "start" && !args.prompt) return { error: "start 需要 prompt(任务内容)" };
        if ((action === "stop" || action === "pause") && !taskId) return { error: `${action} 需要 task_id` };
        if (action === "resume" && !taskId) return { error: "resume 需要原 task_id" };
        let summary = "";
        try {
          if (taskId) {
            const st = mesh.store.get(taskId);
            if (st) {
              const dur = st.started_at ? Math.round((Date.now() - Date.parse(st.started_at)) / 1000) : null;
              summary = `任务 ${taskId}(节点 ${st.harness},状态 ${st.state}${dur ? `,已跑 ${dur}s` : ""},prompt: ${(st.prompt ?? "").slice(0, 60)}…)`;
            } else summary = `任务 ${taskId}(记录不存在)`;
          } else summary = `节点 ${harness} 新会话`;
        } catch { summary = "(任务信息读取失败)"; }
        const tok = `sc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const all = confirmLoad();
        all[tok] = { harness, action, task_id: taskId, expires_at: Date.now() + CONFIRM_TTL_MS };
        confirmSave(all);
        const risk = { stop: "对端执行将被中止,未保存进度丢失", pause: "执行将中止但保留现场,可 resume 恢复", resume: "将按原 prompt 重新派发(产生新任务)", start: "将开启新任务" }[action];
        return {
          needs_confirm: true, confirm_token: tok, expires_in_sec: 60,
          summary: `即将对 ${summary} 执行 ${action}。风险:${risk}。`,
          how_to_confirm: "60 秒内用相同 harness/action/task_id 再加 confirm_token 再次调用本工具即执行;超时请重新发起",
        };
      }
      if (name === "harness_tools") {
        const h = typeof args.harness === "string" ? args.harness.trim() : "";
        if (!h) {
          const all = await availableHarnesses();
          return { harnesses: all, usage: "harness_tools {harness: 'workbuddy'} 看它的专属工具" };
        }
        const pack = await loadHarnessTools(h);
        if (!pack || !pack.tools.length) {
          return { error: `harness "${h}" 暂无专属工具`, available: await availableHarnesses() };
        }
        return {
          harness: h,
          tools: pack.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, doc: t.doc })),
          usage: `直接按上面的 inputSchema 调用,如 {"name":"${pack.tools[0].name}"}`,
        };
      }
      // 专属工具路由(公用名之外的,如 wb_info)
      {
        const COMMON = new Set([...CLIENT_TOOLS.map((t) => t.name), ...ADMIN_EXT_TOOLS.map((t) => t.name)]);
        if (!COMMON.has(name)) {
          const hit = await resolveTool(name);
          if (!hit) throw new Error(`unknown tool: ${name}(公用工具用 harness_help 查;harness 专属工具先用 harness_tools 看)`);
          return await hit.handler(args ?? {}, { mesh, nodes });
        }
      }
      if (name === "harness_help") {
        const tool = typeof args.tool === "string" ? args.tool.trim() : "";
        if (!tool) {
          return {
            tools: CLIENT_TOOLS.map((t) => t.name),
            sop: HELP_DOCS._sop,
            usage: "需要某个工具的完整用法就 harness_help {tool: '<名字>'}",
          };
        }
        const doc = HELP_DOCS[tool];
        if (!doc) {
          const all = [...CLIENT_TOOLS.map((t) => t.name), ...ADMIN_EXT_TOOLS.map((t) => t.name)];
          return { error: `没有名为 ${tool} 的工具文档`, available: all };
        }
        return { tool, doc };
      }
      if (name === "harness_team") {
        const team = await mesh.dispatchTeam({ task: String(args.task ?? ""), members: args.members, cwd: args.cwd, timeoutMs: args.timeoutMs });
        teamSave(team.team_id, team.tasks);
        return team;
      }
      if (name === "harness_team_result") {
        const agg = mesh.teamResult(String(args.team_id ?? ""));
        const roles = teamRoles(String(args.team_id ?? ""));
        agg.members = agg.members.map((m) => ({ ...m, role: roles.get(m.task_id) ?? null }));
        return agg;
      }
      if (name === "harness_status") return mesh.status(String(args.task_id ?? ""));
      if (name === "harness_cancel") return mesh.cancel(String(args.task_id ?? ""));
      if (name === "harness_config") {
        const h = String(args.harness ?? "");
        const node = nodes.get(h);
        if (!node) throw new Error(`harness-mesh: 节点 "${h}" 不存在;可用节点: ${nodes.list().map((n) => n.name).join(", ") || "(无)"}`);
        const raw = String(args.model ?? "").trim();
        const next = !raw || raw === "default" ? "" : raw;
        const changed = (node.model ?? "") !== next;
        if (changed) nodes.save({ ...node, model: next || null });
        return { harness: h, model: next, changed, note: "已写节点表,对后续 dispatch 立即生效;建议先派个小任务验证对端支持该模型" };
      }
      if (name === "harness_result") return mesh.result(String(args.task_id ?? ""));
      throw new Error(`unknown tool: ${name}`);
    };
    try {
      if (method === "initialize") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0", id: id ?? null,
          result: {
            protocolVersion: params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "harness-mesh", version: "0.1.0" },
            // 接口契约(客户端对齐用,见《harness-mesh 接口契约》):
            // contractVersion 变更规则=只增不改;客户端拿到的 unified 工具集与
            // 服务端不一致时,应提示对齐而不是硬调(防"服务端改了客户端错乱")。
            contractVersion: "hm-1",
            unified: CLIENT_TOOLS.map((t) => t.name),   // 统一层工具(语义冻结)
            extended: ADMIN_EXT_TOOLS.map((t) => t.name), // 管理层工具(admin 入口)
          },
        }), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "harness-mesh-main" } });
      }
      if (method === "notifications/initialized" || id === undefined) return new Response(null, { status: 202 });
      if (method === "tools/list") return reply({ tools: mcpAdmin ? [...CLIENT_TOOLS, ...ADMIN_EXT_TOOLS] : CLIENT_TOOLS });
      if (method === "tools/call") {
        const toolName = String(params?.name ?? "");
        if (!mcpAdmin && ADMIN_ONLY.has(toolName)) {
          return fail(-32601, `${toolName} 是服务端工具,请改用服务端入口 /api/mcp/harness-mesh-admin`);
        }
        return reply(mcpText(await mcpCall(toolName, params?.arguments ?? {})));
      }
      if (method === "ping") return reply({});
      return fail(-32601, `method not found: ${method}`);
    } catch (error) {
      return fail(-32000, String(error?.message ?? error));
    }
  }

  return json({ ok: false, error: `not found: ${path}` }, 404);
}
