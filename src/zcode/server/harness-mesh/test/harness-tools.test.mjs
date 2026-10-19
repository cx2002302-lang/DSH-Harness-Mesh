/** harness-tools 单元测试(node:test):index.js 调度 + 模板模块(dsh/kimi/opencode/zcode) + workbuddy 行协议。
 *  网络/子进程零依赖:ctx.mesh / ctx.nodes 全部注入内存桩。
 *  运行:node --test test/harness-tools.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadHarnessTools, availableHarnesses, resolveTool } from "../lib/harness-tools/index.js";
import * as kimiMod from "../lib/harness-tools/kimi.js";
import * as dshMod from "../lib/harness-tools/dsh.js";
import * as opencodeMod from "../lib/harness-tools/opencode.js";
import * as zcodeMod from "../lib/harness-tools/zcode.js";
import * as wbMod from "../lib/harness-tools/workbuddy.js";

// ---- 共享桩 ---------------------------------------------------------------

/** 构造 ctx.nodes / ctx.mesh.store / ctx.mesh.adapters 的最小桩。 */
function makeCtx({ nodes = [], tasks = [], adapterAlive = false } = {}) {
  const adapters = new Map();
  if (adapterAlive !== false) adapters.set(adapterAlive.node, { alive: adapterAlive.alive });
  return {
    nodes: { list: () => nodes },
    mesh: {
      adapters,
      store: {
        list: () => tasks,
        countRunning: (h) => tasks.filter((t) => t.harness === h && t.state === "running").length,
      },
    },
  };
}

const NODES = [
  { name: "winpc-wb-ui", type: "gateway", plugId: "workbuddy-ui", socks: 10808, description: "wb ui" },
  { name: "winpc-workbuddy", type: "acp-plug", plugId: "workbuddy", address: "9.9.9.9" },
  { name: "winpc-kimi", type: "acp-plug", plugId: "kimi", address: "1.2.3.4" },
  { name: "kimi-fallback", type: "ssh", address: "5.6.7.8" },
];

// 模板模块行为同构检查用:每个模板各有一个可匹配节点
const TEMPLATE_NODES = [
  ...NODES,
  { name: "winpc-dsh", type: "acp-plug", plugId: "dsh" },
  { name: "winpc-opencode", type: "acp-plug", plugId: "opencode" },
  { name: "winpc-zcode", type: "acp-plug", plugId: "zcode" },
];

const TASKS = [
  { harness: "winpc-kimi", task_id: "t3", state: "succeeded", summary: "s".repeat(300), duration_ms: 11, created_at: "2024-01-03" },
  { harness: "winpc-kimi", task_id: "t2", state: "failed", error: "boom", duration_ms: 22, created_at: "2024-01-02" },
  { harness: "winpc-kimi", task_id: "t1", state: "running", duration_ms: null, created_at: "2024-01-01" },
  { harness: "other-node", task_id: "tx", state: "succeeded", summary: "x", created_at: "2024-01-04" },
  { harness: "winpc-workbuddy", task_id: "w1", state: "succeeded", summary: "w".repeat(200), created_at: "2024-01-05" },
];

// ---- index.js -------------------------------------------------------------

test("loadHarnessTools: 正常加载 kimi 包(prefix/tools/handlers)", async () => {
  const pack = await loadHarnessTools("kimi");
  assert.ok(pack);
  assert.equal(pack.harness, "kimi");
  assert.equal(pack.prefix, "kimi_");
  assert.ok(Array.isArray(pack.tools) && pack.tools.length >= 1);
  assert.equal(pack.tools[0].name, "kimi_info");
  assert.equal(typeof pack.handlers.kimi_info, "function");
});

test("loadHarnessTools: 未登记的 harness 返回 null", async () => {
  assert.equal(await loadHarnessTools("nope"), null);
});

test("loadHarnessTools: 已登记但文件缺失 → null(mtime stat 失败分支)", async () => {
  // REGISTRY 固定 5 项且文件都在仓库里;文件缺失分支只能靠"登记名与文件一一对应"间接验证:
  // 若某天登记了新名字但没落文件,availableHarnesses 会少一项——此处锁死登记表与文件的一致性。
  assert.deepEqual((await availableHarnesses()).sort(), ["dsh", "kimi", "opencode", "workbuddy", "zcode"]);
});

