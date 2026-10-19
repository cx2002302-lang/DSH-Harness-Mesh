/** lib/tools.js 单元测试(mesh 工具注册表):
 *  - createTools 的注册契约:6 个工具的 name/description/parameters/output.schema
 *  - 每个 handler 的正常路径、边界(空/缺字段/坏值)与错误路径(mesh 抛错、参数非法)
 *  - 与 state(mesh/nodes)的交互:调用参数、返回值挑选、默认值兜底
 *  - render 投影与 output.schema 的一致性(用 dsh-tools 真校验器,镜像注册侧检查)
 *
 * 运行:node --test test/tools.test.mjs
 * 说明:createTools(state) 收的是 state({mesh, nodes, ...})而不是 ctx,
 *      所以这里用假 state(假 mesh + 假 nodes store)捕获注册项再逐一调 handler。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createTools } from "../lib/tools.js";
import { ToolArgsError, validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";

// ------------------------------------------------------------------ 桩工厂

/** 假 MeshController:记录调用、可注入返回值/抛错。 */
function fakeMesh(overrides = {}) {
  const calls = { listNodes: 0, dispatch: [], status: [], cancel: [], result: [] };
  return {
    calls,
    listNodes() {
      calls.listNodes += 1;
      if (overrides.listNodesError) throw overrides.listNodesError;
      return overrides.nodes ?? [];
    },
    async dispatch(payload) {
      calls.dispatch.push(payload);
      if (overrides.dispatchError) throw overrides.dispatchError;
      return {
        task_id: "t-20261019-deadbeef",
        harness: payload.harness,
        state: "queued",
        // 多余字段:handler 只应挑 task_id/harness/state 三件套
        prompt: payload.prompt,
        internal: "must-not-leak",
      };
    },
    status(taskId) {
      calls.status.push(taskId);
      if (overrides.statusError) throw overrides.statusError;
      return overrides.status ?? { task_id: taskId, harness: "n1", state: "running" };
    },
    async cancel(taskId) {
      calls.cancel.push(taskId);
      if (overrides.cancelError) throw overrides.cancelError;
      return { task_id: taskId, state: "cancelling" };
    },
    result(taskId) {
      calls.result.push(taskId);
      if (overrides.resultError) throw overrides.resultError;
      return overrides.result ?? { task_id: taskId, harness: "n1", state: "succeeded" };
    },
  };
}

/** 假 NodesStore:get/list/save,记录 save 入参。 */
function fakeNodes(list = []) {
  const map = new Map(list.map((n) => [n.name, n]));
  const calls = { get: [], save: [] };
  return {
    calls,
    get(name) {
      calls.get.push(name);
      return map.get(name) ?? null;
    },
    list() {
      return [...map.values()];
    },
    save(node) {
      calls.save.push(node);
      map.set(node.name, node);
      return node;
    },
  };
}

/** 组装 state + 注册工具,返回按 name 索引的表。 */
function buildTools({ mesh: meshOverrides, nodes: nodeList } = {}) {
  const mesh = fakeMesh(meshOverrides);
  const nodes = fakeNodes(nodeList ?? [
    { name: "n1", type: "acp-stdio", command: "opencode", args: ["run"], model: "old/model", description: "本机 opencode" },
    { name: "n2", type: "acp-ssh", command: "kimi", ssh: "me@host", model: null, description: "" },
  ]);
  // 形状对齐 lib/index.js 的 state({config, nodes, store, mesh});多带的键不应被用到
  const state = { config: { defaultTimeoutMs: 600000, harnesses: {} }, store: { touched: false }, mesh, nodes };
  const tools = createTools(state);
  return { tools, byName: new Map(tools.map((t) => [t.name, t])), mesh, nodes, state };
}

/** 抓取 async 函数的 rejection,不断言具体类型。 */
async function rejection(fn) {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new assert.AssertionError({ message: "预期抛错,但 promise 实现了" });
}

/** 断言输出符合工具自身声明的 output.schema(镜像注册侧 createSuccessResult 的检查)。 */
function assertOutputConforms(tool, value, label) {
  const violations = validateJsonSchemaValue(tool.output.schema, value, "value");
  assert.deepEqual(violations, [], `${label}: 输出违反 output.schema → ${JSON.stringify(violations)}`);
}

const NODE_FIXTURE = {
  name: "n1", type: "acp-stdio", target: "local", command: "opencode run",
  description: "本机 opencode", health: "up", running: 2,
};

// ------------------------------------------------------------------ 注册契约

test("createTools:返回 M1 六件套,name 与顺序符合契约", () => {
  const { tools } = buildTools();
  assert.deepEqual(tools.map((t) => t.name), [
    "harness_list", "harness_dispatch", "harness_config", "harness_status", "harness_cancel", "harness_result",
  ]);
});

