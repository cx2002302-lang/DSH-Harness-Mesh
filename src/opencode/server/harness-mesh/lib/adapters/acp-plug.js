/** acp-plug 适配器:主控经「插头协议」连被控机的 harnessd。
 *
 *  连接模型(两连接):
 *  - 控制连接(常驻):长度分帧 JSON-RPC —— hello / plug.list / ping / task.open / task.close
 *  - 数据连接(按任务):attach {streamId} 后变成原始字节管道;
 *    ACP 的 NDJSON 端到端跑在「主控 SDK ↔ 被控 CLI」之间,harnessd 只做透传(不懂 ACP)。
 *
 *  与 AcpStdioAdapter 的接口对齐(ensureRunning/newSession/prompt/cancel/dispose/alive),
 *  差异:进程在被控机侧 spawn——每次 newSession 开一条远程流(远程 spawn CLI),
 *  prompt 结束/管道断开即关流。一个适配器(节点)可挂多个并发 session。
 *
 *  传输:TUN 模式下 net.connect(annAddr) 直连;零 root 兜底改走本机 SOCKS5
 *  (ann-agent --socks5-port),由 node.socks 字段指定(可选)。
 */
import net from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { AGENT_METHODS, CLIENT_METHODS, PROTOCOL_VERSION, client, ndJsonStream } from "@agentclientprotocol/sdk";

/** 长度分帧(4 字节大端 + UTF-8 JSON)的控制连接。 */
class PlugControl {
  constructor(socket, onNotification) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.onNotification = onNotification;
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("close", () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) {
        reject(new Error("plug 控制连接已断开"));
      }
      this.pending.clear();
    });
    socket.on("error", () => { /* close 事件会跟进 */ });
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(4 + length);
      try {
        const msg = JSON.parse(body);
        if (msg.id != null && this.pending.has(msg.id)) {
          const entry = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(msg.error.message ?? "plug error"));
          else entry.resolve(msg.result);
        } else if (msg.method && this.onNotification) {
          this.onNotification(msg.method, msg.params ?? {});
        }
      } catch { /* 半包/坏包:等更多数据 */ }
    }
  }

  call(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("plug 控制连接已断开"));
    const id = this.nextId++;
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(Buffer.concat([header, body]));
    });
  }

  close() {
    try { this.socket.destroy(); } catch { /* 已断 */ }
  }
}

/** 零依赖 SOCKS5 拨号:经本机 ann-agent 的 SOCKS5 代理(userspace 节点)连 tailnet 目标。
 *  用于 208 主控在没有 TUN 路由时拨被控机的 tailnet IP;有 TUN 时走系统路由直连。 */
function dialViaSocks(socksAddr, targetHost, targetPort) {
  const [socksHost, socksPort] = socksAddr.split(":");
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: socksHost, port: Number(socksPort) });
    let settled = false;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    // 全程保留 error 监听:destroy(error) 会 emit 'error',无监听 = 未捕获异常 = 进程崩(21:09 实踩)
    sock.on("error", fail);
    sock.setTimeout(15000, () => {
      sock.destroy();
      fail(new Error(`SOCKS5 拨号超时(15s): ${targetHost}:${targetPort}(WG 首次握手可能未完成,重试即可)`));
    });
    sock.once("connect", () => {
      // ① 握手:VER=5,无认证
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
      sock.once("data", (greeting) => {
        if (greeting[0] !== 0x05 || greeting[1] !== 0x00) return fail(new Error(`SOCKS5 握手被拒: ${greeting[1]}`));
        // ② CONNECT(域名形式,ATYP=3)
        const hostBuf = Buffer.from(targetHost, "utf8");
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(targetPort, 0);
        sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf, portBuf]));
        sock.once("data", (reply) => {
          if (reply[0] !== 0x05 || reply[1] !== 0x00) {
            return fail(new Error(`SOCKS5 CONNECT 失败(reply=${reply[1]}): ${targetHost}:${targetPort}`));
          }
          settled = true;
          sock.setTimeout(0);
          // 交接给 ACP 流:留兜底 error 监听,防止流未覆盖的 error 事件升级为未捕获异常
          sock.on("error", () => {});
          resolve(sock);
        });
      });
    });
  });
}

