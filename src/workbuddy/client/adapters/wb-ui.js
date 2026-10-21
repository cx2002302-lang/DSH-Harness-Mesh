#!/usr/bin/env node
// wb-ui.js — WorkBuddy UI 操控口（CDP，零依赖）
// 协议：stdin 每行一个 JSON {cmd, ...} → stdout 每行一个 JSON {ok, ...}
// 命令：status / model / sessions / new-session / switch-session / delete-session / rename / send / screenshot
// 前置：WorkBuddy 以 --remote-debugging-port=9222 启动
//
// 可覆盖的环境变量（别把机器和精确版本路径钉死在源码里）：
//   WB_CDP_PORT CDP 端口  WB_PY python 解释器  WB_SEND_SCRIPT send_via_api.py 位置
//   WB_MESH_DIR 外部脚本的工作目录  WB_SHOT_OUT 截图默认落盘路径

const http = require('http');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CDP_PORT = process.env.WB_CDP_PORT || 9222;

// 版本号按数字比：字典序会把 3.13.12 排在 3.9.1 前面，挑中更旧的那份
function cmpVersion(a, b) {
  const x = String(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const y = String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

function findPython() {
  if (process.env.WB_PY) return process.env.WB_PY;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const root = path.join(home, '.workbuddy', 'binaries', 'python', 'versions');
  try {
    const vs = fs.readdirSync(root)
      .filter(v => fs.existsSync(path.join(root, v, 'python.exe')))
      .sort(cmpVersion);
    if (vs.length) return path.join(root, vs[vs.length - 1], 'python.exe');
  } catch (e) { /* 没装 .workbuddy 就跑 PATH 里的 python */ }
  return 'python';
}

// send_via_api.py 和 wb-ui.js 同目录落地；运行时副本目录也按同目录规则查找(WB_SEND_SCRIPT 可覆盖)
function findSendScript() {
  const cands = [path.join(__dirname, 'send_via_api.py'),
                 path.join(__dirname, '..', 'send_via_api.py')];
  return cands.find(p => fs.existsSync(p)) || cands[0];
}

const SEND_SCRIPT = process.env.WB_SEND_SCRIPT || findSendScript();
const MESH_DIR = process.env.WB_MESH_DIR || path.dirname(SEND_SCRIPT);

function getTargets() {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('cdp timeout')); });
  });
}

// 一次连接执行多个 CDP 调用
function cdpBatch(wsUrl, calls, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const results = {};
    let idx = 0;
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('cdp timeout')); }, timeoutMs);
    const next = () => {
      if (idx >= calls.length) { clearTimeout(timer); try { ws.close(); } catch (e) {} return resolve(results); }
      ws.send(JSON.stringify(calls[idx++]));
    };
    ws.onopen = next;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== undefined) { results[m.id] = m; next(); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
  });
}

const EV = (id, expression) => ({ id, method: 'Runtime.evaluate',
  params: { expression, returnByValue: true, awaitPromise: true } });

// —— 真实鼠标点击（element.click() 对 React 无效，必须用 CDP Input 事件）——
async function realClick(wsUrl, rect) {
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  await cdpBatch(wsUrl, [
    { id: 101, method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y } },
    { id: 102, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: 'left', clickCount: 1 } },
    { id: 103, method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 } },
  ]);
  return { x, y };
}

// expr 必须返回 JSON 字符串 {x,y} 或 {err}
async function rectOf(wsUrl, expr) {
  const res = await cdpBatch(wsUrl, [EV(1, expr)]);
  const raw = valueOf(res, 1);
  try { return JSON.parse(raw); } catch (e) { return { err: 'bad rect: ' + String(raw) }; }
}

function cardRectExpr(name, wantCenter = true) {
  // 找会话卡片中心点
  const n = JSON.stringify(String(name));
  return `(() => {
    const cards = Array.from(document.querySelectorAll('.cb-agent-card'));
    const hit = cards.find(c => (c.innerText||'').includes(${n}));
    if (!hit) return JSON.stringify({err:'card not found'});
    const r = hit.getBoundingClientRect();
    return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
  })()`;
}

async function getPage() {
  const targets = await getTargets();
  const page = targets.find(t => t.type === 'page' && /WorkBuddy/i.test(t.title || '') ) || targets.find(t => t.type === 'page');
  if (!page) throw new Error('no WorkBuddy page');
  return page;
}

function valueOf(res, id) {
  const r = res[id];              // {id, result:{result:{type,value}}}
  if (!r) return null;
  if (r.error) throw new Error(r.error.message || 'cdp error');
  const inner = r.result;         // {result:{type,value}} 或 {data:...}
  if (!inner) return null;
  const v = inner.result;         // Runtime.evaluate 的真实结果
  if (v && typeof v.value !== 'undefined') return v.value;
  return inner;
}

