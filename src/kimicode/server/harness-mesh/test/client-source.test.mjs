/** 客户端半身单元测试:用桩加载真实 lib/client.js,验证
 *  ① slot 注册(图标+面板) ② input-trigger source 的 candidates/onPick/matchEnter
 *  ③ matchEnter claim 的 submit 直连 /api 派发(绕开主 LLM)。
 *  运行:node test/client-source.test.mjs
 */
import { readFileSync } from "node:fs";

// ---- 环境桩 ----
const captured = { load: null, slots: [], source: null };
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => { captured.load = entry; },
  },
};
const calls = [];
globalThis.fetch = async (path, options) => {
  calls.push({ path, options });
  if (String(path).includes("/nodes")) {
    return { ok: true, json: async () => ({ nodes: [
      { name: "opencode-local", type: "acp-stdio", command: "opencode", description: "本机 opencode" },
      { name: "kimi-206", type: "acp-ssh", command: "kimi", description: "206 的 kimi" },
    ] }) };
  }
  if (String(path).includes("/dispatch")) {
    return { ok: true, json: async () => ({ ok: true, task_id: "t-test-001", harness: "opencode-local" }) };
  }
  return { ok: true, json: async () => ({ tasks: [] }) };
};

// React 桩:createElement 记结构,hooks 返回可控值
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: "Fragment",
  useSyncExternalStore: () => captured.__snapshot ?? {},
  useState: (init) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
};

// 加载真实 client.js(浏览器脚本,包一层 Function 注入 window)
const code = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
new Function("window", code)(globalThis.window);
if (!captured.load) { console.error("FAIL: client.js 没有调用 __ModuleLoader__.load"); process.exit(1); }

const { apply, inject } = captured.load.factory((id) => {
  if (id === "react") return reactStub;
  throw new Error(`unexpected require: ${id}`);
});
console.log("inject:", inject.join(", "));
if (!inject.includes("slots") || !inject.includes("inputTriggers")) { console.error("FAIL: inject 缺 slots/inputTriggers"); process.exit(1); }

const ctx = {
  effect: (fn) => { const r = fn(); return typeof r === "function" ? r : () => {}; },
  slots: {
    inject: (name, registerFn) => captured.slots.push({ name, registerFn }),
    register: (def, comp) => ({ def, comp }),
  },
  get: (svc) => {
    if (svc === "inputTriggers") return { registerSource: (s) => { captured.source = s; return () => {}; } };
    throw new Error(`no service ${svc}`);
  },
};
apply(ctx);

// ---- 1. slot 注册 ----
const slotNames = captured.slots.map((s) => s.name);
console.log("注册 slot:", slotNames.join(", "));
if (!slotNames.includes("conversation.input.left")) {
  console.error("FAIL: 缺 conversation.input.left slot"); process.exit(1);
}

// ---- 2. source 基本属性 ----
const src = captured.source;
console.log("source:", JSON.stringify({ trigger: src.trigger, name: src.name, order: src.order }));
if (src.trigger !== "@" || src.name !== "harness") { console.error("FAIL: trigger/name 不对"); process.exit(1); }

// ---- 3. candidates ----
await src.warm();
const all = await src.candidates({}, { query: "" });
console.log("candidates(空 query):", all.map((c) => c.name).join(", "), "(空 @ 也出节点,order:-10 置顶)");
if (all.length !== 2) { console.error("FAIL: candidates 数量不对"); process.exit(1); }
const filtered = await src.candidates({}, { query: "kimi" });
console.log("candidates(kimi):", filtered.map((c) => c.name).join(", "));
if (filtered.length !== 1 || filtered[0].name !== "kimi-206") { console.error("FAIL: 过滤不对"); process.exit(1); }

// ---- 4. onPick(2026-10-19 起回 {claim} 进命令态;{text} 时代 Enter 被框架当普通聊天) ----
const pick = src.onPick({ candidate: { name: "kimi-206" } });
console.log("onPick:", JSON.stringify({ claim: { name: pick.claim?.name, token: pick.claim?.token, hint: pick.claim?.hint } }));
if (pick.claim?.token !== "@kimi-206 ") { console.error("FAIL: onPick 应回 claim 且 token 带分隔空格"); process.exit(1); }
if (typeof pick.claim?.submit !== "function") { console.error("FAIL: claim 缺 submit"); process.exit(1); }

// ---- 5. matchEnter ----
const noMatch = await src.matchEnter({}, "普通一句话");
if (noMatch !== undefined) { console.error("FAIL: 普通行不该 claim"); process.exit(1); }
const bare = await src.matchEnter({}, "@kimi-206");
if (bare !== undefined) { console.error("FAIL: 只有 @节点 没任务内容不该 claim"); process.exit(1); }
const unknown = await src.matchEnter({}, "@nope 干活");
if (unknown !== undefined) { console.error("FAIL: 未知节点不该 claim"); process.exit(1); }
const claim = await src.matchEnter({}, "@kimi-206 帮我把登录页改成暗色");
if (!claim?.claim) { console.error("FAIL: 命中节点该 claim"); process.exit(1); }
console.log("claim token:", claim.claim.token, "| hint:", claim.claim.hint);
if (claim.claim.token !== "@kimi-206 ") { console.error("FAIL: claim token 不对"); process.exit(1); }

// ---- 6. claim.submit 直连派发 ----
const outcome = await claim.claim.submit("帮我把登录页改成暗色");
console.log("submit 结果:", JSON.stringify(outcome));
const dispatchCall = calls.find((c) => String(c.path).includes("/dispatch"));
if (!dispatchCall) { console.error("FAIL: submit 没调 /dispatch"); process.exit(1); }
const body = JSON.parse(dispatchCall.options.body);
console.log("派发体:", JSON.stringify(body));
if (body.harness !== "kimi-206" || !body.prompt.includes("暗色")) { console.error("FAIL: 派发体不对"); process.exit(1); }
if (outcome.kind !== "success") { console.error("FAIL: submit 结果该 success"); process.exit(1); }

console.log("\n全部通过:slot 注册 + candidates/onPick/matchEnter/claim.submit 直连派发");
process.exit(0); // watchTask 的轮询定时器会挂住事件循环,显式退出
