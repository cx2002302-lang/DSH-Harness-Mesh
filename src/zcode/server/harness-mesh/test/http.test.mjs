/** lib/http.js 单元测试(node:test + node:assert/strict)。
 *  覆盖:registerRoutes 的路由注册表(路径/方法/requestBody)、dispose 回收、
 *  handler 热加载壳(make → hot → handle)的正常路径/错误码/坏 JSON/404/500。
 *  handler 直接以标准 Request 调用,不起真实 server;DSH_HOME 指向 tmpdir。
 *  运行:node --test test/http.test.mjs
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRoutes } from "../lib/http.js";

// ---- 公共桩 ----
function makeCtx() {
  const registered = [];
  const ctx = {
    connection: {
      fetch: {
        register: (def) => {
          registered.push(def);
          return async () => { registered.splice(registered.indexOf(def), 1); };
        },
      },
    },
  };
  return { ctx, registered };
}

function makeMesh() {
  const tasks = [
    { task_id: "t2", harness: "b", state: "running", prompt: "p2", created_at: "2026-01-02T00:00:00Z" },
    { task_id: "t1", harness: "a", state: "succeeded", prompt: "p1", created_at: "2026-01-01T00:00:00Z" },
    { task_id: "t3", harness: "a", state: "failed", prompt: "p3", created_at: "2026-01-03T00:00:00Z" },
  ];
  return {
    adapters: new Map(),
    store: { list: () => tasks, countRunning: () => 0 },
    dispatchCalls: [],
    dispatch: async (arg) => { tasks[0].dispatchArgs = arg; return { task_id: "t-new", state: "queued", harness: arg.harness, __args: arg }; },
    status: (id) => { if (id === "t1") return { state: "succeeded" }; throw new Error("no such task: " + id); },
    result: (id) => ({ summary: "done:" + id }),
  };
}

function makeNodes() {
  const nodes = [
    { name: "n1", type: "acp-stdio", command: "opencode" },
    { name: "n2", type: "acp-plug", address: "10.0.0.2:9", plugId: "kimi" },
  ];
  return {
    list: () => nodes,
    saved: [],
    save: (n) => {
      if (!n || !n.name || !/^[A-Za-z0-9_-]{1,32}$/.test(n.name)) throw new Error("invalid node");
      nodes.push(n); return n;
    },
    remove: (name) => { const i = nodes.findIndex((n) => n.name === name); if (i < 0) return false; nodes.splice(i, 1); return true; },
  };
}

let tmpHome;
beforeEach(() => { tmpHome = mkdtempSync(join(tmpdir(), "http-test-")); process.env.DSH_HOME = tmpHome; });
afterEach(() => { delete process.env.DSH_HOME; rmSync(tmpHome, { recursive: true, force: true }); });

async function setup() {
  const { ctx, registered } = makeCtx();
  const mesh = makeMesh();
  const nodes = makeNodes();
  const dispose = registerRoutes(ctx, mesh, nodes);
  const handler = registered[0].fetch; // 全部路由共用同一个 handler
  return { registered, mesh, nodes, dispose, handler };
}

const j = async (res) => ({ status: res.status, body: await res.json() });

// ---- 注册表 ----
test("注册全部固定路由,方法与 requestBody 正确", async () => {
  const { registered, dispose } = await setup();
  const paths = registered.map((r) => r.path);
  for (const p of [
    "/api/harness-mesh/nodes", "/api/harness-mesh/node", "/api/harness-mesh/dispatch",
    "/api/harness-mesh/team", "/api/harness-mesh/plug-reload", "/api/harness-mesh/task",
    "/api/harness-mesh/tasks", "/api/harness-mesh/cancel", "/api/harness-mesh/permission",
    "/api/harness-mesh/ai-config",
    "/api/mcp/harness-mesh", "/api/mcp/harness-mesh-admin",
  ]) assert.ok(paths.includes(p), `缺路径 ${p}`);
  // /api/harness-mesh/models 曾是注册表里的死路由(hot.js 从未实现),2026-10-19 摘除,不许复活
  assert.ok(!paths.includes("/api/harness-mesh/models"), "死路由 /models 不应复活");
  assert.equal(paths.length, new Set(paths).size, "路径不应重复");
  for (const r of registered) {
    assert.ok(Array.isArray(r.methods) && r.methods.length > 0, `${r.path} methods 为空`);
    assert.equal(r.requestBody, "buffered");
    assert.equal(typeof r.fetch, "function");
  }
  const byPath = Object.fromEntries(registered.map((r) => [r.path, r.methods]));
  assert.deepEqual(byPath["/api/harness-mesh/nodes"].sort(), ["GET", "POST"]);
  assert.deepEqual(byPath["/api/harness-mesh/node"], ["DELETE"]);
  assert.deepEqual(byPath["/api/harness-mesh/dispatch"], ["POST"]);
  assert.deepEqual(byPath["/api/mcp/harness-mesh"].sort(), ["DELETE", "GET", "POST"]);
  assert.equal(await dispose(), undefined);
  assert.equal(registered.length, 0, "dispose 应回收全部路由");
});

test("dispose 幂等:二次调用不再抛错", async () => {
  const { dispose } = await setup();
  await dispose();
  await dispose(); // 不应抛
});

// ---- handler 正常路径(经真实 hot.js handle) ----
test("GET /nodes:返回原始节点 + target/health/running 标注", async () => {
  const { handler } = await setup();
  const { status, body } = await j(await handler(new Request("http://127.0.0.1/api/harness-mesh/nodes")));
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.nodes.length, 2);
  const plug = body.nodes.find((n) => n.name === "n2");
  assert.equal(plug.target, "10.0.0.2:9#kimi");
  const local = body.nodes.find((n) => n.name === "n1");
  assert.equal(local.target, "local");
  assert.equal(local.health, "unknown"); // 无任务历史
  assert.equal(plug.running, 0);
  assert.match(new Request("http://x").url, /x/); // 防 lint 空转
});

test("GET /nodes:最近任务 succeeded → health=idle;failed → down", async () => {
  const { handler } = await setup();
  const { body } = await j(await handler(new Request("http://127.0.0.1/api/harness-mesh/nodes")));
  const a = body.nodes.find((n) => n.name === "a");
  assert.equal(a, undefined); // 节点表里没有 a,确认映射只对真实节点
  // 用真实节点名注入任务历史
  const { handler: h2, nodes } = await setup();
  nodes.list().length = 0;
  nodes.list().push({ name: "a", type: "acp-stdio", command: "x" }, { name: "b", type: "acp-stdio", command: "x" });
  const tasks = [
    { task_id: "t1", harness: "a", state: "succeeded", created_at: "2026-01-01T00:00:00Z" },
    { task_id: "t2", harness: "b", state: "timeout", created_at: "2026-01-02T00:00:00Z" },
  ];
  // 重建一个带该历史的 mesh
  const { ctx } = makeCtx();
  const mesh = makeMesh();
  mesh.store.list = () => tasks;
  const registered = [];
  ctx.connection.fetch.register = (d) => { registered.push(d); return async () => {}; };
  const dispose = registerRoutes(ctx, mesh, nodes);
  const { body: b2 } = await j(await registered[0].fetch(new Request("http://127.0.0.1/api/harness-mesh/nodes")));
  assert.equal(b2.nodes.find((n) => n.name === "a").health, "idle");
  assert.equal(b2.nodes.find((n) => n.name === "b").health, "down");
  await dispose();
});

test("POST /nodes:合法节点保存成功;非法节点 400", async () => {
  const { handler, nodes } = await setup();
  const ok = await j(await handler(new Request("http://127.0.0.1/api/harness-mesh/nodes", {
    method: "POST", body: JSON.stringify({ node: { name: "n3", type: "acp-stdio", command: "x" } }),
    headers: { "content-type": "application/json" },
  })));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.node.name, "n3");
  assert.ok(nodes.list().some((n) => n.name === "n3"));

  const bad = await j(await handler(new Request("http://127.0.0.1/api/harness-mesh/nodes", {
    method: "POST", body: JSON.stringify({ node: { name: "坏名字!" } }),
    headers: { "content-type": "application/json" },
  })));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.ok, false);
});

test("POST /nodes:坏 JSON 请求体按 {} 处理 → 400(不崩)", async () => {
  const { handler } = await setup();
  const res = await handler(new Request("http://127.0.0.1/api/harness-mesh/nodes", {
    method: "POST", body: "{not json", headers: { "content-type": "application/json" },
  }));
  assert.equal(res.status, 400);
  const { body } = await j(res);
  assert.equal(body.ok, false);
});

test("POST /nodes:无请求体 → readJson 兜底 {} → 400", async () => {
  const { handler } = await setup();
  const res = await handler(new Request("http://127.0.0.1/api/harness-mesh/nodes", { method: "POST" }));
  assert.equal(res.status, 400);
});

test("DELETE /node?name=X:合法名删除并回 true;非法名 400;不存在回 false", async () => {
  const { handler } = await setup();
  const ok = await j(await handler(new Request("http://127.0.0.1/api/harness-mesh/node?name=n1", { method: "DELETE" })));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.name, "n1");

  const missing = await j(await handler(new Request("http://127.0.0.1/api/harness-mesh/node?name=ghost", { method: "DELETE" })));
  assert.equal(missing.status, 200);
  assert.equal(missing.body.ok, false);

  for (const bad of ["", "有中文", "a".repeat(33), "x.y"]) {
    const r = await j(await handler(new Request(`http://127.0.0.1/api/harness-mesh/node?name=${encodeURIComponent(bad)}`, { method: "DELETE" })));
    assert.equal(r.status, 400, `非法名应 400: ${JSON.stringify(bad)}`);
    assert.equal(r.body.ok, false);
  }
});

test("DELETE /node 缺 name 参数 → 按空串处理 → 400", async () => {
  const { handler } = await setup();
  const r = await j(await handler(new Request("http://127.0.0.1/api/harness-mesh/node", { method: "DELETE" })));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "invalid name");
});

test("POST /dispatch:正常派发回 task_id;缺 prompt 400;dispatch 抛错 400", async () => {
  const { handler, mesh } = await setup();
  const ok = await j(await handler(new Request("http://127.0.0.1/api/harness-mesh/dispatch", {
    method: "POST",
    body: JSON.stringify({ harness: "n1", prompt: "do it", cwd: "/tmp", model: "m", origin: "test" }),
    headers: { "content-type": "application/json" },
  })));
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true, task_id: "t-new", state: "queued", harness: "n1" });

  const missing = await j(await handler(new Request("http://127.0.0.1/api/harness-mesh/dispatch", {
    method: "POST", body: JSON.stringify({ harness: "n1" }), headers: { "content-type": "application/json" },
  })));
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /prompt/);

  const nonStr = await j(await handler(new Request("http://127.0.0.1/api/harness-mesh/dispatch", {
    method: "POST", body: JSON.stringify({ prompt: 123 }), headers: { "content-type": "application/json" },
  })));
  assert.equal(nonStr.status, 400);

  mesh.dispatch = async () => { throw new Error("unknown harness: zz"); };
  const err = await j(await handler(new Request("http://127.0.0.1/api/harness-mesh/dispatch", {
    method: "POST", body: JSON.stringify({ harness: "zz", prompt: "p" }), headers: { "content-type": "application/json" },
  })));
  assert.equal(err.status, 400);
  assert.match(err.body.error, /unknown harness/);
});

test("POST /dispatch:模型字段为非字符串时不透传 model", async () => {
  const { handler, mesh } = await setup();
  let captured;
  mesh.dispatch = async (arg) => { captured = arg; return { task_id: "t", state: "queued", harness: arg.harness }; };
  await handler(new Request("http://127.0.0.1/api/harness-mesh/dispatch", {
    method: "POST", body: JSON.stringify({ harness: "n1", prompt: "p", model: { evil: true } }),
    headers: { "content-type": "application/json" },
  }));
  assert.equal(captured.model, undefined);
  assert.equal(captured.origin, undefined);
});

test("GET /task:存在 → ok + 终态附 result;不存在 → 404;缺 task_id → 404", async () => {
  const { handler } = await setup();
  const ok = await j(await handler(new Request("http://127.0.0.1/api/harness-mesh/task?task_id=t1")));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status.state, "succeeded");
  assert.equal(ok.body.result.summary, "done:t1");

  const nf = await j(await handler(new Request("http://127.0.0.1/api/harness-mesh/task?task_id=nope")));
  assert.equal(nf.status, 404);
  assert.equal(nf.body.ok, false);

  const noId = await j(await handler(new Request("http://127.0.0.1/api/harness-mesh/task")));
  assert.equal(noId.status, 404);
});

test("GET /tasks:列表/节点过滤/状态过滤/limit 截断/limit 上限 100", async () => {
  const { handler } = await setup();
  const all = await j(await handler(new Request("http://127.0.0.1/api/harness-mesh/tasks")));
  assert.equal(all.status, 200);
  assert.equal(all.body.tasks.length, 3);
  assert.equal(all.body.tasks[0].task_id, "t3", "默认按 created_at 倒序");

  const byH = await j(await handler(new Request("http://127.0.0.1/api/harness-mesh/tasks?harness=a")));
  assert.equal(byH.body.tasks.length, 2);
  assert.ok(byH.body.tasks.every((t) => t.harness === "a"));

  const byS = await j(await handler(new Request("http://127.0.0.1/api/harness-mesh/tasks?state=running")));
  assert.equal(byS.body.tasks.length, 1);
  assert.equal(byS.body.tasks[0].task_id, "t2");

  const lim = await j(await handler(new Request("http://127.0.0.1/api/harness-mesh/tasks?limit=2")));
  assert.equal(lim.body.tasks.length, 2);

  // 超上限被钳到 100:构造 150 条任务
  const { ctx, registered } = makeCtx();
  const mesh = makeMesh();
  mesh.store.list = () => Array.from({ length: 150 }, (_, i) => ({ task_id: `t${i}`, harness: "x", state: "queued", prompt: "p", created_at: "2026-01-01T00:00:00Z" }));
  const nodes = makeNodes();
  const dispose = registerRoutes(ctx, mesh, nodes);
  const capped = await j(await registered[0].fetch(new Request("http://127.0.0.1/api/harness-mesh/tasks?limit=999")));
  assert.ok(capped.body.tasks.length <= 100, "limit 应被钳到 100");
  await dispose();
});

test("未注册路径 → hot 兜底 404 not found", async () => {
  const { handler } = await setup();
  const r = await j(await handler(new Request("http://127.0.0.1/api/harness-mesh/nothing")));
  assert.equal(r.status, 404);
  assert.match(r.body.error, /not found/);
});

test("handler 顶层异常 → 500 {ok:false,error}(registerRoutes 的 catch 壳)", async () => {
  const { handler } = await setup();
  // hot.handle 第一行 new URL(request.url) 会对非法 URL 抛错 → 被 http.js 捕获回 500
  const bad = new Request("http://127.0.0.1/api/harness-mesh/nodes");
  Object.defineProperty(bad, "url", { value: "::not a url::" });
  const r = await j(await handler(bad));
  assert.equal(r.status, 500);
  assert.equal(r.body.ok, false);
  assert.ok(typeof r.body.error === "string" && r.body.error.length > 0);
});

test("热加载缓存:连续两次请求复用同一 handler 实例均成功", async () => {
  const { handler } = await setup();
  const r1 = await handler(new Request("http://127.0.0.1/api/harness-mesh/tasks"));
  const r2 = await handler(new Request("http://127.0.0.1/api/harness-mesh/tasks"));
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
});

test("响应 content-type 为 application/json", async () => {
  const { handler } = await setup();
  const res = await handler(new Request("http://127.0.0.1/api/harness-mesh/nodes"));
  assert.match(res.headers.get("content-type"), /application\/json/);
});

// ---- MCP 入口(经注册 handler → hot handle) ----
test("MCP 入口:tools/list 不含 admin 专属工具;ping 可用;未知 method 报 -32601", async () => {
  const { handler } = await setup();
  const call = (method, params) => handler(new Request("http://127.0.0.1/api/mcp/harness-mesh", {
    method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    headers: { "content-type": "application/json" },
  })).then((r) => r.json());

  const tools = await call("tools/list", {});
  const names = tools.result.tools.map((t) => t.name);
  assert.ok(names.includes("harness_dispatch") && names.includes("harness_help"));
  assert.ok(!names.includes("harness_team"), "客户端入口不应看到 admin 扩展工具");

  const pong = await call("ping", {});
  assert.deepEqual(pong.result, {});

  const bad = await call("no/such/method", {});
  assert.equal(bad.error.code, -32601);
});