// —— 各命令 ——
const handlers = {
  async status() {
    const page = await getPage();
    const res = await cdpBatch(page.webSocketDebuggerUrl, [
      EV(1, `(() => {
        const cards = document.querySelectorAll('.cb-agent-card');
        const inputs = document.querySelectorAll('textarea,[contenteditable=true]');
        // 右下角模型名:找含已知模型关键词的最小文本节点
        let model = '';
        document.querySelectorAll('*').forEach(x => {
          if (x.children.length) return;
          const t = (x.innerText || '').trim();
          if (/^(Deepseek|Step-5|GLM|Kimi|MiniMax|fast-model|balanced-model|deep-model)/i.test(t) && t.length < 40 && !model) model = t;
        });
        const sendBtn = document.querySelector('button[aria-label="发送"]');
        const stopBtn = document.querySelector('[aria-label*="停止"],[aria-label*="Stop"],[aria-label*="取消生成"]');
        // engineBusy：以"停止/取消生成"按钮出现为准（保守口径，宁漏报不误报）
        // sendEnabled：发送按钮存在且可点（输入框有内容时才为 true）
        return JSON.stringify({ model, sessions: cards.length, hasInput: inputs.length > 0, title: document.title,
          engineBusy: !!stopBtn, sendEnabled: sendBtn ? !sendBtn.disabled : null });
      })()`),
    ]);
    return JSON.parse(valueOf(res, 1) || '{}');
  },

  async model(args) {
    const page = await getPage();
    if (args && args.set) {
      // 点模型选择器 → 在弹出的列表里点目标模型
      const res = await cdpBatch(page.webSocketDebuggerUrl, [
        EV(1, `(() => {
          const leaves = Array.from(document.querySelectorAll('*')).filter(x => !x.children.length);
          const el = leaves.find(x => /^(Deepseek|Step-5|GLM|Kimi|MiniMax|fast-model|balanced-model|deep-model)/i.test((x.innerText||'').trim()));
          if (!el) return 'NO_SELECTOR';
          let t = el;
          for (let i = 0; i < 5 && t; i++) { if (t.tagName === 'BUTTON' || t.getAttribute('role') === 'button') break; t = t.parentElement; }
          (t || el).click();
          return 'OPENED';
        })()`),
      ]);
      const opened = valueOf(res, 1);
      await new Promise(r => setTimeout(r, 1200));
      const res2 = await cdpBatch(page.webSocketDebuggerUrl, [
        EV(1, `(() => {
          const want = ${JSON.stringify(String(args.set))}.toLowerCase();
          const cand = Array.from(document.querySelectorAll('*')).filter(x => {
            if (x.children.length) return false;
            const t = (x.innerText||'').trim();
            return t.toLowerCase().includes(want) && t.length < 50;
          });
          // 只点可见且在弹层区域的(优先 y 较小的列表项)
          const vis = cand.filter(x => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
          if (!vis.length) return 'OPTION_NOT_FOUND';
          vis[0].click();
          return 'CLICKED:' + vis[0].innerText.trim();
        })()`),
      ]);
      await new Promise(r => setTimeout(r, 800));
      const st = await handlers.status();
      return { opened, pick: valueOf(res2, 1), current: st.model };
    }
    const st = await handlers.status();
    return { model: st.model };
  },

  async sessions() {
    const page = await getPage();
    const res = await cdpBatch(page.webSocketDebuggerUrl, [
      EV(1, `(() => {
        const cards = Array.from(document.querySelectorAll('.cb-agent-card'));
        const out = cards.map(c => {
          const t = (c.innerText || '').trim().split('\\n');
          return { title: t[0] || '', meta: t[1] || '', selected: /_selected_/.test(c.className || '') };
        });
        return JSON.stringify(out);
      })()`),
    ]);
    return { sessions: JSON.parse(valueOf(res, 1) || '[]') };
  },

  async 'new-session'(args) {
    // 已标定：Ctrl+N 是 WorkBuddy 新建任务/会话的正确入口（真实鼠标点按钮会撞到卡片菜单）
    const page = await getPage();
    const wsUrl = page.webSocketDebuggerUrl;
    await cdpBatch(wsUrl, [
      { id: 201, method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 2 } },
      { id: 202, method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 2 } },
    ]);
    await new Promise(r => setTimeout(r, 1600));
    // 新任务页默认模型可能是 Step-5-Preview；若指定 model 则顺手切（避免 429）
    let modelSwitched = null;
    if (args && args.model) {
      try {
        const r = await handlers.model({ set: args.model });
        modelSwitched = r && r.current;
      } catch (e) {
        modelSwitched = 'switch failed: ' + e.message;
      }
    }
    const st = await handlers.status();
    return { action: 'CTRL_N', modelSwitched, currentModel: st.model, sessions: st.sessions, hasInput: st.hasInput };
  },

  async 'switch-session'(args) {
    if (!args || !args.name) throw new Error('need name');
    const page = await getPage();
    const wsUrl = page.webSocketDebuggerUrl;
    const rect = await rectOf(wsUrl, cardRectExpr(args.name));
    if (rect.err) return { action: 'NOT_FOUND', detail: rect.err };
    await realClick(wsUrl, rect);
    await new Promise(r => setTimeout(r, 1800));
    // 验证:哪个卡片是 selected
    const chk = await rectOf(wsUrl, `(() => {
      const sel = Array.from(document.querySelectorAll('.cb-agent-card')).find(c => /_selected_/.test(c.className || ''));
      return JSON.stringify({ selected: sel ? (sel.innerText||'').trim().split('\\n')[0] : null });
    })()`);
    return { action: 'CLICKED', clickedAt: { x: Math.round(rect.x), y: Math.round(rect.y) }, selected: chk.selected };
  },

  async 'delete-session'(args) {
    // 已标定：卡片右键/更多 → 菜单（置顶/重命名/分享/归档/删除任务）
    // 安全策略：默认只"打开菜单并列出可选项"，真删需 args.confirm===true
    if (!args || !args.name) throw new Error('need name');
    const page = await getPage();
    const wsUrl = page.webSocketDebuggerUrl;
    const rect = await rectOf(wsUrl, cardRectExpr(args.name));
    if (rect.err) return { action: 'NOT_FOUND', detail: rect.err };
    // 右键打开菜单
    await cdpBatch(wsUrl, [
      { id: 301, method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: Math.round(rect.x), y: Math.round(rect.y) } },
      { id: 302, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: Math.round(rect.x), y: Math.round(rect.y), button: 'right', clickCount: 1 } },
      { id: 303, method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: Math.round(rect.x), y: Math.round(rect.y), button: 'right', clickCount: 1 } },
    ]);
    await new Promise(r => setTimeout(r, 900));
    // 列出菜单项
    const menu = await rectOf(wsUrl, `(() => {
      const items = Array.from(document.querySelectorAll('*')).filter(x => {
        if (x.children.length) return false;
        const t = (x.innerText||'').trim();
        if (t.length > 12 || !t) return false;
        const r = x.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && /置顶|重命名|分享|独立窗口|文件夹|批量|归档|删除/.test(t);
      });
      return JSON.stringify({ items: items.map(x => (x.innerText||'').trim()) });
    })()`);
    const items = (menu.items || []);
    let deleted = null;
    if (args.confirm === true) {
      const delRect = await rectOf(wsUrl, `(() => {
        const el = Array.from(document.querySelectorAll('*')).find(x => !x.children.length && /删除任务/.test((x.innerText||'').trim()));
        if (!el) return JSON.stringify({err:'no delete item'});
        const r = el.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()`);
      if (!delRect.err) {
        await realClick(wsUrl, delRect);
        await new Promise(r => setTimeout(r, 900));
        // 二次确认弹窗里的"删除/确定"
        const confirmRect = await rectOf(wsUrl, `(() => {
          const el = Array.from(document.querySelectorAll('button')).find(b => /^(删除|确定|确认)$/.test((b.innerText||'').trim()));
          if (!el) return JSON.stringify({err:'no confirm btn'});
          const r = el.getBoundingClientRect();
          return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
        })()`);
        if (!confirmRect.err) {
          await realClick(wsUrl, confirmRect);
          await new Promise(r => setTimeout(r, 1200));
          deleted = true;
        } else {
          deleted = 'confirm btn not found: ' + confirmRect.err;
        }
      } else {
        deleted = 'delete item not found: ' + delRect.err;
      }
    } else {
      // 不开删：按 Esc 关菜单
      await cdpBatch(wsUrl, [
        { id: 310, method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 } },
        { id: 311, method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 } },
      ]);
    }
    return { action: 'MENU', menuItems: items, deleted, note: 'default is dry-run; pass confirm:true to actually delete' };
  },

  async send(args) {
    // 无损平替：走 Gateway HTTP API 派任务，零 CDP、零界面操作
    // 实现在 send_via_api.py（复用适配器的密码发现 + runs API + SSE 等终态）
    if (!args || !args.text) throw new Error('need text');
    const { execFileSync } = require('child_process');
    const out = execFileSync(findPython(), [SEND_SCRIPT, String(args.text)], {
      encoding: 'utf8', timeout: 200000, cwd: MESH_DIR, windowsHide: true,
    });
    const lines = out.trim().split(String.fromCharCode(10));
    const line = lines[lines.length - 1];
    try { return JSON.parse(line); } catch (e) { return { ok: false, error: 'bad output: ' + line.slice(0, 200) }; }
  },

  async rename(args) {
    // 右键卡片 -> 菜单重命名 -> 填新名 -> 回车（CDP 写操作，无 API 替代）
    if (!args || !args.name || !args.newName) throw new Error("need name + newName");
    const page = await getPage();
    const wsUrl = page.webSocketDebuggerUrl;
    const rect = await rectOf(wsUrl, cardRectExpr(args.name));
    if (rect.err) return { action: "NOT_FOUND", detail: rect.err };
    await cdpBatch(wsUrl, [
      { id: 401, method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: Math.round(rect.x), y: Math.round(rect.y) } },
      { id: 402, method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: Math.round(rect.x), y: Math.round(rect.y), button: "right", clickCount: 1 } },
      { id: 403, method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: Math.round(rect.x), y: Math.round(rect.y), button: "right", clickCount: 1 } },
    ]);
    await new Promise(r => setTimeout(r, 900));
        const rnExpr = "(() => {"
      + "var els = Array.from(document.querySelectorAll(\"*\")).filter(function(x) {"
      + "  var t = (x.innerText || \"\").trim();"
      + "  if (t !== \"重命名\" && t !== \"重命名任务\") return false;"
      + "  var r = x.getBoundingClientRect();"
      + "  return r.width > 0 && r.height > 0 && r.height < 80;"
      + "});"
      + "if (!els.length) return JSON.stringify({err:\"no rename item\"});"
      + "els.sort(function(a, b) { var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return ra.width * ra.height - rb.width * rb.height; });"
      + "var r = els[0].getBoundingClientRect();"
      + "return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});"
      + "})()";
    const rn = await rectOf(wsUrl, rnExpr);
    if (rn.err) return { action: "MENU_NO_RENAME", detail: rn.err };
    await realClick(wsUrl, rn);
    await new Promise(r => setTimeout(r, 1000));
    const nn = JSON.stringify(String(args.newName));
        const fillExpr = "(() => {"
      + "var cands = Array.from(document.querySelectorAll(\"input[type=text],input:not([type]),[contenteditable=true]\"));"
      + "cands = cands.filter(function(x){ var r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; });"
      + "if (!cands.length) return \"NO_INPUT\";"
      + "var el = cands[0];"
      + "el.focus();"
      + "var v = " + nn + ";"
      + "if (el.tagName === \"INPUT\" || el.tagName === \"TEXTAREA\") {"
      + "  var proto = el.tagName === \"INPUT\" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;"
      + "  Object.getOwnPropertyDescriptor(proto, \"value\").set.call(el, v);"
      + "  el.dispatchEvent(new Event(\"input\", { bubbles: true }));"
      + "} else { el.textContent = v; el.dispatchEvent(new InputEvent(\"input\", { bubbles: true })); }"
      + "return \"FILLED:\" + el.tagName;"
      + "})()";
    const filled = await cdpBatch(wsUrl, [EV(1, fillExpr)]);
    await new Promise(r => setTimeout(r, 500));
    await cdpBatch(wsUrl, [
      { id: 410, method: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 } },
      { id: 411, method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 } },
    ]);
    await new Promise(r => setTimeout(r, 1200));
    const st = await handlers.sessions();
    return { action: "RENAME_ATTEMPTED", filled: valueOf(filled, 1), sessions: (st.sessions || []).slice(0, 3) };
  },

  async screenshot(args) {
    const page = await getPage();
    const res = await cdpBatch(page.webSocketDebuggerUrl, [
      { id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } },
    ]);
    const out = (args && args.out) || process.env.WB_SHOT_OUT || path.join(MESH_DIR, 'wb-ui-shot.png');
    const data = res[1] && res[1].result && res[1].result.data;
    if (!data) throw new Error('no screenshot data');
    fs.writeFileSync(out, Buffer.from(data, 'base64'));
    return { path: out, bytes: fs.statSync(out).size };
  },
};

// —— 行协议主循环 ——
function respond(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let pending = 0;
let closed = false;
rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  pending++;
  try {
    let req;
    try { req = JSON.parse(line); } catch (e) { respond({ ok: false, error: 'bad json' }); return; }
    const cmd = req.cmd;
    // 只认自有键：handlers['constructor'] 会顺原型链摸到 Object，于是回一个 ok:true 的空应答
    const h = Object.prototype.hasOwnProperty.call(handlers, cmd) ? handlers[cmd] : null;
    if (!h) { respond({ ok: false, error: 'unknown cmd: ' + String(cmd) }); return; }
    try {
      const r = await h(req);
      respond({ ok: true, cmd, ...r });
    } catch (e) {
      respond({ ok: false, cmd, error: String(e && e.message || e) });
    }
  } finally {
    pending--;
    if (closed && pending === 0) process.exit(0);
  }
});
rl.on('close', () => {
  closed = true;
  if (pending === 0) process.exit(0);
});
