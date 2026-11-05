// Headless smoke test of the editor: loads the page, exercises generate / click / undo, reports console errors.
// Usage: node scripts/smoke-editor.mjs   (dev server must be running on :5173)
import puppeteer from 'puppeteer-core';

const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const out = process.env.OUT || 'out/editor.png';
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

const scoreText = () => page.$eval('.score', (el) => el.textContent);
const clickButton = async (label) => {
  const handle = await page.evaluateHandle((l) => [...document.querySelectorAll('button')].find((b) => b.textContent === l), label);
  await handle.click();
};
const score1 = await scoreText();
await clickButton('Next seed');
await sleep(800);
const score2 = await scoreText();
await page.keyboard.down('Meta'); await page.keyboard.press('z'); await page.keyboard.up('Meta');
await sleep(500);
const score3 = await scoreText();

// hover + click the centre of the canvas with the wall tool
const canvas = await page.$('main canvas');
const box = await canvas.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await sleep(300);
const hudHover = await page.$eval('.hud', (el) => el.textContent);
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await sleep(500);
const score4 = await scoreText();
const checks = await page.$eval('aside.right', (el) => el.textContent);
await page.screenshot({ path: out });
console.log(JSON.stringify({ score1, score2, score3, hudHover, score4, checks: checks.slice(0, 160), errors }, null, 1));
await browser.close();
