# kimicode 部署说明(DEPLOY)

> 版本:v1.0(2026-10-18)· kimicode 是**增量部署**:绿模/harnessd/服务端插件已随 workbuddy/zcode 在跑。
>  kimicode 是四形态中最简的:**原生 ACP,零适配器**。

## 0. 部署全景(kimicode 只碰一层)

```
208 服务端    —— 已在跑;kimicode 只加"节点登记"(带 cwd!)
WinPC 绿模    —— 已在跑;kimicode 只加"插头条目"(带 no_auto_port!)
WinPC kimicode —— 本包主体:plugs 条目 + 凭据(login)
```

## 1. 部署(四步,约 10 分钟)

### 1.1 插头条目(★两个必填字段)

`plugs.json` 的 kimicode-exec:
```json
{"plugId":"kimicode-exec","harness":"kimicode","kind":"acp",
 "command":"C:\Users\<用户名>\\.kimi-code\\bin\\kimi.exe","args":["acp"],
 "no_auto_port":true,"enabled":true}
```
- **`no_auto_port:true` 必须**:harnessd_win 默认给所有插头追加 `--port <端口>`(为 workbuddy 躲占用加的);kimi 原生 CLI 不认 → arg 解析失败 → 613ms 自杀(2026-10-17 实踩)
- 同步双副本:共享 wb-green(权威源,git commit)+ **C:\wb-mesh\plugs.json(harnessd 实际加载的!)**
- 重启 harnessd_win(plug.reload 有"载新不换旧"bug,重启最稳;keepalive ~70s 自拉)

### 1.2 节点登记(208 上,★cwd 必填)

```bash
curl -s -b /tmp/jar -X POST http://127.0.0.1:80/api/harness-mesh/nodes \
  -H 'Content-Type: application/json' -d '{"node":{
    "name":"<计算机名>-kimicode","type":"acp-plug",
    "address":"<tailnet-IP>:7080","plugId":"kimicode-exec",
    "socks":"127.0.0.1:11090",
    "cwd":"C:\\wb-mesh",
    "description":"WinPC kimicode(原生 acp,no_auto_port)"}}'
```
- **cwd 必须合法字符串**:kimi 的 ACP 拒 `cwd:null`(`-32602 Invalid params`,2026-10-17 实踩);zcode 适配器宽容 null,别被它的经验误导

### 1.3 凭据(本机用户一次性)

WinPC 终端跑 `kimi login`(device-code flow,浏览器授权)→ 落 `~/.kimi-code/credentials`,长效。**CLI 独立持证,不依赖桌面登录态**——不会踩 zcode 的签名坑。

### 1.4 验收(三件套)

```bash
# ① PONG(期望 succeeded+PONG,~5s)
harness_dispatch {"harness":"<计算机名>-kimicode","prompt":"只回复 PONG","cwd":null}
# ② 带产物(期望 succeeded+changes 捕获+共享可验的产物)
harness_dispatch {"harness":"<计算机名>-kimicode","prompt":"在 <数据目录>\\wb-green\\kimi-e2e-ok.txt 创建文件,内容:kimi 实机测试通过 <当前时间>;并汇报模型名","cwd":null}
# ③ 开团(期望 all_done)
harness_team {"task":"一句话说明角色","members":[{"harness":"<计算机名>-kimicode","role":"执行员"}]}
```
**2026-10-18 01:07 实机基线**:① 4.9s ② 34s(Write 偶发内部错→shell 自救,已验证产物) ③ all_done。

## 2. 排错(kimicode 专属)

| 症状 | 第一查 |
|---|---|
| 进程 613ms 自杀(initialize 前死) | **插头漏了 no_auto_port:true**——harnessd 追加了 --port,kimi 不认 |
| `-32602 Invalid params`(cwd 字段) | 节点表漏配 cwd——kimi 拒 null,填 C:\wb-mesh |
| `plug disabled` | 只改了共享没同步 C:\wb-mesh,或没重启 harnessd |
| Write 工具内部错 | kimi 侧偶发,它会 shell 自救,不阻塞;持续出现反馈 kimicode 侧 |
| 任务 20-40s | 正常(kimi 思考+工具调用比 zcode 略慢) |

## 3. 维护纪律

- plugs 改动走 wb-green git + **同步 C:\wb-mesh 双副本** + 重启 harnessd
- 绿模单例(别起第二份)
- kimicode 频道(AI协调频道-kimicode)转维护模式,安静即正常


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