test("createTools:每次调用返回全新数组(可重复注册/热重载)", () => {
  const { state } = buildTools();
  const a = createTools(state);
  const b = createTools(state);
  assert.notEqual(a, b);
  assert.deepEqual(a.map((t) => t.name), b.map((t) => t.name));
});

test("createTools:每个工具都有 name/非空 description/parameters/output.schema/execute/render", () => {
  const { tools } = buildTools();
  for (const tool of tools) {
    assert.equal(typeof tool.name, "string");
    assert.ok(tool.name.startsWith("harness_"));
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.description.length > 0, `${tool.name} description 为空`);
    assert.equal(typeof tool.execute, "function");
    assert.equal(typeof tool.output.render, "function");
    assert.equal(tool.parameters.type, "object");
    assert.equal(tool.output.schema.type, "object");
  }
});

test("createTools:parameters 根不设 additionalProperties:false(额外参数被宽容,由 handler 挑选)", () => {
  const { byName } = buildTools();
  for (const tool of byName.values()) {
    assert.equal(Object.hasOwn(tool.parameters, "additionalProperties"), false, `${tool.name} 参数根不该锁死`);
  }
});

test("createTools:output.schema 全部锁死 additionalProperties:false(防回传内部字段)", () => {
  const { byName } = buildTools();
  for (const tool of byName.values()) {
    assert.equal(tool.output.schema.additionalProperties, false, `${tool.name} output 未锁死`);
  }
});

test("createTools:各工具 required 参数清单符合契约", () => {
  const { byName } = buildTools();
  const requiredOf = (name) => [...(byName.get(name).parameters.required ?? [])].sort();
  assert.deepEqual(requiredOf("harness_list"), []);
  assert.deepEqual(requiredOf("harness_dispatch"), ["harness", "prompt"]);
  assert.deepEqual(requiredOf("harness_config"), ["harness", "model"]);
  assert.deepEqual(requiredOf("harness_status"), ["task_id"]);
  assert.deepEqual(requiredOf("harness_cancel"), ["task_id"]);
  assert.deepEqual(requiredOf("harness_result"), ["task_id"]);
});

test("createTools:dispatch 参数类型(integer/array-of-string/可选字段)", () => {
  const { byName } = buildTools();
  const p = byName.get("harness_dispatch").parameters;
  assert.equal(p.properties.harness.type, "string");
  assert.equal(p.properties.prompt.type, "string");
  assert.equal(p.properties.cwd.type, "string");
  assert.equal(p.properties.model.type, "string");
  assert.equal(p.properties.timeoutMs.type, "integer");
  assert.equal(p.properties.deny.type, "array");
  assert.equal(p.properties.deny.items.type, "string");
  for (const optional of ["cwd", "model", "timeoutMs", "deny"]) {
    assert.equal(p.required.includes(optional), false, `${optional} 不该是必填`);
  }
});

test("createTools:list 输出 schema 的 nodes.items 全必填且带 enum", () => {
  const { byName } = buildTools();
  const items = byName.get("harness_list").output.schema.properties.nodes.items;
  assert.equal(items.type, "object");
  assert.equal(items.additionalProperties, false);
  assert.deepEqual([...items.required].sort(), ["command", "description", "health", "name", "running", "target", "type"]);
  assert.deepEqual(items.properties.type.enum, ["acp-stdio", "acp-ssh", "cli-oneshot", "acp-plug"]);
  assert.deepEqual(items.properties.health.enum, ["unknown", "up", "down"]);
  assert.equal(items.properties.running.type, "integer");
});

test("createTools:status/result 输出 schema 的关键字段(state 六态 / progress / changes)", () => {
  const { byName } = buildTools();
  const statusSchema = byName.get("harness_status").output.schema;
  assert.deepEqual(statusSchema.properties.state.enum, ["queued", "running", "succeeded", "failed", "cancelled", "timeout"]);
  assert.equal(statusSchema.properties.duration_ms.type, "integer");
  assert.equal(statusSchema.properties.progress.type, "array");
  assert.deepEqual([...statusSchema.properties.progress.items.required].sort(), ["at", "kind", "title"]);
  assert.equal(statusSchema.properties.pending_permission.type, "object");
  assert.equal(statusSchema.required.includes("pending_permission"), false, "pending_permission 必须保持可选");

  const reportSchema = byName.get("harness_result").output.schema;
  assert.deepEqual(reportSchema.properties.state.enum, ["queued", "running", "succeeded", "failed", "cancelled", "timeout"]);
  assert.equal(reportSchema.properties.changes.type, "array");
  assert.deepEqual([...reportSchema.properties.changes.items.required].sort(), ["paths", "title"]);
  assert.equal(reportSchema.properties.artifacts.type, "array");
  assert.equal(reportSchema.required.includes("pending_permission"), false);
});