/** 建连:TUN 模式直连;配了 node.socks 则经 SOCKS5(userspace 兜底)。 */
async function dialNode(node) {
  const [host, port] = node.address.split(":");
  if (node.socks) return dialViaSocks(node.socks, host, Number(port));
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port: Number(port) });
    let settled = false;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    sock.on("error", fail);
    sock.setTimeout(15000, () => {
      sock.destroy();
      fail(new Error(`plug 直连超时(15s): ${host}:${port}`));
    });
    sock.once("connect", () => {
      settled = true;
      sock.setTimeout(0);
      sock.on("error", () => {}); // 交接兜底(同 dialViaSocks)
      resolve(sock);
    });
  });
}

export class AcpPlugAdapter {
  /** @param node { name, type:"acp-plug", address:"host:port", plugId, model?, socks? }
   *  @param hooks 同 AcpStdioAdapter */
  constructor(node, hooks) {
    this.node = node;
    this.hooks = hooks;
    /** @type {PlugControl|null} */
    this.control = null;
    this.agentInfo = null;
    /** sessionId → { streamId, dataConn, connection } */
    this.sessions = new Map();
    /** streamId → 远程进程退出信息(harnessd task.exit 回传,排错用) */
    this.exits = new Map();
    this.starting = null;
    /** plugId → kind(plug.list 拿;"line"=裸行协议模式) */
    this.plugKinds = null;
  }

  get alive() {
    return this.control !== null && !this.control.closed;
  }

