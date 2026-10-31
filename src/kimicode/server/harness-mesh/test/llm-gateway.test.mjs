/** LLM 网关单元测试:OpenAI 兼容路由(假 mesh.dispatch)。
 *  成功 / 模型不在名单 400 / 鉴权失败 401 / 派发失败 502 / buildPrompt / 路由热同步。
 *  不碰网络、不开端口。运行:node --test test/llm-gateway.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPrompt, resolveThinkingValue, startLlmGateway } from "../lib/llm-gateway.js";

const TOKEN = "test-token-abcdef";

/** 假 ctx.connection.fetch.register:记录注册的路由,返回 disposer。 */
function makeCtx() {
  const routes = new Map();
  return {
    routes,
    connection: {
      fetch: {
        register: (route) => {
          routes.set(route.path, route);
          return async () => { routes.delete(route.path); };
        },
      },
    },
  };
}

function makeNodes(nodes) {
  const map = new Map(nodes.map((n) => [n.name, { capability: null, ...n }]));
  return {
    list: () => [...map.values()],
    get: (name) => map.get(name) ?? null,
  };
}

function chatRequest(node, { token = TOKEN, body } = {}) {
  return new Request(`http://127.0.0.1/api/harness-mesh/llm/${encodeURIComponent(node)}/v1/chat/completions`, {
    method: "POST",
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    body: JSON.stringify(body ?? { model: "GLM-5.3", messages: [{ role: "user", content: "hi" }] }),
  });
}

