/** kimi 专属工具(骨架版:档案类,照 wb_info 同型)。
 *  随 kimi 节点接入与能力实测,按《harness专属工具编写规范》扩充
 *  (如 kimi_models/kimi_sessions 等, verbs 用固定词汇表)。 */

function findNode(nodes) {
  const list = nodes.list();
  return list.find((n) => new RegExp("kimi", "i").test(n.name) && n.type === "acp-plug")
      ?? list.find((n) => new RegExp("kimi", "i").test(n.name))
      ?? null;
}

export const tools = [
  {
    name: "kimi_info",
    description: "kimi 节点档案:配置/插头健康/最近任务结果",
    inputSchema: {
      type: "object",
      properties: {
        node: { type: "string", description: "节点名;不填自动匹配 kimi 节点" },
        recent: { type: "number", description: "带最近几条任务摘要,默认 3" },
      },
    },
    doc: "返回 kimi 节点档案:{node 配置, health, running, recent:[{task_id,state,summary,duration_ms}]}。用于确认节点在不在、最近派活结果。不依赖执行体直连,任何时候可调。",
  },
];

export const handlers = {
  kimi_info: async (args, ctx) => {
    const list = ctx.nodes.list();
    const node = args.node ? list.find((n) => n.name === args.node) : findNode(ctx.nodes);
    if (!node) return { error: "未找到 kimi 节点", available: list.map((n) => n.name) };
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
      node: { name: node.name, type: node.type, address: node.address ?? null, plugId: node.plugId ?? null, model: node.model ?? null },
      health: ctx.mesh.adapters.get(node.name)?.alive ? "up" : "unknown",
      running: ctx.mesh.store.countRunning(node.name),
      recent,
    };
  },
};
