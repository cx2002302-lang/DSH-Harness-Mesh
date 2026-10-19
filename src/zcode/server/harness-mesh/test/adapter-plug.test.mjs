/** acp-plug 适配器单元测试(纯 node:test,零第三方测试框架)。
 *
 *  手法:在 127.0.0.1:0 起一个「假 harnessd」——控制连接走长度分帧 JSON-RPC,
 *  数据连接首帧 attach + 之后 NDJSON(ACP)/行协议,与 lib/adapters/acp-plug.js
 *  的传输模型一一对应;不访问真实网络、不监听公认端口、测完全部关闭。
 *
 *  运行:cd harness-mesh && node --test test/adapter-plug.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpPlugAdapter } from "../lib/adapters/acp-plug.js";
import { CLIENT_METHODS } from "@agentclientprotocol/sdk";

// ---------- 小工具 ----------

function frame(bodyBuf) {
  const h = Buffer.alloc(4);
  h.writeUInt32BE(bodyBuf.length, 0);
  return Buffer.concat([h, bodyBuf]);
}
const frameJson = (obj) => frame(Buffer.from(JSON.stringify(obj), "utf8"));

/** 短轮询等条件成立(不用固定长 sleep)。 */
async function waitFor(fn, ms = 5000, step = 20) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, step));
  }
}

// ---------- 假 harnessd ----------

class FakePlugServer {
  constructor(opts = {}) {
    this.opts = opts;
    this.calls = [];            // 控制连接收到的方法调用 {method, params}
    this.acp = [];              // 数据连接(ACP/行)收到的消息
    this.closedStreams = new Set();
    this.dataSockets = new Map(); // streamId -> socket
    this.sockets = new Set();
    this.controlSock = null;
    this.streamSeq = 0;
    this.sessSeq = 0;
    this.openErrorOnce = opts.openErrorOnce ?? false; // 首次 task.open 回"连接已断开"
    this.ndBuf = "";
    this.pendingClient = new Map(); // 服务端→客户端请求的 id → resolve
    this.clientReqSeq = 900;
  }

