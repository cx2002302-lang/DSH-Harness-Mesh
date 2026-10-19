/** M1 权限链路验证:opencode 对 bash 发起权限请求 → deny 命中 → approval 问你 → 放行后继续。 */
import { apply } from "../lib/index.js";

const registered = [];
let approvalCalls = 0;
const ctx = {
  tools: { register: (d) => { registered.push(d); return () => {}; } },
  effect: (fn) => fn(),
  logger: { info: () => {}, error: (m) => console.log("[logger.error]", m) },
  get: (svc) => {
    if (svc === "approval") return {
      request: async (req) => {
        approvalCalls++;
        console.log(`[e2e] approval.request 被调用 #${approvalCalls}: ${req.reason}`);
        return "allowed-once";
      },
    };
    throw new Error(`no service ${svc}`);
  },
  connection: { fetch: { register: () => {} } },
};
await apply(ctx, {
  defaultTimeoutMs: 120000,
  harnesses: { "opencode-local": { type: "acp-stdio", command: "opencode", args: ["acp"], env: {}, description: "e2e 权限测试" } },
});
const dispatch = registered.find((t) => t.name === "harness_dispatch");
const status = registered.find((t) => t.name === "harness_status");
const result = registered.find((t) => t.name === "harness_result");
const exec = { agent: { id: "e2e-perm" }, signal: new AbortController().signal, callId: "e2e-2" };

const { task_id } = await dispatch.execute({
  harness: "opencode-local",
  prompt: "运行 shell 命令 echo permission-test,然后把命令输出结果报告给我。",
  cwd: "/tmp/hm-e2e",
  deny: ["echo"],
}, exec);
console.log("dispatched:", task_id);
for (let i = 0; i < 24; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const s = await status.execute({ task_id }, exec);
  console.log(`[${i}] state=${s.state} events=${s.progress.length}`);
  if (["succeeded", "failed", "cancelled", "timeout"].includes(s.state)) break;
}
const r = await result.execute({ task_id }, exec);
console.log("=== RESULT ===");
console.log(`state=${r.state} | approval 调用 ${approvalCalls} 次`);
console.log(`summary: ${r.summary}`);
console.log(`error: ${r.error || "(无)"}`);
process.exit(0);
