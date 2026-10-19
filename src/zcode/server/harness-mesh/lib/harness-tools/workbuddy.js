/** workbuddy 专属工具(WinPC · <计算机名> · GUI Gateway 形态)。
 *  编写规范见《harness 专属工具编写规范》(共享 新节点接入包/)。
 *
 *  现状:执行体是 GUI Gateway(动态端口 + Bearer 密码,PEB 自取),经 wb-gateway-adapter
 *  适配器对接。本文件先落"不依赖 Gateway 直连"的档案类工具;Gateway 直连类工具
 *  (wb_gateway_status/wb_runs)待 v5 适配器落地后按规范里的模式补。
 */

/** workbuddy 节点在 mesh 里的名字(可能多个,取最匹配的)。 */
function findNode(nodes) {
  const list = nodes.list();
  return list.find((n) => /workbuddy/i.test(n.name) && n.type === "acp-plug")
      ?? list.find((n) => /workbuddy/i.test(n.name))
      ?? null;
}

export const tools = [
  {
    name: "wb_info",
    description: "workbuddy 节点档案:计算机名/节点配置/插头健康/最近任务结果",
    inputSchema: {
      type: "object",
      properties: {
        node: { type: "string", description: "节点名;不填自动匹配 workbuddy 节点" },
        recent: { type: "number", description: "带最近几条任务摘要,默认 3" },
      },
    },
    doc: "返回 workbuddy 节点的档案:{node 配置(name/address/plugId/model/socks), health(up/unknown), recent:[{task_id,state,summary,duration_ms}]}。用于:确认节点在不在、最近派活结果、排查前先看它。不依赖 Gateway 直连,任何时候可调。",
  },
  {
    name: "wb_ui_status",
    description: "WorkBuddy UI 状态:当前模型/会话数/输入框/标题(经 wb-ui 行协议,不占会话引擎)",
    inputSchema: { type: "object", properties: {} },
    doc: "返回 {ok, model, sessions, hasInput, title, engineBusy, sendEnabled}。派活前可看它判断 UI 是否活着;engineBusy=true=引擎在跑(UI 全局态,任何会话在跑都 true,保守口径),此时派活会排队;model 是当前选中的模型。",
  },
  {
    name: "wb_ui_sessions",
    description: "WorkBuddy 会话列表(标题/选中态,最多 30 条)",
    inputSchema: { type: "object", properties: {} },
    doc: "返回 {ok, sessions:[{title, meta, selected}]}。selected=true 是当前会话。",
  },
  {
    name: "wb_ui_model",
    description: "读或设 WorkBuddy 当前模型(CDP 点选择器)",
    inputSchema: {
      type: "object",
      properties: { set: { type: "string", description: "要切换的模型名(如 Deepseek-V4.1-Flash);不填=只读" } },
    },
    doc: "不填 set=返回当前模型;填 set=切换并返回切换后的模型。切换是 UI 操作,不影响正在跑的任务。",
  },
  {
    name: "wb_ui_screenshot",
    description: "WorkBuddy 界面截图(存到 WinPC 本地,返回路径+字节数)",
    inputSchema: {
      type: "object",
      properties: { out: { type: "string", description: "输出路径(WinPC 本地,如 C:\\wb-mesh\\dsh_shot.png);缺省用默认" } },
    },
    doc: "返回 {ok, path, bytes}。截图在 WinPC 的 C:\\wb-mesh\\wb-ui-shot.png;要看图让本机用户或经共享取。",
  },
  {
    name: "wb_ui_switch_session",
    description: "切换 WorkBuddy 当前会话(真实鼠标事件点会话卡片)",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string", description: "目标会话标题(支持子串匹配)" } },
      required: ["title"],
    },
    doc: "返回 {ok, action, model}。切换是 UI 操作不占引擎;标题用 wb_ui_sessions 列出来的真实标题(子串即可)。",
  },
  {
    name: "wb_ui_new_session",
    description: "新建 WorkBuddy 会话(Ctrl+N,可指定模型避免 429)",
    inputSchema: {
      type: "object",
      properties: { model: { type: "string", description: "新建后切换的模型(新建页默认 Step-5-Preview,建议指定 Deepseek-V4.1-Flash)" } },
    },
    doc: "返回 {ok, action, model}。不填 model 用默认(可能是 Step-5-Preview,有 429 风险)。",
  },
  {
    name: "wb_ui_delete_session",
    description: "删除 WorkBuddy 会话(默认 dry-run 只列菜单项,confirm=true 才真删)",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "要删的会话标题(子串匹配)" },
        confirm: { type: "boolean", description: "true 才执行真删;缺省/false=dry-run" },
      },
      required: ["title"],
    },
    doc: "危险操作:dry-run(默认)只返回会发生的菜单动作;confirm=true 才真删。删除不可逆,用前先 wb_ui_sessions 核对标题。",
  },
  {
    name: "wb_ui_send",
    description: "在 WorkBuddy 当前会话发消息(Gateway API 版,零界面操作,返回 runId+完整结果)",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "要发送的消息内容" } },
      required: ["text"],
    },
    doc: "返回 {ok, runId, status, elapsed, text}。走 Gateway POST /api/v1/runs——不碰界面(不影响本机用户用电脑),且能拿到完整结果。等同于派任务,但目标是当前会话。",
  },
  {
    name: "wb_ui_rename_session",
    description: "重命名 WorkBuddy 会话(CDP:右键菜单→重命名→回车)",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "当前会话名(子串匹配)" },
        new_name: { type: "string", description: "新名字" },
      },
      required: ["name", "new_name"],
    },
    doc: "返回 {ok, action, ...}。只能 CDP(WorkBuddy 没有开放会话管理 API);点击类操作不抢焦点。",
  },
];

