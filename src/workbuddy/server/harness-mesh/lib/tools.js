/** M1 工具集(方案 §2.4 的完整契约,send 留到 M2):
 *  - harness_list     节点表(选节点)
 *  - harness_dispatch 下发任务(异步:拿 task_id,轮询跟进)
 *  - harness_status   状态 + 最近进度
 *  - harness_cancel   取消
 *  - harness_result   结构化汇报
 */
import { defineTool } from "@deepseek-ai/dsh-tools";

const NODE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", required: true, description: "节点名" },
    type: { type: "string", required: true, enum: ["acp-stdio", "acp-ssh", "cli-oneshot", "acp-plug"] },
    target: { type: "string", required: true, description: "连接目标:local 或 用户@主机" },
    command: { type: "string", required: true, description: "启动命令(含参数)" },
    description: { type: "string", required: true },
    health: { type: "string", required: true, enum: ["unknown", "up", "down"] },
    running: { type: "integer", required: true, description: "在跑/排队任务数" },
  },
};

const PROGRESS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    at: { type: "string", required: true },
    kind: { type: "string", required: true, description: "事件类型(agent_message_chunk/tool_call/permission/…)" },
    title: { type: "string", required: true },
  },
};

const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    task_id: { type: "string", required: true },
    harness: { type: "string", required: true },
    state: { type: "string", required: true, enum: ["queued", "running", "succeeded", "failed", "cancelled", "timeout"] },
    summary: { type: "string", required: true, description: "agent 的结论文本" },
    changes: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", required: true },
          paths: { type: "array", required: true, items: { type: "string" } },
        },
      },
    },
    tests: { type: "string", required: true, description: "M1 恒为 \"未解析\"" },
    artifacts: { type: "array", required: true, items: { type: "string" } },
    next_hint: { type: "string", required: true },
    session_ref: { type: "string", required: true, description: "被控 harness 的会话 id(续跑用)" },
    stop_reason: { type: "string", required: true },
    duration_ms: { type: "integer", required: true },
    error: { type: "string", required: true, description: "失败原因,成功为 \"\"" },
  },
};

