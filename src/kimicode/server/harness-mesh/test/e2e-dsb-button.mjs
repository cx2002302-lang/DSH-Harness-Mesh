// 无头验证 DSH 与 DeepSeekBot 在同一页面、同一进程内双向切换。
// 用法:DSH_TOKEN=<主GUI token> node test/e2e-dsb-button.mjs(需本机 google-chrome + puppeteer-core)
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const BASE = process.env.DSH_BASE ?? "http://127.0.0.1:80";
const TOKEN = process.env.DSH_TOKEN ?? "";
const BOT_ENTRY = 'nav button[aria-label="Bot 模式"]';
const BOT_RAIL = ".bh-workspace-rail";
const shot = (page, name) => page.screenshot({ path: `/tmp/dsb-btn-${name}.png` });

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--window-size=1440,900"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(BOT_ENTRY, { visible: true, timeout: 45000 });
  assert.equal(await page.$(BOT_RAIL), null, "默认应显示 DSH 主界面");
  const mainUrl = page.url();

  await page.click(BOT_ENTRY);
  await page.waitForSelector(BOT_RAIL, { visible: true, timeout: 15000 });
  assert.equal(page.url(), mainUrl, "进入 Bot 不应改变 URL 或端口");
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === "知道了");
    button?.click();
  });
  await shot(page, "bot");

  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(BOT_ENTRY, { visible: true, timeout: 45000 });
  assert.equal(await page.$(BOT_RAIL), null, "刷新后应回到 DSH 主界面");

  await page.click(BOT_ENTRY);
  await page.waitForSelector(BOT_RAIL, { visible: true, timeout: 15000 });
  await page.click(".bh-workspace-exit");
  await page.waitForSelector(BOT_ENTRY, { visible: true, timeout: 15000 });
  assert.equal(await page.$(BOT_RAIL), null, "退出后应回到 DSH 主界面");
  assert.equal(page.url(), mainUrl, "返回 DSH 不应改变 URL 或端口");
  assert.equal((await browser.pages()).length, 1, "切换不应打开新标签页");
  const externalBotRequests = await page.evaluate(() =>
    performance.getEntriesByType("resource").some((entry) => entry.name.includes(":31967")),
  );
  assert.equal(externalBotRequests, false, "切换不应请求第二套 31967 实例");
  await shot(page, "maingui");
  console.log("VERDICT: PASS — DSH/Bot 同页双向切换,无新标签、无第二端口");
} finally {
  await browser.close();
}
