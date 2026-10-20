/** 无头验收:名册行内"可用模型"(折叠→展开→探测→勾选即存→联动)
 *  用法:DSH_TOKEN=<token> node e2e-node-models.mjs
 */
import puppeteer from "puppeteer-core";
const BASE = process.env.DSH_BASE ?? "http://127.0.0.1:80";
const TOKEN = process.env.DSH_TOKEN ?? "";
const NODE = process.env.PROBE_NODE ?? "opencode-local";
let failed = 0;
const ok = (cond, label) => { console.log(cond ? `✅ ${label}` : `❌ ${label}`); if (!cond) failed++; };

const browser = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 150)));
await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: "networkidle2", timeout: 30000 });
const ICON = 'button[aria-label="Harness 组网菜单"]';
try { await page.waitForSelector(ICON, { timeout: 40000 }); }
catch { await page.reload({ waitUntil: "networkidle2" }); await page.waitForSelector(ICON, { timeout: 40000 }); }
await page.click(ICON);
await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent.includes("配置 · 节点管理")), { timeout: 8000 });
await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("配置 · 节点管理")).click());
ok(true, "打开配置·节点管理面板");

// 目标节点行:折叠态无勾选框 → 点 ▸ 展开
await page.waitForFunction((name) => [...document.querySelectorAll("span")].some((sp) => sp.childNodes[0]?.textContent === name), { timeout: 15000 }, NODE);
const rowHasChecks = () => page.evaluate((name) => {
  const sp = [...document.querySelectorAll("span")].find((x) => x.childNodes[0]?.textContent === name);
  const block = sp.closest("div").parentElement;
  return block.querySelectorAll('input[type="checkbox"]').length;
}, NODE);
ok((await rowHasChecks()) === 0, "折叠态行内无勾选框");
await page.evaluate((name) => {
  const sp = [...document.querySelectorAll("span")].find((x) => x.childNodes[0]?.textContent === name);
  sp.closest("div").querySelector("span[title='展开/折叠可用模型']").click();
}, NODE);
await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent.includes("探测可用模型")), { timeout: 8000 });
ok(true, "展开出现探测按钮");

// 探测 → 勾选框出现
await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("探测可用模型")).click());
await page.waitForFunction(() => document.querySelectorAll('input[type="checkbox"]').length > 3, { timeout: 120000 });
const n = await page.evaluate(() => document.querySelectorAll('input[type="checkbox"]').length);
ok(n > 3, `探测到 ${n} 个模型`);

// 勾选第 3 个(前两个可能已在白名单)→ 自动保存(名册刷新后白名单计数变化)
const before = await page.evaluate(async (name) => {
  const d = await (await fetch("/api/harness-mesh/nodes")).json();
  return d.nodes.find((x) => x.name === name)?.models ?? [];
}, NODE);
console.log("勾选前白名单:", JSON.stringify(before));
const boxes = await page.$$('label input[type="checkbox"]');
let target = null;
for (const b of boxes) { if (!(await (await b.getProperty("checked")).jsonValue())) { target = b; break; } }
if (!target) throw new Error("没有未勾选的框可点");
await target.click();   // 真实鼠标,点第一个未勾的(白名单残留会导致前几个已勾,实踩)
await page.waitForFunction(async (name, cnt) => {
  const d = await (await fetch("/api/harness-mesh/nodes")).json();
  return (d.nodes.find((x) => x.name === name)?.models ?? []).length === cnt;
}, { timeout: 15000 }, NODE, before.length + 1);
const after = await page.evaluate(async (name) => {
  const d = await (await fetch("/api/harness-mesh/nodes")).json();
  return d.nodes.find((x) => x.name === name)?.models ?? [];
}, NODE);
ok(after.length === before.length + 1, `勾选即存:${JSON.stringify(after)}`);

// 行尾计数徽标
const rowText = await page.evaluate((name) => {
  const sp = [...document.querySelectorAll("span")].find((x) => x.childNodes[0]?.textContent === name);
  return sp.closest("div").textContent;
}, NODE);
ok(rowText.includes(`模型${after.length}选`), `行尾显示 模型${after.length}选`);

// 派发表单下拉联动
await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "✕")?.click());
await new Promise((r) => setTimeout(r, 400));
await page.click(ICON);
await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent.includes("任务 · 派发与进度")), { timeout: 8000 });
await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("任务 · 派发与进度")).click());
await page.waitForFunction((name) => [...document.querySelectorAll("select")].some((s) => [...s.options].some((o) => o.value === name)), { timeout: 10000 }, NODE);
await page.evaluate((name) => {
  const sel = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === name));
  sel.value = name; sel.dispatchEvent(new Event("change", { bubbles: true }));
}, NODE);
await new Promise((r) => setTimeout(r, 500));
const wlInSelect = await page.evaluate((want) => [...document.querySelectorAll("select")].some((s) => want.every((m) => [...s.options].some((o) => o.value === m))), after);
ok(wlInSelect, "派发表单模型位变下拉(白名单选项)");
await page.screenshot({ path: "/tmp/e2e-node-models.png" });
console.log(failed ? `VERDICT: FAIL(${failed})` : "VERDICT: PASS");
await browser.close();
process.exit(failed ? 1 : 0);
