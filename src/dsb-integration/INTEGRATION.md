# DeepSeekBot 集成指南(DSH Harness Mesh 的 Bot 团队层)

本目录包含把 **DeepSeekBot(DSB)** 接入 Harness Mesh 的全部材料:一个补丁文件 + 部署/联调说明。

## 1. 基线版本(锁定)

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/BotHarness/DeepSeekBot |
| **基线 commit** | **`810ae53`**(`feat(mobile): add device-local chat backgrounds #2122`) |
| 克隆日期 | 2026-10-18 |
| 构建 | Node ≥20(实测 24)+ pnpm;`pnpm install && pnpm build` |
| 本集成补丁 | `dsb-dreamx-patches.patch`(4 处修复,见 §3) |

> 上游迭代快,换版本需重新验补丁。若 `git apply` 失败,按 §3 四处**手动改**(每处都有 `★DreamX 本地补丁` 注释锚点)。

## 2. 快速开始

```bash
# 1) 按基线克隆(必须锁 commit)
git clone https://github.com/BotHarness/DeepSeekBot.git BotHarness
cd BotHarness && git checkout 810ae53

# 2) 打集成补丁(4 处,冲突则按 §3 手动)
git apply ../dsb-integration/dsb-dreamx-patches.patch

# 3) 改补丁里硬编码的主 GUI 地址(两处,改成你的)
#    packages/client/src/client/workspace.tsx            → 退出按钮跳转
#    packages/client/src/client/bot-mode-sidebar.tsx      → logo 退出跳转

# 4) 构建
pnpm install && pnpm build

# 5) 起实例(LAN 部署三要素)
export DSH_WEB_TOKEN=<你的固定token>          # 稳定 token,免重复认证
node scripts/dev-instance.mjs \
  --home /tmp/botharness-demo --port 31967 \
  --trusted-host <你的局域网IP> \
  --no-client-diagnostics                      # 关首屏诊断(非安全上下文会崩)

# 6) 访问
open "http://<你的局域网IP>:31967/?token=<你的固定token>"
```

## 3. 补丁详解(4 处,源码内均有 `★DreamX 本地补丁` 注释)

| # | 文件 | 修什么 | 不改的后果 |
|---|---|---|---|
| 1 | `packages/client/src/client/index.ts` | **crypto.randomUUID polyfill** | LAN IP(http://192.168.x.x)不是安全上下文,`crypto.randomUUID` 是 undefined → DSB 客户端 TypeError,连接建不起来 |
| 2 | `packages/client/src/client/index.ts` | **自动进 Bot 模式**(DOM ready 后轮询点“Bot 模式”按钮;`window.__dsbNoAutoBot=true` 可关) | 每次都要手动切模式 |
| 3 | `workspace.tsx` + `bot-mode-sidebar.tsx` | **双退出入口回主 GUI**(两处跳转地址,记得改成你的) | Bot 模式里出不来 |
| 4 | `workspace.tsx` | **点频道列表 Bot 开 body 面板**:`registry.open(CHANNEL_BODY_PANEL)` 包住 `openBot/openChannel` | 上游渐进迁移遗留:openBot 只加载对话数据不开面板,点 Bot 像“没反应”(实测高亮变了但主区不动) |

## 4. 与 Harness Mesh 的连接(关键)

**零代码集成**:harness-mesh 插件装在跑 DSB 的同一个 DSH 实例里,每个 Bot 会话**原生**就有 5 个工具:

```
harness_list      列出网格节点(名称/类型/健康/在跑任务)
harness_dispatch  派任务(harness/prompt/cwd/model/timeoutMs/deny)
harness_status    轮询进度(15-30s 一次)
harness_result    取终态结构化汇报
harness_cancel    取消在跑任务
```

Bot 用法示例(直接对它说):
> “用 harness_list 看有哪些节点,派个任务到 CHINAMI-zcode 让它只回复 PONG,轮询到终态拿汇报”

节点配置单一来源(主实例 `nodes.json`);DSB 实例软链到同一份,零漂移:
```bash
ln -sf <主实例>/harness-mesh/nodes.json <dsb-home>/harness-mesh/nodes.json
```

## 5. 模型配置(Bot 大脑)

- **全局默认**:Bot 设置 → 模型与运行 → 全局默认模型(新 Bot 继承)
- **每 Bot 独立**:Bot 资料页 → 对话模型(下拉可选,含思考强度);或 CLI:
  ```bash
  node packages/deepseekbot/dist/deepseekbot.mjs model-presets        # 看预设
  node packages/deepseekbot/dist/deepseekbot.mjs model-preset-apply <bot-id> --preset <id>
  ```
- **注意**:保存时勾选“同时设为 Profile 默认模型”会改全局,影响所有继承 Bot
- **每任务覆盖**:`harness_dispatch` 的 `model` 参数(对端 ACP 需实现 `session/set_model`;kimi/zcode 有已知限制)

## 6. 已知限制(实测)

| 项 | 状态 |
|---|---|
| 信息图/截图里的小字 | MiniMax image-01 生成,少量乱字(不影响主标签) |
| kimi 节点 `set_model` | 实现但拒收所有模型 ID(上游 Internal error)——单次 model 覆盖对它无效 |
| zcode v2(-p 引擎) | 未实现 `session/set_model`(method not found)——同上 |
| DSB 运行形态 | dev 实例 + systemd 保活(60s 巡检);未并入主实例 |
| 反代 | **已弃用**(RST/gzip/303/token 一串问题);用直连+固定 token |

## 7. 保活(可选)

```ini
# ~/.config/systemd/user/dsb-keepalive.service
[Service]
ExecStart=/bin/bash -c 'while true; do
  curl -sf -o /dev/null --max-time 8 "http://127.0.0.1:31967/?token=<token>" || \
    (cd <dsb-src> && node scripts/dev-instance.mjs --home /tmp/botharness-demo \
       --port 31967 --trusted-host <lan-ip> --no-client-diagnostics &)
  sleep 60
done'
Restart=always
```
