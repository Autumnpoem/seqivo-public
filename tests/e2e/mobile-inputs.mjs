import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium,webkit} from '@playwright/test';

const engine=process.env.TEST_BROWSER==='webkit'?'webkit':'chromium';
const browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const css=await readFile(new URL('../../src/styles.css',import.meta.url),'utf8');
  await page.setContent(`<style>${css}</style><main class="main"><form class="setting-card"><label class="field">Login<input type="password"></label><label class="field">Project<select><option>One</option></select></label><label class="field">Review<textarea></textarea></label><div class="decision"><button>Pass</button></div></form><div class="setting-card conversation-compose"><label class="field">Conversation<input></label><label class="field">Existing conversation<select></select></label><textarea></textarea></div><label><input type="checkbox"> Keep signed in</label><div class="mobile-controls"><select></select></div></main>`);
  const readSizes=()=>page.locator('input,textarea,select').evaluateAll(nodes=>nodes.map(node=>({type:node.type||node.tagName.toLowerCase(),size:getComputedStyle(node).fontSize})));
  const mobile=await readSizes();
  for(const [index,control] of mobile.entries()){
    if(control.type==='checkbox')assert.equal(control.size,'14px',`checkbox ${index} should remain outside the editable-control rule`);
    else assert.equal(control.size,'16px',`mobile editable control ${index} should use 16px`);
  }
  await page.setViewportSize({width:800,height:900});
  assert.equal(await page.locator('.setting-card input[type=password]').evaluate(node=>getComputedStyle(node).fontSize),'12px','existing desktop setting-card sizing should remain intact');
  const desktop=await readSizes();
  await page.locator('style').evaluate(node=>{node.sheet.deleteRule(node.sheet.cssRules.length-1)});
  assert.deepEqual(await readSizes(),desktop,'mobile override must leave all desktop control sizes unchanged');
  console.log(`PASS [${engine}]: ${mobile.length-1} mobile editable controls are 16px; checkbox excluded; desktop rules unchanged`);
}finally{await browser.close();}