  async start() {
    this.server = net.createServer((sock) => this.#onConn(sock));
    await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
    this.addr = `127.0.0.1:${this.server.address().port}`;
  }

  async stop() {
    for (const s of this.sockets) { try { s.destroy(); } catch { /* 已断 */ } }
    await new Promise((r) => this.server.close(r));
  }

  writeControlFrame(obj) {
    if (this.controlSock && !this.controlSock.destroyed) this.controlSock.write(frameJson(obj));
  }
  /** 服务端 → 客户端(数据连接上的 ACP 请求,如权限/fs)。 */
  requestClient(sessionStreamId, method, params) {
    const id = ++this.clientReqSeq;
    const sock = this.dataSockets.get(sessionStreamId);
    assert.ok(sock && !sock.destroyed, `数据连接不存在(stream=${sessionStreamId})`);
    return new Promise((resolve, reject) => {
      this.pendingClient.set(id, { resolve, reject });
      sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (this.pendingClient.has(id)) { this.pendingClient.delete(id); reject(new Error("requestClient 超时")); }
      }, 5000).unref();
    });
  }
  notifyClient(sessionStreamId, method, params) {
    const sock = this.dataSockets.get(sessionStreamId);
    if (sock && !sock.destroyed) sock.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  #reply(sock, msg, payload) {
    const out = { jsonrpc: "2.0", id: msg.id, ...(payload.error ? { error: payload.error } : { result: payload.result ?? payload }) };
    sock.write(JSON.stringify(out) + "\n");
  }

  #onConn(sock) {
    this.sockets.add(sock);
    sock.on("error", () => {});
    sock.on("close", () => this.sockets.delete(sock));
    let buf = Buffer.alloc(0);
    let mode = null; // "control" | streamId(数据连接)
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!mode) {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) return;
        let msg;
        try { msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8")); } catch { buf = buf.subarray(4 + len); return; }
        buf = buf.subarray(4 + len);
        if (msg.method === "attach") {
          mode = msg.params.streamId;
          this.dataSockets.set(mode, sock);
        } else {
          mode = "control";
          this.controlSock = sock;
          this.#onControlFrame(sock, msg);
        }
      }
      if (mode === "control") {
        while (buf.length >= 4) {
          const len = buf.readUInt32BE(0);
          if (buf.length < 4 + len) break;
          const raw = buf.subarray(4, 4 + len);
          buf = buf.subarray(4 + len);
          try { this.#onControlFrame(sock, JSON.parse(raw.toString("utf8"))); } catch { /* 坏包忽略 */ }
        }
      } else {
        // 数据连接:NDJSON(ACP)或行协议
        this.ndBuf += buf.toString("utf8");
        buf = Buffer.alloc(0);
        let idx;
        while ((idx = this.ndBuf.indexOf("\n")) >= 0) {
          const line = this.ndBuf.slice(0, idx).trim();
          this.ndBuf = this.ndBuf.slice(idx + 1);
          if (line) this.#onLine(mode, sock, line);
        }
      }
    });
  }

  #onControlFrame(sock, msg) {
    if (msg.id == null) return;
    this.calls.push({ method: msg.method, params: msg.params });
    const done = (payload) => {
      const out = { jsonrpc: "2.0", id: msg.id, ...(payload.error ? { error: payload.error } : { result: payload.result ?? payload }) };
      sock.write(frameJson(out));
    };
    switch (msg.method) {
      case "hello": return done({ result: { node: { name: "fake-harnessd", version: "9.9" } } });
      case "ping": return done({ result: { pong: true } });
      case "plug.list":
        if (this.opts.failPlugList) return done({ error: { code: -2, message: "list 炸了" } });
        return done({ result: { plugs: this.opts.plugs ?? [{ plugId: "p1", kind: "acp" }] } });
      case "plug.reload": return done({ result: { ok: true } });
      case "task.open": {
        if (this.openErrorOnce) { this.openErrorOnce = false; return done({ error: { code: -1, message: "plug 控制连接已断开" } }); }
        if (this.opts.openMissingStream) return done({ result: { oops: true } });
        return done({ result: { streamId: `st-${++this.streamSeq}` } });
      }
      case "task.close": {
        this.closedStreams.add(msg.params?.streamId);
        return done({ result: {} });
      }
      default:
        if (this.opts.ignore?.has(msg.method)) return; // 故意不回 → 挂起
        return done({ result: {} });
    }
  }

  #onLine(streamId, sock, line) {
    let msg;
    try { msg = JSON.parse(line); } catch { msg = null; }
    // 客户端对我方反向请求的响应
    if (msg && typeof msg === "object" && msg.id != null && this.pendingClient.has(msg.id)) {
      const { resolve } = this.pendingClient.get(msg.id);
      this.pendingClient.delete(msg.id);
      resolve(msg.result !== undefined ? msg.result : msg);
      return;
    }
    if (!msg || typeof msg !== "object" || msg.method == null) {
      // 行协议插头:非 JSON-RPC 请求的行 → 回预置行(lineReply)
      this.acp.push({ line: line });
      const rep = this.opts.lineReply;
      sock.write(`${typeof rep === "function" ? rep(line) : (rep ?? JSON.stringify({ echo: line }))}\n`);
      return;
    }
    this.acp.push(msg);
    if (msg.id != null && msg.method) {
      let result;
      try {
        result = this.opts.acpHandler?.(msg.method, msg.params) ?? this.#defaultAcp(msg.method, msg.params);
      } catch (error) {
        return this.#reply(sock, msg, { error: { code: -32000, message: String(error.message ?? error) } });
      }
      return this.#reply(sock, msg, { result });
    }
  }

  #defaultAcp(method) {
    switch (method) {
      case "initialize": return { protocolVersion: 1, agentCapabilities: {} };
      case "session/new": return { sessionId: `sess-${++this.sessSeq}` };
      case "session/set_model": return {};
      case "session/prompt": return { stopReason: "end_turn" };
      default: return {};
    }
  }
}

// ---------- 公共脚手架 ----------

let tmpRoot;
test.before(async () => { tmpRoot = await mkdtemp(join(tmpdir(), "acp-plug-test-")); });
test.after(async () => { await rm(tmpRoot, { recursive: true, force: true }); });