test("availableHarnesses: 包含全部 5 个已登记 harness", async () => {
  const list = await availableHarnesses();
  for (const h of ["workbuddy", "kimi", "zcode", "opencode", "dsh"]) assert.ok(list.includes(h), h);
});

test("resolveTool: wb_info 命中 workbuddy", async () => {
  const r = await resolveTool("wb_info");
  assert.ok(r);
  assert.equal(r.harness, "workbuddy");
  assert.equal(typeof r.handler, "function");
  assert.equal(r.pack.prefix, "wb_");
});

test("resolveTool: 未知工具名 → null", async () => {
  assert.equal(await resolveTool("definitely_not_a_tool"), null);
});

// ---- 模板模块:kimi 全测,其余同构 --------------------------------------------

test("kimi_info: 自动匹配 acp-plug 优先于普通同名节点", async () => {
  const ctx = makeCtx({ nodes: NODES });
  const r = await kimiMod.handlers.kimi_info({}, ctx);
  assert.equal(r.node.name, "winpc-kimi");
  assert.equal(r.node.plugId, "kimi");
  assert.equal(r.node.address, "1.2.3.4");
  assert.equal(r.node.model, null);
});

test("kimi_info: 无 acp-plug 时退回名字匹配", async () => {
  const ctx = makeCtx({ nodes: NODES.filter((n) => n.name !== "winpc-kimi") });
  const r = await kimiMod.handlers.kimi_info({}, ctx);
  assert.equal(r.node.name, "kimi-fallback");
});

test("kimi_info: 找不到节点 → error + available 全名列表", async () => {
  const ctx = makeCtx({ nodes: [{ name: "aaa", type: "x" }] });
  const r = await kimiMod.handlers.kimi_info({}, ctx);
  assert.match(r.error, /kimi/);
  assert.deepEqual(r.available, ["aaa"]);
});

test("kimi_info: recent 默认 3、按 created_at 倒序、summary 截断 120、error 兜底、无 summary/error → null", async () => {
  const ctx = makeCtx({ nodes: NODES, tasks: TASKS, adapterAlive: { node: "winpc-kimi", alive: true } });
  const r = await kimiMod.handlers.kimi_info({}, ctx);
  assert.deepEqual(r.recent.map((t) => t.task_id), ["t3", "t2", "t1"]); // 倒序
  assert.equal(r.recent[0].summary.length, 120); // 300 字符被截断
  assert.equal(r.recent[1].summary, "boom"); // error 兜底
  assert.equal(r.recent[2].summary, null); // 两者皆缺 → null
  assert.equal(r.health, "up");
  assert.equal(r.running, 1);
  // 只统计本节点任务
  assert.ok(!r.recent.some((t) => t.task_id === "tx"));
});

test("kimi_info: adapter 不 alive / 缺失 → health=unknown", async () => {
  const ctx = makeCtx({ nodes: NODES, tasks: TASKS });
  const r = await kimiMod.handlers.kimi_info({}, ctx);
  assert.equal(r.health, "unknown");
});

test("kimi_info: recent 数字钳制(非法→3,上限 20)", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    harness: "winpc-kimi", task_id: `t${i}`, state: "succeeded", created_at: `2024-01-${String(i + 1).padStart(2, "0")}`,
  }));
  const bad = await kimiMod.handlers.kimi_info({ recent: "not-a-number" }, makeCtx({ nodes: NODES, tasks: many }));
  assert.equal(bad.recent.length, 3); // Number(...) NaN → || 3
  const zero = await kimiMod.handlers.kimi_info({ recent: 0 }, makeCtx({ nodes: NODES, tasks: many }));
  assert.equal(zero.recent.length, 3); // 0 → || 3
  const capped = await kimiMod.handlers.kimi_info({ recent: 99 }, makeCtx({ nodes: NODES, tasks: many }));
  assert.equal(capped.recent.length, 20); // min(x, 20)
});

test("kimi_info: args.node 精确指定(不存在的名字 → error)", async () => {
  const ctx = makeCtx({ nodes: NODES });
  const ok = await kimiMod.handlers.kimi_info({ node: "kimi-fallback" }, ctx);
  assert.equal(ok.node.name, "kimi-fallback");
  const bad = await kimiMod.handlers.kimi_info({ node: "winpc-kimi-nope" }, ctx);
  assert.ok(bad.error);
});

