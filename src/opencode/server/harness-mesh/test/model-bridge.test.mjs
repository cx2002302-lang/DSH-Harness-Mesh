/** 模型桥单元测试(网关模式):computeProviders 的 1:1 条目规则 + startModelBridge 的 diff/纪律。
 *  运行:node test/model-bridge.test.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeProviders, computeReasoningEfforts, startModelBridge } from "../lib/model-bridge.js";

let passed = 0;
let failed = 0;
function check(label, cond, detail = "") {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label} ${detail}`); }
}

console.log("computeProviders(网关模式,每节点至多一条):");
{
  // 两节点各勾选若干模型 → 各出一条目,勾选名单原样发布(顺序保持)
  const nodes = [
    { name: "DEMOPC-kimicode", type: "acp-plug", plugId: "kimi", models: ["Kimi-K2.7-Code", "kimi-linear-48b"] },
    { name: "opencode-local", type: "acp-stdio", command: "opencode", models: [] },
  ];
  const { providers, sources } = computeProviders(nodes);
  check("两节点出两条目:mesh-<节点slug>", providers["mesh-demopc-kimicode"] && providers["mesh-opencode-local"] === undefined, JSON.stringify(Object.keys(providers)));
  check("displayName 照抄节点原名:网格 · DEMOPC-kimicode", providers["mesh-demopc-kimicode"]?.displayName === "网格 · DEMOPC-kimicode", JSON.stringify(providers["mesh-demopc-kimicode"]));
  check("api = openai-completions", providers["mesh-demopc-kimicode"]?.api === "openai-completions");
  check("baseURL 指回网关(节点名 URL-encode)", providers["mesh-demopc-kimicode"]?.baseURL === `http://127.0.0.1:80/api/harness-mesh/llm/${encodeURIComponent("DEMOPC-kimicode")}/v1`, providers["mesh-demopc-kimicode"]?.baseURL);
  check("apiKeyEnv = MESH_MCP_TOKEN", providers["mesh-demopc-kimicode"]?.apiKeyEnv === "MESH_MCP_TOKEN");
  check("models = 勾选名单原样(不去重映射/不过滤/保持顺序)", JSON.stringify(providers["mesh-demopc-kimicode"]?.models) === JSON.stringify([{ id: "Kimi-K2.7-Code" }, { id: "kimi-linear-48b" }]), JSON.stringify(providers["mesh-demopc-kimicode"]?.models));
  check("sources 单节点留档", sources["mesh-demopc-kimicode"]?.length === 1 && sources["mesh-demopc-kimicode"][0] === "DEMOPC-kimicode");
  check("无勾选节点不出条目", !providers["mesh-opencode-local"] && JSON.stringify(Object.keys(providers)) === JSON.stringify(["mesh-demopc-kimicode"]), JSON.stringify(Object.keys(providers)));
}
{
  // 勾选含内部/任意模型也原样发布(网关模式不做映射过滤);含特殊字符节点名 URL-encode
  const { providers, skipped } = computeProviders([
    { name: "winpc zcode", type: "acp-plug", plugId: "zcode", models: ["GLM-5.3", "Hy3-Ultra", "快速", "mystery-7b"] },
  ]);
  check("勾选模型原样全发(含内部模型,不过滤)", JSON.stringify(providers["mesh-winpc-zcode"]?.models) === JSON.stringify([{ id: "GLM-5.3" }, { id: "Hy3-Ultra" }, { id: "快速" }, { id: "mystery-7b" }]), JSON.stringify(providers["mesh-winpc-zcode"]?.models));
  check("节点名空格 URL-encode 进 baseURL", providers["mesh-winpc-zcode"]?.baseURL === `http://127.0.0.1:80/api/harness-mesh/llm/${encodeURIComponent("winpc zcode")}/v1`, providers["mesh-winpc-zcode"]?.baseURL);
  check("无旧 per-(节点×供应商) id", !providers["mesh-winpc-zcode-zai-coding-cn"] && !providers["mesh-kimi-coding"], JSON.stringify(Object.keys(providers)));
  check("有勾选节点不进 skipped", skipped.length === 0, JSON.stringify(skipped));
}
{
  const { providers, skipped } = computeProviders([
    { name: "empty-node", models: [] },
    { name: "fake-plug", models: ["glm-5.3"] },
  ]);
  check("无勾选 + fake 节点都不出条目", JSON.stringify(providers) === "{}", JSON.stringify(providers));
  check("无勾选节点被记录(提示去勾选)", skipped.some((s) => s.node === "empty-node"), JSON.stringify(skipped));
}

{
  // 思考档位声明(2026-10-30 思考档位全链):节点有 thinkingOptions → 每个 model 加
  // reasoningEfforts(枚举内收档,wire 值 = ACP value 原样);null/缺/全枚举外 → 不加该键
  const { providers } = computeProviders([
    { name: "oc-node", models: ["m1"], thinkingOptions: { id: "effort", currentValue: "low", options: [{ value: "low" }, { value: "HIGH", name: "高" }, { value: "max" }, { value: "神秘档" }] } },
    { name: "zc-node", models: ["m2"], thinkingOptions: null },
    { name: "no-think", models: ["m3"] },
    { name: "weird-node", models: ["m4"], thinkingOptions: { id: "style", options: [{ value: "神秘档" }] } },
  ]);
  const m1 = providers["mesh-oc-node"]?.models?.[0];
  check("thinkingOptions 节点:model 带 reasoningEfforts(键=枚举小写,wire 值原样)", JSON.stringify(m1?.reasoningEfforts) === JSON.stringify({ low: "low", high: "HIGH", max: "max" }), JSON.stringify(m1));
  check("reasoningEfforts 只加在 model 上,不影响 id", m1?.id === "m1");
  check("thinkingOptions=null 节点:model 不带 reasoningEfforts", JSON.stringify(providers["mesh-zc-node"]?.models) === JSON.stringify([{ id: "m2" }]), JSON.stringify(providers["mesh-zc-node"]?.models));
  check("无 thinkingOptions 字段节点:model 不带 reasoningEfforts", JSON.stringify(providers["mesh-no-think"]?.models) === JSON.stringify([{ id: "m3" }]), JSON.stringify(providers["mesh-no-think"]?.models));
  check("全枚举外档位:不加 reasoningEfforts 键", JSON.stringify(providers["mesh-weird-node"]?.models) === JSON.stringify([{ id: "m4" }]), JSON.stringify(providers["mesh-weird-node"]?.models));
  check("带 reasoningEfforts 不破坏既有字段", providers["mesh-oc-node"]?.api === "openai-completions" && typeof providers["mesh-oc-node"]?.baseURL === "string" && providers["mesh-oc-node"]?.apiKeyEnv === "MESH_MCP_TOKEN");
}

console.log("computeReasoningEfforts(枚举过滤,wire 值原样):");
{
  const logs = [];
  const { efforts, skipped } = computeReasoningEfforts({ id: "effort", options: [{ value: "Low" }, "OFF", { value: "xhigh" }, { value: "巨大" }, ""] });
  check("大小写不敏感收档:键小写、wire 值原样", JSON.stringify(efforts) === JSON.stringify({ low: "Low", off: "OFF", xhigh: "xhigh" }), JSON.stringify(efforts));
  check("枚举外/空值跳过并记录", skipped.length === 1 && skipped[0] === "巨大", JSON.stringify(skipped));
}

console.log("startModelBridge diff 纪律(旧 per-(节点×供应商) id 全清):");
{
  const dir = mkdtempSync(join(tmpdir(), "mb-test-"));
  const nodesFile = join(dir, "nodes.json");
  const calls = [];
  const ctx = {
    settings: {
      describe: () => [{ ns: "llm-pi-ai", value: { providers: { minimax: { apiKeyEnv: "DSH_MINIMAX_API_KEY" } } } }], // minimax 是"手工配置"
      mutate: async (ns, ops) => { calls.push({ ns, ops }); },
    },
  };
  let nodeList = [
    { name: "winpc-zcode", type: "acp-plug", plugId: "zcode", models: ["GLM-5.3"] },
    { name: "opencode-local", type: "acp-stdio", command: "opencode", models: [] },
  ];
  const dispose = startModelBridge(ctx, nodesFile, () => nodeList, dir, () => {});
  await new Promise((r) => setTimeout(r, 100)); // 首轮 reconcile 是立即异步触发
  const setIds = calls[0]?.ops?.filter((o) => o.op === "set").map((o) => o.path.join(".")) ?? [];
  check("首轮写入:仅勾选节点一条 mesh-winpc-zcode", calls.length === 1 && JSON.stringify(setIds) === JSON.stringify(["providers.mesh-winpc-zcode"]), JSON.stringify(calls));
  check("ns 是 llm-pi-ai", calls[0]?.ns === "llm-pi-ai");
  check("不碰手工配置的 minimax(裸 id)", !calls[0]?.ops?.some((o) => o.path.join(".") === "providers.minimax"));

  // 场景 2:勾选变更 → 重写;节点移除 → unset 回收
  nodeList = [{ name: "winpc-zcode", type: "acp-plug", plugId: "zcode", models: ["GLM-5.3", "glm-5-turbo"] }];
  const ctx2 = { settings: { describe: () => [{ ns: "llm-pi-ai", value: { providers: { minimax: {} } } }], mutate: async (ns, ops) => { calls.push({ ns, ops }); } } };
  dispose();
  const dispose2 = startModelBridge(ctx2, nodesFile, () => nodeList, dir, () => {});
  await new Promise((r) => setTimeout(r, 100));
  const second = calls[1];
  check("勾选变更重写条目(名单跟随)", second?.ops.some((o) => o.op === "set" && JSON.stringify(o.value.models) === JSON.stringify([{ id: "GLM-5.3" }, { id: "glm-5-turbo" }])), JSON.stringify(second));
  dispose2();

  // 场景 3:状态文件里存有旧 per-(节点×供应商) id → 首轮对齐时被清掉
  const dir3 = mkdtempSync(join(tmpdir(), "mb-test-"));
  const stateFile = join(dir3, "model-bridge.json");
  writeFileSync(stateFile, JSON.stringify({
    managed: ["mesh-zai-coding-cn", "mesh-winpc-zcode-zai-coding-cn", "mesh-winpc-zcode-kimi-coding"],
    applied: { "mesh-zai-coding-cn": {}, "mesh-winpc-zcode-zai-coding-cn": {}, "mesh-winpc-zcode-kimi-coding": {} },
  }));
  const calls3 = [];
  const ctx3 = { settings: { describe: () => [{ ns: "llm-pi-ai", value: { providers: { "mesh-zai-coding-cn": {}, "mesh-winpc-zcode-zai-coding-cn": {} } } }], mutate: async (ns, ops) => { calls3.push({ ns, ops }); } } };
  const dispose3 = startModelBridge(ctx3, join(dir3, "nodes.json"), () => [], dir3, () => {});
  await new Promise((r) => setTimeout(r, 100));
  const unset3 = calls3[0]?.ops?.filter((o) => o.op === "unset").map((o) => o.path.join(".")) ?? [];
  check("旧桶式/旧 per-(节点×供应商) id 全清", unset3.includes("providers.mesh-zai-coding-cn") && unset3.includes("providers.mesh-winpc-zcode-zai-coding-cn") && unset3.includes("providers.mesh-winpc-zcode-kimi-coding"), JSON.stringify(calls3));
  check("foreign 保护:不碰非 mesh- 前缀的手工条目", !calls3[0]?.ops?.some((o) => !String(o.path.join(".")).startsWith("providers.mesh-")), JSON.stringify(calls3));
  dispose3();

  rmSync(dir, { recursive: true, force: true });
  rmSync(dir3, { recursive: true, force: true });
}

console.log(`\n${passed} 过 / ${failed} 挂`);
process.exit(failed ? 1 : 0);
