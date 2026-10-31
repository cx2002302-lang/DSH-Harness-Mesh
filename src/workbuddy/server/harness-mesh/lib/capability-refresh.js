/** 节点能力识别守护:定期探测各节点真实模型清单,写回 nodes.json。
 *
 *  背景:节点背后的 harness 会上线/下线模型(如 wb 上线新 coding 模型),
 *  但 nodes.json 里的 models 白名单是 GUI 探测时的静态快照 → 注册表漂移 →
 *  model-bridge 映射失真、dispatch 白名单误拒。本模块复用 mesh.probeModels
 *  (ACP session/new 探测)周期轮巡,把最新 modelId 数组写回 NodesStore。
 *
 *  纪律:
 *  - 只有 adapter 支持 listModels 才探(mesh.probeModels 对不支持的类型抛错,识别后静默跳过);
 *  - 单节点探测 45s 超时,单节点失败不影响其他节点;
 *  - 失败只记 capability.lastProbeError/lastProbeAt,绝不覆盖已探到的 models;
 *  - 连续失败 3 次降频到每 5 轮一探(成功即恢复正常频率);
 *  - fake-*(测试桩)节点不探。
 */
const PROBE_TIMEOUT_MS = 45_000;   // 单节点探测超时
const FAIL_THRESHOLD = 3;          // 连续失败 N 次进入降频
const SLOW_EVERY = 5;              // 降频后每 N 轮一探
const UNSUPPORTED_RE = /不支持模型探测/; // mesh.probeModels 对无 listModels 适配器的报错

function nowIso() {
  return new Date().toISOString();
}

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`探测超时(${ms}ms)`)), ms);
  });
  if (timer?.unref) timer.unref();
  return Promise.race([promise, timeout]);
}