function modelsRequest(node, token = TOKEN) {
  return new Request(`http://127.0.0.1/api/harness-mesh/llm/${encodeURIComponent(node)}/v1/models`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

function setup({ nodes, dispatch, pollMs = 1 } = {}) {
  const prev = process.env.MESH_MCP_TOKEN;
  process.env.MESH_MCP_TOKEN = TOKEN;
  const dir = mkdtempSync(join(tmpdir(), "llm-gw-"));
  writeFileSync(join(dir, "nodes.json"), "{}\n");
  const ctx = makeCtx();
  const mesh = {
    dispatch: dispatch ?? (async () => { throw new Error("unexpected dispatch"); }),
    status: () => ({ state: "succeeded" }),
    result: () => ({ summary: "" }),
  };
  const dispose = startLlmGateway(ctx, mesh, makeNodes(nodes ?? []), join(dir, "nodes.json"), () => {}, { pollMs });
  const find = (suffix) => [...ctx.routes.keys()].find((p) => p.endsWith(suffix));
  return {
    ctx, mesh, dispose,
    chat: async (node, opts) => {
      const route = ctx.routes.get([...ctx.routes.keys()].find((p) => p.endsWith(`/${encodeURIComponent(node)}/v1/chat/completions`)) ?? "");
      assert.ok(route, `路由未注册: ${node}`);
      return route.fetch(chatRequest(node, opts));
    },
    models: async (node, token) => {
      const route = ctx.routes.get([...ctx.routes.keys()].find((p) => p.endsWith(`/${encodeURIComponent(node)}/v1/models`)) ?? "");
      assert.ok(route, `路由未注册: ${node}`);
      return route.fetch(modelsRequest(node, token));
    },
    find,
    cleanup() {
      dispose();
      if (prev === undefined) delete process.env.MESH_MCP_TOKEN;
      else process.env.MESH_MCP_TOKEN = prev;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("buildPrompt:system+user 按序拼接,其余角色丢弃,分段 content 取 text", () => {
  const prompt = buildPrompt([
    { role: "system", content: "你是助手。" },
    { role: "assistant", content: "被丢弃" },
    { role: "user", content: [{ type: "text", text: "第一段" }, { type: "image_url", url: "x" }, { type: "text", text: "第二段" }] },
  ]);
  assert.equal(prompt, "你是助手。\n\n第一段第二段");
});

test("chat/completions 成功:派发→等终态→OpenAI 形返回", async () => {
  const dispatched = [];
  let calls = 0;
  const s = setup({
    nodes: [{ name: "winpc-zcode", models: ["GLM-5.3"] }],
    dispatch: async (spec) => {
      dispatched.push(spec);
      return { task_id: "t-1" };
    },
    pollMs: 1,
  });
  try {
    s.mesh.status = () => ({ state: ++calls < 3 ? "running" : "succeeded" });
    s.mesh.result = () => ({ summary: "任务完成,结论在此" });
    const res = await s.chat("winpc-zcode", {
      body: { model: "GLM-5.3", messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }] },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.object, "chat.completion");
    assert.equal(data.model, "GLM-5.3");
    assert.equal(data.choices.length, 1);
    assert.equal(data.choices[0].index, 0);
    assert.deepEqual(data.choices[0].message, { role: "assistant", content: "任务完成,结论在此" });
    assert.equal(data.choices[0].finish_reason, "stop");
    assert.equal(data.usage, null);
    assert.match(data.id, /^chatcmpl-t-1$/);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].harness, "winpc-zcode");
    assert.equal(dispatched[0].model, "GLM-5.3");
    assert.equal(dispatched[0].prompt, "s\n\nu");
    assert.ok(typeof dispatched[0].timeoutMs === "number" && dispatched[0].timeoutMs > 0);
  } finally { s.cleanup(); }
});

test("chat/completions 模型不在勾选名单 → 400 并列出可用", async () => {
  const s = setup({ nodes: [{ name: "winpc-zcode", models: ["GLM-5.3", "GLM-5-Air"] }] });
  try {
    const res = await s.chat("winpc-zcode", { body: { model: "mystery-9b", messages: [{ role: "user", content: "hi" }] } });
    assert.equal(res.status, 400);
    const err = (await res.json()).error;
    assert.equal(err.type, "invalid_request_error");
    assert.ok(err.message.includes("mystery-9b") && err.message.includes("GLM-5.3") && err.message.includes("GLM-5-Air"), err.message);
  } finally { s.cleanup(); }
});

test("chat/completions 鉴权失败 → 401(错 token / 无 token / token 未设置)", async () => {
  const s = setup({ nodes: [{ name: "n1", models: ["m1"] }] });
  try {
    for (const token of ["wrong-token", null]) {
      const res = await s.chat("n1", { token, body: { model: "m1", messages: [{ role: "user", content: "hi" }] } });
      assert.equal(res.status, 401, `token=${String(token)}`);
    }
    delete process.env.MESH_MCP_TOKEN;
    const res = await s.chat("n1", { body: { model: "m1", messages: [{ role: "user", content: "hi" }] } });
    assert.equal(res.status, 401);
  } finally { s.cleanup(); }
});

test("chat/completions 派发失败/终态非成功 → 502 mesh_dispatch_error", async (t) => {
  await t.test("dispatch 抛错", async () => {
    const s = setup({
      nodes: [{ name: "n1", models: ["m1"] }],
      dispatch: async () => { throw new Error("适配器死了"); },
    });
    try {
      const res = await s.chat("n1", { body: { model: "m1", messages: [{ role: "user", content: "hi" }] } });
      assert.equal(res.status, 502);
      const err = (await res.json()).error;
      assert.equal(err.type, "mesh_dispatch_error");
      assert.ok(err.message.includes("适配器死了"), err.message);
    } finally { s.cleanup(); }
  });
  await t.test("终态 timeout", async () => {
    const s = setup({
      nodes: [{ name: "n1", models: ["m1"] }],
      dispatch: async () => ({ task_id: "t-9" }),
    });
    try {
      s.mesh.status = () => ({ state: "timeout", error: "超时已取消" });
      const res = await s.chat("n1", { body: { model: "m1", messages: [{ role: "user", content: "hi" }] } });
      assert.equal(res.status, 502);
      assert.equal((await res.json()).error.type, "mesh_dispatch_error");
    } finally { s.cleanup(); }
  });
});

test("models:返回该节点勾选名单(OpenAI models 列表形)+ 鉴权", async () => {
  const s = setup({ nodes: [{ name: "winpc zcode", models: ["GLM-5.3", "快速"] }] });
  try {
    const res = await s.models("winpc zcode");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.object, "list");
    assert.deepEqual(data.data.map((m) => m.id), ["GLM-5.3", "快速"]);
    assert.ok(data.data.every((m) => m.object === "model"));
    const bad = await s.models("winpc zcode", "wrong");
    assert.equal(bad.status, 401);
  } finally { s.cleanup(); }
});

test("路由热同步:每个勾选/未勾选节点都有路由,fake 不暴露,未知节点 404", async () => {
  const s = setup({ nodes: [{ name: "n1", models: [] }, { name: "fake-x", models: ["m"] }] });
  try {
    const paths = [...s.ctx.routes.keys()];
    assert.ok(paths.some((p) => p.endsWith(`/${encodeURIComponent("n1")}/v1/chat/completions`)) && paths.some((p) => p.endsWith(`/${encodeURIComponent("n1")}/v1/models`)), JSON.stringify(paths));
    assert.ok(!paths.some((p) => p.includes("fake")), JSON.stringify(paths));
    assert.ok(!paths.some((p) => p.includes("nobody")), "未注册节点不暴露路由(外层返回 404)");
  } finally { s.cleanup(); }
});

// ---- reasoning_effort → 节点思考档位(2026-10-30 思考档位全链:透传 + 严格 400) ----
test("resolveThinkingValue:精确命中/大小写回配取节点原值/非法值", () => {
  const opts = { id: "effort", currentValue: "low", options: [{ value: "low", name: "低" }, { value: "high", name: "高" }, { value: "max", name: "最大" }] };
  assert.equal(resolveThinkingValue("low", opts), "low");
  assert.equal(resolveThinkingValue("high", opts), "high");
  assert.equal(resolveThinkingValue("HIGH", opts), "high");
  // 非法值 / 无 thinkingOptions / 空值 → null(调用方回 400)
  assert.equal(resolveThinkingValue("medium", opts), null);
  assert.equal(resolveThinkingValue("turbo", opts), null);
  assert.equal(resolveThinkingValue("low", null), null);
  assert.equal(resolveThinkingValue(42, opts), null);
});

test("chat/completions 带 reasoning_effort / reasoning.effort:dispatch 带 thinking {value}", async () => {
  const dispatched = [];
  const s = setup({
    nodes: [{ name: "oc", models: ["m1"], thinkingOptions: { id: "effort", currentValue: "low", options: [{ value: "low" }, { value: "high" }, { value: "max" }] } }],
    dispatch: async (spec) => { dispatched.push(spec); return { task_id: "t-e" }; },
  });
  try {
    s.mesh.status = () => ({ state: "succeeded" });
    await s.chat("oc", { body: { model: "m1", messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" } });
    assert.deepEqual(dispatched[0].thinking, { value: "high" });
    // body.reasoning.effort 同样支持;大小写回配取节点原值
    await s.chat("oc", { body: { model: "m1", messages: [{ role: "user", content: "hi" }], reasoning: { effort: "MAX" } } });
    assert.deepEqual(dispatched[1].thinking, { value: "max" });
  } finally { s.cleanup(); }
});

test("chat/completions:节点不支持思考档位或值非法 → 400 并列可用档位", async () => {
  const dispatched = [];
  // 节点无 thinkingOptions → 400
  const s = setup({
    nodes: [{ name: "zcode", models: ["m1"], thinkingOptions: null }],
    dispatch: async (spec) => { dispatched.push(spec); return { task_id: "t-n" }; },
  });
  try {
    const res = await s.chat("zcode", { body: { model: "m1", messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" } });
    assert.equal(res.status, 400);
    const err = (await res.json()).error;
    assert.equal(err.type, "invalid_request_error");
    assert.ok(err.message.includes("zcode") && err.message.includes("思考档位"), err.message);
    // 节点有档位但值非法 → 400 消息列出可用档位
    const s2 = setup({
      nodes: [{ name: "oc", models: ["m1"], thinkingOptions: { id: "effort", options: [{ value: "low" }, { value: "high" }, { value: "max" }] } }],
      dispatch: async (spec) => { dispatched.push(spec); return { task_id: "t-i" }; },
    });
    try {
      const res2 = await s2.chat("oc", { body: { model: "m1", messages: [{ role: "user", content: "hi" }], reasoning_effort: "巨大" } });
      assert.equal(res2.status, 400);
      const err2 = (await res2.json()).error;
      assert.ok(err2.message.includes("巨大") && err2.message.includes("low") && err2.message.includes("high") && err2.message.includes("max"), err2.message);
    } finally { s2.cleanup(); }
    // 不带 effort:无档节点照旧派单,dispatch 不带 thinking
    s.mesh.status = () => ({ state: "succeeded" });
    await s.chat("zcode", { body: { model: "m1", messages: [{ role: "user", content: "hi" }] } });
    assert.ok(dispatched[0] && dispatched[0].thinking === undefined, JSON.stringify(dispatched[0]));
  } finally { s.cleanup(); }
});
