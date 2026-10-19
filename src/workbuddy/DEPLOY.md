# workbuddy 集成部署说明(DEPLOY)

> 版本:v1.0(2026-10-17)· 配套 `releases/workbuddy/` 发布包使用
> 原则:**部署动作全部可重入(幂等);任何一步失败,回滚到上一步不影响运行**。

## 0. 架构一页图(先看懂再动手)

```
┌──────────────────── 主控机(master)────────────────────┐
│ DSH 服务(dreamx,:80)                                        │
│  └─ harness-mesh 插件(本包 server/harness-mesh/)            │
│      · MCP 入口:客户端 7 工具 / admin 9 工具                 │
│      · 节点表:$DSH_HOME/harness-mesh/nodes.json             │
│ ann-ctrl(控制面,:8443) + ann-agent-208(SOCKS5 :11090)       │
└──────────────────┬ ANN 隧道(WireGuard 100.64/10)────────────┘
                   │ 拨 <tailnet-ip>(经本机 SOCKS5)
┌──────────────────┴──── WinPC(<计算机名>)──────────────┐
│ ann-agent.exe(绿模入网,--forward 7080=127.0.0.1:7080)        │
│ harnessd_win(:7080,插头服务端,按 plugs.json spawn)           │
│  ├─ workbuddy-exec(acp)→ wb-gateway-adapter.py → GUI Gateway │
│  └─ workbuddy-ui(line)→ wb-ui.js → CDP(9222)                │
│ WorkBuddy GUI(活登录态;Gateway 动态端口;模型 DeepSeek-V4.1)  │
│ keepalive.py(1 分钟巡检)+ mesh-guardian(三哨兵)              │
└─────────────────────────────────────────────────────────────┘
共享(SMB DshData)= 客户端运行权威源 + 双边数据总线
```

**前置条件**(缺一不可):
- [ ] 208:DSH 服务在跑(`systemctl --user is-active dreamx`),ANN 控制面在跑
- [ ] WinPC:WorkBuddy GUI **已登录**(20 天有效,`wb_ui_status` 可验)
- [ ] WinPC:能访问共享 `\\<共享IP>\DshData`
- [ ] 本包(server+client+docs)已就位

## 1. 全新部署(三站,按序)

### 1.1 站一:208 服务端(约 5 分钟)

```bash
# 1) 插件入 profile(幂等;已入则跳过)
cd <项目>/harness-mesh && bash deploy.sh        # 或发布包:server/harness-mesh/

# 2) 装依赖(建 node_modules 链接)
cd /root/.dreamx/profiles/web && pnpm install

# 3) 分离式重启(会断当前会话约 10 秒)
bash /tmp/hm-detached-restart.sh

# 4) 验证:服务起来了 + 插件激活
systemctl --user is-active dreamx
journalctl --user -u dreamx.service --since "-1min" | grep "harness-mesh.*已激活"
curl -s -c /tmp/jar -L -o /dev/null "http://127.0.0.1:80/?token=<token>"
curl -s -b /tmp/jar -X POST http://127.0.0.1:80/api/mcp/harness-mesh \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | grep -o '"contractVersion":"[^"]*"'
# 期望:hm-1
```

### 1.2 站二:ANN 网络(约 5 分钟)

> ANN(ann-ctrl + ann-agent)未随本包开源;等价物(tailscale/netbird/自建 WG)需满足的接口要求见
> `docs/部署参考/ANN-接口要求.md`。下面命令以作者实现的 ann-ctl 为例。

```bash
# 1) 208 侧控制面+agent(应已常驻;确认即可)
systemctl --user is-active ann-ctrl ann-agent-208

# 2) WinPC 入网:拿 bootstrap 码(208 上生成,一次性)
ann-ctrl node create --data-dir=$HOME/.local/share/ann-ctrl   # 输出码给 WinPC

# 3) WinPC:双击 启动绿模.vbs(无窗口)→ ann-agent 自动 bootstrap 入网
#    验证(208 上):
ann-ctrl node list --data-dir=$HOME/.local/share/ann-ctrl | grep <winpc主机名>
# 期望:有一条 online
```

