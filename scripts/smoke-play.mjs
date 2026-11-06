// Headless check of play mode and layer ghosting: autopilot must move the ball and reach a lower layer.
// Usage: node scripts/smoke-play.mjs   (dev server must be running on :5173)
import puppeteer from 'puppeteer-core';

const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1500,950'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0', timeout: 60000 });
await sleep(1500);

const clickButton = async (label) => {
  const handle = await page.evaluateHandle((l) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === l), label);
  await handle.click();
};
const text = (sel) => page.$eval(sel, (el) => el.textContent).catch(() => null);

// 1. ghost a layer: focus the top layer, others become translucent
await clickButton('2 (top)');
await sleep(400);
const layerTable = await text('table.layer-table');
await page.screenshot({ path: 'out/layers-ghost.png' });
await clickButton('All');

// 2. play with the autopilot
await page.evaluate(() => { const cb = [...document.querySelectorAll('label.check input')][0]; if (!cb.checked) cb.click(); });
await clickButton('▶ Play');
await sleep(600);
const overlay0 = await text('.play-overlay');
const status0 = await text('section.play table');
await sleep(9000);
const overlay1 = await text('.play-overlay');
const status1 = await text('section.play table');
const log = await text('.log');
await page.screenshot({ path: 'out/play.png' });

// 3. manual control: switch autopilot off, hold the right arrow, the tilt must become positive
await page.evaluate(() => { const cb = [...document.querySelectorAll('label.check input')][0]; if (cb.checked) cb.click(); });
await page.keyboard.down('ArrowRight');
await sleep(700);
const status2 = await text('section.play table');
await page.keyboard.up('ArrowRight');
await page.keyboard.press('r');
await sleep(300);
const status3 = await text('section.play table');
await page.keyboard.press('Escape');
await sleep(300);
const stopped = (await page.$('.play-overlay')) === null;

console.log(JSON.stringify({ layerTable, overlay0, status0, overlay1, status1, log, status2, status3, stopped, errors }, null, 1));
await browser.close();