function makeAdapter(server, extra = {}, hooksOverride = {}) {
  const hooks = {
    onSessionUpdate: hooksOverride.onSessionUpdate ?? (() => {}),
    resolvePermission: hooksOverride.resolvePermission ?? (async () => ({ action: "allow" })),
    onProcessExit: hooksOverride.onProcessExit ?? (() => {}),
  };
  const node = { name: "fake-node", type: "acp-plug", address: server.addr, plugId: "p1", ...extra };
  return new AcpPlugAdapter(node, hooks);
}

// ---------- 用例 ----------

test("ensureRunning:正常路径 + plugKinds 缓存(默认 kind=acp)", async () => {
  const server = new FakePlugServer({ plugs: [{ plugId: "p1" }, { plugId: "p2", kind: "line" }] });
  await server.start();
  try {
    const adapter = makeAdapter(server);
    assert.equal(adapter.alive, false);
    const info = await adapter.ensureRunning();
    assert.deepEqual(info, { name: "fake-harnessd", version: "9.9" });
    assert.equal(adapter.alive, true);
    assert.ok(adapter.plugKinds instanceof Map);
    assert.equal(adapter.plugKinds.get("p1"), "acp");     // 缺 kind 字段 → 默认 acp
    assert.equal(adapter.plugKinds.get("p2"), "line");
    // 幂等 + 并发去重:再调不重连,hello 只收到一次
    const [a, b] = await Promise.all([adapter.ensureRunning(), adapter.ensureRunning()]);
    assert.deepEqual(a, info);
    assert.deepEqual(b, info);
    assert.equal(server.calls.filter((c) => c.method === "hello").length, 1);
    await adapter.dispose();
  } finally { await server.stop(); }
});

test("ensureRunning:建连失败(拒连)可重试,starting 状态被清理", async () => {
  const server = new FakePlugServer();
  // 先 start 拿到端口再停掉:保证 connect 必然 ECONNREFUSED
  await server.start();
  const deadAddr = server.addr;
  await server.stop();
  const adapter = makeAdapter({ addr: deadAddr });
  await assert.rejects(adapter.ensureRunning(), (e) => /connect ECONNREFUSED|ECONNREFUSED/i.test(String(e)));
  assert.equal(adapter.control, null);
  await server.start();
  try {
    adapter.node.address = server.addr; // 换回活端口(重试语义验证)
    const info = await adapter.ensureRunning(); // 重试成功
    assert.ok(info && info.name === "fake-harnessd");
    await adapter.dispose();
  } finally { await server.stop(); }
});

test("plug.list 失败 → plugKinds 为 null 但连接仍建立", async () => {
  const server = new FakePlugServer({ failPlugList: true });
  await server.start();
  try {
    const adapter = makeAdapter(server);
    await adapter.ensureRunning();
    assert.equal(adapter.plugKinds, null);
    assert.equal(adapter.alive, true);
    await adapter.dispose();
  } finally { await server.stop(); }
});

test("reloadPlugs:调 plug.reload 并刷新 plugKinds", async () => {
  const server = new FakePlugServer({ plugs: [{ plugId: "p1", kind: "acp" }] });
  await server.start();
  try {
    const adapter = makeAdapter(server);
    await adapter.ensureRunning();
    server.opts.plugs = [{ plugId: "p1", kind: "line" }]; // 对端热重载后 kind 变了
    const r = await adapter.reloadPlugs();
    assert.deepEqual(r, { ok: true });
    assert.equal(adapter.plugKinds.get("p1"), "line");
    assert.ok(server.calls.some((c) => c.method === "plug.reload"));
    await adapter.dispose();
  } finally { await server.stop(); }
});

test("控制连接:坏 JSON 帧 不炸、后续正常帧仍可处理", async () => {
  const server = new FakePlugServer();
  await server.start();
  try {
    const adapter = makeAdapter(server);
    await adapter.ensureRunning();
    server.writeControlFrame({});                                   // 空 body 帧 → JSON.parse("{}") 成功但无 id/method,忽略
    server.controlSock.write(frame(Buffer.from("{oops-not-json"))); // 真·坏帧 → 被吞
    const res = await adapter.control.call("ping");                 // 之后的好帧仍正常
    assert.deepEqual(res, { pong: true });
    await adapter.dispose();
  } finally { await server.stop(); }
});

