/** 插头协议本地端到端验证:harnessd(Python)+ fake-acp-agent + MeshController/acp-plug 适配器全链路。
 *  不依赖任何真实 harness CLI,也不需要 DSH 主进程——CI/本机可跑。
 *
 *  覆盖:
 *    ① token 鉴权:节点漏配/配错 token → hello 被拒,任务失败(死因可见)
 *    ② 完整派活:task.open → ACP initialize → session/new → prompt →
 *       假 agent 发起 rm -rf 权限请求(命中 DEFAULT_DENY)→ approval 放行 → end_turn,
 *       session/update 通知经插头数据管道回传,summary 落在任务库里
 *    ③ 模型降级:被控拒收 session/set_model(kimi 同款 Internal error)时,
 *       任务不死在建会话,按被控默认模型继续并出终态
 *
 *  跑法:node test/e2e-plug-fake-agent.mjs
 *  依赖:python3(或 python)在 PATH;@agentclientprotocol/sdk 可解析(缺失则 SKIP)。
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const HARNESSD = join(HERE, "..", "scripts", "harnessd.py");
const FAKE_AGENT = join(HERE, "..", "scripts", "fake-acp-agent.py");
const TOKEN = "hm-e2e-token";
const TERMINAL = ["succeeded", "failed", "cancelled", "timeout"];

// SDK 缺失(不在 DSH profile 内)时跳过,不阻断测试套件
try {
  await import("@agentclientprotocol/sdk");
} catch {
  console.log("SKIP: 缺少 @agentclientprotocol/sdk(在 DSH profile 内或 npm i 后再跑)");
  process.exit(0);
}

const { MeshController } = await import("../lib/mesh.js");
const { NodesStore } = await import("../lib/nodes-store.js");
const { TaskStore } = await import("../lib/task-store.js");

function fail(msg) { console.error(`FAIL: ${msg}`); process.exit(1); }

function resolvePython() {
  const candidates = process.platform === "win32" ? ["python", "python3", "py"] : ["python3", "python"];
  return new Promise((resolve, reject) => {
    let i = 0;
    const next = () => {
      if (i >= candidates.length) return reject(new Error("找不到 python 可执行文件"));
      const cmd = candidates[i++];
      const p = spawn(cmd, ["--version"], { stdio: "ignore" });
      p.on("error", next);
      p.on("exit", (code) => (code === 0 ? resolve(cmd) : next()));
    };
    next();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitFor(pattern, stream, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`等待 harnessd 输出超时: ${pattern}`)), timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      if (pattern.test(buf)) { clearTimeout(timer); stream.off("data", onData); resolve(buf); }
    };
    stream.on("data", onData);
  });
}

async function waitTerminal(mesh, taskId, timeoutMs = 60000) {
  const started = Date.now();
  for (;;) {
    const s = mesh.status(taskId);
    if (TERMINAL.includes(s.state)) return s;
    if (Date.now() - started > timeoutMs) fail(`任务 ${taskId} 超时未到终态(state=${s.state})`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ---- 起 harnessd(带 token) ----
const work = join(tmpdir(), `hm-plug-e2e-${Date.now()}`);
mkdirSync(work, { recursive: true });
const python = await resolvePython();
const port = await freePort();
const plugs = [
  { plugId: "fake-exec", harness: "fake", kind: "acp", enabled: true,
    command: python, args: [FAKE_AGENT], env: { FAKE_SET_MODEL: "ok", PYTHONIOENCODING: "utf-8" } },
  { plugId: "fake-nomodel", harness: "fake", kind: "acp", enabled: true,
    command: python, args: [FAKE_AGENT], env: { FAKE_SET_MODEL: "internal", PYTHONIOENCODING: "utf-8" } },
];
const plugsPath = join(work, "plugs.json");
writeFileSync(plugsPath, JSON.stringify(plugs, null, 2));

const harnessd = spawn(python, [HARNESSD, "--host", "127.0.0.1", "--port", String(port), "--plugs", plugsPath, "--token", TOKEN], { stdio: ["ignore", "pipe", "pipe"] });
await waitFor(/listening on/, harnessd.stderr);
console.log(`harnessd up: 127.0.0.1:${port}(token=${TOKEN})`);

let approvalCalls = 0;
const ctx = {
  get: (svc) => {
    if (svc === "approval") return { request: async () => { approvalCalls += 1; return "allowed-once"; } };
    throw new Error(`no service ${svc}`);
  },
};
const nodes = new NodesStore(join(work, "nodes.json")).load({
  "fake-plug": { type: "acp-plug", address: `127.0.0.1:${port}`, plugId: "fake-exec", token: TOKEN, description: "e2e 插头节点(带 token)" },
  "fake-plug-notoken": { type: "acp-plug", address: `127.0.0.1:${port}`, plugId: "fake-exec", description: "e2e 漏配 token" },
  "fake-plug-model": { type: "acp-plug", address: `127.0.0.1:${port}`, plugId: "fake-nomodel", token: TOKEN, description: "e2e 模型降级节点" },
});
const store = new TaskStore(join(work, "tasks.jsonl"));
const mesh = new MeshController(ctx, { defaultTimeoutMs: 60000 }, nodes, store);

try {
  // ① token 鉴权:漏配 token 的节点,hello 就该被拒,任务失败且死因含 unauthorized
  {
    const t = await mesh.dispatch({ harness: "fake-plug-notoken", prompt: "PONG", approvalAgent: { id: "e2e" } });
    const s = await waitTerminal(mesh, t.task_id);
    if (s.state !== "failed") fail(`漏配 token 的任务应失败,实际 ${s.state}`);
    if (!/unauthorized|token/.test(String(s.error ?? ""))) fail(`失败死因应指向 token,实际: ${s.error}`);
    console.log(`PASS ① token 鉴权:任务按预期失败(${String(s.error).slice(0, 80)}…)`);
  }

  // ② 完整派活 + 权限链:deny 命中 → approval 放行 → end_turn,summary 经数据管道回传
  {
    const t = await mesh.dispatch({ harness: "fake-plug", prompt: "只回复 PONG", approvalAgent: { id: "e2e" } });
    const s = await waitTerminal(mesh, t.task_id);
    if (s.state !== "succeeded") fail(`派活应成功,实际 ${s.state}: ${s.error}`);
    const r = mesh.result(t.task_id);
    if (!String(r.summary).includes("权限决定:selected")) fail(`summary 应含权限决定回传,实际: ${r.summary}`);
    if (approvalCalls < 1) fail("approval 服务应被调用至少一次(deny 命中)");
    console.log(`PASS ② 派活+权限链:succeeded,summary="${String(r.summary).slice(0, 40)}",approval x${approvalCalls}`);
  }

  // ③ 模型降级:被控拒收 set_model(Internal error)时任务不死在建会话
  {
    const t = await mesh.dispatch({ harness: "fake-plug-model", prompt: "只回复 PONG", model: "fake/test-model", approvalAgent: { id: "e2e" } });
    const s = await waitTerminal(mesh, t.task_id);
    if (s.state !== "succeeded") fail(`模型被拒时任务应降级成功,实际 ${s.state}: ${s.error}`);
    console.log("PASS ③ 模型降级:set_model 被拒后按被控默认模型继续,任务 succeeded");
  }

  console.log("\ne2e-plug-fake-agent 全部通过(鉴权/派活/权限链/模型降级)");
} finally {
  await mesh.dispose().catch(() => {});
  harnessd.kill();
  setTimeout(() => { rmSync(work, { recursive: true, force: true }); process.exit(0); }, 300).unref();
}
