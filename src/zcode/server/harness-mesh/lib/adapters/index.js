/** 适配器热加载器:按文件 mtime 做缓存破坏动态 import。
 *
 *  背景:静态 import 的适配器类被 Node 进程缓存终身——改适配器代码必须重启进程,
 *  会话被打断(2026-10-16 用户的核心痛点)。本加载器让 adapters/*.js 的改动
 *  在下次 dispatch 时自动生效:文件没变 → 命中模块缓存原样复用;文件变了 →
 *  新 URL 重导入 → MeshController 销毁旧适配器实例、用新类重建。
 *
 *  热区边界(改哪些文件要重启):
 *  - 热(零重启):lib/hot.js、lib/client.js、lib/adapters/*.js
 *  - 重启(低频,需批量):lib/mesh.js、lib/index.js、lib/http.js、lib/config.js
 */
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** type → { 模块 URL, 导出类名 } */
const REGISTRY = {
  "acp-stdio": { url: new URL("./acp-stdio.js", import.meta.url), export: "AcpStdioAdapter" },
  "acp-plug": { url: new URL("./acp-plug.js", import.meta.url), export: "AcpPlugAdapter" },
};

/** 判断 set_model 失败是否属于"被控 harness 不支持/拒绝"(可降级用默认模型继续),
 *  而不是真故障。已知:kimi 全拒(Internal error)、zcode v2(-p 引擎)无此方法。 */
export function isModelUnsupported(msg) {
  return /method not found|unknown method|not supported|unsupported|internal error|invalid.{0,20}model|model.{0,20}(not (found|available|supported))|no such method/i.test(String(msg ?? ""));
}

/** 加载适配器类;返回 { Cls, modUrl }——modUrl 含 mtime,调用方据此判断是否重建实例。 */
export async function loadAdapterClass(type) {
  const entry = REGISTRY[type];
  if (!entry) {
    throw new Error(`harness-mesh: 适配器类型 "${type}" 未注册(可选: ${Object.keys(REGISTRY).join(" / ")})`);
  }
  const mtimeMs = (await stat(fileURLToPath(entry.url))).mtimeMs;
  const modUrl = `${entry.url.href}?t=${mtimeMs}`;
  const mod = await import(modUrl);
  const Cls = mod[entry.export];
  if (typeof Cls !== "function") {
    throw new Error(`harness-mesh: 适配器模块 ${entry.url.pathname} 缺少导出 ${entry.export}`);
  }
  return { Cls, modUrl };
}
