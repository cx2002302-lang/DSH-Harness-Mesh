# qoder 部署说明(DEPLOY)

> 版本:v1.3.0(2026-10-21)· qoder 是**增量部署**:绿模/harnessd/服务端插件已随 workbuddy 在跑,本包只加 qoder 特有件。
> 前提:被控机已按 workbuddy 包部署绿模(ann-agent + harnessd_win + keepalive 单实例在跑)。

## 0. 部署全景(qoder 在三层里只碰两层)

```
服务端        —— 已在跑(harness-mesh 插件,workbuddy 包部署的);qoder 只加"节点登记"
被控机绿模    —— 已在跑(harnessd_win:7080,单实例);qoder 只加"插头条目"
被控机 qoder  —— 本包主体:qoder-adapter.py + plugs 条目 + CLI 路径
```

## 1. 部署(三步,约 10 分钟)

### 1.1 适配器落地

```bash
# 适配器放共享权威源(git 纪律:改完 commit)
cp client/adapters/qoder-adapter.py  <INSTALL_DIR>/qoder-adapter.py
# <INSTALL_DIR> = 适配器统一落地目录(即绿模共享目录);示例见 plugs.example.json 的 _comment
```

### 1.2 插头条目(harnessd 实际加载的那份!)

```bash
# ★关键:harnessd_win 无 --plugs 参数时默认加载其运行目录下的 plugs.json(本地副本),
#   不是共享那份——两份必须同步(漂移会导致插头时通时断)
cp client/config/plugs.example.json  <HM_BASE_DIR>/plugs.json   # 填好占位符后全量覆盖
# 然后重启 harnessd_win(keepalive ~70s 自拉)
```

占位符填写(详见 `plugs.example.json` 的 `_comment`):

| 占位符 | 填什么 |
|---|---|
| `<INSTALL_DIR>` | 适配器/脚本统一落地目录(绿模共享目录) |
| `<PYTHON_EXE>` | python.exe 全路径(≥3.10,纯标准库即可) |
| `<NODE_EXE>` | node.exe 全路径(仅 workbuddy-ui 需要) |

qoder-exec 插头 env 必填:`QODER_ADAPTER_CLI`(qoderclicn.exe 全路径);建议给 `QODER_ADAPTER_PERM_MODE=bypass_permissions`、`ADAPTER_MAX_TURN_WAIT=1800`、`QODER_ADAPTER_LOG_DIR=<HM_BASE_DIR>/logs`。

### 1.3 节点登记(服务端上,主控侧)

```bash
curl -s -b /tmp/jar -X POST http://127.0.0.1:80/api/harness-mesh/nodes \
  -H 'Content-Type: application/json' -d '{"node":{
    "name":"<你的节点名>","type":"acp-plug",
    "address":"<tailnet-ip>:7080","plugId":"qoder-exec",
    "socks":"127.0.0.1:11090","description":"qoderclicn(CLI-first,-p 引擎)"}}'
```

### 1.4 凭据

qoderclicn 首次使用先在终端完成账号 login(CLI 凭据本地留存);适配器走 `-p` 无头路径,login 一次即通。

## 2. 验收(部署后必跑)

```bash
# ① 基础 PONG(期望 succeeded + summary=PONG)
harness_dispatch {"harness":"<你的qoder节点名>","prompt":"只回复 PONG","cwd":null}

# ② 带产物任务(期望:汇报+共享上可验的产物)
harness_dispatch {"harness":"<你的qoder节点名>","prompt":"在 <INSTALL_DIR>/qoder-e2e-ok.txt 创建文件,内容:qoder 实机测试通过 <当前时间>;并汇报模型名","cwd":null}

# ③ 开团(期望 all_done,与其他 harness 混合编队)
harness_team {"task":"一句话说明角色","members":[{"harness":"<你的qoder节点名>","role":"执行员"},{"harness":"<其他节点>","role":"技术员"}]}
```

## 3. 排错(qoder 专属)

| 症状 | 第一查 |
|---|---|
| `plug disabled:待接` | harnessd 加载的 plugs.json 是旧份→同步+重启(§1.2) |
| `QODER_ADAPTER_CLI 不存在` | plug.env 没给全路径,或自动发现路径不匹配→显式给 QODER_ADAPTER_CLI |
| 权限被拦截(非报错) | 误用 `dont_ask`→改 `bypass_permissions`(§README 权限模式说明) |
| 模型指针坏(`qmodel_latest`) | 正常现象,适配器已每次显式带 `-m`;要钉模型用 `QODER_ADAPTER_MODEL` |
| `unknown cmd` | 适配器旧版→覆盖最新版(每次 spawn 自动加载,不用重启) |
| 任务慢(20-60s) | -p 引擎默认无流式,完整回复一次性返回,正常;要增量上 `QODER_ADAPTER_STREAM=1` |

## 4. 维护纪律

- 适配器/plugs 改动走绿模共享库 git(与 workbuddy 共库,提交前 `git status`)
- **永远只有一份绿模**(复制=双守护=踩过的 bug)
- harnessd 的两份配置(共享 vs 运行目录)每次改 plugs 都要同步
- bypass_permissions 下派活方对任务内容负责(调度纪律见 README)

---

## 构建(源码发布,无预编译产物)

本包只含源码。被控机上需要三样:**harnessd(Plug 协议服务端)**、**guardian/keepalive(守护)**、qoderclicn CLI(用户自行安装)。

```bash
# 1. 依赖(被控机)
python --version        # 需 ≥3.10(适配器纯标准库,无第三方依赖)

# 2. 启动 harnessd(Plug 服务端,默认 127.0.0.1:7080)
python server/harness-mesh/scripts/harnessd.py \
  --config server/harness-mesh/scripts/plugs.json

# 3. 守护(崩溃重启/断线重连/空闲退出)
python server/harness-mesh/scripts/guardian.py &
python server/harness-mesh/scripts/keepalive.py &

# 4. 接入 ANN 绿模(TUN→tailnet IP 直拨;需自行编译 ann-agent)
#    ann-agent --forward 7080=127.0.0.1:7080

# 5. 控制面侧注册节点(见 §1.3)
```

部署/联调细节见 workbuddy 包 `docs/`(联调记录、契约规范、实机测试)。
