/** capability-refresh 单元测试:liveModels 实况分离/策展保护/首次播种/漂移日志/失败降频/fake 跳过/enable:false。
 *  语义(2026-10-29 事故修正):探测只写 liveModels/liveProbedAt,绝不覆盖用户策展 models;
 *  唯一例外是节点从无 models 字段(undefined)时首次探测播种。漂移日志双向:待策展/策展失效。
 *  mesh/nodesStore 全用假桩(不碰网络,不起真实适配器)。
 *  运行:node --test test/capability-refresh.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { startCapabilityRefresh } from "../lib/capability-refresh.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 短轮询等待条件成立(默认 2s 截止),避免长睡。 */
async function waitFor(cond, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(5);
  }
  return cond();
}

function makeStore(nodes) {
  return {
    map: new Map(nodes.map((n) => [n.name, { ...n }])),
    list() { return [...this.map.values()]; },
    get(name) { return this.map.get(name) ?? null; },
    update(name, patch = {}) {
      const cur = this.map.get(name);
      if (!cur) return null;
      const merged = { ...cur, ...patch, capability: { ...(cur.capability ?? {}), ...(patch.capability ?? {}) } };
      this.map.set(name, merged);
      return merged;
    },
  };
}

function stdioNode(name, extra = {}) {
  return { name, type: "acp-stdio", command: "fake-harness", models: [], capability: null, ...extra };
}

test("成功刷新(节点 autoCurate:false):写 liveModels/liveProbedAt,不动策展 models", async () => {
  const store = makeStore([stdioNode("wb", { models: ["keep-me"], autoCurate: false })]);
  const mesh = { probeModels: async () => ({ models: [{ modelId: "kimi-K2.7-Code" }, { modelId: "glm-5" }] }) };
  const dispose = startCapabilityRefresh({ mesh, nodesStore: store, intervalMs: 10 });
  try {
    assert.ok(await waitFor(() => store.get("wb")?.liveModels?.length === 2), "liveModels 应被写回");
    const node = store.get("wb");
    assert.deepEqual(node.liveModels, ["glm-5", "kimi-K2.7-Code"]);
    assert.deepEqual(node.models, ["keep-me"], "策展白名单绝不被探测覆盖");
    assert.ok(node.liveProbedAt);
    assert.equal(node.capability.lastProbeError, null);
    assert.ok(node.capability.lastProbeAt);
  } finally { dispose(); }
});

test("首次播种(autoCurate:false 全局):节点从无 models 字段时用实况初始化,之后不再覆盖", async () => {
  const bare = { name: "fresh", type: "acp-stdio", command: "fake-harness", capability: null };
  const store = makeStore([bare]);
  let live = [{ modelId: "m-a" }];
  const mesh = { probeModels: async () => ({ models: live }) };
  const dispose = startCapabilityRefresh({ mesh, nodesStore: store, intervalMs: 10, autoCurate: false });
  try {
    assert.ok(await waitFor(() => store.get("fresh")?.models?.length === 1), "首次应播种 models");
    assert.deepEqual(store.get("fresh").models, ["m-a"]);
    // 实况变化后:liveModels 跟进,models(已被播种成策展)不再被覆盖
    live = [{ modelId: "m-a" }, { modelId: "m-b" }];
    assert.ok(await waitFor(() => store.get("fresh")?.liveModels?.length === 2));
    assert.deepEqual(store.get("fresh").models, ["m-a"], "播种后 models 即策展,不再被实况覆盖");
  } finally { dispose(); }
});

test("漂移日志(节点 autoCurate:false):双向(待策展/策展失效),按 liveModels 变化驱动", async () => {
  const store = makeStore([stdioNode("wb", { models: ["old-a", "keep-b"], autoCurate: false })]);
  const mesh = { probeModels: async () => ({ models: [{ modelId: "keep-b" }, { modelId: "new-c" }] }) };
  const lines = [];
  const dispose = startCapabilityRefresh({ mesh, nodesStore: store, intervalMs: 10, log: (l) => lines.push(l) });
  try {
    assert.ok(await waitFor(() => store.get("wb")?.liveModels?.includes("new-c")));
    assert.ok(lines.some((l) => l.includes("待策展") && l.includes("new-c")), lines.join("\n"));
    assert.ok(lines.some((l) => l.includes("策展模型实况缺席") && l.includes("old-a")), lines.join("\n"));
    assert.deepEqual(store.get("wb").models, ["old-a", "keep-b"], "策展不被改写");
  } finally { dispose(); }
});

