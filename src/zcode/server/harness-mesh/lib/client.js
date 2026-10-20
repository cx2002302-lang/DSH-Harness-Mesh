/** harness-mesh 客户端半身:dsh 客户端插件(模块加载器 + slots 注册)。
 *
 *  形状照 @dreamx/ui-dreamx(官方 voice-input 同款):
 *    window.__ModuleLoader__.load({id, factory}) → {apply, inject}
 *
 *  三块 UI:
 *    1) composer 工具栏左侧圆形图标(activity slot,风格跟随 +/盾牌)
 *       → 开关「Harness 控制台」悬浮面板;
 *    2) 控制台面板(overlay slot,悬浮在 composer 卡片上方):
 *       - 控制台 tab:节点选择 + 派发表单 + 任务卡片(2s 轮询,权限挂起时渲染允许/拒绝);
 *       - 节点 tab:节点 CRUD + AI 生成配置(自然语言→草案→表单预填→确认保存);
 *    3) @ 召唤(input-trigger source):composer 里 @ 选节点,整行以 @节点 开头时
 *       matchEnter claim 提交 → 客户端直连 /api 派发(绕开主 LLM,零主模型消耗),
 *       派发后自动打开面板展示任务。
 *
 *  服务端通信:同源 fetch /api/harness-mesh/*(lib/http.js 注册)。
 */
