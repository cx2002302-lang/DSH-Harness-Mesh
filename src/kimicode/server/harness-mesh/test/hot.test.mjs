/** lib/hot.js 单元测试(node:test + node:assert/strict,零第三方框架)。
 *  hot.js 唯一公开导出是 handle(request, deps)——按 pathname 分发全部 REST/MCP 请求。
 *  全部依赖(request/json/readJson/ctx/mesh/nodes)注入桩;文件落盘经 DSH_HOME 指到
 *  os.tmpdir() 的 mkdtemp 临时目录(TEAM_FILE/CONFIRM_FILE 在模块加载时定型,必须先设 env 再 import)。
 *  不碰网络、不开端口。运行:node --test test/hot.test.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- 先定 DSH_HOME 再动态 import(模块顶层的 TEAM_FILE/CONFIRM_FILE/CONTROL_LOG 依赖它) ----
const TMP = mkdtempSync(join(tmpdir(), "hot-test-"));
process.env.DSH_HOME = TMP;
const { handle } = await import("../lib/hot.js");
const { validateNode } = await import("../lib/config.js");

const MESH_DIR = join(TMP, "harness-mesh");
const TEAM_FILE = join(MESH_DIR, "team-roles.json");
const CONFIRM_FILE = join(MESH_DIR, "session-confirms.json");
const CONTROL_LOG = join(MESH_DIR, "session-control.log");

after(() => { rmSync(TMP, { recursive: true, force: true }); });

// ---- 桩工厂 ----
const req = (path, { method = "GET", body, query = "" } = {}) => ({
  url: `http://127.0.0.1${path}${query}`,
  method,
  headers: { get: () => null },
  __body: body === undefined ? null : JSON.stringify(body),
});

const readJson = async (r) => {
  if (r.__body === null) throw new Error("empty body");
  return JSON.parse(r.__body);
};
const json = (data, status = 200) => ({ __json: true, status, data });

function makeNodes(over = {}) {
  const table = new Map([["alpha", { name: "alpha", type: "acp-stdio", command: "opencode", model: null }]]);
  return {
    get: (n) => table.get(n) ?? null,
    list: () => [...table.values()],
    save: (n) => { const v = validateNode(String(n.name ?? "").trim(), n); table.set(v.name, v); return v; },
    remove: (n) => table.delete(n),
    ...over,
  };
}

function makeMesh(over = {}) {
  return {
    adapters: new Map(),
    store: { list: () => [], countRunning: () => 0, get: () => null, update: () => {} },
    dispatch: async (o) => ({ task_id: "t-1", state: "queued", harness: o.harness }),
    cancel: async () => ({ state: "cancelling" }),
    status: (id) => ({ task_id: id, state: "succeeded" }),
    result: (id) => ({ task_id: id, summary: "done" }),
    resolvePendingPermission: () => true,
    listNodes: async () => [],
    dispatchTeam: async (o) => ({ team_id: "team-1", tasks: [{ task_id: "t-1", harness: "alpha", role: "前端" }] }),
    teamResult: (id) => ({ team_id: id, members: [{ task_id: "t-1", harness: "alpha" }] }),
    live: new Map(),
    ...over,
  };
}

const deps = (mesh, nodes, ctx = {}) => ({ ctx: { llm: { stream: async function* () {} }, ...ctx }, mesh, nodes: nodes ?? makeNodes(), json, readJson });
const post = (path, body, mesh, nodes, ctx) => handle(req(path, { method: "POST", body }), deps(mesh, nodes, ctx));
const get = (path, query, mesh, nodes, ctx) => handle(req(path, { query }), deps(mesh, nodes, ctx));

// ================= 节点 CRUD =================
test("POST /nodes 保存成功,body.node 优先于裸 body", async () => {
  const mesh = makeMesh();
  const res = await post("/api/harness-mesh/nodes", { node: { name: "beta", type: "acp-stdio", command: "kimi" } }, mesh);
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.node.name, "beta");
  // 裸 body 也能存
  const res2 = await post("/api/harness-mesh/nodes", { name: "gamma", type: "acp-stdio", command: "zcode" }, mesh);
  assert.equal(res2.data.ok, true);
  assert.equal(res2.data.node.name, "gamma");
});

test("POST /nodes 校验失败 → 400 + ok:false", async () => {
  const res = await post("/api/harness-mesh/nodes", { node: { name: "非法名!", type: "acp-stdio" } });
  assert.equal(res.status, 400);
  assert.equal(res.data.ok, false);
  assert.ok(String(res.data.error).includes("非法"));
});

test("GET /nodes:target 推导 + health 语义 + running", async () => {
  const mesh = makeMesh({
    adapters: new Map([["plug-node", { alive: true }]]),
    store: {
      list: () => [
        { harness: "idle-node", state: "succeeded", created_at: "2026-01-02T00:00:00Z" },
        { harness: "idle-node", state: "succeeded", created_at: "2026-01-01T00:00:00Z" },
        { harness: "down-node", state: "failed", created_at: "2026-01-03T00:00:00Z" },
        { harness: "run-node", state: "running", created_at: "2026-01-04T00:00:00Z" },
      ],
      countRunning: (n) => (n === "run-node" ? 2 : 0),
    },
  });
  const nodes = makeNodes();
  nodes.save({ name: "ssh-node", type: "acp-ssh", ssh: "me@10.0.0.2", command: "kimi" });
  nodes.save({ name: "plug-node", type: "acp-plug", address: "10.0.0.3:7080", plugId: "kimi", command: "" });
  nodes.save({ name: "idle-node", type: "acp-stdio", command: "x" });
  nodes.save({ name: "down-node", type: "acp-stdio", command: "x" });
  nodes.save({ name: "run-node", type: "acp-stdio", command: "x" });
  const res = await get("/api/harness-mesh/nodes", "", mesh, nodes);
  assert.equal(res.status, 200);
  const by = Object.fromEntries(res.data.nodes.map((n) => [n.name, n]));
  assert.equal(by["ssh-node"].target, "me@10.0.0.2");
  assert.equal(by["plug-node"].target, "10.0.0.3:7080#kimi");
  assert.equal(by["alpha"].target, "local");
  assert.equal(by["plug-node"].health, "up");       // adapter alive → up
  assert.equal(by["idle-node"].health, "idle");      // 最近 succeeded → idle
  assert.equal(by["down-node"].health, "down");      // 最近 failed → down
  assert.equal(by["run-node"].health, "idle");       // running → 归 idle 分支
  assert.equal(by["alpha"].health, "unknown");       // 无任务记录 → unknown
  assert.equal(by["run-node"].running, 2);
});

test("DELETE /node:非法名 400,合法名返回 remove 结果", async () => {
  const nodes = makeNodes();
  const bad = await handle(req("/api/harness-mesh/node", { method: "DELETE", query: "?name=bad%20name!" }), deps(makeMesh(), nodes));
  assert.equal(bad.status, 400);
  assert.equal(bad.data.ok, false);
  const ok = await handle(req("/api/harness-mesh/node", { method: "DELETE", query: "?name=alpha" }), deps(makeMesh(), nodes));
  assert.equal(ok.data.ok, true);
  assert.equal(ok.data.name, "alpha");
  assert.equal(nodes.get("alpha"), null);
  const missing = await handle(req("/api/harness-mesh/node", { method: "DELETE", query: "?name=ghost" }), deps(makeMesh(), nodes));
  assert.equal(missing.data.ok, false);
});

// ================= 派发 / 跟进 =================
test("POST /dispatch:缺 prompt 400;成功返回 task;dispatch 抛错 400;model 非 string 忽略", async () => {
  const noPrompt = await post("/api/harness-mesh/dispatch", { harness: "alpha" });
  assert.equal(noPrompt.status, 400);
  assert.match(noPrompt.data.error, /prompt/);

  const badPrompt = await post("/api/harness-mesh/dispatch", { harness: "alpha", prompt: 42 });
  assert.equal(badPrompt.status, 400);

  const seen = [];
  const mesh = makeMesh({ dispatch: async (o) => { seen.push(o); return { task_id: "t-9", state: "queued", harness: o.harness }; } });
  const ok = await post("/api/harness-mesh/dispatch", { harness: "alpha", prompt: "干活", model: 123, origin: "gui", timeoutMs: 500 }, mesh);
  assert.equal(ok.status, 200);
  assert.deepEqual({ task_id: ok.data.task_id, state: ok.data.state, harness: ok.data.harness }, { task_id: "t-9", state: "queued", harness: "alpha" });
  assert.equal(seen[0].model, undefined); // 非字符串 model 不透传
  assert.equal(seen[0].origin, "gui");

  const boom = makeMesh({ dispatch: async () => { throw new Error("节点不存在"); } });
  const err = await post("/api/harness-mesh/dispatch", { harness: "ghost", prompt: "x" }, boom);
  assert.equal(err.status, 400);
  assert.match(err.data.error, /节点不存在/);
});

test("GET /task:终态带 result,未知任务 404", async () => {
  const ok = await get("/api/harness-mesh/task", "?task_id=t-1", makeMesh());
  assert.equal(ok.data.ok, true);
  assert.equal(ok.data.status.state, "succeeded");
  assert.deepEqual(ok.data.result, { task_id: "t-1", summary: "done" });

  const running = makeMesh({ status: () => ({ state: "running" }) });
  const r2 = await get("/api/harness-mesh/task", "?task_id=t-2", running);
  assert.equal(r2.data.result, null); // 非终态不给 result

  const missing = makeMesh({ status: () => { throw new Error("no such task"); } });
  const r3 = await get("/api/harness-mesh/task", "?task_id=nope", missing);
  assert.equal(r3.status, 404);
});

test("GET /tasks:过滤/排序/limit/字段裁剪", async () => {
  const mesh = makeMesh({
    store: {
      list: () => [
        { task_id: "a", harness: "n1", state: "running", prompt: "p-a", created_at: "2026-01-01T00:00:00Z", origin: "gui" },
        { task_id: "b", harness: "n2", state: "succeeded", prompt: "p-b", summary: "s", duration_ms: 5, created_at: "2026-01-03T00:00:00Z", secret: "不应出现" },
        { task_id: "c", harness: "n1", state: "failed", prompt: "p-c", error: "e", created_at: "2026-01-02T00:00:00Z" },
      ],
      countRunning: () => 0,
    },
  });
  const all = await get("/api/harness-mesh/tasks", "", mesh);
  assert.equal(all.data.tasks.length, 3);
  assert.deepEqual(all.data.tasks.map((t) => t.task_id), ["b", "c", "a"]); // created_at 倒序
  assert.equal("secret" in all.data.tasks[0], false); // 字段白名单

  const byHarness = await get("/api/harness-mesh/tasks", "?harness=n1", mesh);
  assert.deepEqual(byHarness.data.tasks.map((t) => t.task_id), ["c", "a"]);
  const byState = await get("/api/harness-mesh/tasks", "?state=failed", mesh);
  assert.deepEqual(byState.data.tasks.map((t) => t.task_id), ["c"]);
  const limited = await get("/api/harness-mesh/tasks", "?limit=1", mesh);
  assert.equal(limited.data.tasks.length, 1);
});

test("POST /cancel:成功透传,失败 400", async () => {
  const ok = await post("/api/harness-mesh/cancel", { task_id: "t-1" }, makeMesh());
  assert.equal(ok.data.ok, true);
  assert.equal(ok.data.state, "cancelling");
  const boom = makeMesh({ cancel: async () => { throw new Error("任务已终态"); } });
  const err = await post("/api/harness-mesh/cancel", { task_id: "t-1" }, boom);
  assert.equal(err.status, 400);
});

test("POST /permission:缺 task_id 400;allow 只有 ===true 才算允许", async () => {
  const noId = await post("/api/harness-mesh/permission", {});
  assert.equal(noId.status, 400);
  const seen = [];
  const mesh = makeMesh({ resolvePendingPermission: (id, allow) => { seen.push([id, allow]); return allow; } });
  const yes = await post("/api/harness-mesh/permission", { task_id: "t-1", allow: true }, mesh);
  const no = await post("/api/harness-mesh/permission", { task_id: "t-1", allow: "yes" }, mesh);
  assert.deepEqual(seen, [["t-1", true], ["t-1", false]]); // "yes" 不算 true
  assert.equal(yes.data.ok, true);
  assert.equal(no.data.ok, false);
});

// ================= AI 辅助配置 =================
test("POST /ai-config:缺 description 400;流抛错 422;合法 JSON 产出节点草案", async () => {
  const noDesc = await post("/api/harness-mesh/ai-config", {});
  assert.equal(noDesc.status, 400);

  const boomCtx = { llm: { stream: async function* () { yield ({ type: "text-delta", index: 0, text: "{" }); throw new Error("上游断了"); } } };
  const boom = await post("/api/harness-mesh/ai-config", { description: "开个节点" }, makeMesh(), makeNodes(), boomCtx);
  assert.equal(boom.status, 422);

  const goodCtx = {
    llm: { stream: async function* () {
      yield ({ type: "text-delta", index: 0, text: '好的,这是配置:{"name":"beta","type":"acp-stdio","command":"opencode"} 请确认' });
    } },
  };
  const good = await post("/api/harness-mesh/ai-config", { description: "开个 opencode 节点" }, makeMesh(), makeNodes(), goodCtx);
  assert.equal(good.status, 200);
  assert.equal(good.data.node.name, "beta");
  assert.equal(good.data.node.command, "opencode");
  assert.ok(good.data.raw.includes("beta"));
});

test("POST /ai-config:AI 返回非法节点(坏类型/非 JSON)→ 422", async () => {
  const badType = { llm: { stream: async function* () { yield ({ type: "text-delta", index: 0, text: '{"name":"b","type":"warp-drive"}' }); } } };
  const r1 = await post("/api/harness-mesh/ai-config", { description: "x" }, makeMesh(), makeNodes(), badType);
  assert.equal(r1.status, 422);
  assert.match(r1.data.error, /类型/);

  const notJson = { llm: { stream: async function* () { yield ({ type: "text-delta", index: 0, text: "完全没有花括号" }); } } };
  const r2 = await post("/api/harness-mesh/ai-config", { description: "x" }, makeMesh(), makeNodes(), notJson);
  assert.equal(r2.status, 422);
  assert.match(r2.data.error, /AI 未返回 JSON/);

  const halfBrace = { llm: { stream: async function* () { yield ({ type: "text-delta", index: 0, text: "{{{" }); } } };
  const r3 = await post("/api/harness-mesh/ai-config", { description: "x" }, makeMesh(), makeNodes(), halfBrace);
  assert.equal(r3.status, 422);
});

// ================= 插头热重载 =================
test("POST /plug-reload:适配器缺失/无 reloadPlugs → 400;成功透传 reload 结果;抛错 400", async () => {
  const none = await post("/api/harness-mesh/plug-reload", { harness: "ghost" }, makeMesh());
  assert.equal(none.status, 400);
  assert.match(none.data.error, /适配器不在/);

  const bare = makeMesh({ adapters: new Map([["alpha", {}]]) });
  const noFn = await post("/api/harness-mesh/plug-reload", { harness: "alpha" }, bare);
  assert.equal(noFn.status, 400);

  const okMesh = makeMesh({ adapters: new Map([["alpha", { reloadPlugs: async () => ({ reloaded: ["kimi"] }) }]]) });
  const ok = await post("/api/harness-mesh/plug-reload", { harness: "alpha" }, okMesh);
  assert.deepEqual(ok.data.reload, { reloaded: ["kimi"] });

  const boom = makeMesh({ adapters: new Map([["alpha", { reloadPlugs: async () => { throw new Error("对端拒绝"); } }]]) });
  const err = await post("/api/harness-mesh/plug-reload", { harness: "alpha" }, boom);
  assert.equal(err.status, 400);
  assert.match(err.data.error, /对端拒绝/);
});

// ================= 开团(REST,落盘 team-roles.json) =================
test("POST /team 落盘角色;GET /team 回填 role;teamResult 抛错 404", async () => {
  mkdirSync(MESH_DIR, { recursive: true });
  const mesh = makeMesh();
  const created = await post("/api/harness-mesh/team", { task: "并行干活", members: [{ harness: "alpha", role: "前端" }] }, mesh);
  assert.equal(created.data.ok, true);
  assert.equal(created.data.team_id, "team-1");
  assert.ok(existsSync(TEAM_FILE));
  const saved = JSON.parse(readFileSync(TEAM_FILE, "utf8"));
  assert.deepEqual(saved["team-1"], [{ task_id: "t-1", harness: "alpha", role: "前端" }]);

  const agg = await get("/api/harness-mesh/team", "?team_id=team-1", mesh);
  assert.equal(agg.data.ok, true);
  assert.equal(agg.data.members[0].role, "前端");

  const miss = await get("/api/harness-mesh/team", "?team_id=ghost", makeMesh({ teamResult: () => { throw new Error("不存在"); } }));
  assert.equal(miss.status, 404);

  // 没有角色记录的成员 → role:null(不炸)
  writeFileSync(TEAM_FILE, JSON.stringify({}));
  const noRole = await get("/api/harness-mesh/team", "?team_id=team-1", mesh);
  assert.equal(noRole.data.members[0].role, null);
});

test("POST /team:dispatchTeam 抛错 → 400 且不落盘", async () => {
  rmSync(TEAM_FILE, { force: true });
  const mesh = makeMesh({ dispatchTeam: async () => { throw new Error("成员为空"); } });
  const err = await post("/api/harness-mesh/team", { task: "x", members: [] }, mesh);
  assert.equal(err.status, 400);
  assert.equal(existsSync(TEAM_FILE), false);
});

// ================= MCP 入口 =================
const mcpCall = async (path, msg, mesh, nodes, ctx) =>
  handle(req(path, { method: "POST", body: msg }), deps(mesh, nodes, ctx));
// 兼容两种返回:json() 桩({__json,data})与 initialize 的真 Response
const bodyOf = async (res) => (res.__json ? res.data : await res.json());
const mcpText = async (res) => JSON.parse((await bodyOf(res)).result.content[0].text);
const mcpErr = async (res) => (await bodyOf(res)).error;

test("MCP:非 POST 405;坏 JSON -32700;notification(id 缺)202;ping;未知 method -32601", async () => {
  const mesh = makeMesh();
  const wrongMethod = await handle(req("/api/mcp/harness-mesh"), deps(mesh));
  assert.equal(wrongMethod.status, 405);

  const bad = new Response(null); // 占位避免误用
  const badRes = await handle(
    Object.assign(req("/api/mcp/harness-mesh", { method: "POST" }), { __body: "{not json" }),
    deps(mesh),
  );
  assert.equal(badRes.status, 400);
  assert.equal(badRes.data.error.code, -32700);
  void bad;

  const init = await mcpCall("/api/mcp/harness-mesh", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, mesh);
  assert.equal(init.status, 200);
  const initBody = await bodyOf(init);
  assert.equal(initBody.result.serverInfo.name, "harness-mesh");
  assert.deepEqual(initBody.result.unified.length > 0, true);

  const notif = await mcpCall("/api/mcp/harness-mesh", { jsonrpc: "2.0", method: "notifications/initialized" }, mesh);
  assert.equal(notif.status, 202);

  const ping = await mcpCall("/api/mcp/harness-mesh", { jsonrpc: "2.0", id: 2, method: "ping" }, mesh);
  assert.deepEqual((await bodyOf(ping)).result, {});

  const unknown = await mcpCall("/api/mcp/harness-mesh", { jsonrpc: "2.0", id: 3, method: "resources/list" }, mesh);
  assert.equal((await mcpErr(unknown)).code, -32601);
});

test("MCP tools/list:客户端入口不含 admin 工具,admin 入口含", async () => {
  const client = await bodyOf(await mcpCall("/api/mcp/harness-mesh", { jsonrpc: "2.0", id: 1, method: "tools/list" }, makeMesh()));
  const names = client.result.tools.map((t) => t.name);
  assert.ok(names.includes("harness_list") && names.includes("harness_help"));
  assert.ok(!names.includes("harness_team"));
  const admin = await bodyOf(await mcpCall("/api/mcp/harness-mesh-admin", { jsonrpc: "2.0", id: 1, method: "tools/list" }, makeMesh()));
  assert.ok(admin.result.tools.map((t) => t.name).includes("harness_team"));
});

test("MCP tools/call:admin 工具在客户端入口被拒(-32601);unknown tool -32000;harness_help/harness_tools/harness_config", async () => {
  const mesh = makeMesh();
  const denied = await mcpCall("/api/mcp/harness-mesh", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "harness_team", arguments: {} } }, mesh);
  assert.equal((await mcpErr(denied)).code, -32601);
  // 同一工具在 admin 入口可用
  const admin = await mcpCall("/api/mcp/harness-mesh-admin", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "harness_team", arguments: { task: "t", members: [{ harness: "alpha" }] } } }, mesh);
  const adminBody = await bodyOf(admin);
  assert.equal(adminBody.result.content[0].type, "text");
  assert.ok(JSON.parse(adminBody.result.content[0].text).team_id === "team-1");

  const unknown = await mcpCall("/api/mcp/harness-mesh", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "no_such_tool", arguments: {} } }, mesh);
  assert.match((await mcpErr(unknown)).message, /unknown tool/);

  const helpAll = await mcpText(await mcpCall("/api/mcp/harness-mesh", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "harness_help", arguments: {} } }, mesh));
  assert.ok(Array.isArray(helpAll.tools) && typeof helpAll.sop === "string");
  const helpOne = await mcpText(await mcpCall("/api/mcp/harness-mesh", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "harness_help", arguments: { tool: "harness_dispatch" } } }, mesh));
  assert.equal(helpOne.tool, "harness_dispatch");
  const helpBad = await mcpText(await mcpCall("/api/mcp/harness-mesh", { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "harness_help", arguments: { tool: "nope" } } }, mesh));
  assert.match(helpBad.error, /没有名为/);

  const toolsAll = await mcpText(await mcpCall("/api/mcp/harness-mesh", { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "harness_tools", arguments: {} } }, mesh));
  assert.ok(Array.isArray(toolsAll.harnesses));
  const toolsBad = await mcpText(await mcpCall("/api/mcp/harness-mesh", { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "harness_tools", arguments: { harness: "nope" } } }, mesh));
  assert.match(toolsBad.error, /暂无专属工具/);
});

test("MCP tools/call:harness_dispatch / harness_status / harness_result / harness_cancel / harness_list / harness_tasks", async () => {
  const mesh = makeMesh({
    store: { list: () => [{ task_id: "t-1", harness: "alpha", state: "running", prompt: "x".repeat(300), started_at: new Date().toISOString() }], countRunning: () => 1 },
    live: new Map([["t-1", { events: [{ title: "开工" }], pendingPermission: { title: "等批权" } }]]),
  });
  const d = await mcpText(await mcpCall("/api/mcp/harness-mesh", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "harness_dispatch", arguments: { harness: "alpha", prompt: "干" } } }, mesh));
  assert.equal(d.task_id, "t-1");
  const st = await mcpText(await mcpCall("/api/mcp/harness-mesh", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "harness_status", arguments: { task_id: "t-1" } } }, mesh));
  assert.equal(st.state, "succeeded");
  const rs = await mcpText(await mcpCall("/api/mcp/harness-mesh", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "harness_result", arguments: { task_id: "t-1" } } }, mesh));
  assert.equal(rs.summary, "done");
  const cc = await mcpText(await mcpCall("/api/mcp/harness-mesh", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "harness_cancel", arguments: { task_id: "t-1" } } }, mesh));
  assert.equal(cc.state, "cancelling");
  const ls = await mcpText(await mcpCall("/api/mcp/harness-mesh", { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "harness_list", arguments: {} } } , mesh));
  assert.deepEqual(ls, []);
  // harness_tasks 是服务端工具,必须走 admin 入口
  const tasks = await mcpText(await mcpCall("/api/mcp/harness-mesh-admin", { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "harness_tasks", arguments: {} } }, mesh));
  assert.equal(tasks.state, "running");
  assert.equal(tasks.count, 1);
  assert.equal(tasks.tasks[0].prompt.length <= 120, true); // prompt 截到 120
  assert.deepEqual(tasks.tasks[0].pending_permission, { title: "等批权" });
  assert.equal(tasks.tasks[0].last_progress, "开工");
  // harness_tools admin 入口下 dispatchTeam 走 teamSave 落盘(harness_team 已在上一例覆盖)
});

test("MCP tools/call:harness_config 设默认模型/default 恢复/节点不存在抛错", async () => {
  const nodes = makeNodes();
  const mesh = makeMesh();
  const set = await mcpText(await mcpCall("/api/mcp/harness-mesh", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "harness_config", arguments: { harness: "alpha", model: "opencode/deepseek-v4.1-flash" } } }, mesh, nodes));
  assert.equal(set.changed, true);
  assert.equal(nodes.get("alpha").model, "opencode/deepseek-v4.1-flash");
  const same = await mcpText(await mcpCall("/api/mcp/harness-mesh", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "harness_config", arguments: { harness: "alpha", model: "opencode/deepseek-v4.1-flash" } } }, mesh, nodes));
  assert.equal(same.changed, false);
  const reset = await mcpText(await mcpCall("/api/mcp/harness-mesh", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "harness_config", arguments: { harness: "alpha", model: "default" } } }, mesh, nodes));
  assert.equal(reset.model, "");
  assert.equal(nodes.get("alpha").model, null);
  const ghost = await mcpCall("/api/mcp/harness-mesh", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "harness_config", arguments: { harness: "ghost", model: "x" } } }, mesh, nodes);
  assert.equal((await mcpErr(ghost)).code, -32000);
});

test("MCP harness_session:两段式确认 → 执行 stop;token 一次性;过期/不匹配拒绝;无 task_id 报错", async () => {
  mkdirSync(MESH_DIR, { recursive: true });
  const mesh = makeMesh();
  const cancelled = [];
  mesh.cancel = async (id) => { cancelled.push(id); return { state: "cancelling" }; };
  const call = (args) => mcpCall("/api/mcp/harness-mesh-admin", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "harness_session", arguments: args } }, mesh);
  const parse = (res) => mcpText(res);

  // 无 task_id 的 stop:直接报错
  const noTask = await parse(await call({ harness: "alpha", action: "stop" }));
  assert.match(noTask.error, /task_id/);
  // 非法 action
  const badAction = await parse(await call({ harness: "alpha", action: "nuke", task_id: "t-1" }));
  assert.match(badAction.error, /unknown action/);

  // 第一段:拿 confirm_token
  const first = await parse(await call({ harness: "alpha", action: "stop", task_id: "t-1" }));
  assert.equal(first.needs_confirm, true);
  assert.ok(first.confirm_token);
  assert.equal(existsSync(CONFIRM_FILE), true);
  assert.equal(cancelled.length, 0); // 未确认不执行

  // token 不匹配(harness 换了)
  const mismatch = await parse(await call({ harness: "beta", action: "stop", task_id: "t-1", confirm_token: first.confirm_token }));
  assert.match(mismatch.error, /不匹配/);

  // 第二段:确认执行,token 一次性
  const second = await parse(await call({ harness: "alpha", action: "stop", task_id: "t-1", confirm_token: first.confirm_token }));
  assert.equal(second.ok, true);
  assert.deepEqual(cancelled, ["t-1"]);
  const reuse = await parse(await call({ harness: "alpha", action: "stop", task_id: "t-1", confirm_token: first.confirm_token }));
  assert.match(reuse.error, /无效/);
  assert.ok(readFileSync(CONTROL_LOG, "utf8").includes("STOP"));

  // 过期 token:手工写过期确认单
  const expiredToken = "sc-expired-test";
  writeFileSync(CONFIRM_FILE, JSON.stringify({ [expiredToken]: { harness: "alpha", action: "stop", task_id: "t-1", expires_at: Date.now() - 1 } }));
  const expired = await parse(await call({ harness: "alpha", action: "stop", task_id: "t-1", confirm_token: expiredToken }));
  assert.match(expired.error, /过期/);
  assert.equal(JSON.parse(readFileSync(CONFIRM_FILE, "utf8"))[expiredToken], undefined); // 过期即清

  // resume/start 分支
  const r1 = await parse(await call({ harness: "alpha", action: "resume" }));
  assert.match(r1.error, /task_id/);
  const startNoPrompt = await parse(await call({ harness: "alpha", action: "start" }));
  assert.match(startNoPrompt.error, /prompt/);
  const pauseMissing = await parse(await call({ harness: "alpha", action: "pause", task_id: "ghost" }));
  assert.match(pauseMissing.summary, /记录不存在/);
  // resume 完整执行:store 有原任务 → 重新派发
  mesh.store.get = (id) => ({ task_id: id, harness: "alpha", prompt: "原任务", state: "paused", origin: "gui" });
  const newIds = [];
  mesh.dispatch = async (o) => { newIds.push(o.prompt); return { task_id: "t-new", state: "queued", harness: o.harness }; };
  const rFirst = await parse(await call({ harness: "alpha", action: "resume", task_id: "t-old" }));
  const rSecond = await parse(await call({ harness: "alpha", action: "resume", task_id: "t-old", confirm_token: rFirst.confirm_token }));
  assert.equal(rSecond.ok, true);
  assert.equal(rSecond.new_task_id, "t-new");
  assert.ok(newIds[0].includes("原任务")); // 按原 prompt 重新派发
});

// ================= 模型探测(2026-10-20:节点管理"探测可用模型") =================
// 注意:探测走 nodes 存取 + 一次性适配器实例(零重启设计),不经过 mesh——成功路径由
// adapter-stdio/plug 测试(listModels 双形状提取)与 e2e 真机探测覆盖,这里只测路由分流。
test("POST /probe-models:未知节点 → 404;未注册类型 → 400", async () => {
  const res = await handle(req("/api/harness-mesh/probe-models", { method: "POST", body: { name: "ghost" } }), deps(undefined, makeNodes()));
  assert.equal(res.status, 404);
  assert.match(res.data.error, /ghost/);

  const nodes2 = makeNodes();
  nodes2.save({ name: "oneshot", type: "cli-oneshot", command: "echo" });
  const res2 = await handle(req("/api/harness-mesh/probe-models", { method: "POST", body: { name: "oneshot" } }), deps(undefined, nodes2));
  assert.equal(res2.status, 400);
  assert.match(res2.data.error, /未注册|不支持/);
});

test("GET /nodes?probeModels=<name>:老路由表 shim,未知节点 → 404", async () => {
  const res = await get("/api/harness-mesh/nodes", "?probeModels=ghost", makeMesh(), makeNodes());
  assert.equal(res.status, 404);
  assert.equal(res.data.ok, false);
});

// ================= DSB 登录地址(2026-10-19:token 不出地址栏) =================
test("GET /dsb-open:有 token → {url(带token), cleanUrl(干净)};Host 头决定主机名", async () => {
  const saved = { t: process.env.DSH_DSB_TOKEN, w: process.env.DSH_WEB_TOKEN };
  process.env.DSH_DSB_TOKEN = "tok-dsb-1";
  delete process.env.DSH_WEB_TOKEN;
  try {
    const r = req("/api/harness-mesh/dsb-open");
    r.headers = { get: (k) => (k === "host" ? "mesh.example:80" : null) };
    const res = await handle(r, deps());
    assert.equal(res.data.ok, true);
    assert.equal(res.data.url, "http://mesh.example:31967/?token=tok-dsb-1");
    assert.equal(res.data.cleanUrl, "http://mesh.example:31967/");
  } finally {
    if (saved.t === undefined) delete process.env.DSH_DSB_TOKEN; else process.env.DSH_DSB_TOKEN = saved.t;
    if (saved.w === undefined) delete process.env.DSH_WEB_TOKEN; else process.env.DSH_WEB_TOKEN = saved.w;
  }
});

test("GET /dsb-open:DSH_DSB_TOKEN 缺省回退 DSH_WEB_TOKEN;两个都没 → ok:false 但仍给 cleanUrl", async () => {
  const saved = { t: process.env.DSH_DSB_TOKEN, w: process.env.DSH_WEB_TOKEN };
  delete process.env.DSH_DSB_TOKEN;
  process.env.DSH_WEB_TOKEN = "tok-web-2";
  try {
    let res = await get("/api/harness-mesh/dsb-open");
    assert.equal(res.data.ok, true);
    assert.match(res.data.url, /\?token=tok-web-2$/);
    delete process.env.DSH_WEB_TOKEN;
    res = await get("/api/harness-mesh/dsb-open");
    assert.equal(res.data.ok, false);
    assert.ok(res.data.cleanUrl.endsWith(":31967/"), "没 token 也给干净地址兜底");
  } finally {
    if (saved.t === undefined) delete process.env.DSH_DSB_TOKEN; else process.env.DSH_DSB_TOKEN = saved.t;
    if (saved.w === undefined) delete process.env.DSH_WEB_TOKEN; else process.env.DSH_WEB_TOKEN = saved.w;
  }
});

test("GET /nodes?dsb=1:老路由表 shim,产出与 /dsb-open 同形;?dsb=2 不误触发", async () => {
  const saved = process.env.DSH_DSB_TOKEN;
  process.env.DSH_DSB_TOKEN = "tok-shim";
  try {
    const res = await get("/api/harness-mesh/nodes", "?dsb=1");
    assert.equal(res.data.ok, true);
    assert.match(res.data.url, /\?token=tok-shim$/);
    const normal = await get("/api/harness-mesh/nodes", "?dsb=2", makeMesh(), makeNodes());
    assert.ok(Array.isArray(normal.data.nodes), "dsb≠1 走正常节点清单");
  } finally {
    if (saved === undefined) delete process.env.DSH_DSB_TOKEN; else process.env.DSH_DSB_TOKEN = saved;
  }
});

// ================= 兜底 =================
test("未知路径 → 404", async () => {
  const res = await get("/api/nope");
  assert.equal(res.status, 404);
  assert.match(res.data.error, /not found/);
});
