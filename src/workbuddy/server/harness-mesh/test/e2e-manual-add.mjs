// 手填兜底验收:zcode 行展开 → 探测(0 模型)→ 手填添加 → 持久化
import puppeteer from "puppeteer-core";
const NODE = "node-win-01-zcode";
let failed = 0;
const ok = (c, l) => { console.log(c ? `✅ ${l}` : `❌ ${l}`); if (!c) failed++; };
const browser = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto("http://127.0.0.1:80/?token=88888888", { waitUntil: "networkidle2", timeout: 30000 });
const ICON = 'button[aria-label="Harness 组网菜单"]';
try { await page.waitForSelector(ICON, { timeout: 40000 }); } catch { await page.reload({ waitUntil: "networkidle2" }); await page.waitForSelector(ICON, { timeout: 40000 }); }
await page.click(ICON);
await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("配置 · 节点管理")).click());
await page.waitForFunction((n) => [...document.querySelectorAll("span")].some((sp) => sp.childNodes[0]?.textContent === n), { timeout: 15000 }, NODE);
await page.evaluate((n) => {
  const sp = [...document.querySelectorAll("span")].find((x) => x.childNodes[0]?.textContent === n);
  sp.closest("div").querySelector("span[title='展开/折叠可用模型']").click();
}, NODE);
await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent.includes("探测可用模型")), { timeout: 8000 });
// 手填输入框在零探测时也必须在
ok(await page.evaluate(() => [...document.querySelectorAll("input")].some((i) => i.placeholder.includes("手填模型 id"))), "未探测也有手填输入框");
// 探测:zcode 应提示不上报
await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("探测可用模型")).click());
await page.waitForFunction(() => [...document.querySelectorAll("span")].some((sp) => sp.textContent.includes("不上报模型表")), { timeout: 120000 });
ok(true, "zcode 探测提示『不上报=不限制』");
// 手填添加
const input = (await page.evaluateHandle(() => [...document.querySelectorAll("input")].find((i) => i.placeholder.includes("手填模型 id")))).asElement();
await input.type("zcode/glm-4.6");
await input.press("Enter");
await page.waitForFunction(async (n) => {
  const d = await (await fetch("/api/harness-mesh/nodes")).json();
  return (d.nodes.find((x) => x.name === n)?.models ?? []).includes("zcode/glm-4.6");
}, { timeout: 15000 }, NODE);
ok(true, "手填即存:zcode/glm-4.6 落 nodes.json");
// 重复添加闪红(不重复落)
await input.type("zcode/glm-4.6");
await input.press("Enter");
await new Promise((r) => setTimeout(r, 1200));
const cnt = await page.evaluate(async (n) => {
  const d = await (await fetch("/api/harness-mesh/nodes")).json();
  return (d.nodes.find((x) => x.name === n)?.models ?? []).filter((m) => m === "zcode/glm-4.6").length;
}, NODE);
ok(cnt === 1, "重复添加被拒(仍只 1 条)");
console.log(failed ? `VERDICT: FAIL(${failed})` : "VERDICT: PASS");
await browser.close();
process.exit(failed ? 1 : 0);
