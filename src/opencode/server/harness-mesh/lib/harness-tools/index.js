/** harness 专属工具注册框架。
 *
 *  每个 harness 一个文件(lib/harness-tools/<harness>.js),导出:
 *    export const tools = [{ name, description(一句话), inputSchema, doc(完整用法,渐进披露用) }]
 *    export const handlers = { <tool_name>: async (args, ctx) => result }
 *  ctx = { mesh, nodes }(harness-mesh 的编排核心与节点表,只读用法见规范文档)。
 *
 *  命名规则:<prefix>_<verb>(prefix 见 REGISTRY,如 wb_info/kimi_models),
 *  避免与公用工具(harness_*)撞名,也避免 harness 之间撞名。
 *
 *  热加载:按文件 mtime 缓存破坏动态 import——改 <harness>.js 保存即生效,零重启。
 *  (注意:pnpm 硬链接农场 + sed -i 会掰断同步,只用 python 原地写,见 master-plan §7.4.1)
 */
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** harness → { 模块 URL, 工具名前缀 }。新 harness 在这里登记一行。 */
const REGISTRY = {
  workbuddy: { url: new URL("./workbuddy.js", import.meta.url), prefix: "wb_" },
  kimi: { url: new URL("./kimi.js", import.meta.url), prefix: "kimi_" },
  zcode: { url: new URL("./zcode.js", import.meta.url), prefix: "zc_" },
  opencode: { url: new URL("./opencode.js", import.meta.url), prefix: "oc_" },
  dsh: { url: new URL("./dsh.js", import.meta.url), prefix: "dsh_" },
};

/** 加载单个 harness 的工具表与 handlers;文件不存在返回 null(该 harness 未配专属工具)。 */
export async function loadHarnessTools(harness) {
  const entry = REGISTRY[harness];
  if (!entry) return null;
  let mtimeMs;
  try {
    mtimeMs = (await stat(fileURLToPath(entry.url))).mtimeMs;
  } catch {
    return null; // 文件不存在:该 harness 暂无专属工具
  }
  const mod = await import(`${entry.url.href}?t=${mtimeMs}`);
  return { harness, prefix: entry.prefix, tools: mod.tools ?? [], handlers: mod.handlers ?? {} };
}

/** 已登记且有工具文件的 harness 列表。 */
export async function availableHarnesses() {
  const out = [];
  for (const h of Object.keys(REGISTRY)) {
    if (await loadHarnessTools(h)) out.push(h);
  }
  return out;
}

/** 按工具名找 handler:遍历所有 harness 工具文件,返回 {handler, harness} 或 null。 */
export async function resolveTool(name) {
  for (const h of Object.keys(REGISTRY)) {
    const pack = await loadHarnessTools(h);
    if (pack?.handlers?.[name]) return { handler: pack.handlers[name], harness: h, pack };
  }
  return null;
}