  /** 建控制连接并 hello(幂等;失败清 starting 允许重试)。 */
  async ensureRunning() {
    if (this.control && !this.control.closed) return this.agentInfo;
    if (!this.starting) {
      this.starting = this.#connect().catch((error) => {
        this.starting = null;
        throw error;
      });
    }
    return this.starting;
  }

  async #connect() {
    const socket = await dialNode(this.node);
    const control = new PlugControl(socket, (method, params) => {
      if (method === "task.exit") {
        // 字段别名容错(2026-10-17 11:25):WinPC harnessd_win 用 exitCode/ts,
        // 我的 harnessd.py 用 code/elapsed_ms——两种都吃,避免跨实现字段名漂移丢死因。
        const norm = {
          streamId: params.streamId,
          plugId: params.plugId,
          code: params.code ?? params.exitCode ?? null,
          elapsed_ms: params.elapsed_ms ?? params.ts ?? null,
          stderr: params.stderr ?? null,
        };
        this.exits.set(params.streamId, norm);
        console.log(`[harness-mesh] plug 远程进程退出: stream=${norm.streamId} plug=${norm.plugId} code=${norm.code} (${norm.elapsed_ms}ms${params.reason ? `, reason=${params.reason}` : ""})`);
        if (norm.stderr) console.log(`[harness-mesh] 远程 stderr: ${String(norm.stderr).slice(-400)}`);
      }
    });
    // hello 失败(对端拒/超时/坏包)时必须毁掉 socket——否则连接泄漏:
    // 此刻 this.control 还没赋值,dispose 管不到这条连接(2026-10-19 全量测试发现)。
    let hello;
    try {
      hello = await control.call("hello");
    } catch (error) {
      control.close();
      throw error;
    }
    this.control = control;
    this.agentInfo = hello?.node ?? null;
    // 拉插头清单,缓存 plugId→kind:"line" 类插头(如 wb-ui)走裸行协议,不走 ACP。
    // 零配置零重启——插头加 kind 字段即自动获得正确模式(2026-10-17 13:25)。
    try {
      const list = await control.call("plug.list");
      this.plugKinds = new Map((list?.plugs ?? []).map((p) => [p.plugId, p.kind ?? "acp"]));
    } catch { this.plugKinds = null; }
    socket.on("close", () => {
      if (this.control === control) {
        this.control = null;
        this.agentInfo = null;
        this.starting = null;
      }
    });
    return this.agentInfo;
  }

  /** 热重载对端 plugs.json(改插头配置后不用重启 harnessd)。
   *  同时清本侧 plugKinds 缓存——kind 可能随重载变(line/acp 模式重解析)。 */
  async reloadPlugs() {
    await this.ensureRunning();
    const r = await this.control.call("plug.reload");
    this.plugKinds = null;
    try {
      const list = await this.control.call("plug.list");
      this.plugKinds = new Map((list?.plugs ?? []).map((p) => [p.plugId, p.kind ?? "acp"]));
    } catch { /* 清单刷新失败不影响 reload 结果 */ }
    return r;
  }

  /** 开远程流 + 数据管道 + ACP initialize + session/new(+set_model)。 */
  async newSession(cwd, model) {
    // 会话建立整段 30s 硬超时:harnessd 半死时 task.open(控制连接挂)/initialize(数据连接半开)
    // 都会永久挂起,任务卡 queued 无终态(2026-10-17 08:49 实踩:卡 9 分钟)。
    const OPEN_TIMEOUT_MS = 30_000;
    let timer = null;
    const opened = { streamId: null };
    try {
      return await Promise.race([
        this.#openSession(cwd, model, opened),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error(`插头会话建立超时(${OPEN_TIMEOUT_MS / 1000}s):对端 harnessd 可能半死,重试即可`);
            err.openTimeout = true;
            reject(err);
          }, OPEN_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      // 尽力清理:task.open 已成功但后续挂起时,把远端的流关掉,避免泄漏
      if (opened.streamId && this.control) {
        try { await Promise.race([this.control.call("task.close", { streamId: opened.streamId }), new Promise((r) => setTimeout(r, 2000))]); } catch { /*  best-effort */ }
      }
      // 无论哪种失败,都重置控制连接 + 销毁数据连接:
      // ① 半死的控制连接会让后续 task.open 全部挂起(09:12 实踩)
      // ② 不销毁数据连接,远端的迟到响应会在 N 分钟后溜回来,把已失败任务的
      //    SDK 请求 resolve 掉(09:59 实踩:迟到 13 分钟),且 socket 泄漏
      try { this.control?.close(); } catch { /* 已断 */ }
      this.control = null;
      this.starting = null;
      if (opened?.dataConn) {
        try { opened.dataConn.destroy(); } catch { /* 已断 */ }
        opened.dataConn = null;
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #openSession(cwd, model, opened) {
    await this.ensureRunning();
    const openCall = () => this.control.call("task.open", {
      plugId: this.node.plugId,
      cwd: cwd ?? null,
    });
    let open;
    try {
      open = await openCall();
    } catch (error) {
      // 对端 idle 超时关控制连接:本地 socket 尚未处理到 close(closed 还是 false),
      // task.open 发出去才收到断开——2026-10-17 09:03 实踩(探针交替失败:
      // 失败一次把 control 清掉,下次重连成功,如此往复)。强制重连+重试一次。
      if (/控制连接已断开|ECONNRESET|EPIPE|socket hang up/i.test(String(error?.message ?? error))) {
        this.control = null;
        this.starting = null;
        await this.ensureRunning();
        open = await openCall();
      } else {
        throw error;
      }
    }
    const streamId = open?.streamId;
    // 防御(2026-10-17 16:06):对端 harnessd 在 spawn 失败时可能返回缺 streamId 的
    // result(而不是 JSON-RPC 错误)——拿着 undefined 继续走会让 attach 帧畸形、
    // 被对端秒关,表现为"initialize 失败:ACP connection closed"(死因不透明)。
    // 这里立即明确失败,把死因钉在 task.open 这一跳。
    if (!streamId || typeof streamId !== "string") {
      throw new Error(`plug task.open 响应缺 streamId(对端 harnessd 的 spawn 可能失败):${JSON.stringify(open).slice(0, 200)}`);
    }
    if (opened) opened.streamId = streamId;
    console.log(`[harness-mesh] plug 会话建立:task.open OK(stream=${streamId})`);

    const dataConn = await dialNode(this.node);
    if (opened) opened.dataConn = dataConn;   // 超时清理要销毁它(09:59 实踩:没销毁→13分钟后的迟到响应溜回来+socket 泄漏)
    console.log(`[harness-mesh] plug 会话建立:dial OK(stream=${streamId})`);
    // attach 帧(与数据同一连接的首帧)
    const attachBody = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "attach", params: { streamId } }), "utf8");
    const attachHeader = Buffer.alloc(4);
    attachHeader.writeUInt32BE(attachBody.length, 0);
    dataConn.write(Buffer.concat([attachHeader, attachBody]));

    // 原始字节探针(2026-10-17 09:48):区分"响应没到"vs"到了 SDK 没解析"——
    // 对端日志说 initialize 到了,但我侧 30s 没收到响应;这里记录数据连接
    // 上收到的前几块原始字节,断点定位到"管道"还是"SDK 解析"。
    let rawBytes = 0;
    let rawLogged = 0;
    dataConn.on("data", (chunk) => {
      rawBytes += chunk.length;
      if (rawLogged < 3) {
        rawLogged += 1;
        const head = chunk.toString("utf8", 0, Math.min(120, chunk.length)).replace(/\n/g, " ");
        console.log(`[harness-mesh] plug 原始字节#${rawLogged}(stream=${streamId}): +${chunk.length}B 累计${rawBytes}B | ${head}`);
      }
    });
    // 行协议插头(如 wb-ui:stdin 一行 JSON → stdout 一行 JSON):无 ACP 握手,
    // 自建行读取器,prompt() 直接写行等行。mesh 侧语义不变(响应走 agent_message_chunk)。
    if (this.plugKinds?.get(this.node.plugId) === "line") {
      const lineState = { buf: "", waiter: null };
      dataConn.on("data", (chunk) => {
        lineState.buf += chunk.toString("utf8");
        let idx;
        while ((idx = lineState.buf.indexOf("\n")) >= 0) {
          const line = lineState.buf.slice(0, idx).trim();
          lineState.buf = lineState.buf.slice(idx + 1);
          if (line && lineState.waiter) {
            const w = lineState.waiter;
            lineState.waiter = null;
            w(line);
          }
        }
      });
      const lineSessionId = `line-${streamId}`;
      this.sessions.set(lineSessionId, { streamId, dataConn, lineMode: true, lineState });
      console.log(`[harness-mesh] plug 行协议会话建立(stream=${streamId}, plug=${this.node.plugId})`);
      return lineSessionId;
    }

    const stream = ndJsonStream(Writable.toWeb(dataConn), Readable.toWeb(dataConn));
    const app = client({ name: "harness-mesh", version: "0.1.0" })
      .onNotification(CLIENT_METHODS.session_update, (context) => {
        this.hooks.onSessionUpdate(context.params);
      })
      .onRequest(CLIENT_METHODS.session_request_permission, async (context) => {
        return this.#handlePermission(context.params, context.signal);
      })
      .onRequest(CLIENT_METHODS.fs_write_text_file, async (context) => {
        await writeFile(context.params.path, context.params.content ?? "", "utf8");
        return {};
      })
      .onRequest(CLIENT_METHODS.fs_read_text_file, async (context) => {
        const { path, line, limit } = context.params;
        const full = await readFile(path, "utf8");
        if (line == null && limit == null) return { content: full };
        const lines = full.split("\n");
        const from = Math.max(0, (line ?? 1) - 1);
        const to = limit == null ? lines.length : from + limit;
        return { content: lines.slice(from, to).join("\n") };
      });
    const connection = app.connect(stream);

    let agentInfo;
    try {
      agentInfo = await connection.agent.request(AGENT_METHODS.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });
    } catch (error) {
      console.log(`[harness-mesh] plug 会话建立:initialize 失败(stream=${streamId})`);
      throw new Error(this.#remoteDeath(streamId, error));
    }
    console.log(`[harness-mesh] plug 会话建立:initialize OK(stream=${streamId})`);

    // 远程进程启动即退出:initialize 会因管道断开而失败,这里给出可读信息
    const res = await connection.agent.request(AGENT_METHODS.session_new, { cwd, mcpServers: [] });
    this.lastSessionNewRes = res;  // listModels 探测用:availableModels/configOptions 在这个响应里
    console.log(`[harness-mesh] session/new 响应键: ${Object.keys(res ?? {})} ${res?.configOptions ? `configOptions=${res.configOptions.length}` : ""}${res?.models ? "有models字段" : ""}`);
    console.log(`[harness-mesh] plug 会话建立:session/new OK(stream=${streamId})`);
    const sessionId = res.sessionId;
    this.sessions.set(sessionId, { streamId, dataConn, connection });
    dataConn.once("close", () => {
      this.sessions.delete(sessionId);
      this.hooks.onProcessExit?.("plug-stream-closed");
    });
    const effModel = model ?? this.node.model;
    if (effModel) {
      try {
        await connection.agent.request("session/set_model", { sessionId, modelId: effModel });
      } catch (error) {
        throw new Error(`harness-mesh: 节点 ${this.node.name} 设置模型 ${effModel} 失败: ${String(error?.message ?? error)}`);
      }
    }
    return sessionId;
  }

  /** 探测该 harness 的可用模型:开临时会话读 session/new 的 models 字段,读完 cancel 释放。 */
  async listModels(cwd) {
    const sessionId = await this.newSession(cwd ?? this.node.cwd ?? "/tmp", null);
    try { await this.cancel(sessionId); } catch { /* 尽力释放 */ }
    const res = this.lastSessionNewRes ?? {};
    // 两种形状都认:①标准 ACP res.models.availableModels;②opencode 方言 configOptions[category=model] 的 select(裸抓实测)
    const acp = res?.models?.availableModels ?? [];
    if (acp.length) {
      return {
        models: acp.map((m) => ({ modelId: String(m.modelId ?? ""), name: String(m.name ?? m.modelId ?? "") })).filter((m) => m.modelId),
        currentModelId: res?.models?.currentModelId ?? null,
      };
    }
    const opt = (res?.configOptions ?? []).find((o) => o?.category === "model" && Array.isArray(o.options));
    if (opt) {
      return {
        models: opt.options.map((o) => ({ modelId: String(o.value ?? ""), name: String(o.name ?? o.value ?? "") })).filter((m) => m.modelId),
        currentModelId: opt.currentValue ?? null,
      };
    }
    return { models: [], currentModelId: null };
  }

  /** 把远程进程死因织进错误信息(harnessd task.exit 回传的 code+stderr)。 */
  #remoteDeath(streamId, error) {
    const exit = this.exits.get(streamId);
    const base = `harness-mesh: plug ${this.node.name} ACP 握手失败: ${String(error?.message ?? error)}`;
    if (!exit) return base;
    const stderr = (exit.stderr ?? "").trim();
    return `${base} | 远程进程退出 code=${exit.code}(${exit.elapsed_ms}ms)${stderr ? ` stderr: ${stderr.slice(-300)}` : ""}`;
  }

  /** 权限请求 → MeshController 策略(与 stdio 适配器同一套语义)。 */
  async #handlePermission(params, signal) {
    let decision;
    try {
      decision = await this.hooks.resolvePermission(params, signal);
    } catch (error) {
      decision = { action: "reject", reason: `permission 决策异常: ${String(error)}` };
    }
    const options = params.options ?? [];
    if (decision.action === "allow") {
      const allow = options.find((o) => o.kind === "allow_once") ?? options[0];
      return allow ? { outcome: { outcome: "selected", optionId: allow.optionId } } : { outcome: { outcome: "cancelled" } };
    }
    const reject = options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind === "reject_always");
    return reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
  }

  async prompt(sessionId, text) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`harness-mesh: plug session ${sessionId} 已不存在(远程流可能已断)`);
    // 行协议模式:写一行,等一行(30s),响应作为 agent_message_chunk 回传
    //(mesh 的 summary 累加逻辑原样接住,零改动)。
    if (session.lineMode) {
      const lineP = new Promise((resolve, reject) => {
        let done = false;
        session.lineState.waiter = (line) => { if (!done) { done = true; resolve(line); } };
        // 行协议超时放宽到 300s:send 类命令要等模型完整跑完(实测 52s+);
        // 整体仍有 mesh 任务超时(默认 10min)兜底,不会永久挂。
        setTimeout(() => {
          if (!done) { done = true; if (session.lineState.waiter) session.lineState.waiter = null; reject(new Error("行协议响应超时(300s)")); }
        }, 300000).unref();
      });
      session.dataConn.write(text.endsWith("\n") ? text : `${text}\n`);
      const line = await lineP;
      let obj;
      try { obj = JSON.parse(line); } catch { obj = { raw: line }; }
      this.hooks.onSessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", messageId: "line-1", content: { type: "text", text: JSON.stringify(obj) } },
      });
      // 与 ACP 模式同规则(2026-10-19 补):mesh 每任务建新会话、从不复用,
      // 不关流 = 对端槽位泄漏;延迟 1s 放行尾部字节后 task.close + 断流。
      const sid = sessionId;
      setTimeout(() => { void this.#closeSession(sid); }, 1000).unref();
      return { stopReason: "end_turn" };
    }
    const response = await session.connection.agent.request(AGENT_METHODS.session_prompt, {
      sessionId,
      prompt: [{ type: "text", text }],
    });
    // 终态即关流:mesh 每任务建新会话、从不复用,留着流=泄漏对端槽位
    //(2026-10-17 09:08 实踩:流泄漏累积,对端 task.open 陆续挂起)。
    // 延迟 1s 放行尾部通知,然后 task.close + 断数据连接 + 清会话。
    const sid = sessionId;
    setTimeout(() => { void this.#closeSession(sid); }, 1000).unref();
    return response;
  }

  /** 关一条远程流:task.close(尽力)+ 断数据连接 + 清会话。幂等。 */
  async #closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.sessionIndexDelete?.(sessionId);
    try { session.dataConn.destroy(); } catch { /* 已断 */ }
    try {
      await Promise.race([
        this.control?.call("task.close", { streamId: session.streamId }),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    } catch { /* 控制连接可能已断,尽力而为 */ }
  }

  async cancel(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    try {
      await session.connection.agent.notify(AGENT_METHODS.session_cancel, { sessionId });
    } catch { /* 管道可能已断,忽略 */ }
    // 宽限 3s:agent 配合取消(prompt 会 resolve);不配合则强制断流+杀远程进程,
    // 保证 cancel 是确定性的(不会出现"取消了但任务永远 running")
    setTimeout(() => {
      if (!this.sessions.has(sessionId)) return;
      try { session.dataConn.destroy(); } catch { /* 已断 */ }
      void this.control?.call("task.close", { streamId: session.streamId }).catch(() => {});
      this.sessions.delete(sessionId);
    }, 3000).unref();
  }

  async dispose() {
    for (const [sessionId, session] of this.sessions) {
      try {
        await this.control?.call("task.close", { streamId: session.streamId });
      } catch { /* 控制连接可能已断 */ }
      try { session.dataConn.destroy(); } catch { /* 已断 */ }
      this.sessions.delete(sessionId);
    }
    this.control?.close();
    this.control = null;
  }
}
