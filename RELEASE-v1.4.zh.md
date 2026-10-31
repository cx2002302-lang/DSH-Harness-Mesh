# DSH Harness Mesh v1.4.0 — 发布说明

**发布日期:** 2026-10-31 · **许可:** MIT · **基线:** v1.3.2

## 新能力

- **思考档位全链**——ACP `thought_level` configOption 探测落 nodes.json → 模型桥给节点模型声明 `reasoningEfforts`(pi-ai 枚举,wire 值=ACP 原值,`none→off` 别名归一)→ LLM 网关透传 `reasoning_effort` → `session/set_config_option` 落地到节点。DSB 模型目录的"思考强度"菜单零改动自动点亮。非法档位 400 并列出可用档。
- **网格 LLM 网关**——OpenAI 兼容端点 `POST /api/harness-mesh/llm/:node/v1/chat/completions`(Bearer 鉴权);节点不支持按会话选模型时自动降级默认模型重派,绝不静默错派。
- **模型桥网关模式**——每节点一条目 `网格 · <节点名>`,baseURL 指回本网关,模型目录与节点勾选 1:1 动态关联。
- **qoder 接入发布包**——qoder-adapter.py 全量公开:六档思考强度(none/low/medium/high/xhigh/max,别名 off/disabled→none,白名单卡在适配器层防 CLI 静默丢档)、按会话续接、作业对象防孤儿进程。
- **能力巡查(capability-refresh)**——周期探测节点真实模型写回 `liveModels`(探测/策展分离:永不覆盖用户勾选;节点从无策展时实况播种引导);思考档位/模式变化同步落档。
- **队长循环(captain-loop)+ 巡查哨兵(captain-guardian)**——任务书队列(queue/NN-名.md)→派发→验收→报告归档的全自动值班循环;哨兵保活+定时健康巡查+接续档案。
- **fs_* 团队文件服务器工具组**——Samba 共享 8 工具(init/verify/list/read/write/upload/download/remove),路径沙箱+成员目录规约。
- **MCP 服务间鉴权**——`/api/mcp/harness-mesh(-admin)` 支持 `Authorization: Bearer $MESH_MCP_TOKEN`。

## 修 bug

1. **wb-gateway-adapter v5.2.2**:WorkBuddy 桌面端升级后官方模型目录缓存改带 pid+uuid 后缀文件名(`acc-product-config-v3-<pid>-<uuid>.json`),旧固定路径失效导致官方目录静默丢空——改通配取 mtime 最新一份,兼容旧名。
2. **白名单上限 64→160**:修自动策展同步后按字母序截断、循环派发被拒。
3. **策展事故修正**:探测只写 `liveModels`,不再覆盖用户策展 `models`(曾致桥把全量实况灌进模型目录)。

## 测试

- 362 个 `node:test` 单测全绿(新增 capability-refresh / fs-tools / llm-gateway / model-bridge 思考档套件)。

## 加固 / 脱敏

- 全部示例配置改 `plugs.example.json` 风格占位;代码内凭证 fallback 一律 `change-me`,真实值只走环境变量。
- 内网地址/主机名/人名/用户路径全部泛化(文档段示例 IP、DEMOPC、user、主控)。
