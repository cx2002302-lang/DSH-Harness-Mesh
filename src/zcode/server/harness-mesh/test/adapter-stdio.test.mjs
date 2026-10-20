/** AcpStdioAdapter 单元测试(lib/adapters/acp-stdio.js)。
 *
 *  手法:node:module.registerHooks 把 "node:child_process" 重定向到一个假模块,
 *  spawn 返回 EventEmitter + PassThrough 组成的假子进程——不起真进程、不碰网络。
 *  假 agent(FakeAgent)挂在假子进程的 stdin/stdout 上,按 NDJSON 协议与被测适配器对话,
 *  因此 SDK 的帧解析/请求配对都是真实代码路径,重点覆盖粘包、半包、坏帧。
 *
 *  运行:node --test test/adapter-stdio.test.mjs
 */
import { registerHooks } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// 假 child_process:loader hook 与测试线程共享 globalThis(registerHooks 是同线程钩子)
// ---------------------------------------------------------------------------
process.env.DSH_TEST_ENV_MARKER = "from-process-env";

globalThis.__acpStdioFake = {
  children: [],
  spawn(command, args, options) {
    const child = new EventEmitter();
    child.command = command;
    child.args = args;
    child.killedWith = [];
    child.stdin = new PassThrough(); // 适配器写 → 假 agent 读
    child.stdout = new PassThrough(); // 假 agent 写 → 适配器读
    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});
    child.kill = (signal) => {
      child.killedWith.push(signal);
      return true;
    };
    this.children.push({ command, args, options, child });
    return child;
  },
};

const FAKE_CHILD_PROCESS_SRC = `export function spawn(command, args, options) {
  return globalThis.__acpStdioFake.spawn(command, args, options);
}`;

// 必须在 import 适配器之前注册:之后 import 的 lib/adapters/acp-stdio.js 拿到的就是假 spawn。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "node:child_process") {
      return { url: "acp-stdio-test:fake-child-process", shortCircuit: true, format: "module" };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "acp-stdio-test:fake-child-process") {
      return { format: "module", source: FAKE_CHILD_PROCESS_SRC, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { AcpStdioAdapter } = await import("../lib/adapters/acp-stdio.js");

const fake = globalThis.__acpStdioFake;

// ---------------------------------------------------------------------------
// 假 agent:解析适配器写出的 NDJSON,可向适配器注入任意帧(含半包/坏帧)
// ---------------------------------------------------------------------------
class FakeAgent {
  constructor(child) {
    this.child = child;
    this.received = []; // 适配器发来的所有已解析消息
    this.waiters = [];
    this.buffer = "";
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (chunk) => this.#onData(chunk));
  }

  #onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let message = null;
      try {
        message = JSON.parse(line);
      } catch {
        message = { __unparseable: line };
      }
      this.received.push(message);
      const hit = this.waiters.findIndex((w) => w.pred(message));
      if (hit !== -1) {
        const [waiter] = this.waiters.splice(hit, 1);
        waiter.resolve(message);
      }
    }
  }

  /** 事件驱动等待(无 sleep);匹配已收到的消息或未来的消息。 */
  waitFor(pred, timeout = 2000) {
    const found = this.received.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const done = (message) => {
        clearTimeout(timer);
        resolve(message);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== done);
        reject(new Error(`假 agent 等待超时: ${String(pred)}`));
      }, timeout);
      this.waiters.push({ pred, resolve: done });
    });
  }

  send(obj) {
    this.child.stdout.write(`${JSON.stringify(obj)}\n`);
  }

  sendRaw(text) {
    this.child.stdout.write(text);
  }

  sendBytes(bytes) {
    this.child.stdout.write(bytes);
  }

  respond(request, result) {
    this.send({ jsonrpc: "2.0", id: request.id, result });
  }

  fail(request, error) {
    this.send({ jsonrpc: "2.0", id: request.id, error });
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  count(method) {
    return this.received.filter((m) => m.method === method).length;
  }
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
const OPT = {
  allowOnce: { optionId: "opt-allow-once", name: "允许一次", kind: "allow_once" },
  allowAlways: { optionId: "opt-allow-always", name: "总是允许", kind: "allow_always" },
  rejectOnce: { optionId: "opt-reject-once", name: "拒绝一次", kind: "reject_once" },
  rejectAlways: { optionId: "opt-reject-always", name: "总是拒绝", kind: "reject_always" },
};

let nextId = 5000;

function createHooks({ onPermission, onUpdate } = {}) {
  const hooks = {
    updates: [],
    updateWaiters: [],
    permissions: [],
    exits: [],
    onSessionUpdate: (params) => {
      hooks.updates.push(params);
      onUpdate?.(params);
      const hit = hooks.updateWaiters.findIndex((w) => w.pred(params));
      if (hit !== -1) {
        const [waiter] = hooks.updateWaiters.splice(hit, 1);
        waiter.resolve(params);
      }
    },
    /** 事件驱动等待某条 session/update 被路由进来(无 sleep)。 */
    waitForUpdate(pred, timeout = 2000) {
      const found = hooks.updates.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const done = (params) => {
          clearTimeout(timer);
          resolve(params);
        };
        const timer = setTimeout(() => {
          hooks.updateWaiters = hooks.updateWaiters.filter((w) => w.resolve !== done);
          reject(new Error(`等待 session/update 超时: ${String(pred)}`));
        }, timeout);
        hooks.updateWaiters.push({ pred, resolve: done });
      });
    },
    resolvePermission: async (params, signal) => {
      hooks.permissions.push({ params, signal });
      return onPermission ? onPermission(params, signal) : { action: "reject" };
    },
    onProcessExit: (code) => {
      hooks.exits.push(code);
    },
  };
  return hooks;
}

