import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

// Run against an isolated local snapshot; never creates paid AI calls.
const base = process.env.BROWSER_TEST_BASE || "http://127.0.0.1:4174";
const out = process.env.BROWSER_TEST_OUTPUT || ".local-data/browser-acceptance";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error("Use an isolated localhost server for write-interaction checks");
await mkdir(out, {recursive:true});
const browser = await chromium.launch({headless:true});
try {
  const context = await browser.newContext({viewport:{width:1440,height:1000}});
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const views = ["overview","top50","market","portfolio","news","ai","industries","strategies","tools","review","accuracy","risk","operations"];
  const checked = [];
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:width===390?844:1000});
    for (const view of views) {
      await page.goto(`${base}/?view=${view}`);
      await page.waitForTimeout(600);
      const size = await page.evaluate(()=>({content:document.documentElement.scrollWidth, viewport:innerWidth, text:document.body.innerText.length}));
      assert.ok(size.text>100, `${view} rendered content`);
      assert.ok(size.content<=size.viewport+1, `${view} ${width}: horizontal overflow ${size.content}`);
      checked.push({view,width});
    }
    await page.goto(base);
    await page.waitForTimeout(600);
    await page.screenshot({path:`${out}/home-${width}.png`,fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(`${base}/?view=portfolio`);
  await page.getByRole("button",{name:"导入 / 导出"}).click();
  await page.locator("#portfolio-transfer").fill("bad-code");
  await page.getByRole("button",{name:"合并导入"}).click();
  await page.getByRole("status").filter({hasText:"有效"}).waitFor();
  await page.locator("#portfolio-transfer").fill("600036,000001,600036");
  await page.getByRole("button",{name:"合并导入"}).click();
  await page.waitForTimeout(400);
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem("stock-watchlist"))), ["600036","000001"]);
  await page.reload();
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem("stock-watchlist"))), ["600036","000001"]);
  const tab = await context.newPage();
  await tab.goto(`${base}/?view=portfolio`);
  await tab.getByRole("button",{name:"导入 / 导出"}).click();
  await tab.locator("#portfolio-transfer").fill("601398");
  await tab.getByRole("button",{name:"合并导入"}).click();
  await page.waitForTimeout(500);
  await page.getByRole("button",{name:"导入 / 导出"}).click();
  assert.match(await page.locator("#portfolio-transfer").inputValue(), /601398/);
  await page.keyboard.press("Tab");
  assert.notEqual(await page.evaluate(()=>document.activeElement.tagName), "BODY");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({status:"passed",checked,interactions:["invalid import","deduplicated merge","reload persistence","cross-tab sync","keyboard focus"],pageErrors:errors}));
} finally { await browser.close(); }