export function createTools(state) {
  const mesh = state.mesh;

  return [
    defineTool({
      name: "harness_list",
      description: [
        "列出所有已配置的被控 harness 节点(名称/类型/连接目标/健康状态/在跑任务数)。",
        "编排任务前先用它选节点;没有合适节点时不要臆造,告诉用户缺什么、缺哪个 harness。",
      ].join(""),
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { nodes: { type: "array", required: true, items: NODE_SCHEMA } },
        },
        render: (_args, value) => [{
          type: "text",
          text: value.nodes.length === 0
            ? "harness-mesh: 没有配置任何被控节点(在 profile 的 cordis.patch.yml 里加 harness-mesh.config.harnesses)"
            : `harness-mesh 节点 ${value.nodes.length} 个:\n${value.nodes.map((n) => `- ${n.name} [${n.type}] → ${n.target}(${n.command}),健康 ${n.health},在跑 ${n.running}${n.description ? ` — ${n.description}` : ""}`).join("\n")}`,
        }],
      },
      execute: async () => ({ nodes: mesh.listNodes() }),
    }),

    defineTool({
      name: "harness_dispatch",
      description: [
        "给某个被控 harness 节点下发一个任务,立即返回 task_id(异步执行)。",
        "编排 SOP:①harness_list 选节点 ②dispatch ③周期性 harness_status 看进度(卡住或失败时决定重试/换节点)",
        "④任务到终态后 harness_result 拿结构化汇报,汇总给用户。",
        "prompt 要自包含:被控 harness 看不到本会话历史,把背景/要求/验收标准写全。",
        "敏感操作(删除/外发/提权等,内置 deny 规则)会自动停下来问用户;可用 deny 追加自定义模式。",
      ].join(""),
      parameters: {
        harness: { type: "string", required: true, description: "目标节点名(harness_list 的 name)" },
        prompt: { type: "string", required: true, description: "任务描述(自包含)" },
        cwd: { type: "string", description: "工作目录(绝对路径);缺省用节点配置或主 harness 当前目录" },
        model: { type: "string", description: "指定模型(provider/model,如 opencode/deepseek-v4.1-flash);仅本次任务覆盖节点默认模型" },
        timeoutMs: { type: "integer", description: "超时毫秒数,默认 600000(10 分钟)" },
        deny: { type: "array", items: { type: "string" }, description: "追加的敏感操作正则(命中即问用户)" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            task_id: { type: "string", required: true },
            harness: { type: "string", required: true },
            state: { type: "string", required: true, description: "派发后即 running(会话已建立)" },
          },
        },
        render: (_args, value) => [{ type: "text", text: `已派发任务 ${value.task_id} → ${value.harness}(state=${value.state});用 harness_status 跟进,harness_result 取汇报。` }],
      },
      execute: async (args, exec) => {
        const task = await mesh.dispatch({
          harness: args.harness,
          prompt: args.prompt,
          cwd: args.cwd,
          model: args.model,
          timeoutMs: args.timeoutMs,
          deny: args.deny,
          approvalAgent: exec.agent,
          signal: exec.signal,
        });
        return { task_id: task.task_id, harness: task.harness, state: task.state };
      },
    }),

    defineTool({
      name: "harness_config",
      description: [
        "持久设置某个被控 harness 节点的默认模型(写节点表,重启不丢;之后该节点的任务都用这个模型)。",
        "用法:harness_config {harness:节点名, model:provider/model};model 传空串或 default 恢复用被控 harness 自己的默认。",
        "只改模型这一项,不动节点的其他配置;改完对后续 dispatch 立即生效。",
      ].join(""),
      parameters: {
        harness: { type: "string", required: true, description: "目标节点名(harness_list 的 name)" },
        model: { type: 'string', required: true, description: '模型标识(如 kimi-for-coding / opencode/deepseek-v4.1-flash);空串或 default = 恢复节点默认' },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            harness: { type: "string", required: true },
            model: { type: "string", required: true, description: "生效后的模型(空=用被控默认)" },
            changed: { type: "boolean", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: `节点 ${value.harness} 的默认模型已设为 ${value.model || "(被控 harness 默认)"}${value.changed ? "" : "(无变化)"};后续 dispatch 到该节点的任务都用它。` }],
      },
      execute: async (args) => {
        const name = String(args.harness ?? "");
        const node = state.nodes.get(name);
        if (!node) throw new Error(`harness-mesh: 节点 "${name}" 不存在;可用节点: ${state.nodes.list().map((n) => n.name).join(", ") || "(无)"}`);
        const raw = String(args.model ?? "").trim();
        const next = !raw || raw === "default" ? "" : raw;
        const changed = (node.model ?? "") !== next;
        if (changed) state.nodes.save({ ...node, model: next || null });
        return { harness: name, model: next, changed };
      },
    }),

    defineTool({
      name: "harness_status",
      description: "查任务状态与最近进度事件。轮询节奏建议 15-30 秒一次;state 到终态(succeeded/failed/cancelled/timeout)后改用 harness_result。",
      parameters: {
        task_id: { type: "string", required: true, description: "harness_dispatch 返回的任务 id" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            task_id: { type: "string", required: true },
            harness: { type: "string", required: true },
            state: { type: "string", required: true, enum: ["queued", "running", "succeeded", "failed", "cancelled", "timeout"] },
            session_ref: { type: "string", required: true },
            started_at: { type: "string", required: true },
            duration_ms: { type: "integer", required: true, description: "已运行毫秒数;未开始为 0" },
            progress: { type: "array", required: true, items: PROGRESS_SCHEMA, description: "最近 12 条事件" },
            pending_permission: { type: "object", additionalProperties: true, description: "在等主控侧批的权限(非空=等待中,勿重派;可选字段,不写 required 即可选)" },
            error: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{
          type: "text",
          text: [
            `任务 ${value.task_id} @ ${value.harness}: ${value.state}(已运行 ${Math.round((value.duration_ms ?? 0) / 1000)}s)`,
            ...value.progress.map((p) => `  [${p.at.slice(11, 19)}] ${p.kind}${p.title ? `: ${p.title}` : ""}`),
            value.error ? `错误: ${value.error}` : "",
          ].filter(Boolean).join("\n"),
        }],
      },
      execute: async (args) => {
        const s = mesh.status(args.task_id);
        const out = { ...s, duration_ms: s.duration_ms ?? 0, session_ref: s.session_ref ?? "", started_at: s.started_at ?? "", error: s.error ?? "" };
        // pending_permission 无权限时是 null;schema 声明 object,validator 拒 null
        // → 无权限时整个键去掉(可选字段不出现即合法)
        if (out.pending_permission === null || out.pending_permission === undefined) delete out.pending_permission;
        return out;
      },
    }),

    defineTool({
      name: "harness_cancel",
      description: "取消一个在跑的任务(向被控 harness 发 session/cancel,它会停掉当前的回合)。",
      parameters: {
        task_id: { type: "string", required: true },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            task_id: { type: "string", required: true },
            state: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: `已请求取消任务 ${value.task_id}(state=${value.state});最终状态以 harness_status 为准。` }],
      },
      execute: async (args) => mesh.cancel(args.task_id),
    }),

    defineTool({
      name: "harness_result",
      description: [
        "取任务的结构化汇报(结论文本/文件变更/stop 原因/耗时/错误)。",
        "任务到终态后调用;把 summary 和 changes 消化后用自己的话向用户汇报,不要原样贴大段文本。",
      ].join(""),
      parameters: {
        task_id: { type: "string", required: true },
      },
      output: {
        schema: REPORT_SCHEMA,
        render: (_args, value) => [{
          type: "text",
          text: [
            `任务 ${value.task_id} @ ${value.harness}: ${value.state}(stop=${value.stop_reason}, ${Math.round((value.duration_ms ?? 0) / 1000)}s)`,
            `总结: ${value.summary}`,
            value.changes.length ? `变更 ${value.changes.length} 处:\n${value.changes.map((c) => `  - ${c.title} → ${c.paths.join(", ")}`).join("\n")}` : "变更: 无",
            value.error ? `错误: ${value.error}` : "",
          ].filter(Boolean).join("\n"),
        }],
      },
      execute: async (args) => {
        const r = mesh.result(args.task_id);
        return {
          ...r,
          tests: "未解析",
          artifacts: r.artifacts ?? [],
          next_hint: r.next_hint ?? "",
          session_ref: r.session_ref ?? "",
          stop_reason: r.stop_reason ?? "",
          duration_ms: r.duration_ms ?? 0,
          error: r.error ?? "",
          summary: r.summary ?? "",
          changes: r.changes ?? [],
        };
      },
    }),
  ];
}