test("实况无变化:不写回、不打漂移日志", async () => {
  const store = makeStore([stdioNode("wb", { models: ["m1"], liveModels: ["m1"], liveProbedAt: "2026-10-29T00:00:00Z" })]);
  const mesh = { probeModels: async () => ({ models: [{ modelId: "m1" }] }) };
  let writes = 0;
  const origUpdate = store.update.bind(store);
  store.update = (...a) => { writes += 1; return origUpdate(...a); };
  const lines = [];
  const dispose = startCapabilityRefresh({ mesh, nodesStore: store, intervalMs: 10, log: (l) => lines.push(l) });
  try {
    await sleep(60);
    assert.equal(writes, 0, "实况无变化不应写回");
    assert.ok(!lines.some((l) => l.includes("待策展") || l.includes("实况缺席")));
  } finally { dispose(); }
});

test("探测结果含 thinking/modes → 写回 node.thinkingOptions/node.modeOptions;缺失时清为 null/[]", async () => {
  const store = makeStore([stdioNode("wb", { models: [], autoCurate: false })]);
  let caps = { thinking: { id: "effort", currentValue: "high", options: [{ value: "high" }] }, modes: [{ id: "mode", currentValue: "build", options: [] }] };
  const mesh = { probeModels: async () => ({ models: [{ modelId: "m-a" }], thinking: caps.thinking, modes: caps.modes }) };
  const dispose = startCapabilityRefresh({ mesh, nodesStore: store, intervalMs: 10 });
  try {
    assert.ok(await waitFor(() => store.get("wb")?.thinkingOptions?.id === "effort"), "thinkingOptions 应写回");
    assert.deepEqual(store.get("wb").thinkingOptions, caps.thinking);
    assert.deepEqual(store.get("wb").modeOptions, caps.modes);
    // 下一轮探测结果没有 thinking/modes → 清空(null/[])
    caps = { thinking: null, modes: [] };
    assert.ok(await waitFor(() => store.get("wb")?.thinkingOptions === null && Array.isArray(store.get("wb").modeOptions) && store.get("wb").modeOptions.length === 0));
  } finally { dispose(); }
});

test("探测失败:models/liveModels 都保真,lastProbeError/lastProbeAt 落 capability", async () => {
  const store = makeStore([stdioNode("wb", { models: ["m1", "m2"], liveModels: ["live-1"] })]);
  const mesh = { probeModels: async () => { throw new Error("被控机连接拒绝"); } };
  const dispose = startCapabilityRefresh({ mesh, nodesStore: store, intervalMs: 10 });
  try {
    assert.ok(await waitFor(() => store.get("wb")?.capability?.lastProbeError?.includes("连接拒绝")));
    const node = store.get("wb");
    assert.deepEqual(node.models, ["m1", "m2"], "失败不得毁 models");
    assert.deepEqual(node.liveModels, ["live-1"], "失败不得毁 liveModels");
    assert.ok(node.capability.lastProbeAt);
  } finally { dispose(); }
});

test("连续失败 3 次降频到每 5 轮一探(成功即恢复)", async () => {
  const store = makeStore([stdioNode("down-node")]);
  let calls = 0;
  let fail = true;
  const mesh = { probeModels: async () => { calls += 1; if (fail) throw new Error("boom"); return { models: [{ modelId: "ok-1" }] }; } };
  const dispose = startCapabilityRefresh({ mesh, nodesStore: store, intervalMs: 8 });
  try {
    // 前 3 轮必探;进入降频后第 4~8 轮跳过,第 9 轮恢复探测
    assert.ok(await waitFor(() => calls >= 3), `至少探 3 次,got ${calls}`);
    const atThree = calls;
    assert.equal(atThree, 3, "降频窗口内的轮次不应多探");
    assert.ok(await waitFor(() => calls >= 4, 400), `降频后第 5 轮应再探,got ${calls}`);
    assert.ok(calls - atThree === 1, `降频间隔内只补探 1 次,got ${calls - atThree}`);
    // 成功恢复常频:liveModels 落盘
    fail = false;
    assert.ok(await waitFor(() => store.get("down-node")?.liveModels?.length === 1));
    assert.equal(store.get("down-node").capability.lastProbeError, null);
  } finally { dispose(); }
});

test("fake-* 节点与 isNodeLive=false 的节点跳过", async () => {
  const store = makeStore([stdioNode("fake-plug"), stdioNode("offline"), stdioNode("online")]);
  const probed = [];
  const mesh = { probeModels: async (name) => { probed.push(name); return { models: [{ modelId: "m" }] }; } };
  const dispose = startCapabilityRefresh({
    mesh, nodesStore: store, intervalMs: 10,
    isNodeLive: (node) => node.name !== "offline",
  });
  try {
    await sleep(60);
    assert.ok(probed.length >= 1 && probed.every((n) => n === "online"), `只应探 online,got ${probed}`);
  } finally { dispose(); }
});

