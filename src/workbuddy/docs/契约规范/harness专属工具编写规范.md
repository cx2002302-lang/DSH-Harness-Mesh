# harness 专属工具编写规范

> 2026-10-17 · 管两件事:① 哪些功能做公用工具、哪些做 harness 专属工具;② 专属工具怎么写、放哪、怎么生效。
> 目标:新增一个 harness 的专属工具 = 30 分钟填空题,不碰公用层、不重启、不污染其他 harness 的上下文。

---

## 1. 公用 vs 专属:划分原则

| 类别 | 定义 | 例子 |
|---|---|---|
| **公用工具**(`harness_*`) | 对所有 harness 语义相同的编排动作 | list/dispatch/status/result/cancel/team/team_result/tasks/session/help |
| **harness 专属工具**(`<prefix>_*`) | 只有某个 harness 才有、或只有它那么用的能力 | wb_info(workbuddy 节点档案)、未来的 wb_gateway_status、kimi_models |

**判断法**:删掉这个 harness,工具还对其他 harness 有意义吗?有意义→公用;没意义→专属。**专属工具永远不进公用工具表**——客户端默认看不到,只有主动 `harness_tools {harness}` 才披露(渐进披露,省 context、防幻觉)。

## 2. 命名规则

- 格式:`<prefix>_<verb>`,prefix 全小写、2-4 字母,在注册表里登记后专用
- 现有 prefix:`wb_`(workbuddy)/ `kimi_`(kimi)/ `zc_`(zcode)/ `oc_`(opencode)/ `dsh_`(dsh)
- verb 用现有词汇表:`info`(档案)/ `status`(状态)/ `list`(列表)/ `models`(模型)/ `runs`(运行)/ `config`(配置)——**不要发明新动词**
- 禁止:与公用 `harness_*` 撞名;跨 harness 用别人的 prefix

## 3. 文件位置与导出契约

```
harness-mesh/lib/harness-tools/
├── index.js          # 注册表(harness → URL + prefix)+ 加载/路由框架,**新 harness 只加一行**
├── workbuddy.js      # 每个 harness 一个文件,零依赖(只用 node 内置 + ctx 传入的 mesh/nodes)
├── kimi.js / zcode.js / opencode.js / dsh.js   # 暂缺文件=该 harness 暂无专属工具,框架返回 null,不报错
```

每个 harness 文件导出两样(缺一不可):

```js
export const tools = [
  {
    name: "wb_info",                    // <prefix>_<verb>
    description: "一句话说清干嘛",        // 会进 harness_tools 的披露,保持短
    inputSchema: { type: "object", properties: { ... } },  // JSON Schema,和 MCP 工具同规格
    doc: "完整用法:参数逐个解释 + 什么时候用 + 返回什么 + 常见错误", // 渐进披露的重内容放这,别堆在 description
  },
];

export const handlers = {
  wb_info: async (args, ctx) => {
    // ctx = { mesh, nodes }
    //   nodes.list()/nodes.get(name)   节点表(只读)
    //   mesh.store.list()/get/countRunning   任务注册表(只读)
    //   mesh.dispatch({...})           派活(需要执行体干活时用这个,别自己 spawn)
    //   mesh.adapters.get(name)        适配器实例(alive 状态)
    // 返回:纯对象(会被 JSON 序列化回调用方);出错返回 {error: "..."} 或 throw
    return { ... };
  },
};
```

## 4. 编写步骤(新 harness 专属工具,30 分钟)

1. **登记**:`index.js` 的 REGISTRY 加一行 `{ url: new URL("./<harness>.js", import.meta.url), prefix: "<xx>_" }`
2. **建文件**:照上面契约写 `tools` + `handlers`;**只用 python 原地写**(见 §6)
3. **自测**:
   ```bash
   node --check lib/harness-tools/<harness>.js
   # 披露:MCP tools/call harness_tools {"harness":"<harness>"} 应看到新工具
   # 直调:MCP tools/call <prefix>_<verb> {...} 应返回预期
   ```
4. **同步**:`ln -f lib/harness-tools/<harness>.js /root/.dreamx/profiles/web/node_modules/@agents/harness-mesh/lib/harness-tools/<harness>.js`(硬链接,见 §6)
5. **文档**:客户端指南不用动(harness_tools 是自描述的);在服务端管理指南记一笔该 harness 有哪些专属工具

## 5. 渐进披露是怎么运转的(写工具前先理解)

```
客户端 tools/list          → 只见 6 个公用短定义(list/dispatch/status/result/cancel/help/tools)
客户端想用专属能力          → harness_tools {"harness":"workbuddy"}
                           → 披露 wb_info 的完整 schema + doc(此时才进上下文)
客户端调用                  → tools/call wb_info {...} → 路由到 workbuddy.js 的 handler
```
推论:**description 写短、doc 写全**——description 每次会话都背,doc 只在用时拉。专属工具天然只有目标 harness 的用户会拉,别人的 context 零负担。

## 6. 热加载与同步纪律(踩过的坑,必读)

- 框架按**文件 mtime 缓存破坏**动态 import:改 `<harness>.js` 保存即生效,**零重启**。
- 但 profile 的 `file:` 依赖是 **pnpm 硬链接农场**:python `open(p,'w')` 原地写,硬链接同 inode,自动同步;**`sed -i` 会临时文件+重命名掰断硬链接**,之后改动不生效且无报错。
- **纪律**:① 插件 lib 下所有文件只用 python 原地写,禁用 sed -i;② 新文件首次部署后 `ln -f` 建硬链接;③ 存疑时查 inode 是否一致(master-plan §7.4.1)。

## 7. 已落地示例(照抄这个改)

`lib/harness-tools/workbuddy.js` 的 `wb_info`:读节点档案+健康+最近任务,不依赖 Gateway 直连,任何时候可调——**“档案类”专属工具的首选形态**。Gateway 直连类(wb_gateway_status/wb_runs)等 v5 适配器落地后,按同一契约补,handler 里经 `mesh.dispatch` 或适配器实例取数,**不要自己 spawn 进程**。

## 8. 上线前检查单

- [ ] `node --check` 过;harness_tools 能披露;直接调返回预期
- [ ] 工具名符合 `<prefix>_<verb>`,没撞公用名
- [ ] description 一句话,doc 写全(参数/时机/返回/常见错误)
- [ ] handler 只用 ctx 提供的 mesh/nodes,不 import 插件内部模块、不 spawn
- [ ] 硬链接已建(inode 一致),禁用过 sed -i
- [ ] 服务端管理指南记一笔