function makeAdapter(nodeOverrides = {}, hookOverrides = {}) {
  const node = { name: "t-node", command: "fake-agent", args: ["acp"], ...nodeOverrides };
  const hooks = createHooks(hookOverrides);
  const adapter = new AcpStdioAdapter(node, hooks);
  return { adapter, node, hooks };
}

function attachAgent() {
  return new FakeAgent(fake.children.at(-1).child);
}

/** 起适配器并完成 initialize 握手(握手全部落定后才返回)。 */
async function boot(nodeOverrides = {}, hookOverrides = {}, initResult) {
  const made = makeAdapter(nodeOverrides, hookOverrides);
  const running = made.adapter.ensureRunning();
  running.catch(() => {}); // 防未处理 rejection 拖垮进程;断言仍可用 assert.rejects(running)
  const agent = attachAgent();
  const init = await agent.waitFor((m) => m.method === "initialize");
  agent.respond(init, initResult ?? { protocolVersion: 1, agentCapabilities: { promptCapabilities: {} } });
  await running;
  return { ...made, agent, running, init };
}

/** 冲刷 stream/微任务队列(不是 sleep,用于"尚未投递"的确定性负向断言)。 */
async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

let tmpDir = null;

afterEach(async () => {
  for (const { child } of fake.children) {
    child.stdin.destroy();
    child.stdout.destroy();
  }
  fake.children.length = 0;
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

// ---------------------------------------------------------------------------
describe("构造与初始状态", () => {
  test("初始 alive=false,内部状态为空,不 spawn", () => {
    const { adapter } = makeAdapter();
    assert.equal(adapter.alive, false);
    assert.equal(adapter.child, null);
    assert.equal(adapter.connection, null);
    assert.equal(adapter.agentInfo, null);
    assert.equal(adapter.starting, null);
    assert.equal(fake.children.length, 0, "构造阶段不应 spawn");
  });
});

// ---------------------------------------------------------------------------
describe("ensureRunning:惰性 spawn 与 initialize", () => {
  test("spawn 参数:command/args/cwd/stdio,env 为 process.env + node.env(node.env 覆盖)", async () => {
    const { adapter } = makeAdapter({
      command: "opencode",
      args: ["acp", "--verbose"],
      cwd: "/work/dir",
      env: { AGENT_TOKEN: "tok", DSH_TEST_ENV_MARKER: "from-node-env" },
    });
    const running = adapter.ensureRunning();
    running.catch(() => {});
    assert.equal(fake.children.length, 1, "ensureRunning 应触发一次 spawn");
    const { command, args, options } = fake.children[0];
    assert.equal(command, "opencode");
    assert.deepEqual(args, ["acp", "--verbose"]);
    assert.equal(options.cwd, "/work/dir");
    assert.deepEqual(options.stdio, ["pipe", "pipe", "inherit"]);
    assert.equal(options.env.AGENT_TOKEN, "tok", "node.env 应合并进去");
    assert.equal(options.env.DSH_TEST_ENV_MARKER, "from-node-env", "node.env 应覆盖 process.env");
    assert.equal(typeof options.env.PATH, "string", "process.env 应保留");
    const agent = attachAgent();
    const init = await agent.waitFor((m) => m.method === "initialize");
    agent.respond(init, { protocolVersion: 1, agentCapabilities: {} });
    await running;
  });

  test("缺 cwd 时回落 process.cwd()", async () => {
    const { adapter } = makeAdapter({ command: "x" });
    const running = adapter.ensureRunning();
    running.catch(() => {});
    assert.equal(fake.children[0].options.cwd, process.cwd());
    const agent = attachAgent();
    const init = await agent.waitFor((m) => m.method === "initialize");
    agent.respond(init, { protocolVersion: 1 });
    await running;
  });

  test("initialize 请求体带 protocolVersion 与 fs 客户端能力;成功后 alive 并返回 agentInfo", async () => {
    const agentInfo = { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } };
    const { adapter, agent, running, init } = await boot({}, {}, agentInfo);
    assert.equal(init.params.protocolVersion, 1);
    assert.deepEqual(init.params.clientCapabilities, { fs: { readTextFile: true, writeTextFile: true } });
    assert.deepEqual(await running, agentInfo);
    assert.deepEqual(adapter.agentInfo, agentInfo); // 过 stream 后被结构化克隆,比结构不比引用
    assert.equal(adapter.alive, true);
    assert.equal(adapter.child, fake.children[0].child);
  });

  test("并发 ensureRunning 去重:只 spawn 一次,两个调用拿到同一结果", async () => {
    const { adapter } = makeAdapter();
    const p1 = adapter.ensureRunning();
    const p2 = adapter.ensureRunning();
    assert.equal(fake.children.length, 1);
    const agent = attachAgent();
    const init = await agent.waitFor((m) => m.method === "initialize");
    agent.respond(init, { protocolVersion: 1 });
    assert.equal(await p1, await p2, "去重后两个调用应 resolve 到同一 agentInfo");
    assert.equal(fake.children.length, 1, "handshake 不应再 spawn");
  });

  test("initialize 被 agent 拒绝 → ensureRunning reject,starting 清空,可重试", async () => {
    const { adapter } = makeAdapter();
    const running = adapter.ensureRunning();
    running.catch(() => {});
    const agent = attachAgent();
    const init = await agent.waitFor((m) => m.method === "initialize");
    agent.fail(init, { code: -32000, message: "init refused" });
    await assert.rejects(running, /init refused/);
    assert.equal(adapter.starting, null, "失败后 starting 必须清掉(允许下次重试)");
    assert.equal(adapter.alive, false);

    // 重试:重新 spawn 并成功
    const retry = adapter.ensureRunning();
    retry.catch(() => {});
    assert.equal(fake.children.length, 2, "重试应重新 spawn");
    const agent2 = attachAgent();
    const init2 = await agent2.waitFor((m) => m.method === "initialize");
    agent2.respond(init2, { protocolVersion: 1 });
    await retry;
    assert.equal(adapter.alive, true);
  });

  test("进程在 initialize 前退出且流关闭 → 立刻失败(ACP connection closed)", async () => {
    const { adapter } = makeAdapter();
    const running = adapter.ensureRunning();
    running.catch(() => {});
    const child = fake.children.at(-1).child;
    const agent = attachAgent();
    await agent.waitFor((m) => m.method === "initialize");
    // 真实进程退出:stdout EOF + exit 事件
    child.stdout.end();
    child.emit("exit", 3, null);
    await assert.rejects(running, /connection closed|启动后即退出/);
    assert.equal(adapter.starting, null);
    assert.equal(adapter.alive, false);
  });

  test("进程先退出、initialize 响应后到 → 抛出自定义的“启动后即退出”错误", async () => {
    const { adapter } = makeAdapter({ command: "opencode" });
    const running = adapter.ensureRunning();
    running.catch(() => {});
    const child = fake.children.at(-1).child;
    const agent = attachAgent();
    const init = await agent.waitFor((m) => m.method === "initialize");
    child.emit("exit", 3, null); // 退出事件先于响应
    agent.respond(init, { protocolVersion: 1 });
    await assert.rejects(running, /启动后即退出\(code=3\)/);
    assert.equal(adapter.starting, null);
    assert.equal(adapter.child, null, "启动失败不应留下 child");
    assert.equal(adapter.alive, false);
  });

  test("进程被信号杀死(code=null)时 initialize 挂起 → 流关闭兜底,不会误报成功", async () => {
    const { adapter } = makeAdapter();
    const running = adapter.ensureRunning();
    running.catch(() => {});
    const child = fake.children.at(-1).child;
    const agent = attachAgent();
    await agent.waitFor((m) => m.method === "initialize");
    child.stdout.end();
    child.emit("exit", null, "SIGTERM");
    await assert.rejects(running);
    assert.equal(adapter.alive, false, "死进程不能被标记为 alive");
  });

  test("initialize 被拒绝后,已 spawn 的子进程被 SIGTERM 回收(2026-10-19 修复:原泄漏)", async () => {
    const { adapter } = makeAdapter();
    const running = adapter.ensureRunning();
    running.catch(() => {});
    const child = fake.children.at(-1).child;
    const agent = attachAgent();
    const init = await agent.waitFor((m) => m.method === "initialize");
    agent.fail(init, { code: -32000, message: "init refused" });
    await assert.rejects(running, /init refused/);
    // 修复后行为:#start() 的 initialize 失败路径显式 child.kill("SIGTERM"),
    // 不再泄漏——此时 this.child 还没赋值,dispose 管不到,必须就地杀。
    assert.deepEqual(child.killedWith, ["SIGTERM"], "启动失败后子进程必须被 SIGTERM");
    await adapter.dispose();
  });
});

// ---------------------------------------------------------------------------
describe("进程退出清理", () => {
  test("运行中 exit → 状态清空、onProcessExit 收 code、再次 ensureRunning 重新 spawn", async () => {
    const { adapter, hooks } = await boot();
    const firstChild = fake.children.at(-1).child;
    assert.equal(adapter.alive, true);
    firstChild.emit("exit", 0, null);
    assert.equal(adapter.alive, false);
    assert.equal(adapter.child, null);
    assert.equal(adapter.connection, null);
    assert.equal(adapter.agentInfo, null);
    assert.deepEqual(hooks.exits, [0]);

    // 惰性重启
    const running = adapter.ensureRunning();
    running.catch(() => {});
    assert.equal(fake.children.length, 2);
    const agent = attachAgent();
    const init = await agent.waitFor((m) => m.method === "initialize");
    agent.respond(init, { protocolVersion: 1 });
    await running;
    assert.equal(adapter.alive, true);
  });

  test("hooks 缺 onProcessExit 时 exit 不炸", async () => {
    const adapter = new AcpStdioAdapter({ name: "n", command: "c" }, { onSessionUpdate: () => {}, resolvePermission: async () => ({}) });
    const running = adapter.ensureRunning();
    running.catch(() => {});
    const agent = attachAgent();
    const init = await agent.waitFor((m) => m.method === "initialize");
    agent.respond(init, { protocolVersion: 1 });
    await running;
    fake.children.at(-1).child.emit("exit", 1, null);
    assert.equal(adapter.alive, false);
  });
});

// ---------------------------------------------------------------------------
describe("newSession", () => {
  test("正常路径:发 session/new {cwd, mcpServers:[]},返回 sessionId", async () => {
    const { adapter, agent } = await boot();
    const p = adapter.newSession("/repo", undefined);
    const req = await agent.waitFor((m) => m.method === "session/new");
    assert.equal(req.params.cwd, "/repo");
    assert.deepEqual(req.params.mcpServers, []);
    agent.respond(req, { sessionId: "sess-1" });
    assert.equal(await p, "sess-1");
  });

  test("node.model 存在 → 追加 session/set_model 传生效模型", async () => {
    const { adapter, agent } = await boot({ model: "opencode/deepseek-v4" });
    const p = adapter.newSession("/repo", undefined);
    const reqNew = await agent.waitFor((m) => m.method === "session/new");
    agent.respond(reqNew, { sessionId: "sess-2" });
    const reqModel = await agent.waitFor((m) => m.method === "session/set_model");
    assert.deepEqual(reqModel.params, { sessionId: "sess-2", modelId: "opencode/deepseek-v4" });
    agent.respond(reqModel, {});
    assert.equal(await p, "sess-2");
  });

  test("任务指定模型覆盖 node.model(2026-10-19 修复:不能吞掉任务模型)", async () => {
    const { adapter, agent } = await boot({ model: "node/default" });
    const p = adapter.newSession("/repo", "task/model");
    const reqNew = await agent.waitFor((m) => m.method === "session/new");
    agent.respond(reqNew, { sessionId: "sess-3" });
    const reqModel = await agent.waitFor((m) => m.method === "session/set_model");
    assert.equal(reqModel.params.modelId, "task/model");
    agent.respond(reqModel, {});
    assert.equal(await p, "sess-3");
  });

  test("节点与任务都无模型 → 不发 session/set_model", async () => {
    const { adapter, agent } = await boot();
    const p = adapter.newSession("/repo", undefined);
    const reqNew = await agent.waitFor((m) => m.method === "session/new");
    agent.respond(reqNew, { sessionId: "sess-4" });
    assert.equal(await p, "sess-4");
    // newSession 已 resolve,此时若还会发 set_model 必然已到达——确定性负向断言
    assert.equal(agent.count("session/set_model"), 0);
  });

  test("session/set_model 失败 → 包装成带节点名的错误", async () => {
    const { adapter, agent } = await boot({ name: "winpc-206", model: "m/x" });
    const p = adapter.newSession("/repo", undefined);
    const reqNew = await agent.waitFor((m) => m.method === "session/new");
    agent.respond(reqNew, { sessionId: "sess-5" });
    const reqModel = await agent.waitFor((m) => m.method === "session/set_model");
    agent.fail(reqModel, { code: -32001, message: "no such model" });
    await assert.rejects(p, /harness-mesh: 节点 winpc-206 设置模型 m\/x 失败: no such model/);
  });

  test("agent 回了缺 sessionId 的坏响应且无模型 → newSession resolve 为 undefined(不瞎抛)", async () => {
    const { adapter, agent } = await boot();
    const p = adapter.newSession("/repo", undefined);
    const reqNew = await agent.waitFor((m) => m.method === "session/new");
    agent.respond(reqNew, {});
    assert.equal(await p, undefined);
  });

  test("listModels:opencode 方言 configOptions[category=model] → 模型清单+当前值", async () => {
    const { adapter, agent } = await boot();
    const p = adapter.listModels("/repo");
    const reqNew = await agent.waitFor((m) => m.method === "session/new");
    agent.respond(reqNew, {
      sessionId: "sess-m1",
      configOptions: [
        { id: "mode", category: "mode", type: "select", currentValue: "build", options: [{ value: "build", name: "Build" }] },
        { id: "model", category: "model", type: "select", currentValue: "zai/glm-5.3",
          options: [{ value: "zai/glm-5.3", name: "GLM 5.3" }, { value: "opencode/deepseek-v4.1", name: "DeepSeek 4.1" }] },
      ],
    });
    const r = await p;
    assert.deepEqual(r.models, [
      { modelId: "zai/glm-5.3", name: "GLM 5.3" },
      { modelId: "opencode/deepseek-v4.1", name: "DeepSeek 4.1" },
    ]);
    assert.equal(r.currentModelId, "zai/glm-5.3");
  });

  test("listModels:标准 ACP models.availableModels 优先;都没有 → 空清单不抛错", async () => {
    const { adapter, agent } = await boot();
    const p = adapter.listModels("/repo");
    const reqNew = await agent.waitFor((m) => m.method === "session/new");
    agent.respond(reqNew, {
      sessionId: "sess-m2",
      models: { availableModels: [{ modelId: "a/1", name: "A1" }], currentModelId: "a/1" },
      configOptions: [{ id: "model", category: "model", options: [{ value: "x/9", name: "X9" }] }],  // 方言也在,但标准优先
    });
    const r = await p;
    assert.deepEqual(r.models, [{ modelId: "a/1", name: "A1" }]);
    assert.equal(r.currentModelId, "a/1");

  });

  test("listModels:两种形状都没有 → 空清单不抛错", async () => {
    const { adapter, agent } = await boot();
    const p = adapter.listModels("/repo");
    const reqNew = await agent.waitFor((m) => m.method === "session/new");
    agent.respond(reqNew, { sessionId: "sess-m3" });
    const r = await p;
    assert.deepEqual(r, { models: [], currentModelId: null });
  });

  test("未启动时 newSession 自动 ensureRunning", async () => {
    const { adapter } = makeAdapter();
    const p = adapter.newSession("/repo", undefined);
    assert.equal(fake.children.length, 1, "newSession 应惰性 spawn");
    const agent = attachAgent();
    const init = await agent.waitFor((m) => m.method === "initialize");
    agent.respond(init, { protocolVersion: 1 });
    const reqNew = await agent.waitFor((m) => m.method === "session/new");
    agent.respond(reqNew, { sessionId: "sess-6" });
    assert.equal(await p, "sess-6");
  });
});

// ---------------------------------------------------------------------------
describe("prompt", () => {
  test("正常路径:prompt 体为 text content block,resolve agent 的 stopReason", async () => {
    const { adapter, agent } = await boot();
    const p = adapter.prompt("sess-1", "把登录页改成暗色");
    const req = await agent.waitFor((m) => m.method === "session/prompt");
    assert.equal(req.params.sessionId, "sess-1");
    assert.deepEqual(req.params.prompt, [{ type: "text", text: "把登录页改成暗色" }]);
    agent.respond(req, { stopReason: "end_turn" });
    assert.deepEqual(await p, { stopReason: "end_turn" });
  });

  test("未启动时 prompt 自动 ensureRunning", async () => {
    const { adapter } = makeAdapter();
    const p = adapter.prompt("sess-1", "hi");
    assert.equal(fake.children.length, 1);
    const agent = attachAgent();
    const init = await agent.waitFor((m) => m.method === "initialize");
    agent.respond(init, { protocolVersion: 1 });
    const req = await agent.waitFor((m) => m.method === "session/prompt");
    agent.respond(req, { stopReason: "cancelled" });
    assert.deepEqual(await p, { stopReason: "cancelled" });
  });

  test("agent 回 error → prompt reject 且错误透传", async () => {
    const { adapter, agent } = await boot();
    const p = adapter.prompt("sess-1", "boom");
    const req = await agent.waitFor((m) => m.method === "session/prompt");
    agent.fail(req, { code: -32000, message: "agent exploded" });
    await assert.rejects(p, /agent exploded/);
    assert.equal(adapter.alive, true, "单轮失败不影响连接");
  });

  test("并发 in-flight 乱序回应:请求/响应按 id 正确配对", async () => {
    const { adapter, agent } = await boot();
    const pPrompt = adapter.prompt("sess-1", "乱序-prompt");
    const pNew = adapter.newSession("/乱序-cwd", undefined);
    const reqPrompt = await agent.waitFor((m) => m.method === "session/prompt");
    const reqNew = await agent.waitFor((m) => m.method === "session/new" && m.params.cwd === "/乱序-cwd");
    assert.equal(reqPrompt.id === reqNew.id, false, "两个请求 id 必须不同");
    // 故意乱序:先回 session/new,再回 session/prompt
    agent.respond(reqNew, { sessionId: "sess-乱序" });
    agent.respond(reqPrompt, { stopReason: "end_turn" });
    assert.equal(await pNew, "sess-乱序");
    assert.deepEqual(await pPrompt, { stopReason: "end_turn" });
  });

  test("未知 id 的响应被忽略,不污染后续配对", async () => {
    const { adapter, agent } = await boot();
    agent.send({ jsonrpc: "2.0", id: 999999, result: { ghost: true } });
    await flush();
    const p = adapter.prompt("sess-1", "还在吗");
    const req = await agent.waitFor((m) => m.method === "session/prompt");
    agent.respond(req, { stopReason: "end_turn" });
    assert.deepEqual(await p, { stopReason: "end_turn" });
    assert.equal(adapter.alive, true);
  });
});

// ---------------------------------------------------------------------------
describe("cancel", () => {
  test("运行中 cancel → 发 session/cancel 通知 {sessionId} 并 resolve", async () => {
    const { adapter, agent } = await boot();
    await adapter.cancel("sess-1");
    const msg = agent.received.filter((m) => m.method === "session/cancel").pop();
    assert.ok(msg, "应发出 session/cancel");
    assert.equal(msg.params.sessionId, "sess-1");
    assert.equal(agent.count("session/cancel"), 1);
  });

  test("未启动时 cancel 直接返回,不 spawn", async () => {
    const { adapter } = makeAdapter();
    await adapter.cancel("sess-1");
    assert.equal(fake.children.length, 0);
  });

  test("notify 抛错(进程已死)时 cancel 吞错 resolve", async () => {
    const { adapter } = await boot();
    // 桩一个必抛的 connection:真实场景里子进程死后 notify 会 reject,适配器必须忽略
    adapter.connection = { agent: { notify: async () => { throw new Error("child gone"); } } };
    await adapter.cancel("sess-1");
    assert.equal(adapter.alive, true, "cancel 失败不影响 alive 语义");
  });
});

// ---------------------------------------------------------------------------
describe("权限请求(session/request_permission)", () => {
  async function askPermission(agent, options, decision) {
    const id = nextId++;
    agent.send({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: { sessionId: "sess-1", toolCall: { toolCallId: `tc-${id}` }, options },
    });
    return agent.waitFor((m) => m.id === id && m.result !== undefined);
  }

  test("allow + 有 allow_once → selected(allow_once.optionId),且收到 AbortSignal", async () => {
    const { agent, hooks } = await boot({}, {
      onPermission: async () => ({ action: "allow" }),
    });
    const resp = await askPermission(agent, [OPT.rejectOnce, OPT.allowOnce], undefined);
    assert.deepEqual(resp.result, { outcome: { outcome: "selected", optionId: "opt-allow-once" } });
    assert.ok(hooks.permissions[0].signal instanceof AbortSignal, "resolvePermission 应收到 signal");
  });

  test("allow + 无 allow_once → 回落 options[0]", async () => {
    const { agent } = await boot({}, { onPermission: async () => ({ action: "allow" }) });
    const resp = await askPermission(agent, [OPT.rejectOnce, OPT.rejectAlways], undefined);
    assert.deepEqual(resp.result, { outcome: { outcome: "selected", optionId: "opt-reject-once" } });
  });

  test("allow + 空 options → cancelled", async () => {
    const { agent } = await boot({}, { onPermission: async () => ({ action: "allow" }) });
    const resp = await askPermission(agent, [], undefined);
    assert.deepEqual(resp.result, { outcome: { outcome: "cancelled" } });
  });

  test("reject + 有 reject_once → selected(reject_once.optionId)", async () => {
    const { agent } = await boot({}, { onPermission: async () => ({ action: "reject", reason: "策略不允许" }) });
    const resp = await askPermission(agent, [OPT.allowOnce, OPT.rejectOnce, OPT.rejectAlways], undefined);
    assert.deepEqual(resp.result, { outcome: { outcome: "selected", optionId: "opt-reject-once" } });
  });

  test("reject + 无 reject_once 有 reject_always → selected(reject_always)", async () => {
    const { agent } = await boot({}, { onPermission: async () => ({ action: "reject" }) });
    const resp = await askPermission(agent, [OPT.allowOnce, OPT.rejectAlways], undefined);
    assert.deepEqual(resp.result, { outcome: { outcome: "selected", optionId: "opt-reject-always" } });
  });

  test("reject + 无任何 reject 选项 → cancelled", async () => {
    const { agent } = await boot({}, { onPermission: async () => ({ action: "reject" }) });
    const resp = await askPermission(agent, [OPT.allowOnce, OPT.allowAlways], undefined);
    assert.deepEqual(resp.result, { outcome: { outcome: "cancelled" } });
  });

  test("reject + 缺 options 字段 → cancelled(不炸)", async () => {
    const { agent } = await boot({}, { onPermission: async () => ({ action: "reject" }) });
    const id = nextId++;
    agent.send({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: { sessionId: "sess-1", toolCall: { toolCallId: `tc-${id}` }, options: [] },
    });
    const resp = await agent.waitFor((m) => m.id === id && m.result !== undefined);
    assert.deepEqual(resp.result, { outcome: { outcome: "cancelled" } });
  });

  test("resolvePermission 抛异常 → 降级为 reject 并选中 reject 选项", async () => {
    const { agent } = await boot({}, {
      onPermission: async () => { throw new Error("policy down"); },
    });
    const resp = await askPermission(agent, [OPT.allowOnce, OPT.rejectOnce], undefined);
    assert.deepEqual(resp.result, { outcome: { outcome: "selected", optionId: "opt-reject-once" } });
  });

  test("decision.action 是未知值 → 走 reject 分支", async () => {
    const { agent } = await boot({}, { onPermission: async () => ({ action: "ask_later" }) });
    const resp = await askPermission(agent, [OPT.allowOnce, OPT.rejectOnce], undefined);
    assert.deepEqual(resp.result, { outcome: { outcome: "selected", optionId: "opt-reject-once" } });
  });

  test("权限请求的 params 原样透传给 hooks", async () => {
    const { agent, hooks } = await boot({}, { onPermission: async () => ({ action: "allow" }) });
    const id = nextId++;
    const params = {
      sessionId: "sess-9",
      toolCall: { toolCallId: "tc-9", title: "rm -rf" },
      options: [OPT.allowOnce],
    };
    agent.send({ jsonrpc: "2.0", id, method: "session/request_permission", params });
    await agent.waitFor((m) => m.id === id && m.result !== undefined);
    assert.deepEqual(hooks.permissions[0].params, params);
  });
});

// ---------------------------------------------------------------------------
describe("客户端 fs 方法(fs/write_text_file、fs/read_text_file)", () => {
  async function tmp() {
    tmpDir = await mkdtemp(join(tmpdir(), "acp-stdio-test-"));
    return tmpDir;
  }

  test("fs/write_text_file 正常落盘并回 {}", async () => {
    const dir = await tmp();
    const file = join(dir, "out.txt");
    const { agent } = await boot();
    const id = nextId++;
    agent.send({ jsonrpc: "2.0", id, method: "fs/write_text_file", params: { sessionId: "s", path: file, content: "你好 acp" } });
    const resp = await agent.waitFor((m) => m.id === id);
    assert.deepEqual(resp.result, {});
    assert.equal(await readFile(file, "utf8"), "你好 acp");
  });

  test("fs/write_text_file 缺 content 字段 → 协议层校验拒绝,不写文件", async () => {
    const dir = await tmp();
    const file = join(dir, "never.txt");
    const { agent } = await boot();
    const id = nextId++;
    agent.send({ jsonrpc: "2.0", id, method: "fs/write_text_file", params: { sessionId: "s", path: file } });
    const resp = await agent.waitFor((m) => m.id === id);
    assert.ok(resp.error, "缺 content 应得到 error 响应");
    assert.equal(resp.error.code, -32602, "参数校验失败 → invalid params");
    await assert.rejects(access(file), /ENOENT/);
  });

  test("fs/read_text_file 全文读取", async () => {
    const dir = await tmp();
    const file = join(dir, "src.txt");
    await writeFile(file, "L1\nL2\nL3\n", "utf8");
    const { agent } = await boot();
    const id = nextId++;
    agent.send({ jsonrpc: "2.0", id, method: "fs/read_text_file", params: { sessionId: "s", path: file } });
    const resp = await agent.waitFor((m) => m.id === id && m.result !== undefined);
    assert.deepEqual(resp.result, { content: "L1\nL2\nL3\n" });
  });

  test("fs/read_text_file line/limit 切片(line 为 1 基,截取 [line, line+limit))", async () => {
    const dir = await tmp();
    const file = join(dir, "src.txt");
    await writeFile(file, "L1\nL2\nL3\nL4\nL5\n", "utf8");
    const { agent } = await boot();
    const id = nextId++;
    agent.send({ jsonrpc: "2.0", id, method: "fs/read_text_file", params: { sessionId: "s", path: file, line: 2, limit: 2 } });
    const resp = await agent.waitFor((m) => m.id === id && m.result !== undefined);
    assert.deepEqual(resp.result, { content: "L2\nL3" });
  });

  test("fs/read_text_file line 超出文件行数 → 空 content", async () => {
    const dir = await tmp();
    const file = join(dir, "src.txt");
    await writeFile(file, "L1\nL2\n", "utf8");
    const { agent } = await boot();
    const id = nextId++;
    agent.send({ jsonrpc: "2.0", id, method: "fs/read_text_file", params: { sessionId: "s", path: file, line: 99, limit: 5 } });
    const resp = await agent.waitFor((m) => m.id === id && m.result !== undefined);
    assert.deepEqual(resp.result, { content: "" });
  });

  test("fs/read_text_file 文件不存在 → error 响应(ENOENT 不炸连接)", async () => {
    const dir = await tmp();
    const { agent, adapter } = await boot();
    const id = nextId++;
    agent.send({ jsonrpc: "2.0", id, method: "fs/read_text_file", params: { sessionId: "s", path: join(dir, "missing.txt") } });
    const resp = await agent.waitFor((m) => m.id === id);
    assert.ok(resp.error, "读不存在的文件应回 error");
    assert.equal(resp.error.code, -32603, "handler 抛 ENOENT → internal error");
    assert.equal(adapter.alive, true, "单次 handler 报错不应搞死连接");
  });
});

// ---------------------------------------------------------------------------
describe("NDJSON 帧解析:粘包 / 半包 / 坏帧", () => {
  const update = (sessionId, text) => ({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  });

  test("粘包:一个 chunk 里两帧 → 两条通知都按 sessionId 路由", async () => {
    const { agent, hooks } = await boot();
    agent.sendRaw(`${JSON.stringify(update("s-a", "第一帧"))}\n${JSON.stringify(update("s-b", "第二帧"))}\n`);
    await hooks.waitForUpdate((u) => u.sessionId === "s-b");
    assert.equal(hooks.updates.length, 2);
    assert.deepEqual(hooks.updates.map((u) => [u.sessionId, u.update.content.text]), [["s-a", "第一帧"], ["s-b", "第二帧"]]);
  });

  test("半包:一帧分两段写,未完成前不投递,补齐后投递", async () => {
    const { agent, hooks } = await boot();
    const frame = `${JSON.stringify(update("s-half", "半包数据"))}\n`;
    agent.sendRaw(frame.slice(0, 15));
    await flush();
    assert.equal(hooks.updates.length, 0, "半个帧不应被投递");
    agent.sendRaw(frame.slice(15));
    await hooks.waitForUpdate((u) => u.sessionId === "s-half");
    assert.equal(hooks.updates.length, 1);
  });

  test("半包断在多字节 UTF-8 字符中间 → 流式解码仍完整", async () => {
    const { agent, hooks } = await boot();
    const frame = Buffer.from(`${JSON.stringify(update("s-utf8", "你好,世界🌞"))}\n`, "utf8");
    const cut = frame.indexOf(Buffer.from("世", "utf8")) + 1; // 切在"世"的字节中间
    agent.sendBytes(frame.subarray(0, cut));
    await flush();
    assert.equal(hooks.updates.length, 0, "字符被截断时不应投递坏帧");
    agent.sendBytes(frame.subarray(cut));
    await hooks.waitForUpdate((u) => u.sessionId === "s-utf8");
    assert.equal(hooks.updates[0].update.content.text, "你好,世界🌞");
  });

  test("大帧跨多个 chunk(64KB,按 4KB 切)→ 完整解析", async () => {
    const { agent, hooks } = await boot();
    const big = "x".repeat(64 * 1024);
    const frame = Buffer.from(`${JSON.stringify(update("s-big", big))}\n`, "utf8");
    for (let i = 0; i < frame.length; i += 4096) {
      agent.sendBytes(frame.subarray(i, i + 4096));
    }
    await hooks.waitForUpdate((u) => u.sessionId === "s-big");
    assert.equal(hooks.updates[0].update.content.text.length, big.length);
  });

  test("空行与纯空白行被忽略,不产生消息也不报错", async () => {
    const { agent, hooks } = await boot();
    agent.sendRaw("\n\n   \n\t\n");
    agent.sendRaw(`${JSON.stringify(update("s-blank", "空行之后"))}\n`);
    await hooks.waitForUpdate((u) => u.sessionId === "s-blank");
    assert.equal(hooks.updates.length, 1);
    assert.equal(agent.received.some((m) => m.error), false, "空行不应触发 error 响应");
  });

  test("坏 JSON 行 → 回 parseError(-32700),连接存活,后续帧照常", async () => {
    const { adapter, agent } = await boot();
    agent.sendRaw("{this is not json\n");
    const errResp = await agent.waitFor((m) => m.error);
    assert.equal(errResp.error.code, -32700);
    assert.equal(adapter.alive, true);
    const p = adapter.prompt("s-1", "坏帧之后");
    const req = await agent.waitFor((m) => m.method === "session/prompt");
    agent.respond(req, { stopReason: "end_turn" });
    assert.deepEqual(await p, { stopReason: "end_turn" });
  });

  test("合法 JSON 但不是对象(如 123)→ 回 invalidRequest(-32600),连接存活", async () => {
    const { adapter, agent } = await boot();
    agent.sendRaw("123\n");
    const errResp = await agent.waitFor((m) => m.error);
    assert.equal(errResp.error.code, -32600);
    assert.equal(adapter.alive, true);
  });

  test("CRLF 行尾也能解析(\\r 被 trim 掉)", async () => {
    const { agent, hooks } = await boot();
    agent.sendRaw(`${JSON.stringify(update("s-crlf", "CRLF"))}\r\n`);
    await hooks.waitForUpdate((u) => u.sessionId === "s-crlf");
    assert.equal(hooks.updates[0].update.content.text, "CRLF");
  });

  test("initialize 响应到达前就收到 session/update → 提前路由(handler 已注册)", async () => {
    const { adapter } = makeAdapter();
    const running = adapter.ensureRunning();
    running.catch(() => {});
    const agent = attachAgent();
    const init = await agent.waitFor((m) => m.method === "initialize");
    agent.notify("session/update", { sessionId: "s-early", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "早到通知" } } });
    agent.respond(init, { protocolVersion: 1 });
    await running;
    assert.equal(adapter.hooks.updates.length, 1, "握手完成前的通知也应送达");
    assert.equal(adapter.hooks.updates[0].sessionId, "s-early");
  });

  test("同一会话多条 update 粘包 → 按顺序全部路由", async () => {
    const { agent, hooks } = await boot();
    const frames = [1, 2, 3, 4, 5].map((n) => `${JSON.stringify(update("s-many", `消息${n}`))}\n`).join("");
    agent.sendRaw(frames);
    await hooks.waitForUpdate((u) => u.update.content.text === "消息5");
    assert.deepEqual(hooks.updates.map((u) => u.update.content.text), ["消息1", "消息2", "消息3", "消息4", "消息5"]);
  });
});

