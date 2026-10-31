/** Isolated Core + browser layout check; terminal traffic is a WS protocol mock, not a PTY. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {createCore} from '../../server/core.mjs';
import {startHttp} from '../../server/http.mjs';

const dir=await mkdtemp(join(tmpdir(),'seqivo-terminal-viewport-'));
const qa=resolve(process.env.QA_DIR||'.runtime/app206/qa');
const ref={serverName:'viewport',instanceId:'b'.repeat(64),sessionId:'$1'};
let core,server,browser;
const installSocketMock=()=>{
  window.__terminalSockets=[];window.__terminalFrames=[];
  class MockSocket{
    static OPEN=1;
    constructor(url){this.url=url;this.readyState=0;window.__terminalSockets.push(this);setTimeout(()=>{this.readyState=1;this.onopen?.({});},0);}
    send(data){window.__terminalFrames.push(JSON.parse(data));}
    close(code=1000){this.readyState=3;this.onclose?.({code});}
    emit(frame){this.onmessage?.({data:JSON.stringify({v:1,...frame})});}
  }
  window.WebSocket=MockSocket;
};
async function geometry(page){return page.evaluate(()=>{
  const box=selector=>{const r=document.querySelector(selector)?.getBoundingClientRect();return r?{top:r.top,bottom:r.bottom,height:r.height}:null};
  return {screen:box('.terminal-screen'),keys:box('.terminal-keys'),session:box('.terminal-session-bar'),nav:box('.mobile-nav'),drawer:box('.terminal-drawer'),scrollY:window.scrollY,focused:document.activeElement?.classList.contains('xterm-helper-textarea')};
});}
function visibleScreen(value,label){assert.ok(value.screen&&value.keys&&value.session,`${label}: terminal controls rendered`);assert.ok(value.screen.top>=-2&&value.screen.bottom<=value.keys.top-8,`${label}: cursor area must fit above keys; ${JSON.stringify(value)}`);assert.ok(value.keys.bottom<=value.session.top+2,`${label}: keys do not cover session picker`);}
async function visiblePrompt(page,label){const value=await page.evaluate(()=>{const row=Array.from(document.querySelectorAll('.xterm-rows > div')).find(element=>element.textContent?.includes('VISIBLE_PROMPT>'));const screen=document.querySelector('.terminal-screen')?.getBoundingClientRect(),keys=document.querySelector('.terminal-keys')?.getBoundingClientRect(),rect=row?.getBoundingClientRect();return {row:rect?{top:rect.top,bottom:rect.bottom}:null,screen:screen?{top:screen.top,bottom:screen.bottom}:null,keysTop:keys?.top}});assert.ok(value.row&&value.screen&&value.keysTop!==undefined&&value.row.top>=value.screen.top&&value.row.bottom<value.keysTop,`${label}: actual rendered prompt is visible; ${JSON.stringify(value)}`);}
try{
  await mkdir(qa,{recursive:true});
  core=await createCore({dataDir:join(dir,'data'),pluginDir:resolve('plugins'),files:false});
  core.store.project({name:'移动终端视口',goal:'只验证隔离浏览器中的布局',directory:dir});
  server=await startHttp({core,dataDir:join(dir,'data'),distDir:resolve(process.env.SEQIVO_TEST_DIST_DIR||'.runtime/app206/web'),port:0});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  await context.addInitScript(token=>sessionStorage.setItem('taskboard-token',token),server.tokens.owner);
  await context.addInitScript(installSocketMock);
  const page=await context.newPage();
  await context.route('**/api/terminal/**',route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(path==='/api/terminal/status')return route.fulfill({json:{mode:'local',enabled:true,profiles:[{id:'default',label:'布局测试',enabled:true,tmuxAvailable:true}],grants:[],pendingDevices:[],connections:[],link:{status:'connected'}}});
    if(path==='/api/terminal/tickets')return route.fulfill({json:{ticket:'layout-ticket',connectionId:'layout-connection',wsUrl:'wss://terminal.example.test/api/terminal/ws',expiresAt:Date.now()+30000}});
    return route.abort();
  });
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'远程终端'}).click();
  await page.getByRole('button',{name:'连接终端'}).click();
  await page.waitForFunction(()=>window.__terminalFrames.some(frame=>frame.type==='auth'));
  await page.evaluate(()=>window.__terminalSockets[0].emit({type:'authenticated',connectionId:'layout-connection'}));
  await page.waitForFunction(()=>window.__terminalFrames.some(frame=>frame.type==='open'));
  await page.evaluate(()=>window.__terminalSockets[0].emit({type:'control',phase:'ai_ready',managed:false,owned:true}));
  await page.evaluate(value=>window.__terminalSockets[0].emit({type:'ready',connectionId:'layout-connection',epoch:1,sessionRef:value,offset:0,lastInputSeq:0}),ref);
  await page.getByText('已连接',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.activeElement?.classList.contains('xterm-helper-textarea'),null,{timeout:3000});
  await page.evaluate(()=>{const data=Array.from({length:18},(_,index)=>`line ${index}\r\n`).join('')+'VISIBLE_PROMPT> ';window.__terminalSockets[0].emit({type:'output',epoch:1,offset:0,data:btoa(data)});});
  await page.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent?.includes('VISIBLE_PROMPT>'));
  await page.setViewportSize({width:390,height:430});
  await page.waitForTimeout(200);
  const small=await geometry(page);visibleScreen(small,'390px with keyboard');
  await visiblePrompt(page,'390px with keyboard');
  await page.screenshot({path:join(qa,'terminal-keyboard-390.png'),animations:'disabled'});
  await page.setViewportSize({width:320,height:400});
  await page.waitForTimeout(200);
  const narrow=await geometry(page);visibleScreen(narrow,'320px with keyboard');
  await visiblePrompt(page,'320px with keyboard');
  await page.screenshot({path:join(qa,'terminal-keyboard-320.png'),animations:'disabled'});
  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(200);
  const restored=await geometry(page);assert.ok(restored.screen.height>=300,'screen grows back when keyboard closes');
  // Android IME can shrink visualViewport without changing layout viewport.
  // This is a browser simulation of that geometry, not a physical IME test.
  await page.evaluate(()=>{Object.defineProperty(window.visualViewport,'height',{configurable:true,value:430});window.visualViewport.dispatchEvent(new Event('resize'));});
  await page.waitForTimeout(100);
  const visualOnly=await geometry(page);
  assert.ok(visualOnly.screen.height<=240,'visualViewport-only shrink resizes xterm container');
  assert.ok(visualOnly.keys.bottom<=430&&visualOnly.session.bottom<=430&&visualOnly.nav.bottom<=430,`visualViewport-only keyboard leaves keys, session and navigation visible; ${JSON.stringify(visualOnly)}`);
  visibleScreen(visualOnly,'visualViewport-only keyboard');
  await visiblePrompt(page,'visualViewport-only keyboard');
  await page.screenshot({path:join(qa,'terminal-visual-viewport-only.png'),animations:'disabled'});
  assert.equal(await page.evaluate(()=>window.__terminalFrames.filter(frame=>frame.type==='input').length),0,'resize itself sends no terminal input');
  await page.evaluate(()=>{Object.defineProperty(window.visualViewport,'offsetTop',{configurable:true,value:30});window.visualViewport.dispatchEvent(new Event('resize'));});
  await page.waitForTimeout(100);
  const shiftedVisual=await geometry(page);
  assert.ok(shiftedVisual.keys.bottom<=460&&shiftedVisual.session.bottom<=460&&shiftedVisual.nav.bottom<=460,`visualViewport offset keeps controls within its visible edge; ${JSON.stringify(shiftedVisual)}`);
  assert.ok(shiftedVisual.screen.bottom<=shiftedVisual.keys.top-8,'visualViewport offset keeps terminal above controls');
  await page.getByRole('button',{name:'Tab',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__terminalFrames.filter(frame=>frame.type==='input').length),1,'visible shortcut receives an ordinary click');
  await page.getByRole('button',{name:/会话：/}).click();
  const visualDrawer=await geometry(page);
  assert.ok(visualDrawer.drawer&&visualDrawer.drawer.top>=0&&visualDrawer.drawer.bottom<=430,`visualViewport-only picker is wholly visible; ${JSON.stringify(visualDrawer)}`);
  await page.getByRole('button',{name:'关闭会话列表'}).click();
  await page.evaluate(()=>{delete window.visualViewport.height;delete window.visualViewport.offsetTop;window.visualViewport.dispatchEvent(new Event('resize'));});
  await page.waitForTimeout(100);
  await page.getByRole('button',{name:/会话：/}).click();
  await page.locator('#terminal-session-drawer').waitFor();
  const drawerBefore=await geometry(page);
  await page.setViewportSize({width:390,height:430});
  await page.waitForTimeout(200);
  const drawerAfter=await geometry(page);
  assert.ok(drawerAfter.drawer,'session picker remains available above the keyboard');
  assert.ok(Math.abs(drawerAfter.scrollY-drawerBefore.scrollY)<12,'open picker is not replaced by automatic terminal scrolling');
  await page.getByRole('button',{name:'关闭会话列表'}).click();
  await page.setViewportSize({width:390,height:844});
  await page.mouse.move(200,170);await page.mouse.wheel(0,-1200);
  await page.waitForTimeout(150);
  const manualBefore=await geometry(page);
  await page.setViewportSize({width:390,height:430});
  await page.waitForTimeout(200);
  const manualAfter=await geometry(page);
  assert.ok(Math.abs(manualAfter.scrollY-manualBefore.scrollY)<12,'keyboard resize respects a deliberate upward review of control cards');
  await page.evaluate(value=>window.__terminalSockets[0].emit({type:'ready',connectionId:'layout-connection',epoch:2,sessionRef:value,offset:0,lastInputSeq:0}),ref);
  await page.waitForTimeout(150);
  const automaticReady=await geometry(page);
  assert.ok(Math.abs(automaticReady.scrollY-manualAfter.scrollY)<12&&!automaticReady.focused,`automatic same-connection ready must preserve manual review and focus; ${JSON.stringify(automaticReady)}`);
  await page.evaluate(()=>window.__terminalSockets[0].close(1006));
  await page.waitForFunction(()=>window.__terminalSockets.length>=2,null,{timeout:5000});
  await page.waitForFunction(()=>window.__terminalFrames.filter(frame=>frame.type==='auth').length>=2);
  await page.evaluate(()=>window.__terminalSockets[1].emit({type:'authenticated',connectionId:'layout-connection'}));
  await page.waitForFunction(()=>window.__terminalFrames.filter(frame=>frame.type==='open').length>=2);
  await page.evaluate(value=>window.__terminalSockets[1].emit({type:'ready',connectionId:'layout-connection',epoch:2,sessionRef:value,offset:0,lastInputSeq:0}),ref);
  await page.waitForTimeout(150);
  const resumedReady=await geometry(page);
  assert.ok(Math.abs(resumedReady.scrollY-manualAfter.scrollY)<12&&!resumedReady.focused,`automatic service recovery must preserve manual review and focus; ${JSON.stringify(resumedReady)}`);
  const otherRef={serverName:'viewport',instanceId:'c'.repeat(64),sessionId:'$2'};
  await page.evaluate(({a,b})=>window.__terminalSockets[1].emit({type:'sessions',items:[{sessionRef:a,name:'A',attached:true},{sessionRef:b,name:'B',attached:false}],defaultRef:a,defaultRevision:0,available:true}),{a:ref,b:otherRef});
  await page.getByRole('button',{name:/会话：/}).click();
  await page.locator('#terminal-session-drawer').getByRole('button',{name:/^B/}).click();
  await page.waitForFunction(()=>window.__terminalFrames.some(frame=>frame.type==='select'));
  await page.evaluate(value=>window.__terminalSockets[1].emit({type:'ready',connectionId:'layout-connection',epoch:3,sessionRef:value,offset:0,lastInputSeq:0}),otherRef);
  await page.waitForTimeout(150);
  const explicitSelection=await geometry(page);
  visibleScreen(explicitSelection,'explicit session selection after manual review');
  assert.ok(explicitSelection.focused,'explicit session selection returns focus to the terminal');
  assert.equal(await page.evaluate(()=>window.__terminalFrames.filter(frame=>frame.type==='input').length),1,'later layout changes send no additional terminal input');
  const readOnlyPage=await context.newPage();
  await readOnlyPage.bringToFront();
  await readOnlyPage.goto(`http://127.0.0.1:${server.port}`);
  await readOnlyPage.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'远程终端'}).click({timeout:5000});
  await readOnlyPage.getByRole('checkbox',{name:/只读查看已有 tmux 会话/}).check();
  await readOnlyPage.getByRole('button',{name:'连接终端'}).click();
  await readOnlyPage.waitForFunction(()=>window.__terminalFrames.some(frame=>frame.type==='auth'));
  await readOnlyPage.evaluate(()=>window.__terminalSockets[0].emit({type:'authenticated',connectionId:'layout-connection'}));
  await readOnlyPage.waitForFunction(()=>window.__terminalFrames.some(frame=>frame.type==='open'));
  await readOnlyPage.evaluate(()=>window.__terminalSockets[0].emit({type:'control',phase:'ai_ready',managed:false,owned:true}));
  await readOnlyPage.evaluate(value=>window.__terminalSockets[0].emit({type:'ready',connectionId:'layout-connection',epoch:1,sessionRef:value,offset:0,lastInputSeq:0}),ref);
  await readOnlyPage.getByText('已连接',{exact:true}).waitFor();
  const readOnlyBefore=await geometry(readOnlyPage);
  await readOnlyPage.setViewportSize({width:390,height:430});await readOnlyPage.waitForTimeout(200);
  const readOnlyAfter=await geometry(readOnlyPage);
  assert.ok(Math.abs(readOnlyAfter.scrollY-readOnlyBefore.scrollY)<12&&!readOnlyAfter.focused,'read-only view does not seize keyboard focus or scroll');
  const confirmPage=await context.newPage();
  await confirmPage.bringToFront();
  await confirmPage.goto(`http://127.0.0.1:${server.port}`);
  await confirmPage.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'远程终端'}).click();
  await confirmPage.getByRole('button',{name:'连接终端'}).click();
  await confirmPage.waitForFunction(()=>window.__terminalFrames.some(frame=>frame.type==='auth'));
  await confirmPage.evaluate(()=>window.__terminalSockets[0].emit({type:'authenticated',connectionId:'layout-connection'}));
  await confirmPage.evaluate(()=>window.__terminalSockets[0].emit({type:'control',phase:'ai_ready',managed:true,owned:false}));
  await confirmPage.getByRole('button',{name:'我来处理'}).click();
  await confirmPage.getByRole('button',{name:'确认停止并接管'}).waitFor();
  const confirmBefore=await geometry(confirmPage);
  await confirmPage.setViewportSize({width:390,height:430});await confirmPage.waitForTimeout(200);
  const confirmAfter=await geometry(confirmPage);
  assert.ok(Math.abs(confirmAfter.scrollY-confirmBefore.scrollY)<12&&!confirmAfter.focused,'unconfirmed takeover remains visible without terminal focus');
  await confirmPage.getByRole('button',{name:'确认停止并接管'}).waitFor();
  await confirmPage.screenshot({path:join(qa,'terminal-confirmation-locked.png'),animations:'disabled'});
  console.log(JSON.stringify({result:'PASS',small,narrow,restored,visualOnly,drawerAfter,manualAfter,automaticReady,resumedReady,explicitSelection,readOnlyAfter,confirmAfter}));
  await context.close();
}finally{await browser?.close();await server?.close();await core?.close();await rm(dir,{recursive:true,force:true});}
