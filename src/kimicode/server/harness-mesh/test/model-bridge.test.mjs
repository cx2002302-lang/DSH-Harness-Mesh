/** 模型桥单元测试:computeProviders 纯函数的映射规则 + startModelBridge 的 diff/纪律。
 *  运行:node test/model-bridge.test.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeProviders, startModelBridge } from "../lib/model-bridge.js";

let passed = 0;
let failed = 0;
function check(label, cond, detail = "") {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label} ${detail}`); }
}

const ENV = {
  DSH_OPENCODE_API_KEY: "k1",
  KIMI_CODING_API_KEY: "k2",
  DSH_MINIMAX_API_KEY: "k3",
  // 故意不给 ZAI_CODING_CN_API_KEY / DSH_DEEPSEEK_API_KEY
};

console.log("computeProviders:");
{
  const nodes = [
    { name: "opencode-local", type: "acp-stdio", command: "opencode", model: "opencode/deepseek-v4.1-flash" },
    { name: "winpc-kimicode", type: "acp-plug", plugId: "kimi" },
    { name: "winpc-zcode", type: "acp-plug", plugId: "zcode" },
    { name: "winpc-workbuddy", type: "acp-plug", plugId: "workbuddy" },
    { name: "fake-plug", type: "acp-plug", plugId: "fake" },
    { name: "mystery-box", type: "acp-stdio", command: "something-else" },
  ];
  const { providers, skipped } = computeProviders(nodes, ENV);
  check("固定模型前缀映射:opencode/* → opencode-go", providers["opencode-go"]?.models?.[0]?.id === "deepseek-v4.1-flash", JSON.stringify(providers["opencode-go"]));
  check("固定模型节点出现在 displayName", providers["opencode-go"]?.displayName?.includes("opencode-local"));
  check("名字推断:kimicode → kimi-coding(无 models = 用目录全集)", providers["kimi-coding"] && !("models" in providers["kimi-coding"]));
  check("名字推断:workbuddy → minimax", providers.minimax?.displayName?.includes("winpc-workbuddy"));
  check("凭据缺失:zcode 跳过(zai key 不在环境)", !providers["zai-coding-cn"] && skipped.some((s) => s.node === "winpc-zcode" && s.reason.includes("凭据")));
  check("fake 节点不进目录", !JSON.stringify(providers).includes("fake"));
  check("无映射节点被记录", skipped.some((s) => s.node === "mystery-box" && s.reason === "无供应商映射"));
}
{
  // 凭据回退:kimi-coding 无 KIMI_CODING_API_KEY 时退回 KIMI_API_KEY
  const { providers } = computeProviders([{ name: "kimi-node", type: "acp-plug", plugId: "kimi" }], { KIMI_API_KEY: "fallback" });
  check("凭据回退:KIMI_API_KEY 兜底", providers["kimi-coding"]?.apiKeyEnv === "KIMI_API_KEY");
}

console.log("startModelBridge diff 纪律:");
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
    { name: "opencode-local", type: "acp-stdio", command: "opencode", model: "opencode/deepseek-v4.1-flash" },
    { name: "winpc-workbuddy", type: "acp-plug", plugId: "workbuddy" },
  ];
  const dispose = startModelBridge(ctx, nodesFile, () => nodeList, dir, () => {}, ENV);
  await new Promise((r) => setTimeout(r, 100)); // 首轮 reconcile 是立即异步触发
  check("首轮写入:只注册 opencode-go", calls.length === 1 && calls[0].ops.length === 1 && calls[0].ops[0].path.join(".") === "providers.opencode-go", JSON.stringify(calls));
  check("ns 是 llm-pi-ai", calls[0]?.ns === "llm-pi-ai");
  check("不碰手工配置的 minimax", !JSON.stringify(calls).includes('"minimax"'));

  // 场景 2:节点固定模型变更 → 重新写入
  nodeList = [{ name: "opencode-local", type: "acp-stdio", command: "opencode", model: "opencode/deepseek-v4-pro" }];
  const ctx2 = { settings: { describe: () => [{ ns: "llm-pi-ai", value: { providers: { minimax: {} } } }], mutate: async (ns, ops) => { calls.push({ ns, ops }); } } };
  dispose();
  const dispose2 = startModelBridge(ctx2, nodesFile, () => nodeList, dir, () => {}, ENV);
  await new Promise((r) => setTimeout(r, 100));
  const second = calls[1];
  check("模型变更重写条目", second?.ops.some((o) => o.op === "set" && JSON.stringify(o.value).includes("deepseek-v4-pro")), JSON.stringify(second));
  dispose2();

  // 场景 3:节点清空 → 回收托管条目(unset)
  const dir3 = mkdtempSync(join(tmpdir(), "mb-test-"));
  const stateFile = join(dir3, "model-bridge.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(stateFile, JSON.stringify({ managed: ["opencode-go"], applied: { "opencode-go": { apiKeyEnv: "DSH_OPENCODE_API_KEY" } } }));
  const calls3 = [];
  const ctx3 = { settings: { describe: () => [{ ns: "llm-pi-ai", value: { providers: { "opencode-go": {} } } }], mutate: async (ns, ops) => { calls3.push({ ns, ops }); } } };
  const dispose3 = startModelBridge(ctx3, join(dir3, "nodes.json"), () => [], dir3, () => {}, ENV);
  await new Promise((r) => setTimeout(r, 100));
  check("节点清空 → unset 回收", calls3[0]?.ops.some((o) => o.op === "unset" && o.path.join(".") === "providers.opencode-go"), JSON.stringify(calls3));
  dispose3();

  rmSync(dir, { recursive: true, force: true });
  rmSync(dir3, { recursive: true, force: true });
}

console.log(`\n${passed} 过 / ${failed} 挂`);
process.exit(failed ? 1 : 0);
