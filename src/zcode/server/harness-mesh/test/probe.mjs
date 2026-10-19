import { spawn } from "node:child_process";
import { Readable, Writable, Transform } from "node:stream";
import { AGENT_METHODS, PROTOCOL_VERSION, client, ndJsonStream } from "@agentclientprotocol/sdk";

const child = spawn("opencode", ["acp"], { stdio: ["pipe", "pipe", "inherit"] });
const tap = new Transform({
  transform(chunk, _enc, cb) {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const body = msg.method ?? `resp#${msg.id}`;
        console.log("<<", body, JSON.stringify(msg.params ?? msg.result ?? msg.error ?? "").slice(0, 160));
      } catch { console.log("<< unparsed:", line.slice(0, 100)); }
    }
    cb(null, chunk);
  },
});
child.stdout.pipe(tap);
const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(tap));
const app = client({ name: "probe", version: "0.1.0" })
  .onNotification("session/update", (c) => console.log(">>> session/update:", c.params.update.sessionUpdate))
  .onRequest("session/request_permission", async (context) => {
    const p = context.params;
    console.log(">>> PERMISSION title=", p?.toolCall?.title, "options=", JSON.stringify(p?.options));
    const opt = p.options.find((o) => o.kind === "allow_once") ?? p.options[0];
    const resp = { outcome: { outcome: "selected", optionId: opt.optionId } };
    console.log(">>> 响应:", JSON.stringify(resp));
    return resp;
  });
const conn = app.connect(stream);
console.log("init:", JSON.stringify(await conn.agent.request(AGENT_METHODS.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })).slice(0, 300));
const s = await conn.agent.request(AGENT_METHODS.session_new, { cwd: "/tmp/hm-e2e", mcpServers: [] });
console.log("session:", s.sessionId);
console.log("prompt resp:", JSON.stringify(await conn.agent.request(AGENT_METHODS.session_prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "在当前位置创建文件 e2e-ok.txt,内容为 e2e ok,然后报告你做了什么。" }] })));
process.exit(0);