test("createTools:mesh 引用在创建时绑定(之后换 state.mesh 不影响已注册工具)", () => {
  const first = buildTools({ mesh: { nodes: [NODE_FIXTURE] } });
  const second = buildTools({ mesh: { nodes: [] } });
  first.state.mesh = second.mesh; // 模拟外部改字段
  return first.byName.get("harness_list").execute({}).then((out) => {
    assert.deepEqual(out, { nodes: [NODE_FIXTURE] });
  });
});

// ------------------------------------------------------------------ harness_list

test("harness_list:execute 原样返回 mesh.listNodes() 且只调一次", async () => {
  const { byName, mesh } = buildTools({ mesh: { nodes: [NODE_FIXTURE, { ...NODE_FIXTURE, name: "n2" }] } });
  const out = await byName.get("harness_list").execute({});
  assert.deepEqual(out, { nodes: [NODE_FIXTURE, { ...NODE_FIXTURE, name: "n2" }] });
  assert.equal(mesh.calls.listNodes, 1);
  assertOutputConforms(byName.get("harness_list"), out, "harness_list");
});

test("harness_list:空节点表 → { nodes: [] }", async () => {
  const { byName } = buildTools({ mesh: { nodes: [] } });
  assert.deepEqual(await byName.get("harness_list").execute({}), { nodes: [] });
});

test("harness_list:render 空表给出配置指引", () => {
  const { byName } = buildTools();
  const rendered = byName.get("harness_list").output.render({}, { nodes: [] });
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].type, "text");
  assert.equal(rendered[0].text, "harness-mesh: 没有配置任何被控节点(在 profile 的 cordis.patch.yml 里加 harness-mesh.config.harnesses)");
});

test("harness_list:render 非空表逐节点列出(空 description 不带后缀)", () => {
  const { byName } = buildTools();
  const rendered = byName.get("harness_list").output.render({}, { nodes: [NODE_FIXTURE, { ...NODE_FIXTURE, name: "n2", description: "", health: "unknown", running: 0 }] });
  assert.equal(rendered[0].text, [
    "harness-mesh 节点 2 个:",
    "- n1 [acp-stdio] → local(opencode run),健康 up,在跑 2 — 本机 opencode",
    "- n2 [acp-stdio] → local(opencode run),健康 unknown,在跑 0",
  ].join("\n"));
});

test("harness_list:mesh.listNodes 抛错时原样传播", async () => {
  const boom = new Error("nodes.json 损坏");
  const { byName } = buildTools({ mesh: { listNodesError: boom } });
  const err = await rejection(() => byName.get("harness_list").execute({}));
  assert.equal(err, boom);
});

// ------------------------------------------------------------------ harness_dispatch

test("harness_dispatch:正常路径只回 task_id/harness/state,并透传 exec.agent/signal", async () => {
  const { byName, mesh } = buildTools();
  const exec = { agent: { id: "agent-7" }, signal: new AbortController().signal };
  const out = await byName.get("harness_dispatch").execute({ harness: "n1", prompt: "干活" }, exec);
  assert.deepEqual(out, { task_id: "t-20261019-deadbeef", harness: "n1", state: "queued" });
  const payload = mesh.calls.dispatch[0];
  assert.equal(payload.harness, "n1");
  assert.equal(payload.prompt, "干活");
  assert.equal(payload.approvalAgent, exec.agent);
  assert.equal(payload.signal, exec.signal);
  assert.equal(Object.hasOwn(payload, "origin"), false, "origin 由 mesh 内部补,工具不该传");
  assertOutputConforms(byName.get("harness_dispatch"), out, "harness_dispatch");
});

test("harness_dispatch:可选参数缺省时以 undefined 透传(不臆造默认值)", async () => {
  const { byName, mesh } = buildTools();
  await byName.get("harness_dispatch").execute({ harness: "n1", prompt: "p" }, {});
  const payload = mesh.calls.dispatch[0];
  assert.equal(payload.cwd, undefined);
  assert.equal(payload.model, undefined);
  assert.equal(payload.timeoutMs, undefined);
  assert.equal(payload.deny, undefined);
  assert.equal(payload.approvalAgent, undefined);
  assert.equal(payload.signal, undefined);
});

test("harness_dispatch:全可选参数透传(cwd/model/timeoutMs/deny)", async () => {
  const { byName, mesh } = buildTools();
  await byName.get("harness_dispatch").execute({
    harness: "n1", prompt: "p", cwd: "/w", model: "opencode/x", timeoutMs: 1234, deny: ["内部规则"],
  }, {});
  const payload = mesh.calls.dispatch[0];
  assert.equal(payload.cwd, "/w");
  assert.equal(payload.model, "opencode/x");
  assert.equal(payload.timeoutMs, 1234);
  assert.deepEqual(payload.deny, ["内部规则"]);
});