test("对端断开:pending call 拒绝(控制连接已断开)、alive 变 false、可重连", async () => {
  const server = new FakePlugServer({ ignore: new Set(["ping"]) });
  await server.start();
  try {
    const adapter = makeAdapter(server);
    await adapter.ensureRunning();
    const hangP = adapter.control.call("ping"); // 服务端故意不回
    const rejected = assert.rejects(() => hangP, /控制连接已断开/);
    server.controlSock.destroy();               // 对端拔线
    await rejected;
    await waitFor(() => adapter.alive === false && adapter.control === null);
    assert.equal(adapter.agentInfo, null);
    // 自动重连恢复
    const info = await adapter.ensureRunning();
    assert.ok(info.name === "fake-harnessd");
    assert.equal(adapter.alive, true);
    await adapter.dispose();
  } finally { await server.stop(); }
});

test("控制连接已断开时 call 立即拒绝(不再发帧)", async () => {
  const server = new FakePlugServer();
  await server.start();
  try {
    const adapter = makeAdapter(server);
    await adapter.ensureRunning();
    adapter.control.close(); // 本地主动销毁
    await assert.rejects(adapter.control.call("ping"), /控制连接已断开/);
    adapter.control = null;
    await adapter.dispose();
  } finally { await server.stop(); }
});

test("task.exit 通知归一:code/elapsed_ms 与 exitCode/ts 两种别名都吃", async () => {
  const server = new FakePlugServer();
  await server.start();
  try {
    const adapter = makeAdapter(server);
    await adapter.ensureRunning();
    // 场景 1:harnessd.py 风格 code/elapsed_ms;对端 initialize 回错 → #remoteDeath 把死因织进消息
    server.sendTaskExit = (params) => server.writeControlFrame({ jsonrpc: "2.0", method: "task.exit", params });
    server.sendTaskExit({ streamId: `st-${server.streamSeq + 1}`, plugId: "p1", code: 2, elapsed_ms: 50, stderr: "boom\nstack" });
    server.opts.acpHandler = (method) => { if (method === "initialize") throw new Error("nope"); };
    await adapter.newSession("/w").catch((e) => e).then((e) => {
      const msg = String(e?.message ?? e);
      assert.match(msg, /ACP 握手失败/);
      assert.match(msg, /nope/);
      assert.match(msg, /code=2/);
      assert.match(msg, /50ms/);
      assert.match(msg, /boom/);
    });
    // 场景 2:WinPC 风格 exitCode/ts(先重连——场景1失败清理已把控制连接断掉)
    await adapter.ensureRunning();
    server.sendTaskExit({ streamId: `st-${server.streamSeq + 1}`, plugId: "p1", exitCode: 7, ts: 123, reason: "crash" });
    await adapter.newSession("/w").catch((e) => e).then((e) => {
      const msg = String(e?.message ?? e);
      assert.match(msg, /code=7/);
      assert.match(msg, /123ms/);
    });
    await adapter.dispose();
  } finally { await server.stop(); }
});

test("newSession:task.open 响应缺 streamId → 明确失败并清控制连接", async () => {
  const server = new FakePlugServer({ openMissingStream: true });
  await server.start();
  try {
    const adapter = makeAdapter(server);
    await assert.rejects(adapter.newSession("/w"), /缺 streamId/);
    assert.equal(adapter.control, null); // 失败清理:控制连接被重置
    await adapter.dispose();
  } finally { await server.stop(); }
});

test("newSession:task.open 报「控制连接已断开」→ 强制重连重试一次成功", async () => {
  const server = new FakePlugServer({ openErrorOnce: true });
  await server.start();
  try {
    const adapter = makeAdapter(server);
    const sid = await adapter.newSession("/w");
    assert.match(sid, /^sess-/);
    // hello 应出现两次(初始 + 重连)
    assert.ok(server.calls.filter((c) => c.method === "hello").length >= 2);
    await adapter.dispose();
  } finally { await server.stop(); }
});

