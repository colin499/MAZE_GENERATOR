// Opens the built app in lock box mode from disk, tries to cheat, runs the solve demo and saves screenshots.
// Usage: node scripts/smoke-lockbox.mjs [path-to-html]
import puppeteer from 'puppeteer-core';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';

const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const file = resolve(process.argv[2] || 'app/MazeBuilder.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync('out', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1400,900'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(pathToFileURL(file).href + '#lockbox', { waitUntil: 'load', timeout: 60000 });
await sleep(1500);
const hasCanvas = (await page.$('main canvas')) !== null;
const ring = async () => page.$eval('.dialpos', (el) => el.textContent);
const overlay = async () => page.$eval('.play-overlay', (el) => el.textContent).catch(() => null);
await page.screenshot({ path: 'out/lockbox-start.png' });
// cheat by hand: spin the cap with no ball in the goal, then pull
await page.keyboard.down('q');
await sleep(1500);
await page.keyboard.up('q');
await page.keyboard.press('l');
await sleep(500);
const cheat = { ring: await ring(), overlay: await overlay() };
await page.screenshot({ path: 'out/lockbox-cheat.png' });
// solve demo at 3x
await page.$eval('aside.right input[type=range]:nth-of-type(1)', () => undefined).catch(() => undefined);
const ranges = await page.$$('aside.right input[type=range]');
await ranges[1]?.evaluate((el) => { el.value = '3'; el.dispatchEvent(new Event('input', { bubbles: true })); });
const demoButtons = await page.$$('aside:not(.right) section:nth-of-type(3) button');
await demoButtons[0]?.click();
let mid = null, done = null;
for (let i = 0; i < 80; i++) {
  await sleep(500);
  const o = await overlay();
  if (!mid && o && /clicks|Clutch/.test(o)) { mid = o; await page.screenshot({ path: 'out/lockbox-clutch.png' }); }
  if (o && /^Open/.test(o)) { done = { ring: await ring(), overlay: o }; await sleep(600); await page.screenshot({ path: 'out/lockbox-open.png' }); break; }
}
await sleep(2500);
await page.keyboard.press('t');
await sleep(300);
await page.screenshot({ path: 'out/lockbox-top.png' });
await page.keyboard.press('Escape');
await sleep(500);
const backInEditor = (await page.$('.dialpos')) === null;
console.log(JSON.stringify({ file, hasCanvas, cheat, mid, done, backInEditor, errors }, null, 1));
await browser.close();
const ok = hasCanvas && cheat.ring?.startsWith('0°') && /Locked/.test(cheat.overlay || '') && done && backInEditor && !errors.length;
process.exit(ok ? 0 : 1);