/** @returns {() => void} dispose(停定时器) */
export function startCapabilityRefresh({ mesh, nodesStore, intervalMs = 300_000, log = console.log, isNodeLive = null, enable = true, autoCurate = true }) {
  if (enable === false) return () => {};
  /** name → { failStreak, nextAllowedRound } */
  const state = new Map();
  let round = 0;
  let timer = null;
  let stopped = false;

  function stOf(name) {
    let st = state.get(name);
    if (!st) {
      st = { failStreak: 0, nextAllowedRound: 0 };
      state.set(name, st);
    }
    return st;
  }

  function writeBack(name, patch) {
    if (typeof nodesStore?.update !== "function") return;
    try {
      nodesStore.update(name, patch);
    } catch (error) {
      log(`[harness-mesh:capability-refresh] 节点 ${name} 状态写回失败: ${String(error?.message ?? error)}`);
    }
  }

  async function probeNode(node) {
    const name = node.name;
    const st = stOf(name);
    let result;
    try {
      result = await withTimeout(mesh.probeModels(name), PROBE_TIMEOUT_MS);
    } catch (error) {
      const message = String(error?.message ?? error);
      if (UNSUPPORTED_RE.test(message)) {
        st.unsupported = true;
        return; // 适配器不支持 listModels:不算失败,也不降频
      }
      st.failStreak += 1;
      if (st.failStreak >= FAIL_THRESHOLD) st.nextAllowedRound = round + SLOW_EVERY;
      writeBack(name, { capability: { lastProbeError: message, lastProbeAt: nowIso() } });
      log(`[harness-mesh:capability-refresh] 节点 ${name} 探测失败(连续 ${st.failStreak} 次${st.failStreak >= FAIL_THRESHOLD ? ",已降频" : ""}): ${message}`);
      return;
    }
    // 成功:提取 modelId 数组——只写 liveModels(实况),绝不覆盖用户策展的 models(2026-10-29 事故修正:
    // 曾全量覆盖策展白名单 → 桥把全量实况灌进模型目录/派发白名单失守)。唯一例外:节点从无 models 字段时
    // 首次探测用实况播种(引导态),之后永不覆盖。
    const live = [...new Set((result?.models ?? [])
      .map((m) => (typeof m === "string" ? m : m?.modelId))
      .filter((id) => typeof id === "string" && id.trim())
      .map((id) => id.trim()))].sort();
    const prevLive = Array.isArray(node.liveModels) ? node.liveModels : [];
    const curated = Array.isArray(node.models) ? node.models : null;
    const liveChanged = JSON.stringify(prevLive) !== JSON.stringify(live);
    const pending = live.filter((m) => !(curated ?? []).includes(m));       // 实况有、策展无 → 待策展
    const missing = (curated ?? []).filter((m) => !live.includes(m));       // 策展有、实况无 → 已失效
    // 自动策展:节点级 autoCurate 显式设置优先(true/false),否则跟随全局默认(autoCurate 入参,默认 true)。
    // 生效 = 实况全量覆盖该节点 models(实况即策展);节点 autoCurate===false → 维持 09 保护语义(只写 liveModels)。
    const nodeAutoCurate = node.autoCurate === false ? false : (node.autoCurate === true ? true : autoCurate);
    st.failStreak = 0;
    st.nextAllowedRound = 0;
    const hadError = Boolean(node.capability?.lastProbeError);
    const modelsDiffers = curated === null || JSON.stringify(curated) !== JSON.stringify(live);
    const patch = { liveModels: live, liveProbedAt: nowIso(), capability: { lastProbeError: null, lastProbeAt: nowIso() } };
    // 思考档位/模式探测写回(2026-10-30 思考档位全链):node.thinkingOptions / node.modeOptions
    patch.thinkingOptions = result.thinking ?? null;
    patch.modeOptions = Array.isArray(result.modes) ? result.modes : [];
    const thinkingChanged = JSON.stringify(node.thinkingOptions ?? null) !== JSON.stringify(patch.thinkingOptions);
    const modesChanged = JSON.stringify(node.modeOptions ?? []) !== JSON.stringify(patch.modeOptions);
    if (curated === null || nodeAutoCurate) patch.models = live; // 引导播种 或 自动策展:实况即策展
    if (liveChanged || hadError || curated === null || (nodeAutoCurate && modelsDiffers) || thinkingChanged || modesChanged) writeBack(name, patch);
    if (liveChanged) {
      log(`[harness-mesh:capability-refresh] 节点 ${name} 实况刷新:${live.length} 个;待策展 ${pending.length} 个;策展失效 ${missing.length} 个`);
      if (pending.length) log(`[harness-mesh:capability-refresh] ${name} 网格新模型待策展:[${pending.join(", ")}]`);
      if (missing.length) log(`[harness-mesh:capability-refresh] ${name} 策展模型实况缺席:[${missing.join(", ")}]`);
      if (nodeAutoCurate) log(`[harness-mesh:capability-refresh] ${name} 自动策展:models 已同步 ${live.length} 个`);
    }
  }

  async function tick() {
    round += 1;
    for (const node of nodesStore.list()) {
      if (stopped) return;
      const name = node?.name ?? "";
      if (!name || /^fake/i.test(name)) continue;          // 测试桩不探
      if (isNodeLive && !isNodeLive(node)) continue;       // 调用方判定不在线(如适配器已断连)
      const st = stOf(name);
      if (st.unsupported) continue;                         // 已知不支持 listModels,不再试
      if (st.failStreak >= FAIL_THRESHOLD && round < st.nextAllowedRound) continue; // 降频窗口内跳过
      try {
        await probeNode(node);
      } catch (error) {
        // probeNode 内部已兜错;这里防御外层意外,保证其他节点继续
        log(`[harness-mesh:capability-refresh] 节点 ${name} 轮巡异常(跳过): ${String(error?.message ?? error)}`);
      }
    }
  }

  function schedule() {
    timer = setTimeout(async () => {
      await tick();
      if (!stopped) schedule();
    }, intervalMs);
    if (timer?.unref) timer.unref();
  }
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