/** 经 wb-ui 插头(行协议)执行 UI 命令:dispatch 到 <计算机名>-wb-ui,等终态,summary 是 JSON 回包。 */
async function uiCmd(cmd, extra, ctx, opts = {}) {
  const runOnce = async () => {
    const t = await ctx.mesh.dispatch({
      harness: "<计算机名>-wb-ui",
      prompt: JSON.stringify({ cmd, ...(extra ?? {}) }),
      cwd: null,
      origin: "wb-ui",
    });
    // dispatch 是异步的:轮询到终态(行协议任务秒级,给 150s 上限——send 类要等模型)
    let r = ctx.mesh.result(t.task_id);
    for (let i = 0; i < 75 && !["succeeded", "failed", "cancelled", "timeout"].includes(r.state); i++) {
      await new Promise((res) => setTimeout(res, 2000));
      r = ctx.mesh.result(t.task_id);
    }
    let parsed;
    try { parsed = JSON.parse(String(r.summary ?? "")); } catch { parsed = { raw: r.summary }; }
    return { task_id: t.task_id, state: r.state, ...parsed };
  };
  let out = await runOnce();
  // 写操作冲突重试(它侧策略:CDP 与用户操作冲突时 NOT_FOUND/失败→延后重试,别当永久失败)。
  // 只对写操作且一次:读操作无冲突问题;NOT_FOUND 也可能是真不存在,重试一次无成本。
  const retryable = opts.retryOnConflict && (out.ok === false || out.action === "NOT_FOUND");
  if (retryable) {
    await new Promise((res) => setTimeout(res, 5000));
    const again = await runOnce();
    again.retried = true;
    out = again;
  }
  return out;
}

export const handlers = {
  wb_ui_status: async (args, ctx) => uiCmd("status", null, ctx),
  wb_ui_sessions: async (args, ctx) => uiCmd("sessions", null, ctx),
  wb_ui_model: async (args, ctx) => uiCmd("model", args.set ? { set: args.set } : null, ctx),
  wb_ui_screenshot: async (args, ctx) => uiCmd("screenshot", args.out ? { out: String(args.out) } : null, ctx),
  wb_ui_switch_session: async (args, ctx) => uiCmd("switch-session", { name: String(args.title ?? args.name ?? "") }, ctx, { retryOnConflict: true }),
  wb_ui_new_session: async (args, ctx) => uiCmd("new-session", args.model ? { model: String(args.model) } : null, ctx, { retryOnConflict: true }),
  wb_ui_delete_session: async (args, ctx) => uiCmd("delete-session", { name: String(args.title ?? args.name ?? ""), confirm: args.confirm === true }, ctx, { retryOnConflict: true }),
  wb_ui_send: async (args, ctx) => uiCmd("send", { text: String(args.text ?? "") }, ctx),
  wb_ui_rename_session: async (args, ctx) => uiCmd("rename", { name: String(args.name ?? ""), newName: String(args.new_name ?? "") }, ctx, { retryOnConflict: true }),
  wb_info: async (args, ctx) => {
    const nodes = ctx.nodes;
    const list = nodes.list();
    const node = args.node
      ? list.find((n) => n.name === args.node)
      : findNode(nodes);
    if (!node) {
      return { error: "未找到 workbuddy 节点", available: list.map((n) => n.name) };
    }
    const limit = Math.min(Number(args.recent ?? 3) || 3, 20);
    const recent = ctx.mesh.store.list()
      .filter((t) => t.harness === node.name)
      .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
      .slice(0, limit)
      .map((t) => ({
        task_id: t.task_id, state: t.state,
        summary: (t.summary ?? t.error ?? "").slice(0, 120) || null,
        duration_ms: t.duration_ms ?? null, created_at: t.created_at ?? null,
      }));
    return {
      node: {
        name: node.name, type: node.type, address: node.address ?? null,
        plugId: node.plugId ?? null, model: node.model ?? null,
        socks: node.socks ?? null, description: node.description ?? "",
      },
      health: ctx.mesh.adapters.get(node.name)?.alive ? "up" : "unknown",
      running: ctx.mesh.store.countRunning(node.name),
      recent,
      hint: "派活用 harness_dispatch;在跑任务用 harness_tasks 过滤该节点",
    };
  },
};
