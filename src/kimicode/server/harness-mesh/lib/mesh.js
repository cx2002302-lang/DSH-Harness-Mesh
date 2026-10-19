/** MeshController:harness-mesh 的编排核心。
 *
 *  职责:
 *  - 节点表(配置加载)+ 适配器惰性创建/常驻复用/卸载清理;
 *  - 任务生命周期:queued → running → succeeded/failed/cancelled/timeout;
 *  - ACP session/update 通知按 sessionId 路由到任务(一个被控进程可并行多任务);
 *  - 权限策略(人在环):deny 清单命中 → dsh user-approval 问你;未命中 → 自动放行;
 *  - 结构化汇报提取(agent 结论文本 + 文件变更 + stop 原因 + 耗时)。
 *
 *  needs_input 状态与 harness.send(M2)在本文件预留接口,暂不实现。
 */
import { randomUUID } from "node:crypto";
import { loadAdapterClass } from "./adapters/index.js";

/** 默认敏感操作模式:命中即停下来问你(方案 §3「涉及删除/部署/外发必须问你」)。 */
const DEFAULT_DENY = [
  /rm\s+(-[a-zA-Z]+\s+)*-?[rf]{1,2}\b/i,      // rm -rf / rm -fr
  /git\s+push/i,                              // 外发
  /git\s+reset\s+--hard/i,
  /(curl|wget)\s[^|]*\|\s*(sudo\s+)?(ba)?sh/i, // 远程脚本直接执行
  /\bdd\s+if=/i,
  /\bmkfs\b/i,
  /\b(shutdown|reboot|poweroff)\b/i,
  /\bsudo\b/i,
];

/** 会被视为「文件变更」的工具类别(用于汇报的 changes 字段)。 */
const MUTATING_KINDS = new Set(["edit", "delete", "move", "create"]);

const MAX_RING = 60;        // 每任务内存中保留的最近事件数
const MAX_SUMMARY = 4000;   // 结论文本截断

function nowIso() {
  return new Date().toISOString();
}

