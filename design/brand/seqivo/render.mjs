import { chromium } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const executablePath = process.env.SEQIVO_CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 890 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(path.join(root, 'preview.html')).href);
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(image => image.decode())); });
  await page.screenshot({ path: path.join(root, 'preview.png') });
  const overflow = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
  if (overflow.width > 1440 || overflow.height > 890) throw new Error(`Preview overflow: ${JSON.stringify(overflow)}`);
  for (const theme of ['light', 'dark']) {
    const output = path.join(root, 'exports', theme);
    await mkdir(output, { recursive: true });
    const source = await readFile(path.join(root, `icon-${theme}.svg`), 'utf8');
    for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:100vw;height:100vh;display:block}</style>${source}`);
      await page.screenshot({ path: path.join(output, `${size}.png`), omitBackground: true });
    }
  }
  const tray = await readFile(path.join(root, 'tray.svg'), 'utf8');
  for (const [variant, color] of [['black', '#000'], ['white', '#fff']]) {
    for (const size of [16, 22, 32, 44]) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(`<style>html,body{margin:0;background:transparent;color:${color}}svg{width:100vw;height:100vh;display:block}</style>${tray}`);
      await page.screenshot({ path: path.join(root, `tray-${variant}-${size}.png`), omitBackground: true });
    }
  }
  console.log('Rendered 1440×890 preview, 16 application PNGs and 8 template/tray PNGs. No preview overflow.');
} finally { await browser.close(); }
