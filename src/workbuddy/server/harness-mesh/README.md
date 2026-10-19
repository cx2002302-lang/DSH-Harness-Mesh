# @agents/harness-mesh

Harness 组网系统的 DSH 主控插件(方案见 `../../harness-mesh-plan.md`)。

## 现状(M1 已交付,2026-10-12)

- 5 工具:`harness_list` / `harness_dispatch` / `harness_status` / `harness_cancel` / `harness_result`
- 适配器:`acp-stdio`(本机 ACP,惰性 spawn + 常驻复用);`acp-ssh`/`cli-oneshot` 待 M4/M5
- 任务状态机:queued → running → succeeded/failed/cancelled/timeout;注册表 `$DSH_HOME/harness-mesh/tasks.jsonl`
- 人在环:deny 清单(内置 rm -rf / git push / sudo 等,dispatch 可追加)命中 → `dsh-user-approval` 弹窗问你;未命中自动放行
- 已实测:真实 opencode 端到端派活(建文件、跑命令)、进度事件流、结构化汇报(结论文本 + 文件变更)、权限审批链路

## 验证

```bash
node test/e2e-dispatch.mjs    # 端到端:真实 opencode 建文件 + 汇报
node test/e2e-permission.mjs  # 权限链:deny 命中 → approval → 放行
```

## 节点配置示例

```yaml
- id: harness-mesh
  config:
    defaultTimeoutMs: 600000
    harnesses:
      opencode-local:
        type: acp-stdio        # 本机 spawn `opencode acp`
        command: opencode
        args: ["acp"]
      kimi-206:
        type: acp-ssh          # 跨机:ssh 隧道跑 `kimi acp`
        ssh: myxia@192.168.11.206
        command: kimi
        args: ["acp"]
      workbuddy-234:
        type: cli-oneshot      # 兜底:无 ACP 的 harness 走 CLI 一次性
        ssh: myxia@192.168.9.234
        command: codebuddy
        args: ["-p", "{prompt}"]
```

## 安装 / 卸载

安装:profile `package.json` 的 `dependencies` 加
`"@agents/harness-mesh": "file:/root/data/myagents/DSH_PiDurable/harness-mesh"`,
`dsh.profile.bundles` 加 `"@agents/harness-mesh"`,profile 目录 `pnpm install`,
再 `systemctl --user restart dreamx`。

卸载:删上述两行 + patch 配置段,`pnpm install`,重启。

## 路线图

M2 send(会话续跑)+ UI 进度条;M3 kimi;M4 跨机 SSH + zcode;M5 workbuddy 兜底 + 可选 MCP 导出。
已知欠账:M1 的 summary 只取 agent_message_chunk 累积文本,agent 只调工具不出文本时会空(M2 补 tool 输出兜底)。