/** 把一段文本/对象拍平成用于模式匹配的字符串。 */
function flatten(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

export class MeshController {
  /** @param ctx cordis 插件上下文(取 approval/llm 服务用)
   *  @param config { defaultTimeoutMs }(节点表在 nodes store 里,GUI 可热改)
   *  @param nodes NodesStore
   *  @param store TaskStore */
  constructor(ctx, config, nodes, store) {
    this.ctx = ctx;
    this.config = config;
    this.nodes = nodes;
    this.store = store;
    /** @type {Map<string, AcpStdioAdapter>} */
    this.adapters = new Map();
    /** @type {Map<string, object>} task_id → 运行时状态 */
    this.live = new Map();
    /** sessionId → task_id(ACP 通知路由) */
    this.sessionIndex = new Map();
    // 僵尸任务清扫(2026-10-19):主控重启/插件重载后,tasks.jsonl 里残留的
    // running/queued 任务的运行时早已死亡(live 是内存态),不扫会永远显示"运行中",
    // 还污染节点健康判断与 harness_tasks 列表。启动即标记失败。
    for (const t of this.store.list()) {
      if (t.state === "running" || t.state === "queued") {
        this.store.update(t.task_id, { state: "failed", ended_at: nowIso(), error: "主控重启/插件重载,任务中断(运行时不可恢复)" });
        console.log(`[harness-mesh] 僵尸任务清扫: ${t.task_id} @ ${t.harness}(${t.state} → failed)`);
      }
    }
  }

  /** 节点表(harness_list / GUI 面板用)。 */
  listNodes() {
    return this.nodes.list().map((h) => ({
      name: h.name,
      type: h.type,
      target: h.type === "acp-ssh" ? h.ssh : h.type === "acp-plug" ? `${h.address}#${h.plugId}` : "local",
      command: h.type === "acp-plug" ? `plug ${h.address} → ${h.plugId}` : [h.command, ...h.args].join(" "),
      description: h.description,
      health: this.adapters.get(h.name)?.alive ? "up" : "unknown",
      running: this.store.countRunning(h.name),
    }));
  }

  /** 取(或惰性创建)某节点的适配器。异步:适配器类热加载(mtime 缓存破坏),
   *  文件变了下个派发自动用新类重建实例——改适配器代码零重启。 */
  async #adapterFor(node) {
    const { Cls, modUrl } = await loadAdapterClass(node.type);
    let adapter = this.adapters.get(node.name);
    if (adapter) {
      if (adapter.__modUrl === modUrl) {
        // 复用连接,但配置(如 model/address)以最新为准——GUI 改完即时生效
        adapter.node = node;
        return adapter;
      }
      // 适配器代码变了:销毁旧实例(断连接),用新类重建
      console.log(`[harness-mesh] 适配器热重载: ${node.name}(${node.type})`);
      await adapter.dispose();
    }
    adapter = new Cls(node, {
      onSessionUpdate: (params) => this.#onSessionUpdate(params),
      resolvePermission: (params, signal) => this.#resolvePermission(params, signal),
      onProcessExit: (code) => this.#onProcessExit(node.name, code),
    });
    adapter.__modUrl = modUrl;
    this.adapters.set(node.name, adapter);
    return adapter;
  }

  /** 下发任务。返回 task 记录(状态 queued/running 由内部推进,这里先同步到 session 建立)。 */
  async dispatch({ harness, prompt, cwd, timeoutMs, deny, approvalAgent, origin, signal, model }) {
    const node = this.nodes.get(harness);
    if (!node) {
      throw new Error(`harness-mesh: 节点 "${harness}" 不存在;可用节点: ${this.nodes.list().map((n) => n.name).join(", ") || "(无)"}`);
    }
    const timeout = timeoutMs ?? this.config.defaultTimeoutMs;
    const taskId = `t-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 8)}`;
    const task = this.store.create({
      task_id: taskId,
      harness,
      state: "queued",
      prompt,
      cwd: cwd ?? node.cwd ?? null,
      deny: deny ?? [],
      timeout_ms: timeout,
      origin: typeof origin === "string" && origin ? origin : null,  // 发起会话(用于 GUI 按会话归类)
      model: typeof model === "string" && model ? model : null,     // 按任务指定模型(覆盖节点默认;日常功能:指定模型)
      created_at: nowIso(),
    });
    const runtime = {
      task,
      node,
      approvalAgent,
      denyPatterns: [...DEFAULT_DENY, ...(deny ?? []).map((p) => new RegExp(p, "i"))],
      events: [],               // 最近事件环形缓冲
      messages: new Map(),      // messageId → 累积文本
      toolCalls: new Map(),     // toolCallId → 最新快照
      sessionId: null,
      timedOut: false,
      aborted: false,
      startedAt: Date.now(),
    };
    this.live.set(taskId, runtime);

    // 异步推进:queued → running → 终态。dispatch 工具只拿到 task_id,
    // 主 LLM 用 harness_status / harness_result 跟进。
    void this.#run(runtime, prompt, timeout, signal);
    return task;
  }

  /** 开团:一个任务派给多个 harness(角色可选),并行执行。
   *  members: [{harness, role?}] 或 [harness名];role 会作为 prompt 前缀注入。
   *  返回 {team_id, tasks:[{harness, role, task_id}]};用 harness_status/result 逐任务跟进,
   *  或调 teamResult(team_id) 拿聚合汇报。 */
  async dispatchTeam({ task, members, cwd, timeoutMs, deny, approvalAgent, signal }) {
    const list = Array.isArray(members) ? members : [];
    if (!list.length) throw new Error("harness-mesh: 开团需要 members:[{harness, role?}]");
    const prompt0 = String(task ?? "").trim();
    if (!prompt0) throw new Error("harness-mesh: 开团需要 task(任务内容)");
    const teamId = `tm-${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
    const dispatched = [];
    for (const m of list) {
      const harness = typeof m === "string" ? m : String(m?.harness ?? "");
      const role = typeof m === "string" ? null : (m?.role ?? null);
      if (!harness) throw new Error("harness-mesh: members 里有用例缺少 harness 名");
      const prompt = role ? `【你的角色:${role}】\n${prompt0}` : prompt0;
      const t = await this.dispatch({
        harness, prompt, cwd, timeoutMs, deny, approvalAgent,
        origin: `team:${teamId}`, signal,
      });
      dispatched.push({ harness, role, task_id: t.task_id });
    }
    console.log(`[harness-mesh] 开团 ${teamId}:${dispatched.map((d) => `${d.harness}${d.role ? `(${d.role})` : ""}`).join(" + ")}`);
    return { team_id: teamId, tasks: dispatched, hint: "用 harness_status 逐任务跟进,终态后 teamResult 拿聚合" };
  }

  /** 开团聚合汇报:按 origin=team:<id> 收齐所有成员任务的结构化结果。 */
  teamResult(teamId) {
    const rows = this.store.list()
      .filter((t) => t.origin === `team:${teamId}`)
      .map((t) => {
        const r = this.result(t.task_id);
        return { harness: t.harness, task_id: t.task_id, state: r.state, summary: r.summary, changes: r.changes, error: r.error };
      });
    if (!rows.length) throw new Error(`harness-mesh: 开团 ${teamId} 没有任务记录`);
    const done = rows.filter((r) => ["succeeded", "failed", "cancelled", "timeout"].includes(r.state)).length;
    return { team_id: teamId, total: rows.length, done, all_done: done === rows.length, members: rows };
  }

  async #run(runtime, prompt, timeout, signal) {
    const { task, node } = runtime;
    let timer = null;
    try {
      const adapter = await this.#adapterFor(node);
      // acp-plug 是被控机:cwd 不默认用主控进程目录(那是 Linux 路径,Windows 上直接 267),
      // 传 null 让被控机 harnessd 用 plug 配置或自身工作目录
      const cwd = task.cwd ?? node.cwd ?? (node.type === "acp-plug" ? null : process.cwd());
      const sessionId = await adapter.newSession(cwd, task.model);
      runtime.sessionId = sessionId;
      this.sessionIndex.set(sessionId, task.task_id);
      this.store.update(task.task_id, { state: "running", session_ref: sessionId, started_at: nowIso() });

      if (signal?.aborted) throw Object.assign(new Error("dispatch 被取消"), { aborted: true });

      timer = setTimeout(() => {
        runtime.timedOut = true;
        void adapter.cancel(sessionId);
      }, timeout);

      const response = await adapter.prompt(sessionId, prompt);
      this.#finalize(runtime, { stopReason: response?.stopReason ?? "end_turn" });
    } catch (error) {
      if (runtime.timedOut) {
        this.#finalize(runtime, { error: `超时(${timeout}ms)已取消` });
      } else if (signal?.aborted || error?.aborted) {
        runtime.aborted = true;
        this.#finalize(runtime, { error: "已被取消" });
      } else {
        this.#finalize(runtime, { error: String(error?.message ?? error) });
      }
    } finally {
      clearTimeout(timer);
      if (runtime.sessionId) this.sessionIndex.delete(runtime.sessionId);
    }
  }

  /** ACP 通知路由:按 sessionId 找到任务,累积事件。 */
  #onSessionUpdate(params) {
    const taskId = this.sessionIndex.get(params.sessionId);
    const runtime = taskId ? this.live.get(taskId) : null;
    if (!runtime) return;
    const update = params.update;
    const kind = update?.sessionUpdate;
    if (kind === "agent_message_chunk" || kind === "user_message_chunk" || kind === "agent_thought_chunk") {
      const key = update.messageId ?? `__${kind}`;
      const text = update.content?.type === "text" ? update.content.text : "";
      if (text) {
        runtime.messages.set(key, (runtime.messages.get(key) ?? "") + text);
        if (kind === "agent_message_chunk") runtime.lastAgentText = runtime.messages.get(key);
      }
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      const prev = runtime.toolCalls.get(update.toolCallId) ?? {};
      runtime.toolCalls.set(update.toolCallId, { ...prev, ...update });
    }
    runtime.events.push({ at: nowIso(), kind, title: update.title ?? update.content?.text?.slice(0, 120) ?? "" });
    if (runtime.events.length > MAX_RING) runtime.events.shift();
  }

  /** 权限策略:deny 命中 → 问人;否则自动放行。
   *  两条问人通道:
   *  - LLM 派遣(有 approvalAgent):走 dsh approval 服务,GUI 弹审批框;
   *  - GUI 直连派遣(无 agent/open turn):挂起为 pendingPermission,
   *    由控制台面板渲染允许/拒绝,POST /permission 回传决定。 */
  async #resolvePermission(params, signal) {
    const taskId = this.sessionIndex.get(params.sessionId);
    const runtime = taskId ? this.live.get(taskId) : null;
    const title = params.toolCall?.title ?? "(未命名工具调用)";
    const haystack = `${title}\n${flatten(params.toolCall?.rawInput)}\n${flatten(params.toolCall?.content)}`;
    const hit = runtime?.denyPatterns.find((re) => re.test(haystack));
    if (!hit || !runtime) {
      return { action: "allow" };
    }
    if (runtime.approvalAgent) {
      // LLM 通道:dsh approval 服务(需 open turn,失败 fail-closed)
      let outcome = "unavailable";
      try {
        const approval = this.ctx.get("approval");
        outcome = await approval.request({
          agent: runtime.approvalAgent,
          toolName: "harness_dispatch",
          reason: `被控节点 ${runtime.node.name} 的任务 ${runtime.task.task_id} 请求敏感操作(命中 ${hit}):${title}`,
          signal,
        });
      } catch (error) {
        console.log(`[harness-mesh] approval 不可用,拒绝敏感操作: ${String(error)}`);
      }
      if (outcome === "allowed-once") {
        runtime.events.push({ at: nowIso(), kind: "permission", title: `用户批准敏感操作: ${title}` });
        return { action: "allow" };
      }
      runtime.events.push({ at: nowIso(), kind: "permission", title: `敏感操作被拒(${outcome}): ${title}` });
      return { action: "reject", reason: `命中敏感操作规则 ${hit},审批结果: ${outcome}` };
    }
    // GUI 直连通道:挂起等面板确认(连接中断视为拒绝)
    return new Promise((resolve) => {
      const pending = { id: randomUUID().slice(0, 8), title, reason: `命中敏感操作规则 ${hit}: ${title}` };
      runtime.pendingPermission = { ...pending, resolve };
      const settle = (decision) => {
        if (runtime.pendingPermission?.id !== pending.id) return;
        runtime.pendingPermission = null;
        runtime.events.push({ at: nowIso(), kind: "permission", title: decision.action === "allow" ? `面板批准敏感操作: ${title}` : `面板拒绝敏感操作: ${title}` });
        resolve(decision);
      };
      runtime.pendingPermission.settle = settle;
      signal?.addEventListener("abort", () => settle({ action: "reject", reason: "ACP 连接中断,自动拒绝" }), { once: true });
    });
  }

  /** 面板回传权限决定(GUI 直连通道)。 */
  resolvePendingPermission(taskId, allow) {
    const runtime = this.live.get(taskId);
    const pending = runtime?.pendingPermission;
    if (!pending) return false;
    pending.settle(allow ? { action: "allow" } : { action: "reject", reason: "用户在控制台面板拒绝" });
    return true;
  }

  #onProcessExit(nodeName, code) {
    console.log(`[harness-mesh] 节点 ${nodeName} 的被控进程退出(code=${code})`);
    // 在跑任务标记失败(prompt 调用会因连接断开而 reject,走 #run 的 catch)
  }

  /** 终态处理:提取结构化汇报,落库,清理运行时。 */
  #finalize(runtime, { stopReason, error }) {
    const { task } = runtime;
    const state = error
      ? (runtime.aborted ? "cancelled" : "failed")
      : (runtime.timedOut ? "timeout" : (stopReason === "cancelled" ? "cancelled" : "succeeded"));
    const changes = [...runtime.toolCalls.values()]
      .filter((tc) => MUTATING_KINDS.has(tc.kind))
      .map((tc) => ({
        title: tc.title,
        paths: (tc.locations ?? []).map((l) => l.path).filter(Boolean),
      }))
      .filter((c) => c.paths.length > 0);
    const summary = (runtime.lastAgentText ?? "").trim() || "(agent 未产出结论文本)";
    const report = {
      task_id: task.task_id,
      harness: task.harness,
      state,
      summary: summary.length > MAX_SUMMARY ? `${summary.slice(0, MAX_SUMMARY)}…(截断)` : summary,
      changes,
      tests: null,               // M1 未解析(后续从终端输出提取,M2)
      artifacts: [],
      next_hint: null,
      session_ref: runtime.sessionId,
      stop_reason: stopReason ?? null,
      duration_ms: Date.now() - runtime.startedAt,
      error: error ?? null,
    };
    this.store.update(task.task_id, {
      state,
      ended_at: nowIso(),
      summary: report.summary,
      changes: report.changes,
      stop_reason: report.stop_reason,
      duration_ms: report.duration_ms,
      error: report.error,
    });
    this.live.delete(task.task_id);
    console.log(`[harness-mesh] 任务 ${task.task_id} → ${state}(${report.duration_ms}ms,变更 ${report.changes.length} 处)`);
  }

  /** 任务状态 + 最近进度(harness_status / 面板轮询)。 */
  status(taskId) {
    const stored = this.store.get(taskId);
    if (!stored) throw new Error(`harness-mesh: 任务 ${taskId} 不存在`);
    const runtime = this.live.get(taskId);
    return {
      task_id: stored.task_id,
      harness: stored.harness,
      state: stored.state,
      session_ref: stored.session_ref ?? null,
      started_at: stored.started_at ?? null,
      duration_ms: stored.duration_ms ?? (stored.started_at ? Date.now() - Date.parse(stored.started_at) : null),
      progress: runtime ? runtime.events.slice(-12) : [],
      pending_permission: runtime?.pendingPermission
        ? { id: runtime.pendingPermission.id, title: runtime.pendingPermission.title, reason: runtime.pendingPermission.reason }
        : null,
      error: stored.error ?? null,
    };
  }

  /** 结构化汇报(harness_result)。 */
  result(taskId) {
    const stored = this.store.get(taskId);
    if (!stored) throw new Error(`harness-mesh: 任务 ${taskId} 不存在`);
    return {
      task_id: stored.task_id,
      harness: stored.harness,
      state: stored.state,
      summary: stored.summary ?? null,
      changes: stored.changes ?? [],
      tests: null,
      artifacts: [],
      next_hint: null,
      session_ref: stored.session_ref ?? null,
      stop_reason: stored.stop_reason ?? null,
      duration_ms: stored.duration_ms ?? null,
      error: stored.error ?? null,
    };
  }

  async cancel(taskId) {
    const stored = this.store.get(taskId);
    if (!stored) throw new Error(`harness-mesh: 任务 ${taskId} 不存在`);
    const runtime = this.live.get(taskId);
    if (!runtime || !runtime.sessionId) {
      throw new Error(`harness-mesh: 任务 ${taskId} 不在运行中(state=${stored.state}),无需取消`);
    }
    runtime.aborted = true;
    const adapter = this.adapters.get(stored.harness);
    await adapter?.cancel(runtime.sessionId);
    return { task_id: taskId, state: "cancelling" };
  }

  /** 插件卸载:杀掉所有被控进程。 */
  async dispose() {
    for (const adapter of this.adapters.values()) await adapter.dispose();
    this.adapters.clear();
    this.live.clear();
    this.sessionIndex.clear();
  }
}
