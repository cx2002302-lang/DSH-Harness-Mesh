/** harness-mesh 配置规范化:把 patch 配置段里的节点清单整理成内部结构。
 *
 *  非法配置在插件加载期直接抛错(加载失败 = 该插件不激活,不影响 DSH 其他部分),
 *  防止把错配置带进运行期。
 */

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const TYPES = ["acp-stdio", "acp-ssh", "acp-plug", "cli-oneshot"];

/** 思考档位/模式配置归一化(ACP 探测出 thought_level/mode configOption,2026-10-30 思考档位全链):
 *  {id,name,currentValue,options:[{value,name}]}|null;options 非法条目剔除,全空 → null。 */
export function normalizeThinkingOptions(value) {
  if (!value || typeof value !== "object") return null;
  const options = (Array.isArray(value.options) ? value.options : [])
    .map((o) => {
      if (typeof o === "string" && o.trim()) return { value: o.trim(), name: o.trim() };
      if (o && typeof o === "object" && typeof o.value === "string" && o.value.trim()) {
        return { value: o.value.trim(), name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : o.value.trim() };
      }
      return null;
    })
    .filter(Boolean);
  if (!options.length) return null;
  return {
    id: typeof value.id === "string" && value.id ? value.id : null,
    name: typeof value.name === "string" && value.name ? value.name : null,
    currentValue: typeof value.currentValue === "string" && value.currentValue ? value.currentValue : null,
    options,
  };
}

/** 模式列表归一化:每项都是一份 thinkingOptions 形配置;非法项剔除。@returns {Array<object>} */
export function normalizeModeOptions(value) {
  return (Array.isArray(value) ? value : [])
    .map((m) => normalizeThinkingOptions(m))
    .filter(Boolean);
}

/** 规范化并校验单个节点(patch 种子、nodes.json、GUI 表单三条来路共用)。
 * @returns 规范化后的节点对象;非法时抛错。 */
export function validateNode(name, entry) {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`harness-mesh: 节点名 "${name}" 非法(仅限 1-32 位字母/数字/_/-)`);
  }
  if (!TYPES.includes(entry.type)) {
    throw new Error(`harness-mesh: 节点 "${name}" 类型 "${entry.type}" 不支持(可选: ${TYPES.join(" / ")})`);
  }
  if (entry.type === "acp-plug") {
    // 插头节点:连被控机 harnessd 的 address + 该机上的 plugId;command 由远端 plugs.json 定义
    if (!/^[^:\s]+:\d+$/.test(entry.address ?? "")) {
      throw new Error(`harness-mesh: 节点 "${name}" 是 acp-plug 类型,缺少 address(host:port,如 <tailnet-ip>:7080)`);
    }
    if (!entry.plugId) {
      throw new Error(`harness-mesh: 节点 "${name}" 是 acp-plug 类型,缺少 plugId(被控机 plugs.json 里的插头名)`);
    }
  } else if (!entry.command) {
    throw new Error(`harness-mesh: 节点 "${name}" 缺少 command`);
  }
  if (entry.type === "acp-ssh" && !entry.ssh) {
    throw new Error(`harness-mesh: 节点 "${name}" 是 acp-ssh 类型,缺少 ssh 目标(如 user@your-host)`);
  }
  return {
    name,
    type: entry.type,
    command: entry.command ?? "",
    args: [...(entry.args ?? [])],
    ssh: entry.ssh ?? null,
    /** acp-plug:被控机 harnessd 地址(host:port) */
    address: entry.address ?? null,
    /** acp-plug:被控机 plugs.json 里的插头名 */
    plugId: entry.plugId ?? null,
    /** acp-plug:零 root 兜底——经本机 ann-agent SOCKS5 拨号(如 127.0.0.1:11080);空=系统路由直连 */
    socks: entry.socks ?? null,
    cwd: entry.cwd ?? null,
    env: { ...(entry.env ?? {}) },
    /** 固定模型(如 opencode/deepseek-v4.1-flash);空 = 用被控 harness 默认 */
    model: entry.model ?? null,
    /** 可用模型白名单(2026-10-20,模型探测+勾选):空 = 不限制;非空 = dispatch 模型覆盖必须在名单内。
     *  上限 160:autoCurate 自动同步实况时单节点可达 128+(2026-10-29 截断事故:zai/* 按字母序被切掉)。 */
    models: Array.isArray(entry.models) ? entry.models.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim()).slice(0, 160) : [],
    /** 能力探测状态(capability-refresh 守护写入):lastProbeAt/lastProbeError;不影响 models */
    capability: entry.capability && typeof entry.capability === "object" ? { ...entry.capability } : null,
    /** 实况模型清单(capability-refresh 探测写回,只读参考;发布/派发只吃策展 models) */
    liveModels: Array.isArray(entry.liveModels) ? entry.liveModels.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim()).slice(0, 128) : [],
    liveProbedAt: typeof entry.liveProbedAt === "string" ? entry.liveProbedAt : null,
    /** 自动策展(实况即策展):true/false 显式覆盖;null = 跟随全局 capabilityRefresh.autoCurate(默认 true) */
    autoCurate: entry.autoCurate === false ? false : (entry.autoCurate === true ? true : null),
    /** 思考档位(capability-refresh 探测写回,2026-10-30 思考档位全链):
     *  {id,name,currentValue,options:[{value,name}]}|null;兼容旧字段名 thinking。 */
    thinkingOptions: normalizeThinkingOptions(entry.thinkingOptions ?? entry.thinking),
    /** 模式列表(同探测来源,同形数组);兼容旧字段名 modes。 */
    modeOptions: normalizeModeOptions(entry.modeOptions ?? entry.modes),
    description: entry.description ?? "",
  };
}

/**
 * @param config - 经 schemastery 校验后的插件配置
 * @returns {{ defaultTimeoutMs: number, harnesses: Record<string, object>, modelBridge: { enable: boolean }, capabilityRefresh: { enable: boolean, intervalMs: number, autoCurate: boolean } }}
 */
export function normalizeConfig(config) {
  const harnesses = {};
  for (const [name, entry] of Object.entries(config?.harnesses ?? {})) {
    harnesses[name] = validateNode(name, entry);
  }
  return {
    defaultTimeoutMs: config?.defaultTimeoutMs ?? 600000,
    harnesses,
    modelBridge: { enable: config?.modelBridge?.enable === true },
    capabilityRefresh: {
      enable: config?.capabilityRefresh?.enable !== false,
      intervalMs: config?.capabilityRefresh?.intervalMs ?? 300000,
      autoCurate: config?.capabilityRefresh?.autoCurate !== false,
    },
  };
}
