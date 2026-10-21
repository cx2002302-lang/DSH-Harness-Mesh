# kimicode 接入发布包

> 版本:v1.0(2026-10-18 01:10)· 状态:**全绿+实机测试通过**(PONG 4.9s/带产物 34s 独立验证/开团 all_done)
> 适用:WinPC(node-win-01,与 workbuddy/zcode 同机)上的 kimicode 接入

## 这个包里有什么

| 目录/文件 | 内容 | 备注 |
|---|---|---|
| `DEPLOY.md` | **部署说明(先读它)**——kimicode 增量部署 | |
| `server/` | harness-mesh 插件全量+运维脚本 | **与 workbuddy 包共用,只需部署一次** |
| `client/adapters/` | **NO-ADAPTER-NOTE.md**——kimicode 原生 ACP,零适配器;含两个 harnessd 侧关键配置(no_auto_port/cwd) | kimicode 核心知识 |
| `client/config/` | plugs.json 当前全量(含 kimicode-exec) | 权威源=共享 wb-green |
| `client/green/` | **不含绿模文件**——见 SHARED-NOTE.md | 绿模是单例,三机harness 共用 |
| `docs/联调记录/` | kimicode 频道 chat.log+开场提示词+频道规约 | 全程留痕(20 分钟收官) |
| `docs/契约规范/` | ACP 参考实现+双边对齐表 | 接入契约 |
| `docs/实机测试/` | 实机测试记录(三项+基线) | 见下 |

## 部署(详见 DEPLOY.md,约 10 分钟)

增量式——绿模/harnessd/服务端插件都已在跑,kimicode 只需:
1. plugs.json 的 kimicode-exec 填 command(kimi.exe)/args(["acp"])/**no_auto_port:true**/enabled:true
2. 同步 <MESH_ROOT>\plugs.json + 重启 harnessd_win
3. 主控侧登记节点(**cwd 必须配 <MESH_ROOT>**——kimi 拒 cwd:null)
4. 凭据:一次性 `kimi login`(device-code flow,长效)

## kimicode 形态要点(四形态中最简)

| 维 | kimicode |
|---|---|
| 产品形态 | **CLI-first 原生 ACP**(kimi.exe acp,零适配器零垫片) |
| 鉴权 | CLI 独立持证(device-code login,不依赖桌面/GUI) |
| 下行 | harnessd 直接 spawn kimi.exe acp |
| 关键配置 | **no_auto_port**(harnessd 别追加 --port)+ cwd 合法 |
| 模型 | kimi-for-coding 等(configOptions 运行时切) |

## 已知遗留(不阻塞)

- Write 工具偶发内部错误(kimi 侧,会 shell 自救)——已反馈
- L2 专属工具候选:kimi_models/kimi_sessions(按规范后补)
- harnessd 的 plug.reload 根治/两份配置根治(全体系项)

## 变更

- v1.0(2026-10-18 01:10):首个发布包。20 分钟接入(最快纪录)、三项实机测试全过、no_auto_port 机制入库

> qoder 适配器的开场提示词文档已统一收敛到仓顶层 `docs/qoder-adapter-prompt.md`(本树不再保留副本)。
