// Headless check of the shell topologies in the editor: generate each shape, screenshot it (3D + unfolded),
// then play it with the autopilot and confirm the ball moves and nothing errors.
// Usage: node scripts/smoke-shapes.mjs   (dev server must be running on :5173)
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
await sleep(1200);

const clickButton = async (label) => {
  const handle = await page.evaluateHandle((l) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === l), label);
  await handle.click();
};
const text = (sel) => page.$eval(sel, (el) => el.textContent).catch(() => null);
const setCheck = async (index, on) => page.evaluate((i, v) => { const cb = [...document.querySelectorAll('label.check input')][i]; if (cb.checked !== v) cb.click(); }, index, on);

const results = {};
for (const kind of ['cylinder', 'cube', 'sphere']) {
  await page.select('select', kind);
  await clickButton('Generate');
  await sleep(1200);
  const score = await text('.score');
  const checks = await text('aside.right');
  await page.screenshot({ path: `out/shape-${kind}.png` });
  await clickButton('Unfolded');
  await sleep(600);
  await page.screenshot({ path: `out/shape-${kind}-net.png` });
  await clickButton('3D');
  await sleep(300);
  await setCheck(0, true); // autopilot
  await clickButton('▶ Play');
  await sleep(500);
  const s0 = await text('section.play table');
  await sleep(8000);
  const s1 = await text('section.play table');
  await page.screenshot({ path: `out/shape-${kind}-play.png` });
  await page.keyboard.press('Escape');
  await sleep(300);
  results[kind] = { score, solvable: /Solvable/.test(checks || ''), s0, s1 };
}
console.log(JSON.stringify({ results, errors: errors.slice(0, 10) }, null, 1));
await browser.close();
