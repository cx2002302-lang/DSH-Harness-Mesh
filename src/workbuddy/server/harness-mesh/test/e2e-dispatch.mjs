/** M1 端到端验证:真实 opencode 进程 + 完整 ACP 协议栈。
 *  跑法:DSH_ZAI_API_KEY=<key> node test/e2e-dispatch.mjs
 *
 *  隔离 DSH_HOME:apply() 会加载 $DSH_HOME/harness-mesh/nodes.json 并覆盖同名 patch 种子,
 *  不隔离的话,主 GUI 节点表里 opencode-local 的过期模型钉会盖掉下面的 e2e 配置(2026-10-19 实踩)。
 */
process.env.DSH_HOME = "/tmp/hm-e2e/dsh-home";
import { apply } from "../lib/index.js";
import { mkdirSync } from "node:fs";
mkdirSync("/tmp/hm-e2e", { recursive: true }); // 自愈:/tmp 被清(重启)后测试仍可跑

const registered = [];
const ctx = {
  tools: { register: (d) => { registered.push(d); return () => {}; } },
  effect: (fn) => fn(),   // cordis effect 语义:立即执行,返回清理函数
  logger: { info: () => {}, error: (m) => console.log("[logger.error]", m) },
  get: (svc) => {
    if (svc === "approval") return { request: async () => { console.log("[e2e] approval 被调用!"); return "allowed-once"; } };
    throw new Error(`no service ${svc}`);
  },
  connection: { fetch: { register: () => {} } },
};
await apply(ctx, {
  defaultTimeoutMs: 180000,
  // 模型钉 zai/glm-5.3-flash:opencode-go key 已过期(等管理员换),zai 走 DSH_ZAI_API_KEY
  // (2026-10-19 起 opencode.jsonc 加了 zai provider;跑本脚本前 export DSH_ZAI_API_KEY)
  harnesses: { "opencode-local": { type: "acp-stdio", command: "opencode", args: ["acp"], env: {}, model: "zai/glm-5.3-flash", description: "e2e 测试节点" } },
});
const dispatch = registered.find((t) => t.name === "harness_dispatch");
const status = registered.find((t) => t.name === "harness_status");
const result = registered.find((t) => t.name === "harness_result");
const exec = { agent: { id: "e2e" }, signal: new AbortController().signal, callId: "e2e-1" };

const { task_id } = await dispatch.execute({
  harness: "opencode-local",
  prompt: "在当前位置创建文件 e2e-ok.txt,内容为 e2e ok,然后报告你做了什么。",
  cwd: "/tmp/hm-e2e",
}, exec);
console.log("dispatched:", task_id);

for (let i = 0; i < 36; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const s = await status.execute({ task_id }, exec);
  const last = s.progress.at(-1);
  console.log(`[${i}] state=${s.state} events=${s.progress.length} last=${last ? last.kind : "-"}`);
  if (["succeeded", "failed", "cancelled", "timeout"].includes(s.state)) break;
}
const r = await result.execute({ task_id }, exec);
console.log("=== RESULT ===");
console.log(JSON.stringify(r, null, 2).slice(0, 2500));
console.log("=== e2e-ok.txt ===");
const { readFileSync } = await import("node:fs");
try { console.log(JSON.stringify(readFileSync("/tmp/hm-e2e/e2e-ok.txt", "utf8"))); } catch (e) { console.log("读取失败:", String(e)); }
process.exit(0);