test("newSession + prompt:行协议插头(kind=line)全链路", async () => {
  const server = new FakePlugServer({
    plugs: [{ plugId: "p1", kind: "line" }],
    lineReply: (line) => JSON.stringify({ replyTo: line, done: true }),
  });
  await server.start();
  try {
    const updates = [];
    const exits = [];
    const adapter = makeAdapter(server, {}, {
      onSessionUpdate: (u) => updates.push(u),
      onProcessExit: (r) => exits.push(r),
    });
    const sid = await adapter.newSession("/w", null);
    assert.match(sid, /^line-st-/);
    assert.equal(adapter.sessions.get(sid).lineMode, true);
    // 不发 ACP initialize(行协议无握手):数据连接上不应有任何 ACP 请求
    assert.ok(!server.acp.some((m) => m.method === "initialize"));
    const res = await adapter.prompt(sid, "你好");
    assert.deepEqual(res, { stopReason: "end_turn" });
    assert.equal(updates.length, 1);
    assert.equal(updates[0].sessionId, sid);
    assert.equal(updates[0].update.sessionUpdate, "agent_message_chunk");
    assert.ok(updates[0].update.content.text.includes("你好")); // 回显原文
    // 坏 JSON 行 → { raw } 兜底
    server.opts.lineReply = "这不是JSON";
    const sid2 = sid; // 行协议 prompt 后 1s 自动关流,先等自动关闭再开新会话测 raw
    await waitFor(() => adapter.sessions.size === 0 && server.closedStreams.size >= 1, 5000);
    // 注:行协议会话不挂 dataConn close 钩子 → hooks.onProcessExit 不会触发(与 ACP 模式行为不一致,见汇报)
    // 第二个会话验证 raw 兜底
    const sid3 = await adapter.newSession("/w");
    const res3 = await adapter.prompt(sid3, "again");
    assert.deepEqual(res3, { stopReason: "end_turn" });
    await waitFor(() => adapter.sessions.size === 0, 5000);
    assert.ok(server.closedStreams.size >= 2);
    assert.ok(!adapter.sessions.has(sid2) && !adapter.sessions.has(sid3));
    await adapter.dispose();
  } finally { await server.stop(); }
});

test("newSession + prompt:ACP 模式全链路(initialize/session/new/set_model/prompt)", async () => {
  const server = new FakePlugServer();
  await server.start();
  try {
    const updates = [];
    const permCalls = [];
    const adapter = makeAdapter(server, { model: "m-默认" }, {
      onSessionUpdate: (u) => updates.push(u),
      resolvePermission: async (p) => { permCalls.push(p); return { action: "allow" }; },
    });
    const sid = await adapter.newSession("/w"); // 未传 model → 用 node.model
    assert.match(sid, /^sess-/);
    const acpMethods = () => server.acp.filter((m) => m.id != null && m.method).map((m) => m.method);
    assert.ok(acpMethods().includes("initialize"));
    assert.ok(acpMethods().includes("session/new"));
    assert.ok(acpMethods().includes("session/set_model"));
    const setModelMsg = server.acp.find((m) => m.method === "session/set_model");
    assert.equal(setModelMsg.params.modelId, "m-默认");
    assert.equal(setModelMsg.params.sessionId, sid);

    // 服务端推 session_update 通知 → hooks.onSessionUpdate
    const streamId = [...server.dataSockets.keys()][0];
    server.notifyClient(streamId, CLIENT_METHODS.session_update, { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "推流内容" } } });
    await waitFor(() => updates.length === 1);
    assert.equal(updates[0].update.sessionUpdate, "agent_message_chunk");

    // 服务端反向请求:权限(allow → 选 allow_once)。params 需满足 SDK 的 zod 校验。
    const permRes = await server.requestClient(streamId, CLIENT_METHODS.session_request_permission, {
      sessionId: sid,
      toolCall: { toolCallId: "tc1", kind: "edit", title: "写文件", rawInput: {} },
      options: [
        { name: "允许一次", kind: "allow_once", optionId: "a1" },
        { name: "拒绝一次", kind: "reject_once", optionId: "r1" },
      ],
    });
    assert.equal(permRes.outcome.outcome, "selected");
    assert.equal(permRes.outcome.optionId, "a1");
    assert.equal(permCalls.length, 1);

    // 服务端反向请求:fs 读(带 line/limit)与写
    const file = join(tmpRoot, "fs-probe.txt");
    await writeFile(file, "l1\nl2\nl3", "utf8");
    const readRes = await server.requestClient(streamId, CLIENT_METHODS.fs_read_text_file, { sessionId: sid, path: file, line: 2, limit: 1 });
    assert.equal(readRes.content, "l2");
    const readAll = await server.requestClient(streamId, CLIENT_METHODS.fs_read_text_file, { sessionId: sid, path: file });
    assert.equal(readAll.content, "l1\nl2\nl3");
    const target = join(tmpRoot, "fs-write.txt");
    await server.requestClient(streamId, CLIENT_METHODS.fs_write_text_file, { sessionId: sid, path: target, content: "written" });
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(target, "utf8"), "written");

    // prompt:终态返回 + 1s 后自动关流(task.close + 数据连接断)
    const res = await adapter.prompt(sid, "干个活");
    assert.deepEqual(res, { stopReason: "end_turn" });
    const promptMsg = server.acp.find((m) => m.method === "session/prompt");
    assert.equal(promptMsg.params.sessionId, sid);
    assert.deepEqual(promptMsg.params.prompt, [{ type: "text", text: "干个活" }]);
    await waitFor(() => adapter.sessions.size === 0 && server.closedStreams.has(streamId), 5000);
    await adapter.dispose();
  } finally { await server.stop(); }
});