test("模板模块同构:dsh/opencode/zcode 与 kimi 结构一致、prefix 正确、跨前缀不撞名", async () => {
  const cases = [
    [dshMod, "dsh_", "dsh_info"],
    [opencodeMod, "oc_", "opencode_info"],
    [zcodeMod, "zc_", "zcode_info"],
  ];
  for (const [mod, prefix, toolName] of cases) {
    assert.ok(Array.isArray(mod.tools) && mod.tools.length === 1, `${prefix} tools`);
    assert.equal(mod.tools[0].name, toolName);
    assert.equal(mod.tools[0].inputSchema.type, "object");
    assert.ok(mod.tools[0].doc, `${toolName} 缺 doc`);
    const names = Object.keys(mod.handlers);
    assert.deepEqual(names, [toolName]);
    assert.equal(typeof mod.handlers[toolName], "function");
  }
  // 行为同构:对同一 ctx 各跑一次,确认键集与 kimi 一致
  const ctx = makeCtx({ nodes: TEMPLATE_NODES });
  const baseKeys = Object.keys(await kimiMod.handlers.kimi_info({}, ctx)).sort();
  for (const [mod, , toolName] of cases) {
    const r = await mod.handlers[toolName]({}, ctx);
    assert.deepEqual(Object.keys(r).sort(), baseKeys, toolName);
  }
});

// ---- workbuddy:wb_info ------------------------------------------------------

test("wb_info: 自动匹配 acp-plug workbuddy 节点,带 socks/description/hint", async () => {
  const ctx = makeCtx({ nodes: NODES, tasks: TASKS, adapterAlive: { node: "winpc-workbuddy", alive: true } });
  const r = await wbMod.handlers.wb_info({}, ctx);
  assert.equal(r.node.name, "winpc-workbuddy");
  assert.equal(r.node.address, "9.9.9.9");
  assert.equal(r.node.plugId, "workbuddy");
  assert.equal(r.node.model, null);
  assert.equal(r.node.socks, null); // winpc-workbuddy 未配 socks → null
  assert.equal(r.node.description, ""); // 缺字段 → ""
  assert.equal(r.health, "up");
  assert.ok(r.hint.includes("harness_dispatch"));
  assert.equal(r.recent.length, 1); // 只统计本节点任务(w1)
  assert.equal(r.recent[0].summary.length, 120);
});

test("wb_info: 找不到 workbuddy 节点 → error + available", async () => {
  const ctx = makeCtx({ nodes: [{ name: "zzz", type: "x" }] });
  const r = await wbMod.handlers.wb_info({}, ctx);
  assert.match(r.error, /workbuddy/);
  assert.deepEqual(r.available, ["zzz"]);
});

test("wb_info: recent 非法值回退 3、截断 120", async () => {
  const ctx = makeCtx({ nodes: NODES, tasks: TASKS });
  const r = await wbMod.handlers.wb_info({ recent: "abc" }, ctx);
  assert.equal(r.recent.length, 1); // 非法 recent 回退 3,但本节点只有 1 条任务 → min(3, 1)=1
  assert.ok(r.recent[0].summary.length <= 120);
});

// ---- workbuddy:uiCmd 行协议(handlers dispatch → 轮询 → JSON 解析)-------------

/** 行协议桩:dispatch 记录调用,result 按 task_id 弹出预设状态序列(立即终态,零等待)。 */
function makeUiCtx(responses, { state = "succeeded", summary } = {}) {
  const dispatched = [];
  let n = 0;
  const ctx = makeCtx({ nodes: NODES });
  ctx.mesh.dispatch = async (spec) => {
    dispatched.push(spec);
    const task_id = `wb-${++n}`;
    return { task_id, ...spec };
  };
  const list = Array.isArray(responses) ? responses : [responses ?? { state, summary }];
  ctx.mesh.result = (task_id) => {
    const r = list[Math.min(n - 1, list.length - 1)] ?? {};
    return { task_id, state: r.state ?? state, summary: r.summary !== undefined ? r.summary : summary };
  };
  return { ctx, dispatched };
}

