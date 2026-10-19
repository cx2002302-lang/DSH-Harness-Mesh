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

const name = "harness-mesh";
const inject = ["tools", "connection", "agentDefaultModel", "llm"];

const HarnessEntry = z.object({
  /** 适配器类型:本机 ACP / 跨机 SSH 隧道 ACP / CLI 一次性兜底 */
  type: z.union([z.const("acp-stdio"), z.const("acp-ssh"), z.const("cli-oneshot")]),
  command: z.string().required(),
  args: z.array(z.string()).default([]),
  /** acp-ssh 专用:用户@主机 */
  ssh: z.string(),
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

  ctx.effect(() => {
    const disposers = createTools(state).map((tool) => ctx.tools.register(tool));
    // 路由也进 effect:apply 重入(配置热更/双半身装载)时先清理后重注册,避免重复注册报错
    const disposeRoutes = registerRoutes(ctx, mesh, nodes);
    return () => {
      for (const dispose of disposers) dispose();
      void disposeRoutes();
      void mesh.dispose();
    };
  });

  const names = nodes.list().map((n) => n.name);
  const line = `[harness-mesh] 已激活,注册 list/dispatch/status/cancel/result 5 工具 + /api/harness-mesh/* 路由;节点 ${names.length} 个${names.length ? `: ${names.join(", ")}` : ""}`;
  console.log(line);
  ctx.logger.info(line);
}

export { Config, apply, inject, name };
