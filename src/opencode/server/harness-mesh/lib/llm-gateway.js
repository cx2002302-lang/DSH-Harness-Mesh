/** harness-mesh LLM 网关(OpenAI 兼容,每节点一条路由)。
 *
 *  2026-10-30 拍板:mesh GUI 勾选列表与 DSB 供应商严格 1:1 动态联动——
 *  模型桥(model-bridge.js 网关模式)把每个节点发布成一条 DSB 供应商条目,
 *  baseURL 指回本网关;调用经网关鉴权后派发给节点 harness 执行(用节点自己的
 *  账号/模型勾选),不再"前缀猜供应商、猜不中静默丢"。
 *
 *  路由(每节点两条,注册表精确匹配,随 nodes.json 热同步):
 *  - POST /api/harness-mesh/llm/<节点名>/v1/chat/completions  OpenAI 兼容(非流式)
 *  - GET  /api/harness-mesh/llm/<节点名>/v1/models            该节点勾选名单
 *
 *  鉴权:Authorization: Bearer <MESH_MCP_TOKEN>(与 /api/mcp/harness-mesh 同一
 *  token,env 读;时序安全比较;未设置 → 通道关闭 401)。
 */
import { existsSync, watch } from "node:fs";
import { timingSafeEqual } from "node:crypto";

const BASE_PATH = "/api/harness-mesh/llm";
const TERMINAL_STATES = new Set(["succeeded", "failed", "timeout", "cancelled"]);
const DEFAULT_TIMEOUT_MS = 300_000;

/** 节点 thinkingOptions 的 options 值(字符串/对象兼容)。 */
function optionValues(thinkingOptions) {
  return (Array.isArray(thinkingOptions?.options) ? thinkingOptions.options : [])
    .map((o) => (typeof o === "string" ? o : o?.value))
    .filter((v) => typeof v === "string" && v);
}

/** 请求档位 → 节点 thinkingOptions 里的合法档位值(精确命中;大小写不敏感回配,回配取节点原值)。
 * @returns {string|null} 非法/节点不支持 → null(调用方回 400)。 */
export function resolveThinkingValue(effort, thinkingOptions) {
  if (typeof effort !== "string") return null;
  const key = effort.trim();
  if (!key) return null;
  const values = optionValues(thinkingOptions);
  if (values.includes(key)) return key;
  const lower = key.toLowerCase();
  return values.find((v) => v.toLowerCase() === lower) ?? null;
}

/** messages → 纯文本 prompt:system + user 按序拼接(其余角色丢弃)。
 *  content 兼容 string 与 OpenAI 分段数组(取 text 段)。 */
export function buildPrompt(messages) {
  const parts = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    const role = String(msg?.role ?? "");
    if (role !== "system" && role !== "user") continue;
    const content = msg?.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) text = content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("");
    if (text.trim()) parts.push(text.trim());
  }
  return parts.join("\n\n");
}

