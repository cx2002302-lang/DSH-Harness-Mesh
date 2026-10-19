# opencode(WinPC)接入发布包

> 版本:v1.0(2026-10-18 01:50)· 状态:**全绿+实机测试通过**(PONG 31.5s/模型复验/带产物 56s 独立验证)
> 适用:WinPC(<计算机名>,与 workbuddy/zcode/kimicode 同机)上的 opencode 接入

## 这个包里有什么

| 目录/文件 | 内容 | 备注 |
|---|---|---|
| `DEPLOY.md` | **部署说明(先读它)**——opencode 增量部署 | |
| `server/` | harness-mesh 插件全量+运维脚本 | **与 workbuddy 包共用,只需部署一次** |
| `client/adapters/` | **NO-ADAPTER-NOTE.md**——opencode 原生 ACP 零适配器;含三个关键配置(no_auto_port/cwd/★项目级钉模型) | opencode 核心知识 |
| `client/config/` | plugs.json 当前全量(含 opencode-exec) | 权威源=共享 wb-green |
| `client/green/` | **不含绿模文件**——见 SHARED-NOTE.md | 绿模是单例,四 harness 共用 |
| `docs/联调记录/` | oc 频道 chat.log+开场提示词+频道规约 | 全程留痕(28 分钟) |
| `docs/契约规范/` | ACP 参考实现+双边对齐表 | 接入契约 |
| `docs/实机测试/` | 实机测试记录(三项+基线) | 见下 |

## 部署(详见 DEPLOY.md,约 10 分钟)

增量式——绿模/harnessd/服务端插件都已在跑,opencode 只需:
1. plugs.json 的 opencode-exec 填 command(opencode.exe)/args(["acp"])/**no_auto_port:true**/enabled:true
2. **★C:\wb-mesh\opencode.json 钉模型**(全局默认模型可能是死的,acp 又拒 -m)
3. 同步 C:\wb-mesh\plugs.json + 重启 harnessd_win
4. 主控侧登记节点(**cwd 必须配 C:\wb-mesh**)

## opencode 形态要点

| 维 | opencode(WinPC) |
|---|---|
| 产品形态 | **CLI-first 原生 ACP**(opencode acp,零适配器) |
| 鉴权 | CLI 独立持证(auth.json 多组;与 208 实例凭据独立——208 那个 key 过期红着,这个活着) |
| 模型 | 经 C:\wb-mesh\opencode.json 钉 `opencode/deepseek-v4.1-flash-free`(全局默认 astron 已死) |
| 关键配置 | no_auto_port + cwd 合法 + **项目级钉模型** |
| 能力 | loadSession/close/fork/list/resume/mcp http+sse/embeddedContext+image |

## 已知遗留(不阻塞)

- 全局配置的默认模型(astron)已死——本项目级绕开,全局修复归 opencode 账号侧
- L2 专属工具需求来了再按规范开
- harnessd 的 plug.reload 根治/两份配置根治(全体系项)

## 变更

- v1.0(2026-10-18 01:50):首个发布包。28 分钟接入、三项实机测试全过、钉模型方案入库
