/** HTTP API 层(热路由壳):只注册固定路径,全部处理逻辑在 ./hot.js。
 *  hot.js 以「每请求动态 import + 时间戳查询参数破缓存」方式加载,
 *  改 hot.js 保存即生效,服务端改动零重启。
 *
 *  固定路径:
 *  - GET/POST /api/harness-mesh/nodes     节点全量 / 新增覆盖
 *  - DELETE   /api/harness-mesh/node?name=X
 *  - POST     /api/harness-mesh/dispatch  {harness, prompt, cwd?, timeoutMs?, deny?, origin?}
 *  - GET      /api/harness-mesh/task?task_id=X
 *  - GET      /api/harness-mesh/tasks
 *  - POST     /api/harness-mesh/cancel    {task_id}
 *  - POST     /api/harness-mesh/permission {task_id, allow}
 *  - POST     /api/harness-mesh/ai-config {description}
 *  - POST     /api/mcp/harness-mesh       MCP(Streamable HTTP)JSON-RPC 入口
 */
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export function registerRoutes(ctx, mesh, nodes) {
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const readJson = async (request) => {
    try { return await request.json(); } catch { return {}; }
  };
  /** 热加载 hot.js:按文件 mtime 缓存破坏——文件没变复用模块缓存,变了才重导入。
   *  (2026-10-19 修正:原实现每请求 Date.now() 破缓存,每个请求产生一个新模块实例,
   *   Node 模块缓存只增不减,常驻进程内存缓慢上涨;hot.js 的模块级常量也被每请求重建。) */
  const hotUrl = new URL("./hot.js", import.meta.url);
  const hotPath = fileURLToPath(hotUrl);
  let hotCache = { mtimeMs: -1, mod: null };
  const hot = async () => {
    const { mtimeMs } = await stat(hotPath);
    if (!hotCache.mod || hotCache.mtimeMs !== mtimeMs) {
      hotCache = { mtimeMs, mod: await import(`${hotUrl.href}?t=${mtimeMs}`) };
    }
    return hotCache.mod;
  };
  const make = () => async (request) => {
    try {
      const m = await hot();
      return await m.handle(request, { ctx, mesh, nodes, json, readJson });
    } catch (error) {
      console.error("[harness-mesh] 路由处理异常:", error);
      return json({ ok: false, error: String(error?.message ?? error) }, 500);
    }
  };

  const routes = [
    ["/api/harness-mesh/nodes", ["GET", "POST"]],
    ["/api/harness-mesh/node", ["DELETE"]],
    ["/api/harness-mesh/dispatch", ["POST"]],
    ["/api/harness-mesh/team", ["POST", "GET"]],
    ["/api/harness-mesh/plug-reload", ["POST"]],
    ["/api/harness-mesh/task", ["GET"]],
    ["/api/harness-mesh/tasks", ["GET"]],
    ["/api/harness-mesh/cancel", ["POST"]],
    ["/api/harness-mesh/permission", ["POST"]],
    ["/api/harness-mesh/ai-config", ["POST"]],
    ["/api/mcp/harness-mesh", ["POST", "GET", "DELETE"]],
    ["/api/mcp/harness-mesh-admin", ["POST", "GET", "DELETE"]],
  ];
  const disposers = [];
  for (const [path, methods] of routes) {
    disposers.push(ctx.connection.fetch.register({
      path, methods, requestBody: "buffered",
      fetch: make(),
    }));
  }
  return async () => {
    for (const dispose of disposers) await dispose();
  };
}
