/** harness-mesh 插件入口:Cordis 插件三件套(name/inject/apply)+ Config。
 *  形状对齐 @deepseek-ai/dsh-plan-mode 与 DreamX llm-pi-durable 的导出约定。
 *
 *  M0:插件壳 + 配置加载 + 任务注册表 + harness_list。
 *  M1:MeshController(适配器生命周期/任务状态机/权限策略)+ dispatch/status/cancel/result。
 *  GUI:client 半身(./client)+ /api/harness-mesh/* HTTP 直连通道 + nodes.json 节点存储。
 */
import z from "@deepseek-ai/schemastery";
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { normalizeConfig } from "./config.js";
import { NodesStore } from "./nodes-store.js";
import { TaskStore } from "./task-store.js";
import { MeshController } from "./mesh.js";
import { createTools } from "./tools.js";
import { registerRoutes } from "./http.js";
import { startModelBridge } from "./model-bridge.js";

const name = "harness-mesh";
const inject = ["tools", "connection", "agentDefaultModel", "llm", "settings"];

const HarnessEntry = z.object({
  /** 适配器类型:本机 ACP / 跨机 SSH 隧道 ACP / 插头协议(被控机 harnessd)/ CLI 一次性兜底 */
  type: z.union([z.const("acp-stdio"), z.const("acp-ssh"), z.const("acp-plug"), z.const("cli-oneshot")]),
  command: z.string().required(),
  args: z.array(z.string()).default([]),
  /** acp-ssh 专用:用户@主机 */
  ssh: z.string(),
  /** acp-plug 专用:被控机 harnessd 地址(host:port) */
  address: z.string(),
  /** acp-plug 专用:被控机 plugs.json 里的插头名 */
  plugId: z.string(),
  /** acp-plug 可选:经本机 SOCKS5(ann-agent)拨号,如 127.0.0.1:11080 */
  socks: z.string(),
  /** 任务默认工作目录(dispatch 可覆盖) */
  cwd: z.string(),
  /** 固定模型(provider/model);空 = 用被控 harness 默认 */
  model: z.string(),
  env: z.dict(z.string()).default({}),
  description: z.string(),
});

const Config = z.object({
  defaultTimeoutMs: z.number().step(1).min(1000).default(600000),
  harnesses: z.dict(HarnessEntry).default({}),
  /** 模型桥:把节点背后的模型自动注册进 llm-pi-ai 供应商目录(随 nodes.json 热同步) */
  modelBridge: z.object({ enable: z.boolean().default(false) }).default({}),
});

let applyCount = 0;
function apply(ctx, config) {
  applyCount += 1;
  if (applyCount > 1) console.log(`[harness-mesh:debug] apply 第 ${applyCount} 次(entry=${ctx.fiber?.entry?.options?.id ?? "?"})`);
  const normalized = normalizeConfig(config);
  const nodes = new NodesStore(join(resolveDshHome(), "harness-mesh", "nodes.json")).load(normalized.harnesses);
  const store = new TaskStore(join(resolveDshHome(), "harness-mesh", "tasks.jsonl"));
  const mesh = new MeshController(ctx, { defaultTimeoutMs: normalized.defaultTimeoutMs }, nodes, store);
  const state = { config: normalized, nodes, store, mesh };

  const tools = createTools(state);
  ctx.effect(() => {
    const disposers = tools.map((tool) => ctx.tools.register(tool));
    // 路由也进 effect:apply 重入(配置热更/双半身装载)时先清理后重注册,避免重复注册报错
    const disposeRoutes = registerRoutes(ctx, mesh, nodes);
    // 模型桥:仅在显式开启且实例有 settings+llm 服务时激活(默认关,主 GUI 不需要)
    const disposeBridge = normalized.modelBridge.enable
      ? startModelBridge(ctx, join(resolveDshHome(), "harness-mesh", "nodes.json"), () => nodes.list(), join(resolveDshHome(), "harness-mesh"), (line) => { console.log(line); ctx.logger.info(line); })
      : () => {};
    return () => {
      for (const dispose of disposers) dispose();
      disposeBridge();
      void disposeRoutes();
      void mesh.dispose();
    };
  });

  const names = nodes.list().map((n) => n.name);
  const line = `[harness-mesh] 已激活,注册 ${tools.length} 个工具(${tools.map((t) => t.name.replace(/^harness_/, "")).join("/")})+ /api/harness-mesh/* 路由;节点 ${names.length} 个${names.length ? `: ${names.join(", ")}` : ""}`;
  console.log(line);
  ctx.logger.info(line);
}

export { Config, apply, inject, name };
