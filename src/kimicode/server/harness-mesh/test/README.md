# 适配器协议层回归测试(mock gateway)

用途:任何"ACP 向上"的适配器(workbuddy gateway 适配器、未来的 daemon 适配器)
在真下行端点就绪前,先用本 mock 验证协议层与主控生产管道的互通。

## 用法

```bash
# 1. 起 mock gateway(9999)
python3 test/mock-gateway.py &
# 2. plugs 里加插头(以 workbuddy 适配器为例):
#    {"plugId":"wb-adapter","kind":"acp","command":"python3",
#     "args":["<适配器路径>"],"env":{"GATEWAY_URL":"http://127.0.0.1:9999"}}
# 3. 重启 harnessd + 登记 acp-plug 节点 + dispatch
# 4. 预期:succeeded,summary 含 "mock-gateway 收到:..."
```

## 已验证记录

- 2026-10-16 23:30 wb-gateway-adapter.py v0.1 全链通过(succeeded 2.3s,
  prompt 终态 response 时序正确,session/update 回传正确)
- mock 端点形状按适配器 TODO 假设:POST /api/runs / POST /api/runs/{id}/messages /
  GET /api/runs/{id} / POST /api/runs/{id}/cancel