### 1.3 站三:WinPC 客户端(约 10 分钟)

```bash
# 1) 绿模三件套到位(发布包 client/green/ → 运行目录;或直接用共享)
#    ann-agent.exe / harnessd_win.py / keepalive.py / 启动绿模.vbs

# 2) 适配器+配置到位(client/adapters/ + client/config/plugs.json)
#    共享即运行副本的做法:直接放 DshData/wb-green/,harnessd 从共享加载

# 3) 起 harnessd_win(:7080)并确认保活
#    keepalive 已设 1 分钟巡检;确认:
schtasks /Query /TN "harness-mesh-keepalive" /FO LIST | findstr State
# 期望:State=Ready

# 3b)(可选,推荐)harnessd 鉴权:7080 经 ANN 暴露,建议加 token
#     harnessd 侧:--token <同节点表的值> 或环境变量 HARNESSD_TOKEN
#     主控侧:节点表该节点加 "token":"<同值>"(见 1.4)
#     Linux 被控机可用 deploy/systemd/harnessd.service 直接托管(Env HARNESSD_TOKEN)

# 4) 验证插头在册(经 208 拨一次 hello):
#    我侧节点表先加两条(见 1.4),然后 dispatch 一个 PONG
```

### 1.4 站四:节点登记(208 上,2 分钟)

```bash
# exec 插头(派任务用)
curl -s -b /tmp/jar -X POST http://127.0.0.1:80/api/harness-mesh/nodes \
  -H 'Content-Type: application/json' -d '{"node":{
    "name":"<计算机名>-workbuddy","type":"acp-plug",
    "address":"<tailnet-IP>:7080","plugId":"workbuddy-exec",
    "socks":"127.0.0.1:11090",
    "description":"WinPC workbuddy(GUI Gateway B 架构)"}}'

# ui 插头(UI 操控用)
curl -s -b /tmp/jar -X POST http://127.0.0.1:80/api/harness-mesh/nodes \
  -H 'Content-Type: application/json' -d '{"node":{
    "name":"<计算机名>-wb-ui","type":"acp-plug",
    "address":"<tailnet-IP>:7080","plugId":"workbuddy-ui",
    "socks":"127.0.0.1:11090","description":"WinPC UI 操控口(行协议)"}}'
```
> tailnet-IP 以 `ann-ctrl node list` 的 online 那条为准(IP 会漂,以实测为准)。

## 2. 升级部署(只换变动的)

