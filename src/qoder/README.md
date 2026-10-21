# qoder 接入发布包

> 版本:v1.3.0(2026-10-21)· 状态:**全绿**(承接 v1.2.9 入网,本包首次收录 qoder 客户端件)
> 适用:WinPC(与 workbuddy 同机部署)上的 qoderclicn(CN CLI)接入

## 这个包里有什么

| 目录/文件 | 内容 | 备注 |
|---|---|---|
| `DEPLOY.md` | **部署说明(先读它)**——qoder 增量部署(相对已运行的绿模) | |
| `client/adapters/qoder-adapter.py` | **ACP↔qoderclicn 翻译适配器**(纯标准库,无第三方依赖) | qoder 核心件 |
| `client/config/plugs.example.json` | 6 插头模板(含 qoder-exec),全部占位符化 | 填好后同步到 harnessd 实际加载的 plugs.json |
| `client/green/` | **不含绿模文件**——绿模是单例,与 workbuddy 共用 | 见 workbuddy 包 |
| `server/` | 不含——harness-mesh 插件全量见 workbuddy 包,只需部署一次 | |

## 接入形态

qoderclicn(千问 CN CLI)经 `qoder-adapter.py` 接入 harness-mesh:

- **适配器**:纯标准库 Python,实现 ACP over stdio(initialize / session/new / session/prompt / session/cancel / session/set_model)。
- **下行引擎**:CLI `-p` 无头路径,每任务一会话,同 ACP 会话续接 CLI 会话(`-r`,QODER_ADAPTER_CONTINUITY=0 可关)。
- **模型**:2 款(qfmodel / dfmodel);CLI 不带 `-m` 会解析到坏指针,适配器每次显式带 `-m`(取 `--list-models` 首项,`QODER_ADAPTER_MODEL` 可钉)。
- **流式**:默认完整回复单 chunk;`QODER_ADAPTER_STREAM=1` 可切 stream-json(实测粒度是"按 assistant 块")。

## env 清单(plug.env 注入)

| 变量 | 说明 | 默认 |
|---|---|---|
| `QODER_ADAPTER_CLI` | qoderclicn.exe 全路径 | 按当前用户安装位置自动发现 |
| `QODER_ADAPTER_PERM_MODE` | 权限模式:default / accept_edits / bypass_permissions / dont_ask / auto | bypass_permissions |
| `QODER_ADAPTER_STREAM` | 1 = 下行改 stream-json | 0(完整回复) |
| `QODER_ADAPTER_LOG_DIR` | 诊断日志目录 | `<HM_BASE_DIR>/logs` |
| `ADAPTER_MAX_TURN_WAIT` | 单 prompt 最长等待秒 | 1800 |

> 配置变量一律带 `QODER_ADAPTER_` 前缀:桌面端会向会话注入 `QODER_CLI=1` 这类标记变量,短名会被顶掉(实测教训)。

## 权限模式说明(bypass_permissions 与调度纪律)

qoderclicn 的 `--permission-mode` 各档实测行为:

- `dont_ask`:写文件/跑命令被**静默自动拒绝**(表现为"被拦截"而非报错)——不要用;
- `auto`:全放行,但 CLI 内置安全分类器会拦"与开发无关"的命令;
- `bypass_permissions`:全放行,无内置拦截。

**2026-10-21 由使用方定 `bypass_permissions`**(跨机派活要能跑测试/装依赖)。

配套调度纪律:

- bypass 模式下适配器对主控下发的命令**不做二次确认**,因此派活方(主控/开团发起者)对任务内容负责:不要派未审慎过的破坏性指令;
- 插头 `cwd` 建议钉到专用工作目录,限制落盘范围;
- `ADAPTER_MAX_TURN_WAIT` 兜底卡死任务,超时后适配器回收 CLI 进程(孤儿收尸),不让僵尸进程占会话。

## 变更

- v1.3.0(2026-10-21):首个发布包收录。qoder-adapter 全绿(并发/死锁/孤儿收尸/单例锁对齐 v1.3.0 必修项)、plugs 模板占位符化。
