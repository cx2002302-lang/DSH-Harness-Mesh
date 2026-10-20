// 无头验证 DSB 按钮:地址栏无 token + DSB 正常落地(非 401)
// 用法:DSH_TOKEN=<主GUI token> node test/e2e-dsb-button.mjs(需本机 google-chrome + puppeteer-core)
import puppeteer from "puppeteer-core";

const BASE = process.env.DSH_BASE ?? "http://127.0.0.1:80";
const TOKEN = process.env.DSH_TOKEN ?? "";
const shot = (page, name) => page.screenshot({ path: `/tmp/dsb-btn-${name}.png` });

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--window-size=1440,900"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

// 1) 开主 GUI(token 经 303 换 cookie)
await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: "networkidle2", timeout: 30000 });
console.log("主 GUI 落地:", page.url());

// 2) 等机器人按钮出现(插件 nav 注入)
const BTN = 'button[data-hm-plugin-icon="DeepSeekBot · Bot 团队(打开 DSB 实例)"]';
await page.waitForSelector(BTN, { timeout: 45000 });
console.log("按钮已出现");

// 3) 盯新标签页 + iframe 预登录
const newTarget = new Promise((res) => browser.once("targetcreated", (t) => res(t)));
const iframeSeen = new Promise((res) => {
  page.on("framenavigated", (f) => { if (f !== page.mainFrame()) res(f.url()); });
  setTimeout(() => res(null), 8000);
});
await page.click(BTN);

const t = await newTarget;
const newPage = await t.page();
await newPage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
const finalUrl = newPage.url();
const iframeUrl = await iframeSeen;
console.log("iframe 预登录 URL 含 token?", iframeUrl ? (iframeUrl.includes("token=") ? "是(正常,藏在 iframe)" : iframeUrl) : "(未见 iframe)");
console.log("新标签最终地址:", finalUrl);
console.log("地址栏含 token?", finalUrl.includes("token=") ? "❌ 是" : "✅ 否");

// 4) 新标签内容:不应是 authentication required
const bodyText = await newPage.evaluate(() => document.body?.innerText?.slice(0, 300) ?? "");
const authFail = /authentication required/i.test(bodyText);
console.log("页面含 authentication required?", authFail ? "❌ 是" : "✅ 否");
console.log("页面片段:", JSON.stringify(bodyText.slice(0, 120)));
await newPage.screenshot({ path: "/tmp/dsb-btn-newtab.png" });
await shot(page, "maingui");

const cookies = await page.cookies("http://127.0.0.1:31967/");
console.log("DSB cookie 已种:", cookies.length > 0 ? "✅ " + cookies.map((c) => c.name.slice(0, 20) + "…").join(",") : "❌ 无");
console.log(authFail || finalUrl.includes("token=") ? "VERDICT: FAIL" : "VERDICT: PASS");
await browser.close();
