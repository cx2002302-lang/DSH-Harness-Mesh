# wb-ui 命令验收测试记录

> 被测方：WinPC 侧 wb-ui（`plugId=wb-ui`）| 测试方：主控侧 DSH
> 开始：2026-10-17 13:56 | 记录人：WorkBuddy 侧（崧子）
> 说明：DSH 每测完一项，在频道报结果（①命令 ②入参 ③返回 ④PASS/FAIL），我同步记入本表。

## 测试前置

- [ ] WorkBuddy 带 `--remote-debugging-port=9222` 启动（当前已启用）
- [ ] harnessd_win 在 7080 监听（当前 ✓）
- [ ] wb-ui 插头已在 hello 中可见（当前 ✓）
- [ ] **单拨号方**：测试期间我方不再主动拨号（避免引擎排队干扰）

## 测试清单（9 项）

| # | 命令 | 建议入参 | 预期结果 | 实测结果 | 判定 |
|---|---|---|---|---|---|
| 1 | `status` | 无 | `ok:true` + model/sessions/hasInput/engineBusy | | ⬜ |
| 2 | `sessions` | 无 | `ok:true` + 会话数组（≥1） | | ⬜ |
| 3 | `screenshot` | `{"out":"C:\\wb-mesh\\dsh_shot.png"}` | `ok:true` + path + bytes>10000 | | ⬜ |
| 4 | `model`（读） | 无 set | `ok:true` + model=Deepseek-V4.1-Flash | | ⬜ |
| 5 | `model`（写） | `{"set":"Deepseek-V4.1-Flash"}` | `ok:true` + current=Deepseek-V4.1-Flash | | ⬜ |
| 6 | `new-session` | `{"model":"Deepseek-V4.1-Flash"}` | `action:"CTRL_N"` + modelSwitched | | ⬜ |
| 7 | `switch-session` | `{"name":"联机测试"}` | `action:"CLICKED"` + selected=联机测试 | | ⬜ |
| 8 | `rename` | `{"name":"联机测试","newName":"联机测试-rename"}` | `action:"RENAME_ATTEMPTED"` | | ⬜ |
| 9 | `delete-session`（dry-run） | `{"name":"联机测试-rename"}` | `action:"MENU"` + menuItems 含"删除任务" | | ⬜ |
| 10 | `send`（API 版） | `{"text":"只回复 SEND-OK"}` | `ok:true` + status:completed + text 含 SEND-OK | | ⬜ |

> 注：#9 只测 dry-run（不传 confirm:true），不真删，避免误删生产会话。
> #10 会真起一轮 run（烧一轮配额），如不想烧可跳过，标 SKIP。

## 结果记录区

（DSH 报结果后逐条填入）

| 时间 | # | 命令 | 返回摘要 | 判定 |
|---|---|---|---|---|
| 14:41 | 1-7 | status/sessions/screenshot/model读写/new-session/switch-session | DSH 报告全过 | ✅ PASS |
| 14:41 | 9 | delete-session（dry-run） | DSH 重测后过（MENU，不真删） | ✅ PASS |
| 14:41 | 10 | send（API 版） | SEND-OK，4 秒返回 | ✅ PASS |
| 14:41 | 8 | **rename** | `unknown cmd: rename`（**我方部署缺失，非 DSH 问题**） | ❌ FAIL |
| 15:20 | 8 | **rename（修复后）** | 我方实测：`{"action":"RENAME_ATTEMPTED","filled":"FILLED:INPUT"}`，sessions 显示改名生效后已改回 | ✅ **PASS** |

**修复说明（#8）**：
- 根因：13:53 声明加了 rename，但后续改 send 时用脚本替换误删了整段，运行实例里没有该 handler。
- 修复：重新实现 + 放宽菜单扫描（菜单项含图标不是叶子节点）+ 填充优先弹窗 `input[type=text]`（原先误填主对话输入框）。
- 已部署到 `C:\wb-mesh\wb-ui.js` 并同步共享，实测端到端通过（改名→验证→改回）。

**结论：10/10 全过（#8 待 DSH 复测确认）**

---

## 最终验收（2026-10-17 14:50 DSH 复测 + 15:13 全量终验）

**#8 rename 复测：PASS**（DSH 实证）：
```
rename 回归探针测试 → 回归探针测试-rn
→ {ok:true, action:"RENAME_ATTEMPTED", filled:"FILLED:INPUT", sessions:[{title:"回归探针测试-rn"}]}
→ 已改回原名（现场还原）
```
> 过程如实记录：第一次复测撞上管道层 30s 建立超时（间歇层老毛病，非 rename 问题），重试一次即过。

### 10/10 验收表（DSH 最终确认）

| # | 命令 | 判定 |
|---|---|---|
| 1 | status（全字段 + engineBusy） | PASS |
| 2 | sessions（30 个） | PASS |
| 3 | screenshot（246KB） | PASS |
| 4 | model 读 | PASS |
| 5 | model 写（CLICKED） | PASS |
| 6 | new-session（CTRL_N + 切模型） | PASS |
| 7 | switch-session（CLICKED + selected） | PASS |
| 8 | **rename（RENAME_ATTEMPTED + 标题变化）** | **PASS（复测）** |
| 9 | delete-session（dry-run MENU） | PASS |
| 10 | send API 版（SEND-OK，4s） | PASS |

### 全量终验（15:13 DSH 三连）

| 终验 | 结果 |
|---|---|
| 跨机任务 | `succeeded`，summary=**ALL-GREEN**，6.6 秒（真模型，零 429） |
| UI status | `ok:true, model=Deepseek-V4.1-Flash, engineBusy=false` |
| 四哨兵 | 监控/回归/plugs/掉线 全在岗 |

### 遗留（不阻塞，DSH 已记账）
1. **管道间歇层**（WG 抖动/冷启动）约 60-70% 成功率，失败有界（30s/10min）+ 重试可过——属网络层可接受损耗
2. admin MCP 入口 + /session REST 路由待一次重启激活
3. delete 真删路径未标定（dry-run 已够用，不追）

**最终结论：全部通过。UI 操控层正式闭环。**

## 已知坑（测试时注意）

1. **`name` 参数**：会话类命令用 `name`（不是 title/session），内容需能匹配会话卡片文本（模糊包含即可）。
2. **`text` 参数**：send 用 `text`（不是 content/message）。
3. **引擎忙**：`status.engineBusy=true` 时新任务会排队，`send` 耗时可能 30-60s，**属正常**。
4. **send 会附会话**：任务进 WorkBuddy 当前会话，带上下文，这是设计如此。
5. **delete 默认 dry-run**：不传 `confirm:true` 只开菜单，零副作用。
