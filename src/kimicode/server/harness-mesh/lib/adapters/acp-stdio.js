/** ACP over 本机 stdio 适配器:spawn `<command> <args>`(如 `opencode acp`),
 *  经 NDJSON stdio 桥接 ACP 协议(JSON-RPC)。
 *
 *  进程生命周期:首次 dispatch 时惰性 spawn + initialize,之后常驻复用
 *  (一个 agent 进程可挂多个 session,dispatch 间不重复起进程);
 *  插件卸载或进程退出时清理。跨机变体(acp-ssh)在 M4 增加,接口保持一致。
 *
 *  实现要点:
 *  - 用 SDK 现代 API(client().onNotification/onRequest + connect(stream));
 *  - session/update 通知按 sessionId 路由给 MeshController(一个进程多任务);
 *  - session/request_permission 交给 MeshController 的权限策略(人在环);
 *  - spawn 的 env 用全量 process.env + 节点 env 覆盖(被控 harness 需要自己的
 *    登录态/数据目录,不做凭据 scrub——那是 MCP client 的规则,不适用于此);
 *  - stderr inherit:被控进程的报错直接进 dreamx 日志,排障用。
 */
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { AGENT_METHODS, CLIENT_METHODS, PROTOCOL_VERSION, client, ndJsonStream } from "@agentclientprotocol/sdk";

export class AcpStdioAdapter {
  /** @param node 规范化后的节点配置 { name, type, command, args, cwd, env }
   *  @param hooks { onSessionUpdate(params), resolvePermission(params) -> Promise<{action, reason?}>, onProcessExit(code) } */
  constructor(node, hooks) {
    this.node = node;
    this.hooks = hooks;
    this.child = null;
    this.connection = null;
    this.agentInfo = null;
    /** 进行中的 initialize(惰性启动去重;失败即清,允许下次重试) */
    this.starting = null;
  }

  get alive() {
    return this.connection !== null;
  }

  /** 确保进程已起且 initialize 完成;返回 agentInfo。 */
  async ensureRunning() {
    if (this.connection) return this.agentInfo;
    if (!this.starting) {
      this.starting = this.#start().catch((error) => {
        this.starting = null;
        throw error;
      });
    }
    return this.starting;
  }

  async #start() {
    const child = spawn(this.node.command, this.node.args, {
      cwd: this.node.cwd ?? process.cwd(),
      env: { ...process.env, ...this.node.env },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    const app = client({ name: "harness-mesh", version: "0.1.0" })
      .onNotification(CLIENT_METHODS.session_update, (context) => {
        this.hooks.onSessionUpdate(context.params);
      })
      .onRequest(CLIENT_METHODS.session_request_permission, async (context) => {
        return this.#handlePermission(context.params, context.signal);
      })
      // opencode 的 write/read 工具(尤其在权限询问流程里)走 client fs 方法;
      // 不实现会拿到 -32601,被控进程陷入重试,任务永不收尾。
      .onRequest(CLIENT_METHODS.fs_write_text_file, async (context) => {
        const { path, content } = context.params;
        await writeFile(path, content ?? "", "utf8");
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

    // 进程在 initialize 前就退出:立刻失败,别挂住
    let exitedEarly = null;
    const onEarlyExit = (code) => { exitedEarly = code; };
    child.once("exit", onEarlyExit);

    // initialize 失败(协议不兼容/对端报错/超时)时,已 spawn 的子进程必须杀掉,
    // 否则进程泄漏:child 没赋给 this.child,dispose 也管不到它(2026-10-19 全量测试发现)。
    let agentInfo;
    try {
      agentInfo = await connection.agent.request(AGENT_METHODS.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      });
    } catch (error) {
      try { child.kill("SIGTERM"); } catch { /* 已退出 */ }
      throw error;
    }
    if (exitedEarly !== null) {
      throw new Error(`harness-mesh: 被控进程 ${this.node.command} 启动后即退出(code=${exitedEarly})`);
    }
    child.off("exit", onEarlyExit);
    child.on("exit", (code) => {
      this.connection = null;
      this.child = null;
      this.starting = null;
      this.agentInfo = null;
      this.hooks.onProcessExit?.(code);
    });

    this.child = child;
    this.connection = connection;
    this.agentInfo = agentInfo;
    return agentInfo;
  }

  /** 权限请求 → MeshController 策略决策 → ACP outcome。 */
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
      // 注意:RequestPermissionResponse = {outcome: Outcome},outcome 本体还要再嵌一层
      return allow ? { outcome: { outcome: "selected", optionId: allow.optionId } } : { outcome: { outcome: "cancelled" } };
    }
    const reject = options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind === "reject_always");
    return reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
  }

  async newSession(cwd, model) {
    await this.ensureRunning();
    const res = await this.connection.agent.request(AGENT_METHODS.session_new, { cwd, mcpServers: [] });
    this.lastSessionNewRes = res;  // listModels 探测用:availableModels/configOptions 在这个响应里
    console.log(`[harness-mesh] session/new 响应键: ${Object.keys(res ?? {})} ${res?.configOptions ? `configOptions=${res.configOptions.length}` : ""}${res?.models ? "有models字段" : ""}`);
    // 节点固定了模型(默认模型端点故障时可切到可用模型):session/set_model {sessionId, modelId}
    const effModel = model ?? this.node.model;
    if (effModel) {
      try {
        // 修正(2026-10-19):此前误传 this.node.model——按任务指定的模型被吞掉,
        // 节点无默认模型时甚至发 modelId:null。必须传生效值 effModel。
        await this.connection.agent.request("session/set_model", { sessionId: res.sessionId, modelId: effModel });
      } catch (error) {
        throw new Error(`harness-mesh: 节点 ${this.node.name} 设置模型 ${effModel} 失败: ${String(error?.message ?? error)}`);
      }
    }
    return res.sessionId;
  }

  /** 探测该 harness 的可用模型:开临时会话读 session/new 的 models 字段,读完 cancel 释放。
   * @returns {{models: Array<{modelId: string, name: string}>, currentModelId: string|null}} */
  async listModels(cwd) {
    const sessionId = await this.newSession(cwd ?? this.node.cwd ?? process.cwd(), null);
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

  /** 发起一轮 prompt;整个回合(含权限交互)完成后才 resolve。 */
  async prompt(sessionId, text) {
    await this.ensureRunning();
    return this.connection.agent.request(AGENT_METHODS.session_prompt, {
      sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  async cancel(sessionId) {
    if (!this.connection) return;
    try {
      await this.connection.agent.notify(AGENT_METHODS.session_cancel, { sessionId });
    } catch { /* 进程可能已退出,忽略 */ }
  }

  async dispose() {
    const child = this.child;
    this.connection = null;
    this.child = null;
    this.starting = null;
    this.agentInfo = null;
    if (child) {
      try { child.kill("SIGTERM"); } catch { /* 已退出 */ }
    }
  }
}