test("wb_ui_status: dispatch 行协议 JSON、harness 按 plugId=workbuddy-ui 自动发现(不再硬编码主机名)、回包 JSON 解析展开", async () => {
  const { ctx, dispatched } = makeUiCtx({ summary: JSON.stringify({ ok: true, model: "m1", sessions: 2 }) });
  const r = await wbMod.handlers.wb_ui_status({}, ctx);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].harness, "winpc-wb-ui");
  assert.equal(dispatched[0].origin, "wb-ui");
  assert.equal(dispatched[0].cwd, null);
  assert.deepEqual(JSON.parse(dispatched[0].prompt), { cmd: "status" });
  assert.equal(r.task_id, "wb-1");
  assert.equal(r.state, "succeeded");
  assert.equal(r.ok, true);
  assert.equal(r.model, "m1");
});

test("uiCmd: 节点表无 wb-ui 节点 → 不 dispatch,报错并列出可用节点(2026-10-19 去硬编码后的新分支)", async () => {
  const { ctx, dispatched } = makeUiCtx({});
  ctx.nodes.list = () => [{ name: "some-other", type: "acp-plug", plugId: "x" }];
  const r = await wbMod.handlers.wb_ui_status({}, ctx);
  assert.equal(dispatched.length, 0, "找不到节点不许派发");
  assert.equal(r.ok, false);
  assert.match(r.error, /wb-ui/);
  assert.deepEqual(r.available, ["some-other"]);
});

test("uiCmd: plugId 缺位时按名字含 wb-ui 兜底发现", async () => {
  const { ctx, dispatched } = makeUiCtx({});
  ctx.nodes.list = () => [{ name: "my-WB-UI-box", type: "acp-plug" }];
  const r = await wbMod.handlers.wb_ui_status({}, ctx);
  assert.equal(dispatched[0].harness, "my-WB-UI-box");
  assert.equal(r.state, "succeeded");
});

test("wb_ui_model: 不带 set 只读;带 set 传 {set}", async () => {
  const a = makeUiCtx({ summary: "{}" });
  await wbMod.handlers.wb_ui_model({}, a.ctx);
  assert.deepEqual(JSON.parse(a.dispatched[0].prompt), { cmd: "model" });
  const b = makeUiCtx({ summary: "{}" });
  await wbMod.handlers.wb_ui_model({ set: "Deepseek-V4.1-Flash" }, b.ctx);
  assert.deepEqual(JSON.parse(b.dispatched[0].prompt), { cmd: "model", set: "Deepseek-V4.1-Flash" });
});

test("wb_ui_screenshot: 缺省无 out;指定 out 转 String", async () => {
  const a = makeUiCtx({ summary: "{}" });
  await wbMod.handlers.wb_ui_screenshot({}, a.ctx);
  assert.deepEqual(JSON.parse(a.dispatched[0].prompt), { cmd: "screenshot" });
  const b = makeUiCtx({ summary: "{}" });
  await wbMod.handlers.wb_ui_screenshot({ out: 123 }, b.ctx);
  assert.deepEqual(JSON.parse(b.dispatched[0].prompt), { cmd: "screenshot", out: "123" });
});

test("wb_ui_send: required text;缺 text 时 String(undefined??'')=''", async () => {
  const a = makeUiCtx({ summary: "{}" });
  await wbMod.handlers.wb_ui_send({ text: "hi" }, a.ctx);
  assert.deepEqual(JSON.parse(a.dispatched[0].prompt), { cmd: "send", text: "hi" });
  const b = makeUiCtx({ summary: "{}" });
  await wbMod.handlers.wb_ui_send({}, b.ctx);
  assert.deepEqual(JSON.parse(b.dispatched[0].prompt), { cmd: "send", text: "" });
});

test("wb_ui_switch_session: title→name 子串匹配参数(兼容旧字段 name)", async () => {
  const a = makeUiCtx({ summary: "{}" });
  await wbMod.handlers.wb_ui_switch_session({ title: "sess A" }, a.ctx);
  assert.deepEqual(JSON.parse(a.dispatched[0].prompt), { cmd: "switch-session", name: "sess A" });
  const b = makeUiCtx({ summary: "{}" });
  await wbMod.handlers.wb_ui_switch_session({ name: "legacy" }, b.ctx);
  assert.deepEqual(JSON.parse(b.dispatched[0].prompt), { cmd: "switch-session", name: "legacy" });
});

test("wb_ui_delete_session: confirm 严格 === true,dry-run 默认 false", async () => {
  const a = makeUiCtx({ summary: "{}" });
  await wbMod.handlers.wb_ui_delete_session({ title: "x", confirm: 1 }, a.ctx); // 1 !== true → dry-run
  assert.deepEqual(JSON.parse(a.dispatched[0].prompt), { cmd: "delete-session", name: "x", confirm: false });
  const b = makeUiCtx({ summary: "{}" });
  await wbMod.handlers.wb_ui_delete_session({ title: "x", confirm: true }, b.ctx);
  assert.deepEqual(JSON.parse(b.dispatched[0].prompt), { cmd: "delete-session", name: "x", confirm: true });
});

