/** harness-mesh 模型桥(网关模式:mesh → llm-pi-ai 供应商目录自动同步)。
 *
 *  2026-10-30 再拍板(主控):不要"前缀名猜供应商、猜不中静默丢"的间接桥——
 *  mesh GUI 勾选列表与 DSB 供应商列表严格 1:1、动态联动。架构:mesh 插件自身开
 *  OpenAI 兼容网关(lib/llm-gateway.js),每个节点一条供应商条目,勾选的模型
 *  原样发布(不去重映射、不过滤、保持顺序),调用经网关派发给节点 harness
 *  执行(用节点自己的账号)。
 *
 *  条目形状:displayName `网格 · <节点原名>`、api "openai-completions"、
 *  baseURL `http://127.0.0.1:80/api/harness-mesh/llm/<URL编码节点名>/v1`、
 *  apiKeyEnv "MESH_MCP_TOKEN"(网关鉴权同一 token)。无勾选模型的节点不出条目;
 *  旧 per-(节点×供应商) id 靠 managed 状态对齐自动清掉;只动 mesh-* 前缀
 *  (foreign 保护:用户手工配置不碰)。
 *
 *  本模块监听 nodes.json,变化时经 ctx.settings.mutate("llm-pi-ai", ops) 热写
 *  providers(volatile 配置,写入即热生效,不用重启)。节点增删/勾选变更 →
 *  下拉框自动跟随。
 */
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const GATEWAY_ORIGIN = "http://127.0.0.1:80/api/harness-mesh/llm";

/** llm-pi-ai reasoningEfforts 枚举(大小写不敏感收档;收不下的跳过并记日志)。 */
const REASONING_EFFORT_KEYS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "off"]);

/** ACP 档位值 → pi-ai 枚举键别名(语义对齐:qoder 的 none 即 pi-ai 的 off)。 */
const REASONING_KEY_ALIASES = { none: "off" };

/** 节点思考档位 → llm-pi-ai model.reasoningEfforts(纯函数,便于单测)。
 *  键 = 枚举名(小写,别名归一),wire 值 = ACP value 原样;枚举外的档位进 skipped。
 * @returns {{ efforts: Record<string, string>, skipped: string[] }} */
export function computeReasoningEfforts(thinkingOptions) {
  const efforts = {};
  const skipped = [];
  for (const o of Array.isArray(thinkingOptions?.options) ? thinkingOptions.options : []) {
    const value = typeof o === "string" ? o : o?.value;
    if (typeof value !== "string" || !value.trim()) continue;
    const raw = value.trim().toLowerCase();
    const key = REASONING_KEY_ALIASES[raw] ?? raw;
    if (!REASONING_EFFORT_KEYS.has(key)) {
      skipped.push(value);
      continue;
    }
    efforts[key] = value; // wire 值 = ACP value 原样(如键 off 值 "none")
  }
  return { efforts, skipped };
}

/** 节点名 → id slug:全小写,非法字符转 -(仅 displayName/baseURL 保留节点原名)。 */
function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "node";
}

/** 把节点清单换算成 llm-pi-ai providers 补丁(纯函数,便于单测)。
 *  网关模式:每节点至多一条 mesh-<节点slug>;models = 节点勾选名单原样。
 * @param {Array<object>} nodes - NodesStore.list() 的形状
 * @param {Record<string, string|undefined>} _env - 兼容旧签名(网关模式不看凭据)
 * @returns {{ providers: Record<string, object>, sources: Record<string, string[]>, skipped: Array<{node: string, reason: string}> }} */