test("适配器不支持 listModels:静默跳过且不计失败", async () => {
  const store = makeStore([stdioNode("cli-node")]);
  const mesh = { probeModels: async () => { throw new Error('harness-mesh: 节点 cli-node(cli-oneshot)不支持模型探测'); } };
  const lines = [];
  const dispose = startCapabilityRefresh({ mesh, nodesStore: store, intervalMs: 10, log: (l) => lines.push(l) });
  try {
    await sleep(60);
    assert.equal(store.get("cli-node").capability, null, "不支持不是失败,不写 lastProbeError");
    assert.ok(!lines.some((l) => l.includes("探测失败")), lines.join("\n"));
  } finally { dispose(); }
});

test("enable:false 不启动(零探测零写回)", async () => {
  const store = makeStore([stdioNode("wb")]);
  let calls = 0;
  const mesh = { probeModels: async () => { calls += 1; return { models: [] }; } };
  const dispose = startCapabilityRefresh({ mesh, nodesStore: store, intervalMs: 10, enable: false });
  try {
    await sleep(40);
    assert.equal(calls, 0);
    assert.equal(store.get("wb").models.length, 0);
  } finally { dispose(); }
});

test("dispose 后停止轮巡", async () => {
  const store = makeStore([stdioNode("wb")]);
  let calls = 0;
  const mesh = { probeModels: async () => { calls += 1; return { models: [{ modelId: "m" }] }; } };
  const dispose = startCapabilityRefresh({ mesh, nodesStore: store, intervalMs: 10 });
  assert.ok(await waitFor(() => calls >= 1));
  dispose();
  const atDispose = calls;
  await sleep(50);
  assert.equal(calls, atDispose, "dispose 后不应再探");
});

test("自动策展(全局开+节点未设):models 跟随实况全量覆盖,日志加自动策展行", async () => {
  const store = makeStore([stdioNode("wb", { models: ["old-1"] })]);
  const mesh = { probeModels: async () => ({ models: [{ modelId: "new-a" }, { modelId: "new-b" }] }) };
  const lines = [];
  const dispose = startCapabilityRefresh({ mesh, nodesStore: store, intervalMs: 10, autoCurate: true, log: (l) => lines.push(l) });
  try {
    assert.ok(await waitFor(() => store.get("wb")?.models?.length === 2), "models 应被实况全量覆盖");
    assert.deepEqual(store.get("wb").models, ["new-a", "new-b"], "旧策展被实况替换");
    assert.ok(lines.some((l) => l.includes("自动策展:models 已同步 2 个")), lines.join("\n"));
    // 双向漂移日志仍保留
    assert.ok(lines.some((l) => l.includes("待策展") && l.includes("new-a")), lines.join("\n"));
    assert.ok(lines.some((l) => l.includes("策展模型实况缺席") && l.includes("old-1")), lines.join("\n"));
  } finally { dispose(); }
});

test("节点 autoCurate:false:全局开也只写 liveModels,models 不动(09 保护语义)", async () => {
  const store = makeStore([stdioNode("wb", { models: ["keep-me"], autoCurate: false })]);
  const mesh = { probeModels: async () => ({ models: [{ modelId: "m-live" }] }) };
  const lines = [];
  const dispose = startCapabilityRefresh({ mesh, nodesStore: store, intervalMs: 10, autoCurate: true, log: (l) => lines.push(l) });
  try {
    assert.ok(await waitFor(() => store.get("wb")?.liveModels?.length === 1));
    assert.deepEqual(store.get("wb").models, ["keep-me"], "节点级退出权:models 不被覆盖");
    assert.ok(!lines.some((l) => l.includes("自动策展:models 已同步")), lines.join("\n"));
  } finally { dispose(); }
});

test("全局关 + 节点 autoCurate:true:该节点仍自动策展", async () => {
  const store = makeStore([stdioNode("wb", { models: ["old-1"], autoCurate: true }), stdioNode("other", { models: ["stay"] })]);
  const mesh = {
    probeModels: async (name) => ({ models: [{ modelId: name === "wb" ? "fresh-a" : "other-a" }] }),
  };
  const lines = [];
  const dispose = startCapabilityRefresh({ mesh, nodesStore: store, intervalMs: 10, autoCurate: false, log: (l) => lines.push(l) });
  try {
    assert.ok(await waitFor(() => store.get("wb")?.models?.length === 1 && store.get("wb").models[0] === "fresh-a"));
    assert.deepEqual(store.get("other").models, ["stay"], "未显式开启的节点维持保护语义");
    assert.deepEqual(store.get("other").liveModels, ["other-a"]);
    assert.ok(lines.some((l) => l.includes("wb 自动策展:models 已同步 1 个")), lines.join("\n"));
  } finally { dispose(); }
});