test("wb_ui_new_session / wb_ui_rename_session 参数映射", async () => {
  const a = makeUiCtx({ summary: "{}" });
  await wbMod.handlers.wb_ui_new_session({ model: "m" }, a.ctx);
  assert.deepEqual(JSON.parse(a.dispatched[0].prompt), { cmd: "new-session", model: "m" });
  const b = makeUiCtx({ summary: "{}" });
  await wbMod.handlers.wb_ui_new_session({}, b.ctx);
  assert.deepEqual(JSON.parse(b.dispatched[0].prompt), { cmd: "new-session" });
  const c = makeUiCtx({ summary: "{}" });
  await wbMod.handlers.wb_ui_rename_session({ name: "old", new_name: "new" }, c.ctx);
  assert.deepEqual(JSON.parse(c.dispatched[0].prompt), { cmd: "rename", name: "old", newName: "new" });
});

test("uiCmd: 非法 JSON 回包 → {raw: 原文} 不抛异常", async () => {
  const { ctx } = makeUiCtx({ summary: "not-json{{" });
  const r = await wbMod.handlers.wb_ui_sessions({}, ctx);
  assert.equal(r.raw, "not-json{{");
  assert.equal(r.ok, undefined);
});

test("uiCmd: summary 为 null → 解析失败,raw 保留原值 null", async () => {
  const { ctx } = makeUiCtx({ summary: null });
  const r = await wbMod.handlers.wb_ui_sessions({}, ctx);
  assert.equal(r.raw, null); // 源码 parsed = { raw: r.summary }(不是 '')
});

test("uiCmd: 轮询到终态(前两次 running,第三次 succeeded,无固定 sleep)", async () => {
  let calls = 0;
  const ctx = makeCtx({ nodes: NODES });
  ctx.mesh.dispatch = async () => ({ task_id: "wb-x" });
  ctx.mesh.result = () => {
    calls += 1;
    return calls < 3 ? { state: "running", summary: "" } : { state: "succeeded", summary: '{"ok":true}' };
  };
  const r = await wbMod.handlers.wb_ui_status({}, ctx);
  assert.equal(calls, 3);
  assert.equal(r.ok, true);
});

test("uiCmd: retryOnConflict — 首次 ok:false → 重试一次并标 retried(源码含 5s 固定等待,此处实测耗时)", async () => {
  const t0 = Date.now();
  const { ctx, dispatched } = makeUiCtx(null, { summary: JSON.stringify({ ok: false, action: "NOT_FOUND" }) });
  const r = await wbMod.handlers.wb_ui_switch_session({ title: "x" }, ctx);
  assert.equal(dispatched.length, 2, "应二次 dispatch");
  assert.equal(r.retried, true);
  assert.ok(Date.now() - t0 >= 4900, "源码重试前固定 sleep 5000ms");
});

// ---- workbuddy:tools 元数据表 -----------------------------------------------

test("workbuddy tools 表:10 个工具、命名全为 wb_ 前缀、schema 形状合法", () => {
  assert.equal(wbMod.tools.length, 10);
  const names = wbMod.tools.map((t) => t.name);
  assert.deepEqual(names, [
    "wb_info", "wb_ui_status", "wb_ui_sessions", "wb_ui_model", "wb_ui_screenshot",
    "wb_ui_switch_session", "wb_ui_new_session", "wb_ui_delete_session", "wb_ui_send", "wb_ui_rename_session",
  ]);
  for (const t of wbMod.tools) {
    assert.ok(t.name.startsWith("wb_"), t.name);
    assert.ok(t.description, `${t.name} 缺 description`);
    assert.ok(t.doc, `${t.name} 缺 doc`);
    assert.equal(t.inputSchema.type, "object");
    assert.ok(t.inputSchema.properties, `${t.name} 缺 properties`);
  }
});

test("workbuddy handlers:与 tools 一一对应(无漏挂)", () => {
  assert.deepEqual(Object.keys(wbMod.handlers).sort(), wbMod.tools.map((t) => t.name).sort());
});
