/** 无头验收:节点管理"可用模型"改造
 *  流程:开 GUI → 网格菜单 → 配置·节点管理 → 编辑 opencode-local → 展开可用模型 →
 *        探测(真拉起本机 opencode acp)→ 勾选 2 个 → 保存 → 断言 nodes.json 持久化
 *        + 节点行"模型N选" + 派发表单变下拉。
 *  用法:DSH_TOKEN=<token> node test/e2e-node-models.mjs(需本机 google-chrome + puppeteer-core)
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

// 1) 网格图标 → 小菜单 → 配置·节点管理
await page.waitForSelector('button[aria-label="Harness 组网菜单"]', { timeout: 45000 });
await page.click('button[aria-label="Harness 组网菜单"]');
await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent.includes("配置 · 节点管理")), { timeout: 8000 });
await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("配置 · 节点管理")).click());
ok(true, "打开配置·节点管理面板");

// 2) 找到目标节点行 → 编辑
await page.waitForFunction((name) => [...document.querySelectorAll("div")].some((d) => d.textContent.includes(name) && [...d.querySelectorAll("button")].some((b) => b.textContent === "编辑")), { timeout: 15000 }, NODE);
await page.evaluate((name) => {
  const row = [...document.querySelectorAll("div")].find((d) => d.textContent.includes(name) && [...d.querySelectorAll("button")].some((b) => b.textContent === "编辑"));
  [...row.querySelectorAll("button")].find((b) => b.textContent === "编辑").click();
}, NODE);
ok(true, `进入 ${NODE} 编辑表单`);

// 3) 可用模型区:默认折叠 → 展开 → 探测
await page.waitForFunction(() => [...document.querySelectorAll("div")].some((d) => d.textContent.trim().startsWith("可用模型")), { timeout: 8000 });
const collapsedHasList = await page.evaluate(() => document.querySelectorAll('input[type="checkbox"]').length > 0);
ok(!collapsedHasList, "折叠态不出勾选框");
await page.evaluate(() => [...document.querySelectorAll("div")].find((d) => d.textContent.trim().startsWith("▸") || d.textContent.trim().startsWith("可用模型")).click());
await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent.includes("探测可用模型")), { timeout: 8000 });
ok(true, "展开后出现探测按钮");

await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("探测可用模型")).click());
await page.waitForFunction(() => document.querySelectorAll('input[type="checkbox"]').length > 3, { timeout: 120000 });
const probeCount = await page.evaluate(() => document.querySelectorAll('input[type="checkbox"]').length);
ok(probeCount > 3, `探测到 ${probeCount} 个模型`);

// 4) 勾选前 2 个 → 保存
const picked = await page.evaluate(() => {
  const labels = [...document.querySelectorAll("label")].filter((l) => l.querySelector('input[type="checkbox"]'));
  const out = [];
  for (const l of labels.slice(0, 2)) { l.querySelector("input").click(); out.push(l.textContent.trim().slice(0, 30)); }
  return out;
});
console.log("勾选:", picked.join(" | "));
await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "保存").click());
await page.waitForFunction(() => [...document.querySelectorAll("div")].some((d) => d.textContent.includes("已保存")), { timeout: 10000 });
ok(true, "保存成功提示出现");

// 5) 持久化断言(服务端 nodes.json)
const persisted = await page.evaluate(async (name) => {
  const r = await fetch("/api/harness-mesh/nodes");
  const d = await r.json();
  return d.nodes.find((n) => n.name === name)?.models ?? null;
}, NODE);
ok(Array.isArray(persisted) && persisted.length === 2, `nodes.json 持久化白名单: ${JSON.stringify(persisted)}`);

// 6) 节点行显示"模型2选"
const rowText = await page.evaluate((name) => {
  const row = [...document.querySelectorAll("div")].find((d) => d.textContent.includes(name) && [...d.querySelectorAll("button")].some((b) => b.textContent === "编辑"));
  return row?.textContent ?? "";
}, NODE);
ok(rowText.includes("模型2选"), "节点行显示 模型2选");

// 7) 派发表单:选该节点 → 模型输入变下拉
await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("📋 任务") || b.textContent.includes("任务 ·"))?.click());
await page.waitForFunction((name) => [...document.querySelectorAll("select")].some((s) => [...s.options].some((o) => o.value === name)), { timeout: 10000 }, NODE);
await page.evaluate((name) => {
  const sel = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === name));
  const ev = new Event("change", { bubbles: true });
  sel.value = name; sel.dispatchEvent(ev);
}, NODE);
await new Promise((r) => setTimeout(r, 500));
const selectHasWl = await page.evaluate(() => [...document.querySelectorAll("select")].some((s) => [...s.options].some((o) => o.textContent.includes("GLM") || o.value.includes("/"))));
ok(selectHasWl, "派发表单模型位变下拉(白名单选项)");

await page.screenshot({ path: "/tmp/e2e-node-models.png" });
console.log(failed ? `VERDICT: FAIL(${failed})` : "VERDICT: PASS");
await browser.close();
process.exit(failed ? 1 : 0);
