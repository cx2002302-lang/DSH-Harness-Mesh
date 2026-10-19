# zcode 接入发布包

> 版本:v1.0(2026-10-17 22:15)· 状态:**全绿+实机测试通过**(带产物任务独立验证+跨 harness 开团)
> 适用:WinPC(CHINAMI-EKC4J2J,与 workbuddy 同机)上的 zcode 接入

## 这个包里有什么

| 目录/文件 | 内容 | 备注 |
|---|---|---|
| `DEPLOY.md` | **部署说明(先读它)**——zcode 增量部署(相对已运行的绿模) | |
| `server/` | harness-mesh 插件全量+运维脚本 | **与 workbuddy 包共用,只需部署一次** |
| `client/adapters/` | **zcode-adapter.py**(ACP↔ZCode 翻译,v2 = -p 引擎) | zcode 核心件 |
| `client/config/` | plugs.json 当前全量(含 zcode-exec 条目) | 权威源=共享 wb-green |
| `client/green/` | **不含绿模文件**——见 SHARED-NOTE.md | 绿模是单例,与 workbuddy 共用 |
| `docs/联调记录/` | zcode 频道 chat.log+开场提示词+频道规约 | 全程留痕 |
| `docs/契约规范/` | ACP 参考实现+双边对齐表 | 接入契约 |
| `docs/实机测试/` | 实机测试记录 | 见下 |

## 部署(三步,详见 DEPLOY.md)

zcode 的部署是**增量式**——绿模/harnessd/服务端插件都已随 workbuddy 在跑,zcode 只需:
1. `client/adapters/zcode-adapter.py` → 放共享 wb-green(git 权威源)
2. `client/config/plugs.json` 的 zcode-exec 条目 → 同步到 harnessd 实际加载的 C:\wb-mesh\plugs.json
3. 主控侧登记节点 CHINAMI-zcode(plugId=zcode-exec,address <tailnet-ip>)

**凭据前提**:app-server 会话路径需 CLI 侧密钥;v2 已切 `zcode -p` 引擎(账号 login 即可用),`zcode login` 由老徐一次性完成。

## zcode 形态要点(与 workbuddy 的关键差异)

| 维 | workbuddy | zcode |
|---|---|---|
| 产品形态 | GUI-first(桌面 OAuth+Gateway) | **CLI-first(zcode CLI -p)** |
| 下行 | B 架构:REST runs 隔离 run | **zcode -p:每任务一会话,-c 续接** |
| 鉴权 | GUI 登录态(20 天) | **账号 login(CLI 用 -p 路径)** |
| 流式 | 有(SSE→chunk) | **无(v2 取舍:完整回复作单 chunk)** |
| 会话复用 | 跨任务 | **无(每任务新会话;多轮靠 -c 续接)** |
| UI 操控 | 有(CDP,10 工具) | 二期(app-server 会话管理映射) |

## 已知遗留(二期)

- 流式增量(v2.1:app-server+手工注入密钥)
- ui 插头(会话管理映射)
- harnessd_win 的 plug.reload 修复+收编 git;两份配置根治(harnessd 指向共享)

## 变更

- v1.0(2026-10-17 22:15):首个发布包。zcode-adapter v2(-p 引擎)、实机测试双发 PASS、开团实证
