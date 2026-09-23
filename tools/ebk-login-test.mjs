// GitHub Actions 登录可行性测试：只验证「能否用账号密码登录并调通接口」
// 不打印任何账号密码；日志可公开，故只输出布尔/长度等非敏感信息
import { chromium } from "playwright";

const USER = process.env.EBK_USER || "";
const PASS = process.env.EBK_PASS || "";
const PATH_ONLY = u => { try { return new URL(u).pathname; } catch { return "(bad-url)"; } };

if (!USER || !PASS) {
  console.log("RESULT=NO_CREDS （未配置 EBK_USER / EBK_PASS）");
  process.exit(1);
}

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({
  locale: "zh-CN",
  timezoneId: "Asia/Shanghai",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
  viewport: { width: 1440, height: 900 },
});
const page = await ctx.newPage();

let captcha = false;
try {
  await page.goto("https://ebooking.ctrip.com/login", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(6000);
  console.log("STEP1_login_page=" + PATH_ONLY(page.url()));

  // 填账号密码
  let filled = false;
  const uSel = ['input[placeholder="输入用户名"]', 'input[placeholder*="用户名"]', 'input[name*=user i]', 'input[type=text]'];
  const pSel = ['input[placeholder="输入密码"]', 'input[placeholder*="密码"]', 'input[type=password]'];
  for (const s of uSel) { const el = page.locator(s).first(); if (await el.count()) { await el.fill(USER).catch(() => {}); filled = true; break; } }
  for (const s of pSel) { const el = page.locator(s).first(); if (await el.count()) { await el.fill(PASS).catch(() => {}); break; } }
  console.log("STEP2_filled=" + filled);

  // 勾选协议（如有）
  try { const cbs = page.locator('input[type=checkbox]'); const n = await cbs.count(); for (let i = 0; i < n; i++) { await cbs.nth(i).check({ force: true, timeout: 1000 }).catch(() => {}); } } catch {}

  // 点登录
  let clicked = false;
  for (const t of ["登录", "登 录", "立即登录"]) {
    const b = page.getByRole("button", { name: t }).first();
    if (await b.count()) { await b.click({ timeout: 5000 }).catch(() => {}); clicked = true; break; }
    const b2 = page.getByText(t, { exact: true }).first();
    if (await b2.count()) { await b2.click({ timeout: 5000 }).catch(() => {}); clicked = true; break; }
  }
  console.log("STEP3_clicked=" + clicked);

  await page.waitForTimeout(15000);
  const path2 = PATH_ONLY(page.url());
  console.log("STEP4_after_login=" + path2);

  const text = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 500));
  captcha = /滑块|安全验证|拖动|验证码|请完成验证|异常/.test(text);
  console.log("STEP5_captcha_or_risk=" + captcha);
  console.log("STEP5_login_ok=" + !/login/i.test(path2));

  // 若已登录，测一个商品接口
  if (!/login/i.test(path2)) {
    await page.goto("https://ebooking.ctrip.com/hmall/list", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(6000);
    const r = await page.evaluate(async () => {
      try {
        const res = await fetch("/hmall/api/product/getProduct", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ productId: "475", country: 1, province: null, city: 22249, district: null, subDistrict: null, latitude: 31.225599, longitude: 121.36413 }),
        });
        const t = await res.text();
        return { status: res.status, len: t.length, ok: t.indexOf("<code>200</code>") >= 0, hasName: /<name>/.test(t) && !/<name><\/name>/.test(t) };
      } catch (e) { return { err: String(e).slice(0, 80) }; }
    });
    console.log("STEP6_api=" + JSON.stringify(r));
    console.log("RESULT=" + ((r && r.ok && r.hasName) ? "SUCCESS 登录+接口都通，可以走 GitHub Actions" : "API_FAIL 登录可能成功但接口没数据"));
  } else {
    console.log("RESULT=" + (captcha ? "CAPTCHA 被风控拦截" : "LOGIN_FAIL 登录未成功"));
  }
} catch (e) {
  console.log("ERROR=" + String(e).slice(0, 200));
}

await browser.close();
