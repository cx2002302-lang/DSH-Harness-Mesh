# zcode 部署说明(DEPLOY)

> 版本:v1.0(2026-10-17)· zcode 是**增量部署**:绿模/harnessd/服务端插件已随 workbuddy 在跑,本包只加 zcode 特有件。
> 前提:WinPC 已按 workbuddy 包部署绿模(ann-agent+harnessd_win+keepalive 单实例在跑)。

## 0. 部署全景(zcode 在三层里只碰两层)

```
208 服务端    —— 已在跑(harness-mesh 插件,workbuddy 包部署的);zcode 只加"节点登记"
WinPC 绿模    —— 已在跑(ann-agent+harnessd_win:7080,单实例);zcode 只加"插头条目"
WinPC zcode  —— 本包主体:适配器 + plugs 条目 + 凭据(login)
```

## 1. 部署(三步,约 10 分钟)

### 1.1 适配器落地(zcode 核心件)

```bash
# 适配器放共享权威源(git 纪律:改完 commit)
cp client/adapters/zcode-adapter.py  <INSTALL_DIR>\zcode-adapter.py
cd <INSTALL_DIR> && git add -A && git commit -m "zcode-adapter v2 (-p engine)"
```

### 1.2 插头条目(harnessd 实际加载的那份!)

```bash
# ★关键:harnessd_win 无 --plugs 参数,默认加载 <MESH_ROOT>\plugs.json(本地副本),
#   不是共享那份——两份必须同步(2026-10-17 踩过:漂移导致插头时通时断)
cp client\config\plugs.json  <MESH_ROOT>\plugs.json        # 全量覆盖(以共享为权威源)
# 然后重启 harnessd_win(plug.reload 有"载新不换旧"bug,重启最稳;keepalive ~70s 自拉)
```

### 1.3 节点登记(208 上,主控侧)

```bash
curl -s -b /tmp/jar -X POST http://127.0.0.1:80/api/harness-mesh/nodes \
  -H 'Content-Type: application/json' -d '{"node":{
    "name":"node-win-01-zcode","type":"acp-plug",
    "address":"<tailnet-IP>:7080","plugId":"zcode-exec",
    "socks":"127.0.0.1:11090","description":"WinPC zcode(CLI-first,-p 引擎)"}}'
```

### 1.4 凭据(管理员一次性)

WinPC 终端跑 `zcode login`(浏览器 OAuth)。**v2 适配器用 -p 路径,账号 login 即通**;app-server 会话路径的密钥问题二期再治。

## 2. 验收(部署后必跑)

```bash
# ① 基础 PONG(期望 succeeded + summary=PONG)
harness_dispatch {"harness":"node-win-01-zcode","prompt":"只回复 PONG","cwd":null}

# ② 带产物任务(期望:汇报+共享上可验的产物)
harness_dispatch {"harness":"node-win-01-zcode","prompt":"在 <INSTALL_DIR>\\zcode-e2e-ok.txt 创建文件,内容:zcode 实机测试通过 <当前时间>;并汇报模型名","cwd":null}

# ③ 开团(期望 all_done,与 opencode/workbuddy 混合编队)
harness_team {"task":"一句话说明角色","members":[{"harness":"node-win-01-zcode","role":"执行员"},{"harness":"opencode-local","role":"技术员"}]}
```

**2026-10-17 22:08 实机基线**:① PONG 23s ② 产物任务 57s(共享文件独立验证通过)③ 开团 all_done。

## 3. 排错(zcode 专属)

| 症状 | 第一查 |
|---|---|
| `plug disabled:待接` | harnessd 加载的 <MESH_ROOT>\plugs.json 是旧份→同步+重启(§1.2) |
| exit code=1(会话创建步) | app-server env 断供→确认适配器的 env 显式化(zcode-builtin.json 注入)在位 |
| summary=`[zcode turn 失败] invalid-config` | 凭据未修→管理员 `zcode login`(§1.4) |
| `unknown cmd` | 适配器旧版→覆盖最新版(每次 spawn 自动加载,不用重启) |
| 任务慢(20-60s) | -p 引擎无流式,完整回复一次性返回,正常 |

## 4. 维护纪律

- 适配器/plugs 改动走 wb-green git(与 workbuddy 共库,提交前 `git status`)
- **永远只有一份绿模**(复制=双 guardian=今天修掉的 bug)
- harnessd 的两份配置(共享 vs <MESH_ROOT>)每次改 plugs 都要同步


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