test("harness_dispatch:render 提示用 status/result 跟进", () => {
  const { byName } = buildTools();
  const rendered = byName.get("harness_dispatch").output.render({}, { task_id: "t-1", harness: "n1", state: "queued" });
  assert.deepEqual(rendered, [{ type: "text", text: "已派发任务 t-1 → n1(state=queued);用 harness_status 跟进,harness_result 取汇报。" }]);
});

test("harness_dispatch:mesh.dispatch 抛错(如未知节点)时原样传播", async () => {
  const boom = new Error('harness-mesh: 节点 "ghost" 不存在;可用节点: n1, n2');
  const { byName, mesh } = buildTools({ mesh: { dispatchError: boom } });
  const err = await rejection(() => byName.get("harness_dispatch").execute({ harness: "ghost", prompt: "p" }, {}));
  assert.equal(err, boom);
  assert.equal(mesh.calls.dispatch.length, 1);
});

test("harness_dispatch:缺 harness → ToolArgsError(violations 指明缺失字段)", async () => {
  const { byName } = buildTools();
  const err = await rejection(() => byName.get("harness_dispatch").execute({ prompt: "p" }, {}));
  assert.ok(err instanceof ToolArgsError);
  assert.equal(err.name, "ToolArgsError");
  assert.equal(err.code, "INVALID_ARGS");
  assert.ok(err.violations.some((v) => v === 'missing required property "harness"'), JSON.stringify(err.violations));
});

test("harness_dispatch:缺 prompt → ToolArgsError", async () => {
  const { byName } = buildTools();
  const err = await rejection(() => byName.get("harness_dispatch").execute({ harness: "n1" }, {}));
  assert.ok(err instanceof ToolArgsError);
  assert.ok(err.violations.some((v) => v === 'missing required property "prompt"'), JSON.stringify(err.violations));
});

test("harness_dispatch:参数类型错误(harness 数字 / prompt 数组)→ ToolArgsError", async () => {
  const { byName } = buildTools();
  for (const args of [{ harness: 1, prompt: "p" }, { harness: "n1", prompt: ["p"] }]) {
    const err = await rejection(() => byName.get("harness_dispatch").execute(args, {}));
    assert.ok(err instanceof ToolArgsError, JSON.stringify(args));
    assert.ok(err.violations.some((v) => v.startsWith('"harness" must be a string') || v.startsWith('"prompt" must be a string')), JSON.stringify(err.violations));
  }
});

test("harness_dispatch:timeoutMs 非法(字符串 / 小数)→ ToolArgsError", async () => {
  const { byName } = buildTools();
  for (const timeoutMs of ["600000", 1.5, true, null]) {
    const err = await rejection(() => byName.get("harness_dispatch").execute({ harness: "n1", prompt: "p", timeoutMs }, {}));
    assert.ok(err instanceof ToolArgsError, `timeoutMs=${String(timeoutMs)}`);
    assert.ok(err.violations.some((v) => v.startsWith('"timeoutMs" must be an integer')), JSON.stringify(err.violations));
  }
});

test("harness_dispatch:timeoutMs 负整数通过 schema(schema 无 minimum,原样透传给 mesh)", async () => {
  // 边界记录:integer 不校验范围,-1 会被当成合法参数透传;范围约束在 mesh/config 侧。
  const { byName, mesh } = buildTools();
  const out = await byName.get("harness_dispatch").execute({ harness: "n1", prompt: "p", timeoutMs: -1 }, {});
  assert.equal(out.state, "queued");
  assert.equal(mesh.calls.dispatch[0].timeoutMs, -1);
});

test("harness_dispatch:deny 非法(字符串 / 元素非字符串)→ ToolArgsError", async () => {
  const { byName } = buildTools();
  for (const deny of ["rm -rf", [1], [null]]) {
    const err = await rejection(() => byName.get("harness_dispatch").execute({ harness: "n1", prompt: "p", deny }, {}));
    assert.ok(err instanceof ToolArgsError, JSON.stringify(deny));
    assert.ok(err.violations.some((v) => v.startsWith('"deny" must be an array') || v.startsWith('"deny[')), JSON.stringify(err.violations));
  }
});

test("harness_dispatch:args 整体非法(null / 数组 / 字符串)→ ToolArgsError", async () => {
  const { byName } = buildTools();
  for (const args of [null, [], "n1", 42]) {
    const err = await rejection(() => byName.get("harness_dispatch").execute(args, {}));
    assert.ok(err instanceof ToolArgsError, JSON.stringify(args));
    assert.ok(err.violations.some((v) => v === '"arguments" must be an object'), JSON.stringify(err.violations));
  }
});

