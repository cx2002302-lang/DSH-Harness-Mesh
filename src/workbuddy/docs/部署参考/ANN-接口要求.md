# ANN 网络层接口要求(harnessd / harness-mesh 依赖什么)

> 背景:harness-mesh 的跨机组网依赖一层 overlay 网络(作者实现叫 ANN:ann-ctrl 控制面 + ann-agent 客户端,
> WireGuard tailnet)。**该组件未随本发布包开源**;本文把 harnessd 与主控插件对它的最小要求写清楚,
> 便于用 tailscale / netbird / 自建 WireGuard 等任何等价物替代。

## 1. 必须提供的能力

| 能力 | 消费者 | 要求 |
|---|---|---|
| 被控机有 overlay IP(tailnet,如 100.64/10) | 主控 `nodes.json` 的 `address` | 被控机入网后 IP 可见(控制面 `node list` 能查到 online 状态) |
| 端口转发:overlay:7080 → 被控机 127.0.0.1:7080 | 主控拨 harnessd | 作者用 `ann-agent.exe run --forward 7080=127.0.0.1:7080`;等价物可用 WG 配置或 socat/ssh -L |
| 本机 SOCKS5 代理(如 127.0.0.1:11090) | 主控 `node.socks`(零 root 兜底) | 无 TUN 权限时,主控经它拨 overlay IP;有 TUN 时可省略该字段 |
| 环境变量 `ANN_NODE_IP` 注入被控机 | harnessd 自报(hello 的 `ann_addr`) | 让主控侧知道被控机的 overlay IP;没有就报 null,不影响功能 |
| 一次性入网凭证(bootstrap 码) | 运维 | 控制面签发,被控机凭码入网;具体流程由所用方案决定 |

## 2. harnessd 侧对网络的假设(就这些)

- 只监听 `127.0.0.1:7080`(默认),暴露面完全交给 overlay 转发层——**不要把 7080 直接绑 0.0.0.0**。
- 建议同时开启 harnessd 鉴权(`--token`/`HARNESSD_TOKEN`,主控节点表配同值 `token`),overlay 内也多一层。
- 不需要 ANN 提供任何应用层 API;hello/plug.list/task.open 等全是 harnessd 自己的插头协议。

## 3. 替代方案对照(任选其一)

| 方案 | 端口转发 | SOCKS5 兜底 | 备注 |
|---|---|---|---|
| Tailscale | `tailscale serve` / ACL | tailscaled 自带(socks5 1080 附近端口) | 最省事;注意 tailnet IP 会变,节点表以实测为准 |
| Netbird | 需自建转发 | 无内置,可用 ssh -D | 纯 WG userspace |
| 自建 WireGuard + socat | `socat TCP-LISTEN:7080,fork TCP:127.0.0.1:7080` | `ssh -D 11090 user@被控机` | 零依赖兜底 |

## 4. 排错

| 症状 | 第一查 |
|---|---|
| `SOCKS5 拨号超时` | WG 首次握手未完成→等 1 分钟自愈;持续看 agent 日志(DERP 中继是否兜住) |
| `插头会话建立超时(30s)` | overlay 通但 harnessd 半死→看重启/keepalive 日志 |
| 节点表地址失效 | overlay IP 漂移→控制面 `node list` 取新 IP,更新 nodes.json |