/** Bearer 校验:合法返回 undefined,否则返回拒绝原因。 */
function bearerRejection(request) {
  const expected = process.env.MESH_MCP_TOKEN ?? "";
  if (expected === "") return "unauthorized: MESH_MCP_TOKEN 未设置,网关通道关闭";
  const got = /^Bearer\s+(.+)$/s.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  if (got.length !== expected.length ||
      !timingSafeEqual(Buffer.from(got, "utf8"), Buffer.from(expected, "utf8"))) {
    return "unauthorized: invalid bearer token";
  }
  return undefined;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 启动网关:为当前节点清单注册路由,nodes.json 变化时热同步(增/删/改名)。
 * @returns {() => void} dispose(停 watch + 反注册全部路由) */
export function startLlmGateway(ctx, mesh, nodes, nodesFile, log = console.log, options = {}) {
  const pollMs = options.pollMs ?? 500;
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const registered = new Map(); // path → dispose

  const chatPath = (name) => `${BASE_PATH}/${encodeURIComponent(name)}/v1/chat/completions`;
  const modelsPath = (name) => `${BASE_PATH}/${encodeURIComponent(name)}/v1/models`;

  async function handleChat(request, nodeName) {
    const reject = bearerRejection(request);
    if (reject !== undefined) return json({ error: { message: reject, type: "invalid_request_error" } }, 401);
    const node = nodes.get(nodeName);
    if (!node) return json({ error: { message: `harness-mesh: 节点 "${nodeName}" 不存在`, type: "invalid_request_error" } }, 404);
    const whitelist = Array.isArray(node.models) ? node.models.filter((m) => typeof m === "string" && m.trim()) : [];
    let body = {};
    try { body = await request.json(); } catch { /* 空 body 走下面的校验 */ }
    const model = typeof body?.model === "string" ? body.model : "";
    if (!model || !whitelist.includes(model)) {
      return json({ error: { message: `harness-mesh: 节点 "${nodeName}" 不允许模型 "${model || "(空)"}";可用: ${whitelist.join(", ") || "(无,先在节点管理勾选)"}(在节点管理勾选调整)`, type: "invalid_request_error" } }, 400);
    }
    const prompt = buildPrompt(body?.messages);
    if (!prompt) return json({ error: { message: "harness-mesh: messages 里没有可用的 system/user 文本", type: "invalid_request_error" } }, 400);
    // 思考档位透传(2026-10-30 思考档位全链):body.reasoning_effort 或 body.reasoning.effort
    // → 节点 thinkingOptions 里合法 → dispatch 带 thinking:{value};节点不支持/值非法 → 400(列可用档位)。
    const rawEffort = typeof body?.reasoning_effort === "string" ? body.reasoning_effort
      : (typeof body?.reasoning?.effort === "string" ? body.reasoning.effort : null);
    let thinking;
    if (rawEffort !== null) {
      const options = optionValues(node.thinkingOptions);
      const value = resolveThinkingValue(rawEffort, node.thinkingOptions);
      if (!value) {
        return json({
          error: {
            message: options.length
              ? `harness-mesh: 节点 "${nodeName}" 不支持思考档位 "${rawEffort}";可用: ${options.join(", ")}`
              : `harness-mesh: 节点 "${nodeName}" 不支持思考档位(未探测出 thinkingOptions)`,
            type: "invalid_request_error",
          },
        }, 400);
      }
      thinking = { value }; // 形如 {value:"high"};configId 由适配器在 session/new 时补
    }
    const timeoutMs = Number.isFinite(body?.timeout_ms) && body.timeout_ms > 0 ? body.timeout_ms : DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const kill = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let task = await mesh.dispatch({ harness: nodeName, prompt, model, timeoutMs, signal: controller.signal, origin: "llm-gateway", thinking });
      let status = null;
      while (!TERMINAL_STATES.has(status?.state)) {
        await delay(pollMs);
        status = mesh.status(task.task_id);
      }
      // 兜底:节点引擎不支持按会话选模型(如 zcode -p)→ 去掉 model 用节点默认模型重派一次
      if (status.state === "failed" && /不支持按会话选模型/.test(status.error ?? "")) {
        log(`[harness-mesh:llm-gateway] 节点 ${nodeName} 不支持会话选模型,改用节点默认模型重派`);
        task = await mesh.dispatch({ harness: nodeName, prompt, timeoutMs, signal: controller.signal, origin: "llm-gateway", thinking });
        status = null;
        while (!TERMINAL_STATES.has(status?.state)) {
          await delay(pollMs);
          status = mesh.status(task.task_id);
        }
      }
      if (status.state !== "succeeded") {
        throw new Error(`任务 ${task.task_id} 终态 ${status.state}${status.error ? `: ${status.error}` : ""}`);
      }
      const report = mesh.result(task.task_id);
      return json({
        id: `chatcmpl-${task.task_id}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: "assistant", content: report.summary ?? "" }, finish_reason: "stop" }],
        usage: null,
      });
    } catch (error) {
      log(`[harness-mesh:llm-gateway] 节点 ${nodeName} 派发失败: ${String(error?.message ?? error)}`);
      return json({ error: { message: `harness-mesh: 派发失败(${String(error?.message ?? error)})`, type: "mesh_dispatch_error" } }, 502);
    } finally {
      clearTimeout(kill);
    }
  }

  function handleModels(request, nodeName) {
    const reject = bearerRejection(request);
    if (reject !== undefined) return json({ error: { message: reject, type: "invalid_request_error" } }, 401);
    const node = nodes.get(nodeName);
    if (!node) return json({ error: { message: `harness-mesh: 节点 "${nodeName}" 不存在`, type: "invalid_request_error" } }, 404);
    const whitelist = Array.isArray(node.models) ? node.models.filter((m) => typeof m === "string" && m.trim()) : [];
    return json({ object: "list", data: whitelist.map((id) => ({ id, object: "model", owned_by: "harness-mesh" })) });
  }

  /** 路由表热同步:精确匹配注册表,节点增删/改名时增减路由。 */
  function syncRoutes() {
    const wanted = new Map();
    for (const node of nodes.list()) {
      if (/^fake/i.test(node?.name ?? "")) continue; // 测试桩不暴露网关
      wanted.set(chatPath(node.name), { fetch: (req, url) => handleChat(req, node.name), methods: ["POST"] });
      wanted.set(modelsPath(node.name), { fetch: (req, url) => handleModels(req, node.name), methods: ["GET"] });
    }
    for (const [path, dispose] of registered) {
      if (!wanted.has(path)) {
        void dispose();
        registered.delete(path);
        log(`[harness-mesh:llm-gateway] 反注册 ${path}`);
      }
    }
    for (const [path, spec] of wanted) {
      if (registered.has(path)) continue;
      const dispose = ctx.connection.fetch.register({ path, methods: spec.methods, requestBody: "buffered", fetch: spec.fetch });
      registered.set(path, dispose);
      log(`[harness-mesh:llm-gateway] 注册 ${path}`);
    }
  }

  syncRoutes();
  let timer = null;
  let watcher = existsSync(nodesFile)
    ? watch(nodesFile, { persistent: false }, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(syncRoutes, 400); // NodesStore 直写非原子,防抖
      })
    : null;
  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
    for (const dispose of registered.values()) void dispose();
    registered.clear();
  };
}
