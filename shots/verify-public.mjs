import { chromium, devices } from '@playwright/test';
const URL = 'https://forest-lake.bles-software.com/';
const browser = await chromium.launch();
for (const [name, ctx] of [['desktop', { viewport: { width: 1440, height: 900 } }], ['mobile', devices['iPhone 15 Pro Max']]]) {
  const context = await browser.newContext({ ...ctx, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__luminous?.getState, null, { timeout: 60000 });
  await page.waitForTimeout(5000);
  const state = await page.evaluate(() => window.__luminous.getState());
  await page.screenshot({ path: `artifacts/public-${name}.png` });
  console.log(name, JSON.stringify({ renderer: state.rendererType, fps: state.fps, boat: state.boat, errors }));
  await context.close();
}
await browser.close();
