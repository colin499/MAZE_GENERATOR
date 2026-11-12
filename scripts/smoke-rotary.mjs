// Opens the built app in rotary mode from disk, plays a little, runs a demo and saves screenshots.
// Usage: node scripts/smoke-rotary.mjs [path-to-html]
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
await page.goto(pathToFileURL(file).href + '#rotary', { waitUntil: 'load', timeout: 60000 });
await sleep(1500);
const hasCanvas = (await page.$('main canvas')) !== null;
const dial = async () => page.$eval('.dialpos', (el) => el.textContent);
const dial0 = await dial();
await page.screenshot({ path: 'out/rotary-start.png' });
await page.keyboard.press('e');
await page.keyboard.down('ArrowRight');
await sleep(1500);
await page.keyboard.up('ArrowRight');
const dial1 = await dial();
await page.screenshot({ path: 'out/rotary-play.png' });
// second demo button = first one after the three "Maze N" buttons and the load button
const demoButtons = await page.$$('aside:not(.right) section:nth-of-type(3) button');
await demoButtons[Math.min(3, demoButtons.length - 1)]?.click();
await sleep(6000);
const overlay = await page.$eval('.play-overlay', (el) => el.textContent).catch(() => null);
await page.screenshot({ path: 'out/rotary-demo.png' });
await page.keyboard.press('Escape');
await sleep(300);
await page.keyboard.press('Escape');
await sleep(500);
const backInEditor = (await page.$('.dialpos')) === null;
console.log(JSON.stringify({ file, hasCanvas, dial0, dial1, demos: demoButtons.length, overlay, backInEditor, errors }, null, 1));
await browser.close();
process.exit(errors.length || !hasCanvas || !overlay || !backInEditor || demoButtons.length < 1 ? 1 : 0);
