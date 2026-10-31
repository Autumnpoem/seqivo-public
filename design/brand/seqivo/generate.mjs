import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const shape = 'M288 64H736C891 64 960 133 960 288V736C960 891 891 960 736 960H288C133 960 64 891 64 736V288C64 133 133 64 288 64Z';
// A continuous, rounded S: a plan becomes a visible course of action.
const route = 'M674 306H443C374 306 324 350 324 412C324 474 374 512 443 512H581C650 512 700 550 700 612C700 674 650 718 581 718H350';
const svg = (body, label, size = 1024, viewBox = '0 0 1024 1024') => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}" role="img" aria-label="${label}">${body}</svg>\n`;
const icon = (dark) => svg(`<defs>
  <linearGradient id="tile" x1=".1" y1="0" x2=".9" y2="1"><stop stop-color="${dark ? '#26354c' : '#ffffff'}"/><stop offset="1" stop-color="${dark ? '#101a2b' : '#edf2f9'}"/></linearGradient>
  <linearGradient id="ink" x1=".15" y1="0" x2=".85" y2="1"><stop stop-color="${dark ? '#c8e8ff' : '#559bfa'}"/><stop offset="1" stop-color="${dark ? '#80afff' : '#225ce1'}"/></linearGradient>
</defs><path d="${shape}" fill="url(#tile)"/><path d="${shape}" fill="none" stroke="${dark ? '#a6c6ff' : '#ffffff'}" stroke-opacity="${dark ? '.12' : '.9'}" stroke-width="3"/><path d="${route}" fill="none" stroke="url(#ink)" stroke-width="112" stroke-linecap="round" stroke-linejoin="round"/>`, `序程 Seqivo ${dark ? '夜间' : '日间'}应用图标`);

await mkdir(root, { recursive: true });
await writeFile(path.join(root, 'icon-light.svg'), icon(false));
await writeFile(path.join(root, 'icon-dark.svg'), icon(true));
await writeFile(path.join(root, 'mark.svg'), svg(`<path d="${route}" fill="none" stroke="currentColor" stroke-width="112" stroke-linecap="round" stroke-linejoin="round"/>`, 'Seqivo 标志', 512, '240 240 544 544'));
// Pixel-aligned simplification for 16–24 px menu bars. The application supplies the color.
await writeFile(path.join(root, 'tray.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="M11.5 3.5H6.5C4.8 3.5 3.5 4.4 3.5 5.8S4.8 8 6.5 8H9.5C11.2 8 12.5 8.9 12.5 10.3S11.2 12.5 9.5 12.5H4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>\n`);

await writeFile(path.join(root, 'preview.html'), `<!doctype html>
<html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>序程 · Seqivo</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f2f4f8;color:#172436;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{width:1440px;margin:auto;padding:68px 80px 48px}.header{display:flex;justify-content:space-between;align-items:start}.wordmark{font-size:62px;font-weight:600;letter-spacing:-2.4px;line-height:1}.cn{font-size:28px;font-weight:500;letter-spacing:5px;margin-top:20px}.purpose{text-align:right;padding-top:8px;font-size:14px;letter-spacing:1px;color:#6d7889}.tagline{font-size:22px;letter-spacing:.5px;margin:17px 0 0;color:#293d56}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:48px}.card{height:476px;border-radius:32px;position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden}.light{background:linear-gradient(140deg,#fff,#e9eef6)}.dark{background:linear-gradient(140deg,#1b2638,#101925);color:#edf4ff}.icon{width:300px;height:300px;filter:drop-shadow(0 18px 23px #17263c10)}.dark .icon{filter:drop-shadow(0 18px 23px #00000030)}.label{font-size:15px;margin-top:28px;letter-spacing:3px;font-weight:500;color:#68778d}.dark .label{color:#a7b6cc}
.footer{margin-top:36px;display:flex;align-items:center;justify-content:space-between}.sizes{display:flex;gap:22px;align-items:center;height:58px}.sizes img{display:block}.divider{width:1px;height:28px;background:#d8dee7;margin:0 2px}.mono{display:flex;align-items:center;gap:22px}.mono img{opacity:.82}.note{font-size:13px;line-height:1.8;color:#728096;letter-spacing:.25px;text-align:right}.accent{color:#316deb}
@media(max-width:900px){main{width:100%;padding:32px 20px}.wordmark{font-size:42px}.cn{font-size:22px}.purpose{font-size:11px}.tagline{font-size:15px}.grid{gap:12px;margin-top:30px}.card{height:280px;border-radius:24px}.icon{width:180px;height:180px}.label{font-size:12px;margin-top:16px}.footer{align-items:start;gap:24px}.sizes{gap:10px;flex-wrap:wrap}.note{font-size:10px}.mono{gap:12px}}
</style><main><div class="header"><div><div class="wordmark">Seqivo<span class="accent">.</span></div><div class="cn">序程</div></div><div class="purpose">跨 AI 的任务与验收看板<p class="tagline">让每一步，都有着落。</p></div></div>
<div class="grid"><div class="card light"><img class="icon" src="icon-light.svg" alt="序程日间图标"><div class="label">日间 · 清晰从容</div></div><div class="card dark"><img class="icon" src="icon-dark.svg" alt="序程夜间图标"><div class="label">夜间 · 安静专注</div></div></div>
<div class="footer"><div class="sizes"><img src="icon-light.svg" width="64" height="64" alt="64px"><img src="icon-light.svg" width="48" height="48" alt="48px"><img src="icon-light.svg" width="32" height="32" alt="32px"><img src="icon-light.svg" width="16" height="16" alt="16px"><div class="divider"></div><div class="mono"><img src="tray.svg" width="16" height="16" alt="16px 单色托盘"><img src="tray.svg" width="22" height="22" alt="22px 单色托盘"><img src="mark.svg" width="40" height="40" alt="单色标志"></div></div><div class="note">一条连续的 S 路径<br>串起计划、行动与结果</div></div></main></html>`);
console.log(`Seqivo vector assets written to ${root}`);
