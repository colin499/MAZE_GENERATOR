// Opens the built single-file app straight from disk (file://) and checks it renders and plays without errors.
// Usage: node scripts/smoke-file.mjs [path-to-html]
import puppeteer from 'puppeteer-core';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const file = resolve(process.argv[2] || 'app/MazeBuilder.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1400,900'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()}`));
await page.goto(pathToFileURL(file).href, { waitUntil: 'load', timeout: 60000 });
await sleep(1500);
const score = await page.$eval('.score', (el) => el.textContent).catch(() => null);
const hasCanvas = (await page.$('main canvas')) !== null;
await page.keyboard.press('p');
await sleep(2500);
const overlay = await page.$eval('.play-overlay', (el) => el.textContent).catch(() => null);
await page.screenshot({ path: 'out/file-app.png' });
console.log(JSON.stringify({ file, score, hasCanvas, overlay, errors }, null, 1));
await browser.close();
process.exit(errors.length || !hasCanvas || !overlay ? 1 : 0);