| 换什么 | 动作 | 要重启吗 |
|---|---|---|
| 适配器(wb-gateway-adapter/wb-ui.js) | 覆盖运行副本(共享) | **否**——每次 task.open 新 spawn,自动加载最新 |
| plugs.json | 覆盖运行副本 | **否**——plug.reload 或下次 spawn 生效 |
| harnessd_win | 覆盖+重启进程 | 是(keepalive 1 分钟内自拉;ANN 节点可能抖 ~50s,自愈) |
| keepalive/sentries | 覆盖 | 否(下个巡检周期生效) |
| **服务端插件**(lib/*) | 覆盖项目文件 → `bash deploy.sh` → `pnpm install` → 分离式重启 | **是**(约 10 秒断会话) |

**服务端升级纪律**(硬规则):
1. 插件 lib 文件只用 python 原地写,**禁用 sed -i**(pnpm 硬链接会被掰断,详见 master-plan §7.4.1)
2. `node --check` 不过**绝不** ln 进 node_modules(必须 `node --check X && ln -f X <nm>` 同链)
3. 重启先问、批量、优先热加载(适配器/hot.js/client.js 都是热的)

## 3. 部署后验收(必跑,5 分钟)

按 `docs/对齐运维/wb-ui-测试记录.md` 的 10 项跑 UI 层;任务层跑这三条:

```bash
# ① 跨机任务(期望 succeeded + 真回复)
harness_dispatch {"harness":"<节点>","prompt":"只回复 PONG","cwd":null}

# ② 开团(期望 all_done,双成员)
harness_team {"task":"一句话说明角色","members":[{"harness":"<节点>","role":"测试"}]}

# ③ UI 状态(期望 ok+model+engineBusy)
wb_ui_status {}
```

**全绿判据**:① succeeded 且 summary 是模型真回复(非 429/错误)② ③ ok:true。

## 4. 回滚

| 层 | 回滚法 |
|---|---|
| 适配器/plugs | 覆盖回上一版文件(共享里留副本;下次 spawn 生效) |
| harnessd_win | 覆盖回上一版+重启(keepalive 自拉) |
| 服务端插件 | git/备份覆盖 lib → deploy.sh → pnpm install → 重启 |
| 节点表 | nodes.json 删对应条目(GUI 或 API) |
| 全网最坏 | 停 ann-agent(节点下线,主控侧任务全部排队不死)+ 修好后重拉 |

## 5. 排错(症状→查什么)

| 症状 | 第一查 |
|---|---|
| dispatch 卡 queued 30s 失败 | 对端 harnessd 半死→重试;持续则看 keepalive 日志 |
| `unauthorized: token 缺失或不符` | 主控节点表漏配/配错 `token`;或对端 harnessd 没起 `--token`。两边同值即可 |
| `SOCKS5 拨号超时` | WG 隧道抖动→等 1 分钟自愈;持续看 ann-agent(DERP) |
| `未发现 gateway` | WorkBuddy GUI 没开→让本机用户开 GUI(gateway 是 GUI 本体) |
| summary 是 429 | 模型配额→等重置或 `wb_ui_model` 切换模型 |
| `unknown cmd` | 适配器版本旧→覆盖最新版(每次 spawn 自动加载) |
| wb_ui_* 返回 NOT_FOUND | 会话不存在或 CDP 撞用户操作→工具已带 5s 重试;仍失败核对 sessions 标题 |
| 改了不生效 | 硬链接被 sed -i 掰断→查 inode 一致性(master-plan §7.4.1) |
| 节点表地址失效 | IP 漂移→`ann-ctrl node list` 取新 IP 更新节点 |

## 6. 运维日历(日常)

| 频率 | 做什么 |
|---|---|
| 持续(自动) | 回归哨兵 20 分钟一探;掉线哨兵 1 分钟;监控 30s 采样 |
| 每天 | 看 `ops/alerts.log` 有无 [回归异常];看对齐表有无新 ✗ |
| 每次变更 | 改完记 `_对齐/changelog.md`;涉及共享文件跑 `check_alignment.py` |
| 每月 | `bash releases/build-release.sh` 重新生成发布包(防漂移) |

## 7. 客户端程序 git 纪律(多 harness 共享资产)

`DshData/wb-green/` 是 git 仓库(2026-10-17 初始化,47 文件)。**所有客户端侧改动(plugs.json/适配器/脚本/文档)改完必须 commit**:

```bash
cd DshData/wb-green
git status          # 看改了啥
git add -A && git commit -m "<改了什么,例:zcode-exec plug added>"
git log --oneline   # 看历史
```

- 冲突:主控侧与 WinPC 侧都可能提交,**冲突时先在频道说,别强行 merge**
- 已配 .gitignore(二进制/日志/ann-data/调试残留)和 .gitattributes(*.bat/*.vbs/*.ps1=CRLF,*.py/*.js/*.json/*.md=LF)——提交前不用手动修行尾
- 二进制(ann-agent.exe)不入库,随发布包传递

## 8. 联系人/职责

- **本机用户**:GUI 登录态唯一人工门(20 天一次)、CDP 冲突时的操作避让
- **workbuddy 侧**:适配器/wb-ui/harnessd_win/保活的开发与排错
- **主控侧(我)**:插件/节点表/工具/监测/对齐/发布包