test("newSession:set_model 失败 → 报设置模型失败", async () => {
  const server = new FakePlugServer({
    acpHandler: (method) => { if (method === "session/set_model") throw new Error("模型不存在"); },
  });
  await server.start();
  try {
    const adapter = makeAdapter(server);
    await assert.rejects(adapter.newSession("/w", "bad-model"), /设置模型 bad-model 失败.*模型不存在/s);
    await adapter.dispose();
  } finally { await server.stop(); }
});

test("prompt:未知 sessionId → 明确报错", async () => {
  const server = new FakePlugServer();
  await server.start();
  try {
    const adapter = makeAdapter(server);
    await assert.rejects(adapter.prompt("no-such", "hi"), /已不存在/);
    await adapter.dispose();
  } finally { await server.stop(); }
});

test("权限决策:reject 路径 / resolvePermission 抛异常 / 无匹配 option → cancelled", async () => {
  const server = new FakePlugServer();
  await server.start();
  try {
    const adapter = makeAdapter(server);
    const sid = await adapter.newSession("/w");
    const streamId = [...server.dataSockets.keys()][0];
    const options = [
      { name: "允许一次", kind: "allow_once", optionId: "a1" },
      { name: "拒绝一次", kind: "reject_once", optionId: "r1" },
      { name: "总是拒绝", kind: "reject_always", optionId: "r2" },
    ];
    const permParams = (opts) => ({ sessionId: sid, toolCall: { toolCallId: "tc1", kind: "edit", title: "x", rawInput: {} }, options: opts });

    adapter.hooks.resolvePermission = async () => ({ action: "reject" });
    let res = await server.requestClient(streamId, CLIENT_METHODS.session_request_permission, permParams(options));
    assert.equal(res.outcome.optionId, "r1"); // reject_once 优先

    adapter.hooks.resolvePermission = async () => ({ action: "reject" });
    res = await server.requestClient(streamId, CLIENT_METHODS.session_request_permission, permParams([{ name: "总是拒绝", kind: "reject_always", optionId: "r2" }]));
    assert.equal(res.outcome.optionId, "r2");

    adapter.hooks.resolvePermission = async () => { throw new Error("决策器挂了"); };
    res = await server.requestClient(streamId, CLIENT_METHODS.session_request_permission, permParams(options));
    assert.equal(res.outcome.optionId, "r1"); // 异常 → 按 reject 兜底

    adapter.hooks.resolvePermission = async () => ({ action: "allow" });
    res = await server.requestClient(streamId, CLIENT_METHODS.session_request_permission, permParams([])); // allow 但无选项
    assert.equal(res.outcome.outcome, "cancelled");

    adapter.hooks.resolvePermission = async () => ({ action: "whatever" }); // 非 allow → reject 分支,无 reject 选项
    res = await server.requestClient(streamId, CLIENT_METHODS.session_request_permission, permParams([{ name: "允许一次", kind: "allow_once", optionId: "a1" }]));
    assert.equal(res.outcome.outcome, "cancelled");

    await adapter.dispose();
  } finally { await server.stop(); }
});

