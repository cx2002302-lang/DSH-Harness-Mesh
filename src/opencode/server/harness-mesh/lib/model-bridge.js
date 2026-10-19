/** harness-mesh 模型桥(mesh → llm-pi-ai 供应商目录自动同步)。
 *
 *  背景:mesh 适配的是 harness(任务级编排),节点背后的模型全是标准 LLM API。
 *  要让 DSB/DSH 的"模型配置"下拉框能用这些模型,正确姿势是把节点映射成
 *  llm-pi-ai 的 provider 条目——而不是把 harness 包成假模型端点(会截断
 *  流式与 tool_calls)。
 *
 *  本模块监听 nodes.json,把节点清单换算成 providers 补丁,经
 *  ctx.settings.mutate("llm-pi-ai", ops) 写入;llm-pi-ai 的 providers 是
 *  volatile 配置,写入即热生效(loader/volatile-update → 重注册路由+目录),
 *  不用重启。节点增删/固定模型变更 → 下拉框自动跟随。
 *
 *  纪律:
 *  - 只动自己管理过的 provider id;用户手工配的同名片段永不覆盖;
 *  - 凭据环境变量缺失的供应商跳过并在日志点名(不注册"看着能用实则 401"的条目);
 *  - fake-*(测试桩)节点不进模型目录。
 */
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 网格节点 → llm 供应商路由 的映射表。
 *  apiKeyEnv 按顺序取第一个存在于进程环境的环境变量。 */
const PROVIDERS = {
  "opencode-go": { label: "opencode Zen", apiKeyEnv: ["DSH_OPENCODE_API_KEY"] },
  "kimi-coding": { label: "Kimi Coding", apiKeyEnv: ["KIMI_CODING_API_KEY", "KIMI_API_KEY"] },
  "zai-coding-cn": { label: "Z.AI Coding", apiKeyEnv: ["ZAI_CODING_CN_API_KEY", "DSH_ZAI_API_KEY"] },
  minimax: { label: "MiniMax", apiKeyEnv: ["DSH_MINIMAX_API_KEY"] },
  deepseek: { label: "DeepSeek", apiKeyEnv: ["DSH_DEEPSEEK_API_KEY"] },
};

/** node.model 的供应商前缀(opencode/kimi/...)→ llm 供应商路由 id。 */
const MODEL_PREFIX = {
  opencode: "opencode-go",
  "opencode-go": "opencode-go",
  kimi: "kimi-coding",
  "kimi-coding": "kimi-coding",
  glm: "zai-coding-cn",
  zai: "zai-coding-cn",
  "zai-coding-cn": "zai-coding-cn",
  minimax: "minimax",
  deepseek: "deepseek",
};

/** 无固定模型的节点,按名字/插头/命令猜底层模型供应商。 */
const NAME_HINT = [
  [/kimi/i, "kimi-coding"],
  [/zcode|zai/i, "zai-coding-cn"],
  [/opencode/i, "opencode-go"],
  [/workbuddy|wb[-_]?ui/i, "minimax"],
];

/** 把节点清单换算成 llm-pi-ai providers 补丁(纯函数,便于单测)。
 * @param {Array<object>} nodes - NodesStore.list() 的形状
 * @param {Record<string, string|undefined>} env - 凭据查找环境(默认 process.env)
 * @returns {{ providers: Record<string, object>, skipped: Array<{node: string, provider?: string, reason: string}> }} */