window.__ModuleLoader__.load({
  id: "@agents/harness-mesh",
  factory: (require) => {
    const React = require("react");
    const inject = ["slots", "inputTriggers"];

    // ==================== 模块级 store(图标与面板跨 slot 共享状态) ====================
    const initial = {
      open: false,           // 配置悬浮页
      menuOpen: false,       // 图标小菜单
      enabled: (() => { try { return globalThis.localStorage?.getItem("harness-mesh.enabled") !== "0"; } catch { return true; } })(),
      tab: "console",        // console | nodes
      nodes: [],             // [{name,type,target,command,description,health,running,...}]
      tasks: [],             // 最近任务(列表态)
      active: {},            // task_id → 详细状态(进度/挂起权限)
      err: null,
      notice: null,
      form: { harness: "", prompt: "", deny: "", timeout: "", model: "", team: false, members: [] },
      editing: null,         // null | "new" | 节点对象
      aiText: "",
      aiBusy: false,
      receipts: [],          // 完成回执卡(自动淡出)
      anchorRect: null,      // 图标矩形(fixed 定位锚,规避父级裁剪)
    };
    const saveEnabled = (v) => { try { globalThis.localStorage?.setItem("harness-mesh.enabled", v ? "1" : "0"); } catch { /* 无 localStorage 环境 */ } };
    let state = initial;
    const listeners = new Set();
    const store = {
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      getSnapshot() { return state; },
      set(patch) { state = { ...state, ...patch }; for (const l of listeners) l(); },
    };
    const useStore = () => React.useSyncExternalStore(store.subscribe, store.getSnapshot);

    // ==================== 完成回执(任务终态 → 悬浮回执卡) ====================
    const TERMINAL_STATES = new Set(["succeeded", "failed", "timeout", "cancelled"]);
    const watched = new Map(); // task_id → 轮询定时器
    function pushReceipt(rcpt) {
      store.set({ receipts: [...(state.receipts ?? []), rcpt].slice(-5) });
      setTimeout(() => {
        store.set({ receipts: (state.receipts ?? []).filter((x) => x.id !== rcpt.id) });
      }, 20000);
    }
    /** 派发成功后开始盯一个任务;到终态弹回执卡。面板开着有 2s 轮询,这里独立于面板工作。 */
    function watchTask(taskId) {
      if (watched.has(taskId)) return;
      const startedAt = Date.now();
      const timer = setInterval(async () => {
        try {
          const { status } = await api.task(taskId);
          if (TERMINAL_STATES.has(status.state)) {
            clearInterval(timer); watched.delete(taskId);
            const r = status.result ?? {};
            pushReceipt({
              id: taskId, harness: status.harness, state: status.state,
              summary: r.summary || status.error || "(无汇报文本)",
              changes: r.changes ?? [],
            });
          } else if (Date.now() - startedAt > (status.timeout_ms ?? 600000) + 60000) {
            clearInterval(timer); watched.delete(taskId); // 兜底退出
          }
        } catch { /* 网络抖动:下个周期重试 */ }
      }, 2500);
      watched.set(taskId, timer);
    }

    // ==================== API ====================
    const jsonHeaders = { "content-type": "application/json" };
    const call = async (path, options) => {
      const res = await fetch(path, options);
      let data = {};
      try { data = await res.json(); } catch { /* 非 JSON */ }
      if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    };
    const api = {
      loadNodes: () => call("/api/harness-mesh/nodes"),
      saveNode: (node) => call("/api/harness-mesh/nodes", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ node }) }),
      // 探测节点可用模型:正式端点(重启后)→ 老实例 shim(热加载即有)
      probeModels: async (name) => {
        try { return await call("/api/harness-mesh/probe-models", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ name }) }); }
        catch { return await call(`/api/harness-mesh/nodes?probeModels=${encodeURIComponent(name)}`); }
      },
      removeNode: (name) => call(`/api/harness-mesh/node?name=${encodeURIComponent(name)}`, { method: "DELETE" }),
      dispatch: (body) => call("/api/harness-mesh/dispatch", { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) }),
      team: (body) => call("/api/harness-mesh/team", { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) }),
      task: (id) => call(`/api/harness-mesh/task?task_id=${encodeURIComponent(id)}`),
      tasks: () => call("/api/harness-mesh/tasks"),
      cancel: (id) => call("/api/harness-mesh/cancel", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ task_id: id }) }),
      permission: (id, allow) => call("/api/harness-mesh/permission", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ task_id: id, allow }) }),
      aiConfig: (description) => call("/api/harness-mesh/ai-config", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ description }) }),
    };

    const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timeout"]);

    async function refreshNodes() {
      try { store.set({ nodes: (await api.loadNodes()).nodes ?? [] }); }
      catch (error) { store.set({ err: String(error?.message ?? error) }); }
    }
    async function refreshTasks() {
      try {
        const { tasks } = await api.tasks();
        const active = { ...state.active };
        const live = tasks.filter((t) => !TERMINAL.has(t.state));
        await Promise.all(live.map(async (t) => {
          try {
            const { status, result } = await api.task(t.task_id);
            active[t.task_id] = { ...status, result };
          } catch { /* 单任务查询失败不阻塞列表 */ }
        }));
        for (const t of tasks) {
          if (TERMINAL.has(t.state) && !active[t.task_id]) {
            try {
              const { status, result } = await api.task(t.task_id);
              active[t.task_id] = { ...status, result };
            } catch { /* 忽略 */ }
          }
        }
        store.set({ tasks, active });
      } catch (error) { store.set({ err: String(error?.message ?? error) }); }
    }
    async function refreshAll() {
      await Promise.all([refreshNodes(), refreshTasks()]);
    }

    // ==================== 样式常量 ====================
    const C = {
      panel: {
        position: "fixed", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
        width: "min(880px, 94vw)", height: "min(72vh, 640px)",
        display: "flex", flexDirection: "column",
        background: "var(--dsw-alias-bg-float, rgba(30,30,32,.92))",
        color: "var(--dsw-alias-text-primary, inherit)",
        border: "1px solid var(--dsw-alias-border, rgba(128,128,128,.35))",
        borderRadius: 14, boxShadow: "0 18px 60px rgba(0,0,0,.45)",
        backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)",
        zIndex: 9999, overflow: "hidden", fontSize: 13, lineHeight: 1.6,
      },
      scrim: {
        position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", zIndex: 9998,
      },
      head: { display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", borderBottom: "1px solid rgba(128,128,128,.2)" },
      menu: {
        position: "fixed", width: 232, display: "flex", flexDirection: "column",
        background: "var(--dsw-alias-bg-float, rgba(30,30,32,.92))",
        color: "var(--dsw-alias-text-primary, inherit)",
        border: "1px solid var(--dsw-alias-border, rgba(128,128,128,.35))",
        borderRadius: 12, boxShadow: "0 12px 40px rgba(0,0,0,.35)",
        backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)",
        zIndex: 9999, overflow: "hidden", fontSize: 12, lineHeight: 1.6,
      },
      tab: (on) => ({
        padding: "6px 18px", borderRadius: 8, cursor: "pointer", border: "none",
        background: on ? "rgba(128,128,128,.22)" : "transparent", color: "inherit",
        fontWeight: on ? 600 : 400, fontSize: 13,
      }),
      body: { padding: 14, overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 8 },
      input: { width: "100%", boxSizing: "border-box", fontSize: 13, padding: "6px 9px", borderRadius: 7, border: "1px solid rgba(128,128,128,.4)", background: "transparent", color: "inherit" },
      btn: { fontSize: 12, padding: "4px 12px", borderRadius: 6, border: "1px solid rgba(128,128,128,.4)", background: "transparent", color: "inherit", cursor: "pointer" },
      btnPrimary: { fontSize: 12, padding: "5px 14px", borderRadius: 6, border: "1px solid rgba(128,128,128,.4)", background: "rgba(128,128,128,.25)", color: "inherit", cursor: "pointer", fontWeight: 600 },
      row: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, padding: "4px 0", borderBottom: "1px solid rgba(128,128,128,.14)" },
      card: { border: "1px solid rgba(128,128,128,.25)", borderRadius: 9, padding: "7px 9px" },
      iconBtn: {
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 26, height: 26, borderRadius: "50%", padding: 0,
        border: "1px solid rgba(128,128,128,.35)", background: "transparent",
        color: "inherit", cursor: "pointer", flex: "none",
      },
    };
    const stateColor = (s) => s === "running" || s === "queued" ? "#4fc3f7" : s === "succeeded" ? "#7bc86c" : s === "timeout" ? "#e5c07b" : "#e5534b";
    const stateText = (s) => ({ queued: "排队中", running: "运行中", succeeded: "已完成", failed: "失败", cancelled: "已取消", timeout: "超时", cancelling: "取消中" }[s] ?? s);

    // ==================== 圆形图标(activity slot) ====================
    const MESH_SVG = React.createElement(
      "svg", { viewBox: "0 0 16 16", width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", "aria-hidden": true },
      React.createElement("circle", { cx: 8, cy: 3.2, r: 1.7 }),
      React.createElement("circle", { cx: 3.4, cy: 12, r: 1.7 }),
      React.createElement("circle", { cx: 12.6, cy: 12, r: 1.7 }),
      React.createElement("path", { d: "M6.7 4.5 4.7 10.5M9.3 4.5l2 6M5.1 12h5.8" }),
    );
    function MeshIcon() {
      const s = useStore();
      const click = (event) => {
        const menuOpen = !(s.menuOpen || s.open);
        const r = event?.currentTarget?.getBoundingClientRect?.();
        console.log("[harness-mesh] 图标点击 → menu=", menuOpen, r ? `锚点(${Math.round(r.left)},${Math.round(r.top)})` : "");
        store.set({
          menuOpen,
          open: false,           // 图标只管小菜单;悬浮配置页由菜单里"设置"打开
          err: null,
          notice: null,
          anchorRect: r ? { left: r.left, top: r.top, right: r.right } : null,
        });
      };
      const activeAccent = "#4da3ff";
      const color = s.enabled ? activeAccent : "rgba(140,140,140,.75)";   // 关=灰,开=蓝
      const engaged = s.menuOpen || s.open;
      return React.createElement("button", {
        type: "button",
        title: `Harness 组网 · ${s.enabled ? "@ 召唤开启中" : "已停用"}(点击菜单)`,
        "aria-label": "Harness 组网菜单", onClick: click,
        style: {
          ...C.iconBtn, color,
          borderColor: engaged ? activeAccent : "rgba(128,128,128,.35)",
          background: engaged ? "rgba(77,163,255,.14)" : "transparent",
        },
      }, MESH_SVG);
    }

    /** 滑动开关。 */
    function Toggle({ on, onChange }) {
      return React.createElement("div", {
        role: "switch", "aria-checked": on, tabIndex: 0,
        onClick: () => onChange(!on),
        onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onChange(!on); } },
        style: {
          width: 34, height: 19, borderRadius: 10, cursor: "pointer", flexShrink: 0, position: "relative",
          background: on ? "#4da3ff" : "rgba(128,128,128,.35)",
          transition: "background .15s", outline: "none",
        },
      }, React.createElement("div", {
        style: {
          position: "absolute", top: 2.5, left: on ? 17.5 : 2.5,
          width: 14, height: 14, borderRadius: "50%", background: "#fff",
          transition: "left .15s", boxShadow: "0 1px 3px rgba(0,0,0,.35)",
        },
      }));
    }

    /** 图标小菜单:开关 + 任务入口 + 配置入口。 */
    function IconMenu() {
      const s = useStore();
      if (!s.menuOpen || s.open) return null;
      // 向上展开(bottom 锚定=原始正确方向;老徐 10-18 反馈)
      const r = s.anchorRect;
      const vw = (typeof window !== "undefined" && window.innerWidth) || 1280;
      const vh = (typeof window !== "undefined" && window.innerHeight) || 800;
      const pos = r
        ? { left: Math.max(8, Math.min(r.left, vw - 246)), bottom: Math.max(8, vh - r.top + 10) }
        : { left: 16, bottom: 130 };
      const openView = (tab, label) => {
        console.log("[harness-mesh] 菜单 →", label);
        store.set({ menuOpen: false, open: true, tab });
        void refreshAll();
      };
      const item = { width: "100%", border: "none", background: "transparent", textAlign: "left", padding: "9px 12px", fontSize: 12, fontWeight: 600, borderRadius: 0, color: "inherit", cursor: "pointer" };
      return React.createElement("div", { style: { ...C.menu, ...pos }, role: "menu", "aria-label": "Harness 菜单" },
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "10px 12px" } },
          React.createElement("div", { style: { marginRight: "auto" } },
            React.createElement("div", { style: { fontWeight: 600 } }, "@ 召唤"),
            React.createElement("div", { style: { opacity: .6, fontSize: 11 } }, s.enabled ? "聊天框 @ 直达被控节点" : "已停用,开启后可用"),
          ),
          React.createElement(Toggle, {
            on: s.enabled,
            onChange: (v) => { saveEnabled(v); store.set({ enabled: v }); console.log("[harness-mesh] @ 召唤开关 →", v); },
          }),
        ),
        React.createElement("div", { style: { borderTop: "1px solid rgba(128,128,128,.2)" } },
          React.createElement("button", { style: item, onClick: () => openView("console", "任务") }, "📋 任务 · 派发与进度"),
        ),
        React.createElement("div", { style: { borderTop: "1px solid rgba(128,128,128,.14)" } },
          React.createElement("button", { style: item, onClick: () => openView("nodes", "配置") }, "⚙ 配置 · 节点管理"),
        ),
        // 最底行:📋 项目管理(原输入栏 project-hub 图标并入此处,老徐 10-18 定位置;
        // 转派=程序化点击 project-hub 图标按钮,其面板/状态逻辑仍归它自己)
        React.createElement("div", { style: { borderTop: "1px solid rgba(128,128,128,.14)" } },
          React.createElement("button", { style: item, onClick: () => {
            document.querySelector('button[aria-label="项目管理面板"]')?.click();
            store.set({ menuOpen: false });
          } }, "📋 项目管理 · 驾驶舱"),
        ),
      );
    }

    // ==================== 任务卡片 ====================
    function TaskCard({ task }) {
      const detail = state.active[task.task_id];
      const st = detail?.state ?? task.state;
      const perm = detail?.pending_permission ?? null;
      const result = detail?.result ?? null;
      return React.createElement("div", { key: task.task_id, style: C.card },
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 } },
          React.createElement("span", { style: { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, `${task.harness} · ${task.task_id.slice(-8)}`),
          React.createElement("span", { style: { color: stateColor(st), flex: "none" } }, stateText(st)),
        ),
        React.createElement("div", { style: { opacity: .7, margin: "2px 0", wordBreak: "break-all" }, title: task.prompt }, task.prompt.length > 80 ? `${task.prompt.slice(0, 80)}…` : task.prompt),
        detail?.progress?.length
          ? React.createElement("div", { style: { opacity: .55, fontSize: 11 } }, `最近:${detail.progress.at(-1).kind}${detail.progress.at(-1).title ? ` — ${String(detail.progress.at(-1).title).slice(0, 50)}` : ""}`)
          : null,
        perm
          ? React.createElement("div", { style: { marginTop: 5, padding: "5px 7px", borderRadius: 7, background: "rgba(229,192,123,.14)", border: "1px solid rgba(229,192,123,.4)" } },
              React.createElement("div", { style: { fontWeight: 600 } }, "⚠ 被控 harness 请求敏感操作"),
              React.createElement("div", { style: { opacity: .85, margin: "2px 0 5px" } }, perm.reason ?? perm.title),
              React.createElement("div", { style: { display: "flex", gap: 6 } },
                React.createElement("button", { style: C.btnPrimary, onClick: () => void api.permission(task.task_id, true).then(refreshTasks) }, "允许本次"),
                React.createElement("button", { style: { ...C.btn, color: "#e5534b" }, onClick: () => void api.permission(task.task_id, false).then(refreshTasks) }, "拒绝"),
              ),
            )
          : null,
        result?.summary
          ? React.createElement("div", { style: { marginTop: 5, whiteSpace: "pre-wrap", wordBreak: "break-word", opacity: .9 } }, result.summary.length > 400 ? `${result.summary.slice(0, 400)}…` : result.summary)
          : null,
        result?.changes?.length
          ? React.createElement("div", { style: { marginTop: 4, fontSize: 11, opacity: .75 } }, `变更 ${result.changes.length} 处:${result.changes.slice(0, 4).map((c) => c.paths.join(", ")).join("; ")}${result.changes.length > 4 ? " …" : ""}`)
          : null,
        task.error ? React.createElement("div", { style: { marginTop: 4, color: "#e5534b" } }, String(task.error)) : null,
        !TERMINAL.has(st)
          ? React.createElement("div", { style: { marginTop: 5 } },
              React.createElement("button", { style: C.btn, onClick: () => void api.cancel(task.task_id).then(refreshTasks) }, "取消任务"),
            )
          : null,
      );
    }

    /** 完成回执卡堆(右下角,悬浮于输入框上方)。 */
    function Receipts() {
      const s = useStore();
      if (!s.receipts?.length) return null;
      return React.createElement("div", {
        style: { position: "fixed", right: 16, bottom: 110, display: "flex", flexDirection: "column", gap: 8, zIndex: 9999, width: 340, maxWidth: "90vw" },
      }, s.receipts.map((r) => React.createElement("div", {
        key: r.id,
        style: {
          ...C.panel, width: "auto", bottom: "auto", left: "auto", position: "relative",
          padding: "8px 10px", borderLeft: `3px solid ${stateColor(r.state)}`,
        },
      },
      React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
        React.createElement("span", { style: { color: stateColor(r.state), fontWeight: 700, flex: "none" } }, stateText(r.state)),
        React.createElement("span", { style: { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, `${r.harness} · ${r.id.slice(-8)}`),
        React.createElement("button", {
          style: { ...C.btn, marginLeft: "auto", flex: "none" },
          onClick: () => store.set({ receipts: (state.receipts ?? []).filter((x) => x.id !== r.id) }),
        }, "✕"),
      ),
      React.createElement("div", { style: { marginTop: 3, whiteSpace: "pre-wrap", wordBreak: "break-word", opacity: .9, maxHeight: 84, overflow: "hidden" } }, r.summary.length > 220 ? `${r.summary.slice(0, 220)}…` : r.summary),
      r.changes?.length
        ? React.createElement("div", { style: { marginTop: 3, fontSize: 11, opacity: .7 } }, `变更 ${r.changes.length} 处:${r.changes.slice(0, 3).map((c) => c.paths.join(", ")).join("; ")}${r.changes.length > 3 ? " …" : ""}`)
        : null,
      React.createElement("div", { style: { marginTop: 4 } },
        React.createElement("button", {
          style: C.btn,
          onClick: () => store.set({ open: true, menuOpen: false, tab: "console", receipts: (state.receipts ?? []).filter((x) => x.id !== r.id) }),
        }, "查看控制台"),
      ),
      )));
    }

    // ==================== 控制台 tab ====================
    function ConsoleTab() {
      const s = useStore();
      const set = (k, v) => store.set({ form: { ...s.form, [k]: v } });
      const submit = async () => {
        const prompt = s.form.prompt.trim();
        store.set({ err: null, notice: null });
        if (!prompt) { store.set({ err: "先写任务内容" }); return; }
        try {
          const timeoutMs = s.form.timeout ? Number(s.form.timeout) : undefined;
          if (s.form.team) {
            // 开团模式:多节点并行(成员来自勾选)
            const members = s.form.members.map((h) => ({ harness: h }));
            if (!members.length) { store.set({ err: "开团模式:至少勾选一个节点" }); return; }
            const res = await api.team({ task: prompt, members, timeoutMs });
            store.set({ notice: `已开团 ${res.team_id}(${members.length} 个成员):${res.tasks.map((t) => t.task_id).join(", ")}`, form: { ...s.form, prompt: "" } });
            for (const t of res.tasks) watchTask(t.task_id);
          } else {
            if (!s.form.harness) { store.set({ err: "先选节点" }); return; }
            const deny = s.form.deny.split(/[,,\s]+/).map((x) => x.trim()).filter(Boolean);
            const res = await api.dispatch({
              harness: s.form.harness,
              prompt,
              deny: deny.length ? deny : undefined,
              timeoutMs,
              model: s.form.model.trim() || undefined,
              origin: currentSessionId ?? undefined,
            });
            store.set({ notice: `已派发 ${res.task_id}(@ ${res.harness}${res.model ? `,模型 ${res.model}` : ""}),完成会弹回执`, form: { ...s.form, prompt: "" } });
            watchTask(res.task_id);
          }
          await refreshTasks();
        } catch (error) { store.set({ err: String(error?.message ?? error) }); }
      };
      return React.createElement(React.Fragment, null,
        React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
          s.form.team
            ? React.createElement("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
                s.nodes.map((n) => React.createElement("label", { key: n.name, style: { fontSize: 11, color: "#9fb2cc", display: "flex", alignItems: "center", gap: 3 } },
                  React.createElement("input", {
                    type: "checkbox",
                    checked: s.form.members.includes(n.name),
                    onChange: (e) => store.set({ form: { ...s.form, members: e.target.checked ? [...s.form.members, n.name] : s.form.members.filter((x) => x !== n.name) } }),
                  }), n.name)),
              )
            : React.createElement("select", {
                style: { ...C.input, width: 150 }, value: s.form.harness,
                onChange: (e) => set("harness", e.target.value),
              },
                React.createElement("option", { value: "" }, "选择节点…"),
                s.nodes.map((n) => React.createElement("option", { key: n.name, value: n.name }, `${n.name}(${n.type === "acp-ssh" ? n.target : "本机"})`)),
              ),
          React.createElement("input", {
            style: { ...C.input, width: 90 }, placeholder: "超时ms", value: s.form.timeout,
            onChange: (e) => set("timeout", e.target.value),
          }),
          !s.form.team && (() => {
            // 节点勾了可用模型白名单 → 下拉选;没勾 → 自由输入(2026-10-20 节点管理改造)
            const wl = s.nodes.find((n) => n.name === s.form.harness)?.models ?? [];
            if (!wl.length) {
              return React.createElement("input", {
                style: { ...C.input, width: 170 }, placeholder: "模型(可选,如 opencode/xx)", value: s.form.model,
                onChange: (e) => set("model", e.target.value),
              });
            }
            return React.createElement("select", {
              style: { ...C.input, width: 170 }, value: s.form.model, title: "该节点在管理面板勾选的可用模型",
              onChange: (e) => set("model", e.target.value),
            },
              React.createElement("option", { value: "" }, "模型(默认)"),
              wl.map((m) => React.createElement("option", { key: m, value: m }, m)),
            );
          })(),
          React.createElement("label", { style: { fontSize: 11, color: "#9fb2cc", display: "flex", alignItems: "center", gap: 3 } },
            React.createElement("input", {
              type: "checkbox", checked: s.form.team,
              onChange: (e) => store.set({ form: { ...s.form, team: e.target.checked, members: [] } }),
            }), "开团(多节点并行)"),
        ),
        React.createElement("textarea", {
          style: { ...C.input, minHeight: 54, resize: "vertical" }, placeholder: "任务内容(自包含:背景/要求/验收标准,被控 harness 看不到本会话历史)",
          value: s.form.prompt, onChange: (e) => set("prompt", e.target.value),
        }),
        React.createElement("input", {
          style: C.input, placeholder: "敏感操作正则(可选,逗号/空格分隔;命中会停下来问你)", value: s.form.deny,
          onChange: (e) => set("deny", e.target.value),
        }),
        React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
          React.createElement("button", { style: C.btnPrimary, onClick: submit }, "派发任务"),
          React.createElement("button", { style: C.btn, onClick: () => void refreshAll() }, "刷新"),
          s.notice ? React.createElement("span", { style: { color: "#7bc86c" } }, s.notice) : null,
        ),
        React.createElement("div", { style: { opacity: .7, margin: "4px 0 0" } }, `任务(${s.tasks.length},按会话归类)`),
        s.tasks.length === 0 ? React.createElement("div", { style: { opacity: .55 } }, "暂无任务。也可以在聊天框打 @ 直接召唤节点。") : null,
        ...(() => {
          // 按会话分组:当前会话在最上,其余按最近活跃排序;无 origin 的归"未标记"
          const groups = new Map();
          for (const t of s.tasks) {
            const key = t.origin ?? "none";
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(t);
          }
          const keys = [...groups.keys()].sort((a, b) => {
            if (a === currentSessionId) return -1;
            if (b === currentSessionId) return 1;
            if (a === "none") return 1;
            if (b === "none") return -1;
            return 0;
          });
          return keys.map((key) => React.createElement(React.Fragment, { key },
            React.createElement("div", { style: { fontWeight: 600, opacity: .75, margin: "6px 0 2px", fontSize: 12 } },
              key === "none" ? "未标记会话" : key === currentSessionId ? `本会话(${String(key).slice(0, 8)}…)` : `会话 ${String(key).slice(0, 8)}…`),
            ...groups.get(key).map((t) => React.createElement(TaskCard, { key: t.task_id, task: t })),
          ));
        })(),
      );
    }

    // ==================== 节点配置 tab ====================
    function NodeForm({ node, isNew, onSave, onCancel }) {
      const [form, setForm] = React.useState(node);
      const [err, setErr] = React.useState(null);
      const set = (k, v) => setForm({ ...form, [k]: v });
      const save = () => {
        try {
          onSave({
            ...form,
            name: String(form.name ?? "").trim(),
            args: String(form.args ?? "").split(/\s+/).filter(Boolean),
            env: form.envText ? Object.fromEntries(String(form.envText).split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])) : {},
          });
        } catch (error) { setErr(String(error?.message ?? error)); }
      };
      return React.createElement("div", { style: C.card },
        React.createElement("div", { style: { fontWeight: 600, marginBottom: 6 } }, isNew ? "新增节点" : `编辑 ${node.name}`),
        React.createElement("input", { style: C.input, placeholder: "节点名(字母/数字/_/-,1-32位)", value: form.name ?? "", disabled: !isNew, onChange: (e) => set("name", e.target.value) }),
        React.createElement("select", { style: C.input, value: form.type ?? "acp-stdio", onChange: (e) => set("type", e.target.value) },
          React.createElement("option", { value: "acp-plug" }, "acp-plug(插头协议,连被控机 harnessd)"),
          React.createElement("option", { value: "acp-stdio" }, "acp-stdio(本机直连)"),
          React.createElement("option", { value: "acp-ssh" }, "acp-ssh(跨机 SSH 隧道)"),
          React.createElement("option", { value: "cli-oneshot" }, "cli-oneshot(CLI 兜底,暂未实现)"),
        ),
        form.type === "acp-plug"
          ? React.createElement(React.Fragment, null,
              React.createElement("input", { style: C.input, placeholder: "address(被控机 harnessd 地址,如 <tailnet-ip>:7080)", value: form.address ?? "", onChange: (e) => set("address", e.target.value) }),
              React.createElement("input", { style: C.input, placeholder: "plugId(被控机 plugs.json 里的插头名)", value: form.plugId ?? "", onChange: (e) => set("plugId", e.target.value) }),
              React.createElement("input", { style: C.input, placeholder: "socks(可选,本机 SOCKS5 如 127.0.0.1:11080;空=系统路由直连)", value: form.socks ?? "", onChange: (e) => set("socks", e.target.value) }),
            )
          : React.createElement(React.Fragment, null,
              React.createElement("input", { style: C.input, placeholder: "command(如 opencode)", value: form.command ?? "", onChange: (e) => set("command", e.target.value) }),
              React.createElement("input", { style: C.input, placeholder: "args(空格分隔,如 acp)", value: form.args ?? "", onChange: (e) => set("args", e.target.value) }),
            ),
        form.type === "acp-ssh"
          ? React.createElement("input", { style: C.input, placeholder: "ssh(用户@主机,如 user@192.168.x.x)", value: form.ssh ?? "", onChange: (e) => set("ssh", e.target.value) })
          : null,
        React.createElement("input", { style: C.input, placeholder: "cwd(默认工作目录,可空)", value: form.cwd ?? "", onChange: (e) => set("cwd", e.target.value) }),
        React.createElement("input", { style: C.input, placeholder: "固定模型(可空,如 opencode/deepseek-v4.1-flash;空=用默认)", value: form.model ?? "", onChange: (e) => set("model", e.target.value) }),
        React.createElement("textarea", { style: { ...C.input, minHeight: 40 }, placeholder: "env(每行 K=V,可空)", value: form.envText ?? "", onChange: (e) => set("envText", e.target.value) }),
        React.createElement("input", { style: C.input, placeholder: "描述(中文,可选)", value: form.description ?? "", onChange: (e) => set("description", e.target.value) }),
        err ? React.createElement("div", { style: { color: "#e5534b", margin: "4px 0" } }, err) : null,
        React.createElement("div", { style: { display: "flex", gap: 6 } },
          React.createElement("button", { style: C.btnPrimary, onClick: save }, "保存"),
          React.createElement("button", { style: C.btn, onClick: onCancel }, "取消"),
        ),
      );
    }

    /** MCP 接入卡片:一键复制的连接配置。 */
    function McpCard() {
      const [copied, setCopied] = React.useState(false);
      const mcpUrl = `${location.origin}/api/mcp/harness-mesh${location.search || "?token="}`;
      const line = `MCP(Streamable HTTP): ${mcpUrl} — tools: harness_list/dispatch/status/cancel/result`;
      const copy = async () => {
        try { await navigator.clipboard.writeText(line); }
        catch {
          try {
            const ta = document.createElement("textarea");
            ta.value = line; document.body.appendChild(ta); ta.select();
            document.execCommand("copy"); ta.remove();
          } catch { /* 复制失败静默 */ }
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      };
      return React.createElement("div", { style: { padding: "6px 8px", border: "1px dashed rgba(128,128,128,.4)", borderRadius: 9 } },
        React.createElement("div", { style: { fontWeight: 600, marginBottom: 4 } }, "MCP 接入(任何 MCP host 可召唤节点网格)"),
        React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
          React.createElement("code", { style: { flex: 1, fontSize: 11, opacity: .8, wordBreak: "break-all", userSelect: "all" } }, line),
          React.createElement("button", { style: { ...C.btn, flex: "none" }, onClick: () => void copy() }, copied ? "✓ 已复制" : "复制"),
        ),
        React.createElement("div", { style: { opacity: .55, fontSize: 11, marginTop: 3 } }, "在支持 MCP 的客户端里以 Streamable HTTP 方式添加上面的地址即可。"),
      );
    }

    /** 节点行(2026-10-20 名册改造):默认折叠一行;点 ▸ 展开 → 可用模型
     *  (探测该 harness 的真实模型表 → 勾选白名单,勾选即自动保存)。 */
    function NodeRow({ n }) {
      const [open, setOpen] = React.useState(false);
      const [probe, setProbe] = React.useState(null);      // {models, currentModelId} | {error}
      const [probing, setProbing] = React.useState(false);
      const [saving, setSaving] = React.useState(false);
      const [models, setModels] = React.useState(n.models ?? []);
      const [manual, setManual] = React.useState("");         // 手填模型 id 输入框内容
      const [manualBad, setManualBad] = React.useState(false); // 重复输入时闪红边框
      React.useEffect(() => { setModels(n.models ?? []); }, [JSON.stringify(n.models ?? [])]);  // 名册刷新跟随
      const doProbe = async () => {
        setProbing(true); setProbe(null);
        try { setProbe(await api.probeModels(n.name)); }
        catch (error) { setProbe({ error: String(error?.message ?? error) }); }
        finally { setProbing(false); }
      };
      const toggle = async (modelId, on) => {
        const next = [...new Set(on ? [...models, modelId] : models.filter((x) => x !== modelId))];
        setModels(next);
        setSaving(true);
        try { await api.saveNode({ ...n, models: next }); await refreshNodes(); }
        catch (error) { store.set({ err: `保存模型勾选失败: ${String(error?.message ?? error)}` }); }
        finally { setSaving(false); }
      };
      const addManual = async () => {
        const value = manual.trim();
        if (!value || value.length > 128) { setManual(""); return; }
        if (models.includes(value)) {  // 重复:闪红边框 600ms 提示
          setManualBad(true);
          setTimeout(() => setManualBad(false), 600);
          return;
        }
        setManual("");
        await toggle(value, true);
      };
      // 渲染清单 = 探测结果 ∪ 已勾白名单(探测过的显示友好名,白名单里探测不到的留 modelId)
      const listed = new Map();
      for (const m of probe?.models ?? []) listed.set(m.modelId, m.name);
      for (const id of models) if (!listed.has(id)) listed.set(id, id);
      return React.createElement("div", null,
        React.createElement("div", { style: C.row },
          React.createElement("span", { style: { cursor: "pointer", userSelect: "none", opacity: .75, flex: "none", width: 14 }, title: "展开/折叠可用模型", onClick: () => setOpen(!open) }, open ? "▾" : "▸"),
          React.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer", flex: "1 1 auto", minWidth: 0 }, onClick: () => setOpen(!open) },
            n.name, " ",
            React.createElement("span", { style: { opacity: .55, fontSize: 11 } }, `${n.type} · ${n.target} · ${n.command}${n.args?.length ? ` ${n.args.join(" ")}` : ""}${models.length ? ` · 模型${models.length}选` : ""}${n.running ? ` · 在跑${n.running}` : ""}`),
          ),
          React.createElement("span", { style: { flex: "none", display: "flex", gap: 4 } },
            React.createElement("button", { style: C.btn, onClick: () => store.set({ editing: { ...n, args: (n.args ?? []).join(" "), envText: Object.entries(n.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n") } }) }, "编辑"),
            React.createElement("button", { style: { ...C.btn, color: "#e5534b" }, onClick: async () => {
              if (!confirm(`删除节点 ${n.name}?`)) return;
              try { await api.removeNode(n.name); await refreshNodes(); } catch (error) { store.set({ err: String(error?.message ?? error) }); }
            } }, "删除"),
          ),
        ),
        open ? React.createElement("div", { style: { padding: "4px 8px 9px 26px" } },
          React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center", marginBottom: 4 } },
            React.createElement("button", { style: C.btn, disabled: probing, onClick: () => void doProbe() },
              probing ? "探测中…(拉起 harness 需数十秒)" : "↻ 探测可用模型"),
            saving ? React.createElement("span", { style: { opacity: .55, fontSize: 11 } }, "保存中…") : null,
            probe?.error ? React.createElement("span", { style: { color: "#e5534b", fontSize: 11 } }, probe.error) : null,
            probe && !probe.error && !probe.models?.length ? React.createElement("span", { style: { opacity: .55, fontSize: 11 } }, "该 harness 不上报模型表 = 不限制") : null,
          ),
          listed.size ? React.createElement("div", { style: { maxHeight: 200, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 } },
            [...listed.entries()].map(([id, name]) => React.createElement("label", { key: id, style: { display: "flex", gap: 6, alignItems: "center", fontSize: 12, cursor: "pointer" } },
              React.createElement("input", { type: "checkbox", checked: models.includes(id), onChange: (e) => void toggle(id, e.target.checked) }),
              React.createElement("span", null, name),
              id !== name ? React.createElement("span", { style: { opacity: .5, fontSize: 11 } }, id) : null,
              probe?.currentModelId === id ? React.createElement("span", { style: { opacity: .5, fontSize: 11 } }, "(harness 当前)") : null,
            )),
          ) : null,
          React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center", marginTop: 4 } },
            React.createElement("input", {
              style: { ...C.input, width: 260, ...(manualBad ? { borderColor: "#e5534b" } : null) },
              placeholder: "手填模型 id,回车添加(如 zcode/glm-4.6)",
              value: manual,
              onChange: (e) => setManual(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") void addManual(); },
              onBlur: () => void addManual(),
            }),
          ),
          React.createElement("div", { style: { opacity: .55, fontSize: 11, marginTop: 4 } },
            "勾选 = 该节点允许用的模型(派发的模型覆盖必须在名单内),勾选即保存;全不勾 = 不限制。"),
        ) : null,
      );
    }

    function NodesTab() {
      const s = useStore();
      const [aiErr, setAiErr] = React.useState(null);
      const gen = async () => {
        const description = s.aiText.trim();
        if (!description) return;
        store.set({ aiBusy: true, err: null });
        setAiErr(null);
        try {
          const { node } = await api.aiConfig(description);
          store.set({ aiBusy: false, editing: { ...node, args: (node.args ?? []).join(" "), envText: Object.entries(node.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n") }, notice: "AI 已生成配置草案,确认后保存" });
        } catch (error) {
          store.set({ aiBusy: false });
          setAiErr(String(error?.message ?? error));
        }
      };
      if (s.editing) {
        const isNew = s.editing === "new";
        const node = isNew ? { name: "", type: "acp-stdio", command: "", args: "", ssh: "", cwd: "", envText: "", description: "" } : s.editing;
        return React.createElement(NodeForm, {
          node, isNew,
          onSave: async (n) => {
            try { await api.saveNode(n); store.set({ editing: null, notice: `节点 ${n.name} 已保存` }); await refreshNodes(); }
            catch (error) { store.set({ err: String(error?.message ?? error) }); }
          },
          onCancel: () => store.set({ editing: null, aiBusy: false }),
        });
      }
      return React.createElement(React.Fragment, null,
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
          React.createElement("span", { style: { opacity: .75 } }, `节点(${s.nodes.length}) · 改动即时生效`),
          React.createElement("button", { style: C.btn, onClick: () => store.set({ editing: "new", err: null, notice: null }) }, "+ 新增"),
        ),
        React.createElement("div", { style: { padding: "6px 8px", border: "1px dashed rgba(128,128,128,.4)", borderRadius: 9 } },
          React.createElement("div", { style: { fontWeight: 600, marginBottom: 4 } }, "AI 辅助配置"),
          React.createElement("textarea", {
            style: { ...C.input, minHeight: 40 }, placeholder: "用自然语言描述你的 harness,如:「本机的 opencode,命令 opencode acp,用来跑前端任务」或「另一台机器上的 kimi,ssh 用户 user」",
            value: s.aiText, onChange: (e) => store.set({ aiText: e.target.value }),
          }),
          React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center", marginTop: 4 } },
            React.createElement("button", { style: C.btnPrimary, disabled: s.aiBusy, onClick: gen }, s.aiBusy ? "生成中…" : "生成配置"),
            aiErr ? React.createElement("span", { style: { color: "#e5534b" } }, aiErr) : null,
          ),
          React.createElement("div", { style: { opacity: .55, fontSize: 11, marginTop: 3 } }, "生成后进入表单预填,确认无误再保存;不会自动写入。"),
        ),
        React.createElement(McpCard, null),
        s.nodes.map((n) => React.createElement(NodeRow, { key: n.name, n })),
      );
    }

    // ==================== 控制台面板(overlay slot) ====================
    function ConsolePanel() {
      const s = useStore();
      React.useEffect(() => {
        if (!s.open) return;
        let alive = true;
        const tick = async () => { if (alive) await refreshAll(); };
        const timer = setInterval(tick, 2000);
        return () => { alive = false; clearInterval(timer); };
      }, [s.open]);
      if (!s.open) return null;
      // 居中大悬浮窗:不锚定图标,直接画面正中;点遮罩或 ✕ 关闭
      return React.createElement(React.Fragment, null,
        React.createElement("div", { style: C.scrim, onClick: () => store.set({ open: false, menuOpen: false }) }),
        React.createElement("div", { style: C.panel, role: "dialog", "aria-label": "Harness 组网" },
          React.createElement("div", { style: C.head },
            React.createElement("span", { style: { fontWeight: 700, marginRight: "auto", fontSize: 14 } },
              s.tab === "console" ? "📋 Harness 任务" : "⚙ Harness 配置"),
            React.createElement("button", { style: { ...C.btn }, onClick: () => store.set({ open: false, menuOpen: false }) }, "✕"),
          ),
          React.createElement("div", { style: C.body },
            s.err ? React.createElement("div", { style: { color: "#e5534b" } }, s.err) : null,
            s.notice ? React.createElement("div", { style: { color: "#7bc86c" } }, s.notice) : null,
            s.tab === "console" ? React.createElement(ConsoleTab, null)
              : React.createElement(NodesTab, null),
          ),
        ),
      );
    }

    // ==================== 侧栏图标坞(H 版:2026-10-18 老徐确认的形态) ====================
    // 形态:侧栏目标条目(OpenDesign/折叠)压成仅图标+悬停文本;整组网格排列;
    // 插件图标接在其后:机器人第三(跳 GitHub),⚡控制台/📋驾驶舱随后。
    // ★安全纪律(凌晨崩溃根因):MutationObserver 回调【绝不重置已追加标记】;
    // 追加每 nav 实例只做一次;回调只做属性变异;500 次熔断兜底。
    function installSidebarDock() {
      const COLS = 4;
      const labels = () => {
        const raw = globalThis.localStorage?.getItem("harness-mesh.compactLabels") ?? "OpenDesign,折叠";
        return raw.split(",").map((x) => x.trim()).filter(Boolean);
      };
      const styleId = "hm-sidebar-dock-style";
      if (!document.getElementById(styleId)) {
        const st = document.createElement("style");
        st.id = styleId;
        st.textContent = `
[data-hm-dock-grid]{display:grid !important;grid-template-columns:repeat(${COLS},1fr) !important;gap:10px;padding:6px 4px;justify-items:center;align-items:center}
[data-hm-dock-grid] > *{max-width:52px;overflow:hidden;white-space:nowrap}
[data-hm-dock-grid] svg,[data-hm-dock-grid] img{width:28px;height:28px}
[data-hm-plugin-icon]{width:46px;height:46px;display:flex;align-items:center;justify-content:center;border-radius:10px;cursor:pointer;border:none;background:transparent;font-size:22px;padding:0}
[data-hm-plugin-icon]:hover{background:rgba(255,255,255,.10)}`;
        document.head.appendChild(st);
      }
      const findNav = () => {
        const want = labels();
        for (const el of document.querySelectorAll("nav a, nav button, nav li, [role='treeitem'], [role='link'], aside a, aside button")) {
          const t = (el.textContent ?? "").trim();
          if (t && (want.includes("*") || want.some((w) => t === w || t.startsWith(w)))) {
            const list = el.closest("ul, ol, [role='list'], [role='tree'], [role='menu']") ?? el.parentElement;
            if (list) return list;
          }
        }
        return null;
      };
      const compactEntry = (el) => {
        if (!el || el.dataset?.hmCompacted) return;
        if (el.closest?.("[data-hm-plugin-icon]")) return;   // 自家插件按钮永不压
        const text = (el.textContent ?? "").trim();
        if (!text) return;
        // ★坞内条目全部压(不只名单里的):名单只用于"找坞"。
        // 教训:只压名单条目时,"插件"这类后出现的条目没 title 还被格子裁字(老徐 10-18 反馈)
        el.dataset.hmCompacted = "1";
        el.title = text;
        el.style.background = "transparent";
        el.style.backgroundImage = "none";
        el.style.border = "none";
        el.style.boxShadow = "none";
        let hid = 0;
        for (const d of el.querySelectorAll("*")) {
          if (d.children.length === 0 && (d.textContent ?? "").trim()) { d.style.display = "none"; hid += 1; }
        }
        if (hid === 0) { delete el.dataset.hmCompacted; el.title = ""; }
      };
      const sweep = () => {
        const nav = findNav();
        if (!nav) return;
        if (!nav.dataset.hmDockized) {                      // 每 nav 实例只追加一次(永不重置)
          nav.dataset.hmDockized = "1";
          nav.setAttribute("data-hm-dock-grid", "");
          nav.style.gridTemplateColumns = `repeat(${Math.max(4, nav.querySelectorAll(":scope > *").length + 3)}, 1fr)`;
          const BOT_SVG = `<svg viewBox="0 0 24 24" width="27" height="27" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.2v1.8"/><circle cx="12" cy="2.4" r="1.1"/><rect x="4.2" y="6" width="15.6" height="12.4" rx="3.4"/><circle cx="9.1" cy="11.8" r="1.25" fill="currentColor" stroke="none"/><circle cx="14.9" cy="11.8" r="1.25" fill="currentColor" stroke="none"/><path d="M9.4 15.4h5.2"/><path d="M4.2 10.2H2.6M21.4 10.2h-1.6"/></svg>`;
          const add = (title, glyph, onOpen) => {
            const b = document.createElement("button");
            b.type = "button";
            b.title = title;
            b.dataset.hmPluginIcon = title;
            b.innerHTML = glyph.trimStart().startsWith("<") ? glyph : `<span style="font-size:22px;line-height:1">${glyph}</span>`;
            b.addEventListener("click", () => onOpen());
            nav.appendChild(b);
          };
          // 顺序即排位:两个目标条目之后,机器人第三个(老徐最终确认:只加这一个,
          // ⚡控制台/📋驾驶舱不进坞——它们已在聊天框输入区,不重复)
          add("DeepSeekBot · Bot 团队(打开 DSB 实例)", BOT_SVG, async () => {
            // 打开 DSB,地址栏全程无 token(2026-10-19):
            // ①服务端出一次性登录 URL(token 只走已鉴权的 API 通道)
            // ②隐藏 iframe 加载它 → DSB 种好自己的 auth cookie
            // ③新标签打开干净地址。拿不到登录 URL 就直接开干净地址(DSB cookie 有效期内直通)。
            const cleanGuess = `${location.protocol}//${location.hostname}:31967/`;
            const openClean = (u) => window.open(u, "_blank", "noopener");
            let login = null, clean = cleanGuess;
            try {
              const d = await call("/api/harness-mesh/dsb-open");
              if (d?.ok) { login = d.url; clean = d.cleanUrl ?? cleanGuess; }
            } catch { /* 旧服务端无此端点 */ }
            if (!login) {
              try {
                const d = await call("/api/harness-mesh/nodes?dsb=1");  // 老实例 shim(路由表未含新端点)
                if (d?.ok && d?.url) { login = d.url; clean = d.cleanUrl ?? cleanGuess; }
              } catch { /* 没 token 可给 */ }
            }
            if (!login) { openClean(clean); return; }
            let done = false;
            const go = () => { if (done) return; done = true; try { f.remove(); } catch { /* 已摘 */ } openClean(clean); };
            const f = document.createElement("iframe");
            f.style.display = "none";
            f.src = login;               // 先指 src 再入 DOM:否则空 iframe 的 about:blank onload 抢跑,把它提前摘掉(无头实测实踩)
            f.onload = go;
            setTimeout(go, 5000);  // 兜底:被 X-Frame-Options 拒也照开(cookie 通常已种上)
            document.body.appendChild(f);
          });
        }
        for (const el of nav.querySelectorAll("a, button, li, [role='treeitem'], [role='link']")) compactEntry(el);
      };
      sweep();
      let n = 0;                                             // 熔断器:500 次即断
      const mo = new MutationObserver(() => { if (++n > 500) { mo.disconnect(); return; } sweep(); });
      mo.observe(document.body, { childList: true, subtree: true });
      return () => mo.disconnect();
    }

    // ==================== @ 召唤(input-trigger source) ====================
    let currentSessionId = null;   // 发起会话 id(来自 trigger 投影;任务按它归类)
    function createSource() {
      let warmNodes = [];      const warmListeners = new Set();
      const invalidate = () => { for (const l of warmListeners) l(); };
      const warm = async () => {
        try {
          const { nodes } = await api.loadNodes();
          warmNodes = nodes ?? [];
          invalidate();
        } catch { /* 预热失败静默,菜单打开时 candidates 再拉 */ }
      };
      /** 构造召唤 claim(CommandClaim 契约:token 带参数分隔空格;submit 的 args = token 之后的文本)。
       *  2026-10-19 修正:onPick 必须回 {claim} 进入命令态,Enter 才走 claim.submit 直连派发;
       *  此前回 {text} 只插文本芯片——框架的 matchEnter 裁决只对 "/" 开头草稿生效,
       *  "@节点 任务"会被当普通聊天发给主 LLM(无头实测抓出:@ 召唤此前从未真正生效)。 */
      const makeClaim = (name, fallbackText = "") => ({
        name: "harness",
        token: `@${name} `,
        hint: `召唤 ${name} 执行任务`,
        submit: async (args) => {
          const prompt = (args ?? "").trim() || fallbackText;
          if (!prompt) return { kind: "error", text: `任务内容为空:@${name} 后面写上任务再回车。` };
          try {
            const res = await api.dispatch({ harness: name, prompt, origin: currentSessionId ?? undefined });
            watchTask(res.task_id);
            store.set({ open: true, menuOpen: false, tab: "console", notice: `已召唤 ${name}:${res.task_id}` });
            await refreshTasks();
            return { kind: "success", text: `已召唤 ${name} 执行任务(${res.task_id}),进度见 Harness 控制台。` };
          } catch (error) {
            return { kind: "error", text: `召唤失败:${String(error?.message ?? error)}` };
          }
        },
      });
      return {
        trigger: "@",
        name: "harness",
        order: -10,   // 置顶(菜单按 order 升序,系统文件源是 0/1;老徐要求 harness 在顶部)
        showGroupTitle: true,
        warm() { void warm(); },
        lexicon: () => warmNodes.filter((n) => !n.name.startsWith("fake-")).map((n) => n.name),
        subscribeLexicon(session, listener) { if (session?.sessionId) currentSessionId = session.sessionId; warmListeners.add(listener); return () => warmListeners.delete(listener); },
        async candidates(session, req) {
          if (session?.sessionId) currentSessionId = session.sessionId;
          if (!state.enabled) return [];                       // 总开关关闭:不出候选
          if (warmNodes.length === 0) await warm();
          const q = (req.query ?? "").toLowerCase();
          // 空 @ 也出节点候选,靠 order:-10 置顶(老徐要求:harness 在菜单顶部,
          // 系统文件/子智能体/会话组在下方——不藏,只排最上)
          return warmNodes
            // fake-* 是回环测试资产(回归测试用),不进 @ 菜单(2026-10-18 菜单净化)
            .filter((n) => !n.name.startsWith("fake-"))
            .filter((n) => !q || n.name.toLowerCase().includes(q) || String(n.description ?? "").toLowerCase().includes(q))
            .map((n) => ({ name: n.name, label: n.name, description: n.description || `${n.type} → ${n.target}` }));
        },
        onPick({ candidate }) {
          // claim 结局:进入命令态(token + hint),Enter 时 claim.submit 直连派发
          return { claim: makeClaim(candidate.name) };
        },
        async matchEnter(session, line) {
          if (session?.sessionId) currentSessionId = session.sessionId;
          if (!state.enabled) return undefined;                 // 总开关关闭:不接管提交
          const m = /^@([A-Za-z0-9_-]{1,32})\s+([\s\S]+)$/.exec(line.trim());
          if (!m) return undefined;
          const name = m[1];
          const taskText = m[2].trim();
          if (!taskText) return undefined;
          if (warmNodes.length === 0) await warm();
          const node = warmNodes.find((n) => n.name === name);
          if (!node) return undefined;
          return { claim: makeClaim(name, taskText) };
        },
      };
    }

    // ==================== apply ====================
    const log = (...args) => console.log("[harness-mesh]", ...args);
    let slotRendered = false;
    /** left slot 宿主:图标(第三位,+和盾牌之后) + 小菜单 + 配置悬浮页,一起渲染。
     *  全部用 fixed 定位,不依赖宿主容器样式。 */
    const LeftSlotHost = () => {
      try {
        if (!slotRendered) { slotRendered = true; log("left slot 已渲染(图标菜单合并部件+回执宿主)"); }
        return React.createElement(React.Fragment, null,
          MeshIcon(),
          IconMenu(),
          ConsolePanel(),
          Receipts(),
        );
      } catch (error) {
        console.error("[harness-mesh] left slot 渲染异常:", error);
        return null;
      }
    };

    function apply(ctx) {
      log("apply 开始,inject 服务:", inject.join(","));
      const disposers = [];

      const safe = (label, fn) => {
        try {
          disposers.push(ctx.effect(fn, label));
          log(label, "注册成功");
        } catch (error) {
          console.error("[harness-mesh]", label, "注册失败:", error);
        }
      };
      // "S临时A项"并入菜单:输入栏的 project-hub 图标撤掉(老徐 10-18)
      try {
        if (typeof document !== "undefined" && !document.getElementById("hm-hide-hub-icon")) {
          const st = document.createElement("style");
          st.id = "hm-hide-hub-icon";
          st.textContent = `button[aria-label="项目管理面板"]{display:none !important}`;
          document.head.appendChild(st);
        }
      } catch { /* 无 DOM 环境(单测)时跳过 */ }
      // 菜单失焦自隐(老徐 10-18:对齐系统菜单——点外面就收):
      // 捕获相监听,菜单开时点菜单外任意处即关;点菜单内/图标上不截走
      // (图标自己的 toggle、菜单项自己的逻辑照常跑)。
      safe("harness-mesh: menu-dismiss", () => {
        if (typeof document === "undefined") return () => {};
        const onDocClick = (e) => {
          const s = store.getSnapshot();
          if (!s.menuOpen || s.open) return;
          const t = e.target;
          if (t?.closest?.('[role="menu"]')) return;                                    // 菜单内
          if (t?.closest?.('button[aria-label="Harness 组网菜单"]')) return;            // 图标自己(toggle)
          store.set({ menuOpen: false });
        };
        const onKey = (e) => {
          if (e.key === "Escape") { const s = store.getSnapshot(); if (s.menuOpen) store.set({ menuOpen: false }); }
        };
        document.addEventListener("click", onDocClick, true);
        document.addEventListener("keydown", onKey, true);
        return () => {
          document.removeEventListener("click", onDocClick, true);
          document.removeEventListener("keydown", onKey, true);
        };
      });
      safe("harness-mesh: left-slot", () =>
        ctx.slots.inject("conversation.input.left", () =>
          ctx.slots.register({ name: "conversation.input.left", id: "@agents/harness-mesh/icon", order: 100,
            inject: (sessionKey) => { if (typeof sessionKey === "string" && sessionKey) currentSessionId = sessionKey; return {}; } },
            LeftSlotHost)));
      safe("harness-mesh: sidebar-dock", () => installSidebarDock());
      safe("harness-mesh: source", () => {
        const triggers = ctx.get("inputTriggers");
        if (!triggers?.registerSource) throw new Error(`inputTriggers 服务不可用: ${String(triggers)}`);
        const unregister = triggers.registerSource(createSource());
        return () => unregister();
      });
      void refreshAll();
      return () => { for (const d of disposers) d(); };
    }

    return { apply, inject };
  },
});