// ---------------------------------------------------------------------------
describe("dispose", () => {
  test("运行中 dispose → SIGTERM 杀进程并清空状态", async () => {
    const { adapter } = await boot();
    const child = fake.children.at(-1).child;
    await adapter.dispose();
    assert.deepEqual(child.killedWith, ["SIGTERM"]);
    assert.equal(adapter.alive, false);
    assert.equal(adapter.child, null);
    assert.equal(adapter.connection, null);
    assert.equal(adapter.agentInfo, null);
  });

  test("二次 dispose 不炸、不重复 kill", async () => {
    const { adapter } = await boot();
    const child = fake.children.at(-1).child;
    await adapter.dispose();
    await adapter.dispose();
    assert.deepEqual(child.killedWith, ["SIGTERM"]);
  });

  test("未启动时 dispose 安全:不 spawn 不抛错", async () => {
    const { adapter } = makeAdapter();
    await adapter.dispose();
    assert.equal(fake.children.length, 0);
    assert.equal(adapter.alive, false);
  });

  test("dispose 之后可重新 ensureRunning(重新 spawn)", async () => {
    const { adapter } = await boot();
    await adapter.dispose();
    const running = adapter.ensureRunning();
    running.catch(() => {});
    assert.equal(fake.children.length, 2);
    const agent = attachAgent();
    const init = await agent.waitFor((m) => m.method === "initialize");
    agent.respond(init, { protocolVersion: 1 });
    await running;
    assert.equal(adapter.alive, true);
  });

  test("dispose 时启动尚未完成:进程随后死亡 → 启动失败,适配器保持死亡态", async () => {
    const { adapter } = makeAdapter();
    const running = adapter.ensureRunning();
    running.catch(() => {});
    const child = fake.children.at(-1).child;
    const agent = attachAgent();
    const init = await agent.waitFor((m) => m.method === "initialize");
    await adapter.dispose(); // 启动中就被 dispose
    child.stdout.end(); // 进程随后死亡(SIGTERM 生效)
    child.emit("exit", null, "SIGTERM");
    await assert.rejects(running);
    assert.equal(adapter.alive, false);
    assert.equal(adapter.child, null);
  });
});