test("harness_dispatch:未声明的额外参数被宽容放行(参数根无 additionalProperties:false)", async () => {
  const { byName, mesh } = buildTools();
  const out = await byName.get("harness_dispatch").execute({ harness: "n1", prompt: "p", surprise: 1 }, {});
  assert.equal(out.state, "queued");
  assert.equal(mesh.calls.dispatch.length, 1);
  assert.equal(mesh.calls.dispatch[0].surprise, undefined, "额外参数不该漏进 mesh.dispatch");
});

// ------------------------------------------------------------------ harness_config

test("harness_config:设置新模型 → save({...node, model}) + changed:true", async () => {
  const { byName, nodes } = buildTools();
  const out = await byName.get("harness_config").execute({ harness: "n1", model: "opencode/deepseek-v4-pro" });
  assert.deepEqual(out, { harness: "n1", model: "opencode/deepseek-v4-pro", changed: true });
  assert.equal(nodes.calls.save.length, 1);
  const saved = nodes.calls.save[0];
  assert.equal(saved.model, "opencode/deepseek-v4-pro");
  assert.equal(saved.name, "n1");
  assert.equal(saved.type, "acp-stdio", "只改 model,不动其他配置");
  assertOutputConforms(byName.get("harness_config"), out, "harness_config");
});

test("harness_config:模型相同 → changed:false 且不落盘", async () => {
  const { byName, nodes } = buildTools();
  const out = await byName.get("harness_config").execute({ harness: "n1", model: "old/model" });
  assert.deepEqual(out, { harness: "n1", model: "old/model", changed: false });
  assert.equal(nodes.calls.save.length, 0);
});

test("harness_config:model 前后空白被 trim", async () => {
  const { byName, nodes } = buildTools();
  const out = await byName.get("harness_config").execute({ harness: "n1", model: "  opencode/x  " });
  assert.deepEqual(out, { harness: "n1", model: "opencode/x", changed: true });
  assert.equal(nodes.calls.save[0].model, "opencode/x");
});

test("harness_config:model='default' 恢复节点默认(model 置 null 落盘)", async () => {
  const { byName, nodes } = buildTools();
  const out = await byName.get("harness_config").execute({ harness: "n1", model: "default" });
  assert.deepEqual(out, { harness: "n1", model: "", changed: true });
  assert.equal(nodes.calls.save[0].model, null);
});

test("harness_config:model 纯空白同样视为恢复默认", async () => {
  const { byName, nodes } = buildTools();
  const out = await byName.get("harness_config").execute({ harness: "n1", model: "   " });
  assert.deepEqual(out, { harness: "n1", model: "", changed: true });
  assert.equal(nodes.calls.save[0].model, null);
});

test("harness_config:节点本就没有 model 且传空串 → changed:false 不落盘", async () => {
  const { byName, nodes } = buildTools({ nodes: [{ name: "bare", type: "acp-stdio", command: "c" }] });
  const out = await byName.get("harness_config").execute({ harness: "bare", model: "" });
  assert.deepEqual(out, { harness: "bare", model: "", changed: false });
  assert.equal(nodes.calls.save.length, 0);
});

test("harness_config:节点 model 为 null 且传空串 → changed:false", async () => {
  const { byName, nodes } = buildTools({ nodes: [{ name: "nulled", type: "acp-stdio", command: "c", model: null }] });
  const out = await byName.get("harness_config").execute({ harness: "nulled", model: "default" });
  assert.deepEqual(out, { harness: "nulled", model: "", changed: false });
  assert.equal(nodes.calls.save.length, 0);
});

test("harness_config:未知节点 → 抛错(消息带可用节点清单)且不落盘", async () => {
  const { byName, nodes } = buildTools();
  const err = await rejection(() => byName.get("harness_config").execute({ harness: "ghost", model: "m" }));
  assert.ok(err instanceof Error);
  assert.equal(err.message, 'harness-mesh: 节点 "ghost" 不存在;可用节点: n1, n2');
  assert.equal(nodes.calls.save.length, 0);
});

test("harness_config:无任何节点时可用清单显示 (无)", async () => {
  const { byName } = buildTools({ nodes: [] });
  const err = await rejection(() => byName.get("harness_config").execute({ harness: "ghost", model: "m" }));
  assert.equal(err.message, 'harness-mesh: 节点 "ghost" 不存在;可用节点: (无)');
});

test("harness_config:harness 空串 → 走未知节点分支(String 归一不炸)", async () => {
  const { byName, nodes } = buildTools();
  const err = await rejection(() => byName.get("harness_config").execute({ harness: "", model: "m" }));
  assert.equal(err.message, 'harness-mesh: 节点 "" 不存在;可用节点: n1, n2');
  assert.equal(nodes.calls.save.length, 0);
});

test("harness_config:nodes.get 抛错时原样传播", async () => {
  const { byName } = buildTools();
  const nodes = fakeNodes([]);
  const boom = new Error("nodes.json 读取失败");
  nodes.get = () => { throw boom; };
  const tool = createTools({ mesh: fakeMesh(), nodes }).find((t) => t.name === "harness_config");
  const err = await rejection(() => tool.execute({ harness: "n1", model: "m" }));
  assert.equal(err, boom);
});

