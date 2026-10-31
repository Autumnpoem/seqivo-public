/** Isolated browser UI + real TerminalClient; only terminal HTTP/WebSocket transport is mocked. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {createCore} from '../../server/core.mjs';
import {startHttp} from '../../server/http.mjs';

const dir=await mkdtemp(join(tmpdir(),'seqivo-owner-recovery-notice-'));
const original={serverName:'default',instanceId:'a'.repeat(64),sessionId:'$1'};
const deadDefault={...original,sessionId:'$2'};
let core,server,browser;
try{
  core=await createCore({dataDir:join(dir,'data'),pluginDir:resolve('plugins'),files:false});
  core.store.project({name:'恢复提示测试',goal:'验证原会话就绪前后提示状态。',directory:dir});
  server=await startHttp({core,dataDir:join(dir,'data'),distDir:resolve(process.env.SEQIVO_TEST_DIST_DIR||'dist'),port:0});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  const page=await context.newPage();
  const pageErrors=[];
  page.on('pageerror',error=>pageErrors.push(error.message));
  await page.addInitScript(token=>sessionStorage.setItem('taskboard-token',token),server.tokens.owner);
  await page.addInitScript(()=>{
    window.__terminalFrames=[];
    window.__terminalSockets=[];
    class MockSocket{
      static OPEN=1;
      constructor(){this.readyState=0;window.__terminalSockets.push(this);setTimeout(()=>{this.readyState=1;this.onopen?.({});},0);}
      send(raw){window.__terminalFrames.push(JSON.parse(raw));}
      close(code=1000){this.readyState=3;this.onclose?.({code});}
      emit(frame){this.onmessage?.({data:JSON.stringify({v:1,...frame})});}
    }
    window.WebSocket=MockSocket;
  });
  await context.route('**/api/terminal/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/terminal/status')return route.fulfill({json:{mode:'local',enabled:true,profiles:[{id:'default',label:'原会话',enabled:true,tmuxAvailable:true}],grants:[],pendingDevices:[],connections:[],link:{status:'connected'}}});
    if(path==='/api/terminal/tickets')return route.fulfill({json:{ticket:'mock-ticket',connectionId:'owner-notice-connection',wsUrl:'wss://terminal.example.test/api/terminal/ws',expiresAt:Date.now()+30000}});
    return route.abort();
  });
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'远程终端'}).click();
  await page.getByRole('button',{name:'连接终端'}).click();
  await page.waitForFunction(()=>window.__terminalSockets.length===1&&window.__terminalFrames.some(frame=>frame.type==='auth'));
  await page.evaluate(()=>{
    const socket=window.__terminalSockets[0];
    socket.emit({type:'authenticated',connectionId:'owner-notice-connection'});
    socket.emit({type:'control',phase:'unknown',managed:true,mode:'managed',owned:false,canReconcileAcquire:true,generation:5,authorizedSessionRefs:[],reason:'原执行权待核对'});
    socket.emit({type:'error',code:'CONTROL_REQUIRED',message:'请核对现场'});
  });
  await page.getByRole('button',{name:'恢复其他设备的执行权'}).click();
  const list=await page.evaluate(()=>window.__terminalFrames.filter(frame=>frame.type==='list').at(-1));
  assert.ok(list?.requestId,'owner recovery requests a correlated live session list');
  await page.evaluate(({requestId,original,deadDefault})=>window.__terminalSockets[0].emit({type:'sessions',requestId,items:[{sessionRef:original,name:'存活 A',attached:false}],defaultRef:deadDefault,defaultRevision:3,available:true}),{requestId:list.requestId,original,deadDefault});
  await page.getByRole('radio',{name:'存活 A'}).check();
  await page.getByRole('button',{name:'确认核对并恢复'}).click();
  const progress=page.getByText('正在核对选中的原会话；默认会话不会改变。',{exact:true});
  await progress.waitFor();
  const recovery=await page.evaluate(()=>window.__terminalFrames.filter(frame=>frame.type==='reconcile-control').at(-1));
  assert.deepEqual(recovery?.sessionRef,original,'owner explicitly submits the original surviving session');
  assert.equal(await page.evaluate(()=>window.__terminalFrames.filter(frame=>frame.type==='default').length),0,'recovery does not change the saved default');
  await page.evaluate(({requestId,original})=>window.__terminalSockets[0].emit({type:'control',phase:'human',managed:true,mode:'managed',owned:true,generation:6,authorizedSessionRefs:[original],requestId}),{requestId:recovery.requestId,original});
  await page.waitForFunction(()=>window.__terminalFrames.some(frame=>frame.type==='select'));
  assert.equal(await progress.isVisible(),true,'human control alone does not claim the terminal is ready');
  assert.equal(await page.locator('.terminal-keys').getByRole('button',{name:'Ctrl',exact:true}).isDisabled(),true);
  await page.evaluate(ref=>window.__terminalSockets[0].emit({type:'ready',connectionId:'owner-notice-connection',epoch:1,sessionRef:ref,offset:0,lastInputSeq:0}),deadDefault);
  assert.equal(await progress.isVisible(),true,'late ready for the dead default cannot clear progress');
  assert.equal(await page.locator('.terminal-keys').getByRole('button',{name:'Ctrl',exact:true}).isDisabled(),true);
  await page.evaluate(ref=>window.__terminalSockets[0].emit({type:'ready',connectionId:'owner-notice-connection',epoch:2,sessionRef:ref,offset:0,lastInputSeq:0}),original);
  await page.getByText('已连接',{exact:true}).waitFor();
  assert.equal(await page.locator('.terminal-keys').getByRole('button',{name:'Ctrl',exact:true}).isDisabled(),false,'only the selected original session enables input');
  await progress.waitFor({state:'hidden'});
  assert.deepEqual(pageErrors,[]);
  console.log('owner recovery notice: pending until exact original ready, then cleared');
}finally{
  await browser?.close();await server?.close();await core?.close();await rm(dir,{recursive:true,force:true});
}