export function computeProviders(nodes, _env = process.env, log = () => {}) {
  const providers = {};
  const sources = {};
  const skipped = [];
  for (const node of nodes ?? []) {
    const nodeName = node?.name ?? "";
    if (!nodeName || /^fake/i.test(nodeName)) continue; // 测试桩不进目录
    const models = Array.isArray(node.models) ? node.models.filter((m) => typeof m === "string" && m.trim()) : [];
    if (!models.length) {
      skipped.push({ node: nodeName, reason: "无勾选模型(在节点管理勾选后自动出条目)" });
      continue;
    }
    const id = `mesh-${slugify(nodeName)}`;
    // 思考档位声明(2026-10-30 思考档位全链):节点探出 thinkingOptions 时,该节点
    // provider 条目每个 model 声明 reasoningEfforts(枚举内收档;DSH resolveModelInfo
    // 据此自动产出 reasoning.efforts,DSB 目录/思考菜单零改动点亮)。
    const { efforts, skipped: effortSkipped } = computeReasoningEfforts(node.thinkingOptions);
    for (const value of effortSkipped) {
      log(`[harness-mesh:model-bridge] 节点 ${nodeName} 思考档位 "${value}" 不在 reasoningEfforts 枚举,跳过`);
    }
    const withEfforts = Object.keys(efforts).length > 0;
    const entry = {
      api: "openai-completions",
      baseURL: `${GATEWAY_ORIGIN}/${encodeURIComponent(nodeName)}/v1`,
      apiKeyEnv: "MESH_MCP_TOKEN",
      displayName: `网格 · ${nodeName}`,
      models: models.map((mid) => (withEfforts ? { id: mid, reasoningEfforts: { ...efforts } } : { id: mid })), // 勾选名单原样:不排序、不去重映射、不过滤
    };
    providers[id] = entry;
    sources[id] = [nodeName];
  }
  return { providers, sources, skipped };
}

function loadState(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return {
      managed: Array.isArray(data?.managed) ? data.managed.filter((x) => typeof x === "string") : [],
      applied: data?.applied && typeof data.applied === "object" ? data.applied : {},
      sources: data?.sources && typeof data.sources === "object" ? data.sources : {},
    };
  } catch {
    return { managed: [], applied: {}, sources: {} };
  }
}

function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** 启动模型桥:盯 nodesFile,变化时把 providers 补丁热写进 llm-pi-ai。
 *  供应商 id 用 mesh- 前缀,与用户手工配置不撞名,foreign 保护不变。
 * @returns {() => void} dispose(停 watch + 清定时器;不回收已写入的 providers——那是用户可见配置) */
export function startModelBridge(ctx, nodesFile, nodesList, stateDir, log = console.log, env = process.env) {
  if (!ctx?.settings?.mutate) {
    log("[harness-mesh:model-bridge] 本实例缺 settings 服务,桥接不激活");
    return () => {};
  }
  const stateFile = join(stateDir, "model-bridge.json");
  const state = loadState(stateFile);
  let timer = null;
  let running = false;
  let queued = false;

  async function reconcile() {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      const { providers, sources, skipped } = computeProviders(nodesList(), env, log);
      for (const s of skipped) log(`[harness-mesh:model-bridge] 跳过 ${s.node}: ${s.reason}`);
      const ops = [];
      const nextManaged = [];
      const nextApplied = {};
      const nextSources = {};
      for (const [id, entry] of Object.entries(providers)) {
        nextManaged.push(id);
        if (JSON.stringify(state.applied[id]) !== JSON.stringify(entry)) {
          ops.push({ op: "set", path: ["providers", id], value: entry });
        }
        nextApplied[id] = entry;
        nextSources[id] = sources[id] ?? []; // 节点来源留档状态文件
      }
      for (const id of state.managed) {
        if (!nextManaged.includes(id)) ops.push({ op: "unset", path: ["providers", id] });
      }
      if (ops.length) {
        await ctx.settings.mutate("llm-pi-ai", ops);
        log(`[harness-mesh:model-bridge] 已同步 ${nextManaged.length} 个供应商: ${nextManaged.join(", ") || "(空)"}`);
      }
      if (ops.length || JSON.stringify(state.sources) !== JSON.stringify(nextSources)) {
        state.managed = nextManaged;
        state.applied = nextApplied;
        state.sources = nextSources;
        saveState(stateFile, state);
      }
    } catch (error) {
      log(`[harness-mesh:model-bridge] 同步失败(下轮重试): ${error?.message ?? error}`);
    } finally {
      running = false;
      if (queued) {
        queued = false;
        void reconcile();
      }
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void reconcile(), 400);
  }

  let watcher = null;
  if (existsSync(nodesFile)) {
    // NodesStore 直写文件(非原子 rename),盯文件即可
    watcher = watch(nodesFile, { persistent: false }, schedule);
  } else {
    log(`[harness-mesh:model-bridge] ${nodesFile} 不存在,仅启动时对齐一次`);
  }
  void reconcile();
  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}