test("harness_config:nodes.save 抛错时原样传播", async () => {
  const { byName } = buildTools();
  const nodes = fakeNodes([{ name: "n1", type: "acp-stdio", command: "c", model: "old" }]);
  const boom = new Error("磁盘只读");
  nodes.save = () => { throw boom; };
  const tool = createTools({ mesh: fakeMesh(), nodes }).find((t) => t.name === "harness_config");
  const err = await rejection(() => tool.execute({ harness: "n1", model: "new" }));
  assert.equal(err, boom);
});

test("harness_config:非法参数(缺 harness / 缺 model / model 非字符串)→ ToolArgsError", async () => {
  const { byName } = buildTools();
  const cases = [{ model: "m" }, { harness: "n1" }, { harness: "n1", model: 5 }];
  for (const args of cases) {
    const err = await rejection(() => byName.get("harness_config").execute(args));
    assert.ok(err instanceof ToolArgsError, JSON.stringify(args));
    assert.ok(err.violations.length > 0, JSON.stringify(args));
  }
  const missingHarness = await rejection(() => byName.get("harness_config").execute({ model: "m" }));
  assert.ok(missingHarness.violations.includes('missing required property "harness"'));
  const missingModel = await rejection(() => byName.get("harness_config").execute({ harness: "n1" }));
  assert.ok(missingModel.violations.includes('missing required property "model"'));
});

test("harness_config:render 三种形态(已设 / 无变化 / 恢复默认)", () => {
  const { byName } = buildTools();
  const render = byName.get("harness_config").output.render;
  assert.equal(render({}, { harness: "n1", model: "m/x", changed: true })[0].text,
    "节点 n1 的默认模型已设为 m/x;后续 dispatch 到该节点的任务都用它。");
  assert.equal(render({}, { harness: "n1", model: "m/x", changed: false })[0].text,
    "节点 n1 的默认模型已设为 m/x(无变化);后续 dispatch 到该节点的任务都用它。");
  assert.equal(render({}, { harness: "n1", model: "", changed: true })[0].text,
    "节点 n1 的默认模型已设为 (被控 harness 默认);后续 dispatch 到该节点的任务都用它。");
});

// ------------------------------------------------------------------ harness_status

test("harness_status:完整记录透传 + null 兜底为 \"\"/0", async () => {
  const status = {
    task_id: "t-1", harness: "n1", state: "running", session_ref: "sess-1",
    started_at: "2026-10-19T12:00:00.000Z", duration_ms: 4200,
    progress: [{ at: "2026-10-19T12:00:01.000Z", kind: "tool_call", title: "编辑文件" }],
    pending_permission: null, error: null,
  };
  const { byName, mesh } = buildTools({ mesh: { status } });
  const out = await byName.get("harness_status").execute({ task_id: "t-1" });
  assert.deepEqual(mesh.calls.status, ["t-1"]);
  assert.deepEqual(out, {
    task_id: "t-1", harness: "n1", state: "running", session_ref: "sess-1",
    started_at: "2026-10-19T12:00:00.000Z", duration_ms: 4200,
    progress: [{ at: "2026-10-19T12:00:01.000Z", kind: "tool_call", title: "编辑文件" }],
    error: "",
  });
  assert.equal(Object.hasOwn(out, "pending_permission"), false, "null 权限必须删键(optional 字段不出现即合法)");
  assertOutputConforms(byName.get("harness_status"), out, "harness_status");
});

test("harness_status:缺 session_ref/started_at/duration_ms/error → 补默认值", async () => {
  const { byName } = buildTools({ mesh: { status: { task_id: "t-1", harness: "n1", state: "succeeded", progress: [] } } });
  const out = await byName.get("harness_status").execute({ task_id: "t-1" });
  assert.equal(out.session_ref, "");
  assert.equal(out.started_at, "");
  assert.equal(out.duration_ms, 0);
  assert.equal(out.error, "");
});

test("harness_status:pending_permission 为 undefined 也删键", async () => {
  const { byName } = buildTools({ mesh: { status: { task_id: "t-1", harness: "n1", state: "running", progress: [], pending_permission: undefined } } });
  const out = await byName.get("harness_status").execute({ task_id: "t-1" });
  assert.equal(Object.hasOwn(out, "pending_permission"), false);
});

test("harness_status:pending_permission 非空对象 → 原样保留(等审批中)", async () => {
  const pending = { id: "p-1", title: "rm -rf /tmp/x", reason: "命中敏感操作规则" };
  const { byName } = buildTools({ mesh: { status: { task_id: "t-1", harness: "n1", state: "running", progress: [], pending_permission: pending } } });
  const out = await byName.get("harness_status").execute({ task_id: "t-1" });
  assert.deepEqual(out.pending_permission, pending);
  assertOutputConforms(byName.get("harness_status"), out, "harness_status+pending");
});

