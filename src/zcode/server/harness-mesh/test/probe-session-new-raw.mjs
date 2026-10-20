// 看 opencode ACP session/new 的原始响应形状(models 在哪)
import { client, ndJsonStream, PROTOCOL_VERSION, AGENT_METHODS, CLIENT_METHODS } from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

const child = spawn("opencode", ["acp"], { cwd: "/tmp/hm-probe", stdio: ["pipe", "pipe", "inherit"], env: { ...process.env } });
const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
const app = client({ name: "probe", version: "0.0.1" })
  .onNotification(CLIENT_METHODS.session_update, () => {})
  .onRequest(CLIENT_METHODS.session_request_permission, async () => ({ outcome: { outcome: "cancelled" } }));
const connection = app.connect(stream);
await connection.agent.request(AGENT_METHODS.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
const res = await connection.agent.request(AGENT_METHODS.session_new, { cwd: "/tmp/hm-probe", mcpServers: [] });
console.log("session/new 完整响应:", JSON.stringify(res, null, 2).slice(0, 3000));
child.kill();
process.exit(0);
