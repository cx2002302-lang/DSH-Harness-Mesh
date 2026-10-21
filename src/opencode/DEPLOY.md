# opencode(WinPC)部署说明(DEPLOY)

> 版本:v1.0(2026-10-18)· opencode 是**增量部署**:绿模/harnessd/服务端插件已随 workbuddy 等在跑。
> opencode 是**原生 ACP 零适配器**(与 kimicode 同款模板 A),但多一个**钉模型**的关键步。

## 0. 部署全景

```
208 服务端    —— 已在跑;opencode 只加"节点登记"(带 cwd!)
WinPC 绿模    —— 已在跑;opencode 只加"插头条目"(带 no_auto_port!)
WinPC opencode —— 本包主体:plugs 条目 + opencode.json 钉模型
```

## 1. 部署(五步,约 10 分钟)

### 1.1 插头条目

`plugs.json` 的 opencode-exec:
```json
{"plugId":"opencode-exec","harness":"opencode","kind":"acp",
 "command":"<USERPROFILE>\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe",
 "args":["acp"],"no_auto_port":true,"enabled":true}
```
- **no_auto_port:true**:harnessd 默认追加 --port;保守不掺(kimi 实踩过 613ms 自杀)
- 同步双副本:共享 wb-green(权威源,git commit)+ **<MESH_ROOT>\plugs.json(harnessd 实际加载的!)**

### 1.2 ★钉模型(opencode 特有,最易漏)

```json
// <MESH_ROOT>\opencode.json(harnessd 的 spawn cwd 正好是它,项目级配置自动生效)
{"model": "opencode/deepseek-v4.1-flash-free"}
```
- **为什么必须**:全局配置的默认模型可能是死的(astron → `HMAC signature cannot be verified: apikey not found`),而 `acp` 子命令**拒收 `-m`**(参数白名单)——命令行绕不过,只能项目级配置钉
- 可用模型清单:`opencode` auth.json 里有多组凭据(opencode/longcat2/opencode-go),选活的那个

### 1.3 重启 harnessd_win

同步 plugs 后重启(plug.reload 有"载新不换旧"bug;keepalive/start-all ~70s 自拉,ANN 抖 ~50-70s 属正常)

### 1.4 节点登记(208,★cwd 必填)

```bash
curl -s -b /tmp/jar -X POST http://127.0.0.1:80/api/harness-mesh/nodes \
  -H 'Content-Type: application/json' -d '{"node":{
    "name":"node-win-01-opencode","type":"acp-plug",
    "address":"<tailnet-IP>:7080","plugId":"opencode-exec",
    "socks":"127.0.0.1:11090","cwd":"<MESH_ROOT>",
    "description":"WinPC opencode(原生 acp,no_auto_port,项目级钉模型)"}}'
```
- **cwd 必须合法**:opencode 的 ACP 拒 `cwd:null`(-32602)

### 1.5 验收(三件套)

```bash
harness_dispatch {"harness":"node-win-01-opencode","prompt":"只回复 PONG","cwd":null}          # 期望 ~30s
harness_dispatch {"harness":"node-win-01-opencode","prompt":"一句话:模型名+现在几点","cwd":null}  # 期望真模型回答
harness_dispatch {"harness":"node-win-01-opencode","prompt":"在 <INSTALL_DIR>\\oc-e2e-ok.txt 建文件(内容:oc 实机测试通过 <时间>);报模型名","cwd":null}  # 期望 ~56s+changes
```
**2026-10-18 01:44 实机基线**:① 31.5s ② deepseek-v4.1-flash-free ③ 56s(产物独立验证)。

## 2. 排错(opencode 专属)

| 症状 | 第一查 |
|---|---|
| summary 是 `Unauthorized: HMAC signature...apikey not found` | **全局默认模型(astron)是死的**→按 §1.2 在 <MESH_ROOT>\opencode.json 钉活模型 |
| `-32602 Invalid params`(cwd) | 节点表漏配 cwd→填 <MESH_ROOT> |
| 进程 613ms 自杀 | 插头漏 no_auto_port:true |
| `plug disabled` | 只改共享没同步 <MESH_ROOT>,或没重启 |
| 208 的 opencode-local 也红着 | **另一台机器的另一个实例**,凭据独立——各修各的 |

## 3. 维护纪律

- plugs/opencode.json 改动走 wb-green git + 同步 <MESH_ROOT> 双副本 + 重启 harnessd
- 绿模单例;oc 频道(AI协调频道-oc)转维护,安静即正常
- 全局默认模型的修复归 opencode 账号侧(本项目级绕开不阻塞)


---

## 构建(源码发布,无预编译产物)

本包只含源码。被控机上需要三样:**harnessd.py(Plug 协议服务端)**、**guardian.py/keepalive.py(守护)**、对应 harness 的**官方 CLI**(用户自行安装)。

```bash
# 1. 依赖(被控机)
python --version        # 需 ≥3.10(只用标准库,无第三方依赖)

# 2. 启动 harnessd(Plug 服务端,默认 127.0.0.1:7080)
python server/harness-mesh/scripts/harnessd.py \
  --config server/harness-mesh/scripts/plugs.json

# 3. 守护(崩溃重启/断线重连/空闲退出)
python server/harness-mesh/scripts/guardian.py &
python server/harness-mesh/scripts/keepalive.py &

# 4. 接入 ANN 绿模(TUN→tailnet IP 直拨;需自行编译 ann-agent)
#    工具链与补丁见主仓库 ann-src/(Go 1.26.3),产物 ann-agent(.exe)
#    ann-agent --forward 7080=127.0.0.1:7080

# 5. 控制面侧(208)注册节点
curl -X POST http://127.0.0.1:80/api/harness-mesh/nodes \
  -H 'Content-Type: application/json' \
  -d '{"node":{"name":"<你的节点名>","type":"acp-plug","address":"<tailnet-ip>:7080","plugId":"<plugId>","socks":"127.0.0.1:11090","cwd":"<默认工作目录>"}}'
```

**各 harness CLI 自行安装**(本包不含):

| 包 | 需要装 | 说明 |
|---|---|---|
| zcode | zcode CLI(带 `-p` 无头引擎) | 薄适配器 `zcode-adapter.py` 在本包 client/adapters/ |
| kimicode | kimi CLI(原生 ACP) | 零适配器,直连 |
| opencode | opencode CLI(原生 ACP) | 零适配器,直连;需 `opencode auth login` |

部署/联调细节见本包 `docs/`(联调记录、契约规范、实机测试)。