test("harness_status:progress 数组原样透传(含 12 条上限由 mesh 负责)", async () => {
  const progress = Array.from({ length: 12 }, (_, i) => ({ at: `2026-10-19T12:00:0${i % 10}.000Z`, kind: "tool_call", title: `t${i}` }));
  const { byName } = buildTools({ mesh: { status: { task_id: "t-1", harness: "n1", state: "running", progress } } });
  const out = await byName.get("harness_status").execute({ task_id: "t-1" });
  assert.deepEqual(out.progress, progress);
});

test("harness_status:execute 不补 progress 默认值(mesh.status 若缺 progress,输出会违反自身 schema)", async () => {
  // 记录当前契约:handler 只兜底 session_ref/started_at/duration_ms/error。
  // lib/mesh.js 的 status() 永远返回 progress,所以线上不可达;这里锁定现状防回归。
  const { byName } = buildTools({ mesh: { status: { task_id: "t-1", harness: "n1", state: "succeeded" } } });
  const out = await byName.get("harness_status").execute({ task_id: "t-1" });
  assert.equal(Object.hasOwn(out, "progress"), false);
  const violations = validateJsonSchemaValue(byName.get("harness_status").output.schema, out, "value");
  assert.ok(violations.some((v) => v === 'missing required property "value.progress"'), JSON.stringify(violations));
});

test("harness_status:render 状态行/进度行/错误行(duration 取整秒)", () => {
  const { byName } = buildTools();
  const rendered = byName.get("harness_status").output.render({}, {
    task_id: "t-1", harness: "n1", state: "running", duration_ms: 1500,
    progress: [
      { at: "2026-10-19T12:34:56.789Z", kind: "tool_call", title: "编辑 lib/a.js" },
      { at: "2026-10-19T12:34:57.000Z", kind: "permission", title: "" },
    ],
    error: "boom",
  });
  assert.equal(rendered[0].text, [
    "任务 t-1 @ n1: running(已运行 2s)",
    "  [12:34:56] tool_call: 编辑 lib/a.js",
    "  [12:34:57] permission",
    "错误: boom",
  ].join("\n"));
});

test("harness_status:render 无 error 时不出现错误行", () => {
  const { byName } = buildTools();
  const rendered = byName.get("harness_status").output.render({}, {
    task_id: "t-1", harness: "n1", state: "succeeded", duration_ms: 0, progress: [], error: "",
  });
  assert.equal(rendered[0].text, "任务 t-1 @ n1: succeeded(已运行 0s)");
});

test("harness_status:mesh.status 抛错(任务不存在)时原样传播", async () => {
  const boom = new Error("harness-mesh: 任务 t-x 不存在");
  const { byName } = buildTools({ mesh: { statusError: boom } });
  const err = await rejection(() => byName.get("harness_status").execute({ task_id: "t-x" }));
  assert.equal(err, boom);
});

test("harness_status:非法参数(缺 task_id / task_id 非字符串)→ ToolArgsError", async () => {
  const { byName } = buildTools();
  const missing = await rejection(() => byName.get("harness_status").execute({}));
  assert.ok(missing instanceof ToolArgsError);
  assert.ok(missing.violations.includes('missing required property "task_id"'));
  const wrongType = await rejection(() => byName.get("harness_status").execute({ task_id: 42 }));
  assert.ok(wrongType instanceof ToolArgsError);
  assert.ok(wrongType.violations.some((v) => v === '"task_id" must be a string'), JSON.stringify(wrongType.violations));
});

// ------------------------------------------------------------------ harness_cancel

test("harness_cancel:正常路径透传 mesh.cancel 返回值", async () => {
  const { byName, mesh } = buildTools();
  const out = await byName.get("harness_cancel").execute({ task_id: "t-1" });
  assert.deepEqual(mesh.calls.cancel, ["t-1"]);
  assert.deepEqual(out, { task_id: "t-1", state: "cancelling" });
  assertOutputConforms(byName.get("harness_cancel"), out, "harness_cancel");
});

test("harness_cancel:render 提示终态以 status 为准", () => {
  const { byName } = buildTools();
  const rendered = byName.get("harness_cancel").output.render({}, { task_id: "t-1", state: "cancelling" });
  assert.deepEqual(rendered, [{ type: "text", text: "已请求取消任务 t-1(state=cancelling);最终状态以 harness_status 为准。" }]);
});