test("cancel:通知 session/cancel;宽限期后强制断流清会话;未知会话幂等", async () => {
  const server = new FakePlugServer();
  await server.start();
  try {
    const adapter = makeAdapter(server);
    const sid = await adapter.newSession("/w");
    await adapter.cancel("no-such"); // 未知会话:静默返回
    const streamId = [...server.dataSockets.keys()][0];
    await adapter.cancel(sid);
    await waitFor(() => server.acp.some((m) => m.method === "session/cancel" && m.params?.sessionId === sid));
    // 3s 宽限后:数据连接销毁 + task.close + 会话清除(短轮询等待)
    await waitFor(() => adapter.sessions.size === 0 && server.closedStreams.has(streamId), 6000);
    await adapter.dispose();
  } finally { await server.stop(); }
});

test("dispose:关全部会话流 + 控制连接,幂等可重复调", async () => {
  const server = new FakePlugServer();
  await server.start();
  try {
    const adapter = makeAdapter(server);
    const sid = await adapter.newSession("/w");
    const streamId = [...server.dataSockets.keys()][0];
    await adapter.dispose();
    assert.equal(adapter.alive, false);
    assert.equal(adapter.control, null);
    assert.equal(adapter.sessions.size, 0);
    assert.ok(server.closedStreams.has(streamId));
    // 服务侧 socket 的 close 是异步事件:短轮询等它关
    await waitFor(() => {
      const s = server.dataSockets.get(streamId);
      return !s || s.destroyed || s.readyState === "closed";
    });
    await adapter.dispose(); // 再调不炸
    assert.equal(adapter.alive, false);
    assert.ok(!adapter.sessions.has(sid));
  } finally { await server.stop(); }
});

test("SOCKS5 兜底:node.socks 走假 SOCKS5 服务完成握手建连", async () => {
  // 假 SOCKS5:回握手 05 00,回 CONNECT 05 00 00 01 0.0.0.0 0,之后透传为假 harnessd 的前置
  const target = new FakePlugServer();
  await target.start();
  const [tHost, tPort] = target.addr.split(":");
  const socks = net.createServer((client) => {
    client.on("error", () => {});
    let stage = 0;
    let upstream = null;
    client.on("data", (chunk) => {
      if (stage === 0) { stage = 1; client.write(Buffer.from([0x05, 0x00])); return; }
      if (stage === 1) {
        stage = 2;
        assert.equal(chunk[0], 0x05); assert.equal(chunk[3], 0x03); // ATYP=域名
        const dom = chunk.subarray(5, 5 + chunk[4]).toString("utf8");
        assert.equal(dom, tHost);
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        // 握手完成后才建立隧道(握手字节不能漏进隧道)
        upstream = net.connect(Number(tPort), "127.0.0.1");
        upstream.on("error", () => client.destroy());
        upstream.pipe(client);
        const rest = chunk.subarray(5 + chunk[4] + 2); // CONNECT 帧后可能跟的隧道数据
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        return;
      }
      if (upstream) upstream.write(chunk);
    });
    client.on("close", () => { if (upstream) upstream.destroy(); });
  });
  await new Promise((r) => socks.listen(0, "127.0.0.1", r));
  const socksAddr = `127.0.0.1:${socks.address().port}`;
  try {
    const adapter = makeAdapter(target, { socks: socksAddr });
    const info = await adapter.ensureRunning();
    assert.ok(info.name === "fake-harnessd"); // 经 SOCKS5 隧道 hello 成功
    await adapter.dispose();
  } finally {
    await new Promise((r) => socks.close(r));
    await target.stop();
  }
});

test("SOCKS5 兜底:握手被拒 → 报 SOCKS5 握手被拒", async () => {
  const socks = net.createServer((client) => {
    client.on("error", () => {});
    client.once("data", () => client.write(Buffer.from([0x05, 0x02]))); // 拒绝无认证
  });
  await new Promise((r) => socks.listen(0, "127.0.0.1", r));
  try {
    const adapter = new AcpPlugAdapter(
      { name: "n", type: "acp-plug", address: "127.0.0.1:1", plugId: "p1", socks: `127.0.0.1:${socks.address().port}` },
      { onSessionUpdate: () => {}, resolvePermission: async () => ({ action: "allow" }) },
    );
    await assert.rejects(adapter.ensureRunning(), /SOCKS5 握手被拒/);
    assert.equal(adapter.control, null);
  } finally { await new Promise((r) => socks.close(r)); }
});
