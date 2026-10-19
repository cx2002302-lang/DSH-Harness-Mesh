/** 探针:验证 session/set_model 的参数形状 + 换模型后 prompt 正常 */
import { client, ndJsonStream, PROTOCOL_VERSION, AGENT_METHODS, CLIENT_METHODS } from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

const child = spawn("opencode", ["acp"], { cwd: "/tmp/hm-e2e", stdio: ["pipe", "pipe", "inherit"] });
const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
let updates = 0;
const app = client({ name: "probe", version: "0.0.1" })
  .onNotification(CLIENT_METHODS.session_update, () => { updates++; })
  .onRequest(CLIENT_METHODS.session_request_permission, async () => ({ outcome: { outcome: "cancelled" } }))
  .onRequest(CLIENT_METHODS.fs_write_text_file, async (c) => { console.log(">>> fs_write:", c.params.path); return {}; });
const connection = app.connect(stream);

try {
  await connection.agent.request(AGENT_METHODS.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  const { sessionId } = await connection.agent.request(AGENT_METHODS.session_new, { cwd: "/tmp/hm-e2e", mcpServers: [] });
  console.log("session:", sessionId);

  // 试形状 A: {sessionId, modelId}
  try {
    await connection.agent.request("session/set_model", { sessionId, modelId: "opencode/deepseek-v4.1-flash" });
    console.log("形状 A(modelId) 接受");
  } catch (e) {
    console.log("形状 A(modelId) 拒绝:", String(e.message).slice(0, 80));
    // 试形状 B: {sessionId, model}
    try {
      await connection.agent.request("session/set_model", { sessionId, model: "opencode/deepseek-v4.1-flash" });
      console.log("形状 B(model) 接受");
    } catch (e2) {
      console.log("形状 B(model) 拒绝:", String(e2.message).slice(0, 80));
    }
  }

  console.log("发起 prompt(默认模型已挂,仅看是否有响应流)...");
  const resp = await Promise.race([
    connection.agent.request(AGENT_METHODS.session_prompt, { sessionId, prompt: [{ type: "text", text: "只回复两个字:正常" }] }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("15s 超时")), 15000)),
  ]);
  console.log("prompt 完成, stopReason:", resp.stopReason, "| 事件数:", updates);
} catch (e) {
  console.log("失败:", String(e.message ?? e).slice(0, 120));
} finally {
  child.kill();
  process.exit(0);
}