export function computeProviders(nodes, env = process.env) {
  const acc = new Map(); // providerId -> { envName, nodes: [], pinned: Set }
  const skipped = [];
  for (const node of nodes ?? []) {
    const nodeName = node?.name ?? "";
    if (!nodeName || /^fake/i.test(nodeName)) continue; // 测试桩不进目录
    let provider = null;
    let pinned = null;
    if (typeof node.model === "string" && node.model.includes("/")) {
      const [prefix, ...rest] = node.model.split("/");
      provider = MODEL_PREFIX[prefix] ?? null;
      pinned = rest.join("/") || null;
    }
    if (!provider) {
      const haystack = `${nodeName} ${node.plugId ?? ""} ${node.command ?? ""}`;
      provider = NAME_HINT.find(([re]) => re.test(haystack))?.[1] ?? null;
    }
    if (!provider || !PROVIDERS[provider]) {
      skipped.push({ node: nodeName, reason: "无供应商映射" });
      continue;
    }
    const envName = PROVIDERS[provider].apiKeyEnv.find((key) => env[key]);
    if (!envName) {
      skipped.push({ node: nodeName, provider, reason: `缺少凭据(${PROVIDERS[provider].apiKeyEnv.join(" 或 ")})` });
      continue;
    }
    if (!acc.has(provider)) acc.set(provider, { envName, nodes: [], pinned: new Set() });
    const slot = acc.get(provider);
    slot.nodes.push(nodeName);
    if (pinned) slot.pinned.add(pinned);
  }
  const providers = {};
  for (const [id, slot] of [...acc.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    providers[id] = {
      apiKeyEnv: slot.envName,
      displayName: `网格 · ${PROVIDERS[id].label}(${slot.nodes.sort().join("/")})`,
      // 有节点固定了模型 → 目录聚焦到固定模型;全无固定 → 不给 models,用供应商内置目录
      ...(slot.pinned.size ? { models: [...slot.pinned].sort().map((mid) => ({ id: mid })) } : {}),
    };
  }
  return { providers, skipped };
}

function loadState(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return {
      managed: Array.isArray(data?.managed) ? data.managed.filter((x) => typeof x === "string") : [],
      applied: data?.applied && typeof data.applied === "object" ? data.applied : {},
    };
  } catch {
    return { managed: [], applied: {} };
  }
}

function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** 启动模型桥:盯 nodesFile,变化时把 providers 补丁热写进 llm-pi-ai。
 * @returns {() => void} dispose(停 watch + 清定时器;不回收已写入的 providers——那是用户可见配置) */
export function startModelBridge(ctx, nodesFile, nodesList, stateDir, log = console.log, env = process.env) {
  if (!ctx?.settings?.mutate || !ctx?.settings?.describe) {
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
      const { providers, skipped } = computeProviders(nodesList(), env);
      for (const s of skipped) log(`[harness-mesh:model-bridge] 跳过 ${s.node}: ${s.reason}`);
      const managed = new Set(state.managed);
      // 谁已被手工配置:读 llm-pi-ai 的活配置(只取 providers 的键,不碰值/凭据)。
      // 注意不能用 ctx.llm.listConfigurableProviders()——它把 41 个内置目录供应商全列出来,分不清"目录休眠条目"和"用户已配置"。
      const descriptor = ctx.settings.describe().find((d) => d.ns === "llm-pi-ai");
      const configuredIds = Object.keys(descriptor?.value?.providers ?? {});
      const foreign = new Set(configuredIds.filter((id) => !managed.has(id)));
      const ops = [];
      const nextManaged = [];
      const nextApplied = {};
      for (const [id, entry] of Object.entries(providers)) {
        if (foreign.has(id)) {
          log(`[harness-mesh:model-bridge] ${id} 已有手工配置,跳过不覆盖`);
          continue;
        }
        nextManaged.push(id);
        if (JSON.stringify(state.applied[id]) !== JSON.stringify(entry)) {
          ops.push({ op: "set", path: ["providers", id], value: entry });
        }
        nextApplied[id] = entry;
      }
      for (const id of state.managed) {
        if (!nextManaged.includes(id)) ops.push({ op: "unset", path: ["providers", id] });
      }
      if (!ops.length) return;
      await ctx.settings.mutate("llm-pi-ai", ops);
      state.managed = nextManaged;
      state.applied = nextApplied;
      saveState(stateFile, state);
      log(`[harness-mesh:model-bridge] 已同步 ${nextManaged.length} 个供应商: ${nextManaged.join(", ") || "(空)"}`);
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
