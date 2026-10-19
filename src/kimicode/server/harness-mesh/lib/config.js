/** harness-mesh 配置规范化:把 patch 配置段里的节点清单整理成内部结构。
 *
 *  非法配置在插件加载期直接抛错(加载失败 = 该插件不激活,不影响 DSH 其他部分),
 *  防止把错配置带进运行期。
 */

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const TYPES = ["acp-stdio", "acp-ssh", "acp-plug", "cli-oneshot"];

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
      throw new Error(`harness-mesh: 节点 "${name}" 是 acp-plug 类型,缺少 address(host:port,如 100.64.0.9:7080)`);
    }
    if (!entry.plugId) {
      throw new Error(`harness-mesh: 节点 "${name}" 是 acp-plug 类型,缺少 plugId(被控机 plugs.json 里的插头名)`);
    }
  } else if (!entry.command) {
    throw new Error(`harness-mesh: 节点 "${name}" 缺少 command`);
  }
  if (entry.type === "acp-ssh" && !entry.ssh) {
    throw new Error(`harness-mesh: 节点 "${name}" 是 acp-ssh 类型,缺少 ssh 目标(如 myxia@192.168.11.206)`);
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
    description: entry.description ?? "",
  };
}

/**
 * @param config - 经 schemastery 校验后的插件配置
 * @returns {{ defaultTimeoutMs: number, harnesses: Record<string, object> }}
 */
export function normalizeConfig(config) {
  const harnesses = {};
  for (const [name, entry] of Object.entries(config?.harnesses ?? {})) {
    harnesses[name] = validateNode(name, entry);
  }
  return { defaultTimeoutMs: config?.defaultTimeoutMs ?? 600000, harnesses };
}