test("harness_cancel:mesh.cancel 抛错(任务不在运行中)时原样传播", async () => {
  const boom = new Error("harness-mesh: 任务 t-1 不在运行中(state=succeeded),无需取消");
  const { byName } = buildTools({ mesh: { cancelError: boom } });
  const err = await rejection(() => byName.get("harness_cancel").execute({ task_id: "t-1" }));
  assert.equal(err, boom);
});

test("harness_cancel:非法参数(缺 task_id)→ ToolArgsError", async () => {
  const { byName } = buildTools();
  const err = await rejection(() => byName.get("harness_cancel").execute({}));
  assert.ok(err instanceof ToolArgsError);
  assert.ok(err.violations.includes('missing required property "task_id"'));
});

// ------------------------------------------------------------------ harness_result

test("harness_result:部分记录 → 全部可选字段补默认值,tests 恒为 未解析", async () => {
  const { byName, mesh } = buildTools();
  const out = await byName.get("harness_result").execute({ task_id: "t-1" });
  assert.deepEqual(mesh.calls.result, ["t-1"]);
  assert.deepEqual(out, {
    task_id: "t-1", harness: "n1", state: "succeeded", summary: "", changes: [],
    tests: "未解析", artifacts: [], next_hint: "", session_ref: "", stop_reason: "",
    duration_ms: 0, error: "",
  });
  assertOutputConforms(byName.get("harness_result"), out, "harness_result");
});

test("harness_result:mesh 返回的 tests/artifacts/next_hint 被归一(tests 恒 未解析)", async () => {
  const { byName } = buildTools({
    mesh: {
      result: {
        task_id: "t-1", harness: "n1", state: "succeeded", summary: "做完了",
        changes: [{ title: "改登录页", paths: ["a.js"] }], tests: "3 passed",
        artifacts: ["/tmp/x.png"], next_hint: "下一步", session_ref: "sess-9",
        stop_reason: "end_turn", duration_ms: 6500, error: null,
      },
    },
  });
  const out = await byName.get("harness_result").execute({ task_id: "t-1" });
  assert.equal(out.tests, "未解析", "M1 恒为未解析(覆盖 mesh 侧返回值)");
  assert.deepEqual(out.artifacts, ["/tmp/x.png"]);
  assert.equal(out.next_hint, "下一步");
  assert.equal(out.session_ref, "sess-9");
  assert.equal(out.error, "");
  assert.deepEqual(out.changes, [{ title: "改登录页", paths: ["a.js"] }]);
  assertOutputConforms(byName.get("harness_result"), out, "harness_result-full");
});

test("harness_result:changes 为 null → 兜底为空数组", async () => {
  const { byName } = buildTools({ mesh: { result: { task_id: "t-1", harness: "n1", state: "failed", changes: null, summary: null, error: "炸了" } } });
  const out = await byName.get("harness_result").execute({ task_id: "t-1" });
  assert.deepEqual(out.changes, []);
  assert.equal(out.summary, "");
  assert.equal(out.error, "炸了");
  assertOutputConforms(byName.get("harness_result"), out, "harness_result-null-changes");
});

test("harness_result:render 总结/变更清单/耗时", () => {
  const { byName } = buildTools();
  const rendered = byName.get("harness_result").output.render({}, {
    task_id: "t-1", harness: "n1", state: "succeeded", stop_reason: "end_turn", duration_ms: 6500,
    summary: "做完了", changes: [{ title: "改登录页", paths: ["a.js", "b.js"] }], error: "",
  });
  assert.equal(rendered[0].text, [
    "任务 t-1 @ n1: succeeded(stop=end_turn, 7s)",
    "总结: 做完了",
    "变更 1 处:",
    "  - 改登录页 → a.js, b.js",
  ].join("\n"));
});

test("harness_result:render 无变更 → 变更: 无;有 error → 错误行", () => {
  const { byName } = buildTools();
  const rendered = byName.get("harness_result").output.render({}, {
    task_id: "t-1", harness: "n1", state: "failed", stop_reason: "", duration_ms: 0,
    summary: "", changes: [], error: "超时(600000ms)已取消",
  });
  assert.equal(rendered[0].text, [
    "任务 t-1 @ n1: failed(stop=, 0s)",
    "总结: ",
    "变更: 无",
    "错误: 超时(600000ms)已取消",
  ].join("\n"));
});

test("harness_result:mesh.result 抛错(任务不存在)时原样传播", async () => {
  const boom = new Error("harness-mesh: 任务 t-x 不存在");
  const { byName } = buildTools({ mesh: { resultError: boom } });
  const err = await rejection(() => byName.get("harness_result").execute({ task_id: "t-x" }));
  assert.equal(err, boom);
});

test("harness_result:非法参数(缺 task_id)→ ToolArgsError", async () => {
  const { byName } = buildTools();
  const err = await rejection(() => byName.get("harness_result").execute({}));
  assert.ok(err instanceof ToolArgsError);
  assert.ok(err.violations.includes('missing required property "task_id"'));
});
