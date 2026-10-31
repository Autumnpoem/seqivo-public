/** Real xterm DOM events with an isolated Core and mocked terminal WebSocket; no PTY. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {createCore} from '../../server/core.mjs';
import {startHttp} from '../../server/http.mjs';

const dir=await mkdtemp(join(tmpdir(),'seqivo-ime-'));
const ref={serverName:'ime',instanceId:'b'.repeat(64),sessionId:'$1'};
let core,server,browser;
const socketMock=()=>{
  Error.stackTraceLimit=30;
  window.__terminalSockets=[];window.__terminalFrames=[];
  class Socket{
    static OPEN=1;
    constructor(){this.readyState=0;window.__terminalSockets.push(this);setTimeout(()=>{this.readyState=1;this.onopen?.({});},0);}
    send(value){const frame=JSON.parse(value);if(frame.type==='input')frame.testStack=new Error().stack?.split('\n').slice(10,28);window.__terminalFrames.push(frame);}
    close(code=1000){this.readyState=3;this.onclose?.({code});}
    emit(frame){this.onmessage?.({data:JSON.stringify({v:1,...frame})});}
  }
  window.WebSocket=Socket;
};
const values=page=>page.evaluate(()=>window.__terminalFrames.filter(frame=>frame.type==='input').map(frame=>new TextDecoder().decode(Uint8Array.from(atob(frame.data),char=>char.charCodeAt(0)))));
const acknowledge=page=>page.evaluate(()=>{for(const frame of window.__terminalFrames.filter(item=>item.type==='input'))window.__terminalSockets[0].emit({type:'inputAck',epoch:frame.epoch,seq:frame.seq,status:'written'});});
const fireKey=(page,scenario)=>page.evaluate(async scenario=>{
  const textarea=document.querySelector('.xterm-helper-textarea');
  const fire=(type,key,charCode,isComposing)=>{
    const keyCode=key.length===1?key.toUpperCase().charCodeAt(0):key==='Enter'?13:16;
    const event=new KeyboardEvent(type,{bubbles:true,cancelable:true,composed:true,key,code:key.length===1?`Key${key.toUpperCase()}`:key,isComposing});
    Object.defineProperties(event,{keyCode:{value:keyCode},which:{value:charCode||0},charCode:{value:charCode||0}});
    textarea.dispatchEvent(event);
  };
  window.__terminalFrames=[];
  textarea.value='';
  if(scenario==='plain-pp'||scenario==='missing-start'){
    for(const key of scenario==='plain-pp'?['P','P']:['P']){
      const composing=scenario==='missing-start';
      fire('keydown',key,0,composing);fire('keypress',key,key.charCodeAt(0),composing);
      textarea.value+=key;textarea.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,data:key,inputType:'insertText'}));
      fire('keyup',key,0,composing);
    }
    return;
  }
  if(scenario==='input-only'||scenario==='input-only-text'){
    const data=scenario==='input-only'?'😀':'好';
    textarea.value=data;
    textarea.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,data,inputType:'insertText'}));
    return;
  }
  if(['chinese','enter','suffix','late-before','late-after','input-only-suffix','active-enter'].includes(scenario)){
    textarea.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    textarea.value='中';textarea.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'中'}));
    await new Promise(resolve=>setTimeout(resolve,0));
    if(scenario==='active-enter'){
      fire('keydown','Enter',0,true);
      textarea.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中'}));
      fire('keyup','Enter',0,true);
      return;
    }
    textarea.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中'}));
    if(scenario==='enter'){fire('keydown','Enter',0,false);fire('keyup','Enter',0,false);}
    if(scenario==='input-only-suffix'){
      textarea.value+='X';textarea.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,data:'X',inputType:'insertText'}));
    }
    if(['suffix','late-before','late-after'].includes(scenario)){
      fire('keydown','Shift',0,false);fire('keydown','X',0,false);fire('keypress','X',88,false);textarea.value+='X';fire('keyup','X',0,false);fire('keyup','Shift',0,false);
      if(scenario==='late-after')await new Promise(resolve=>setTimeout(resolve,0));
      if(scenario!=='suffix')textarea.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,data:'中',inputType:'insertText'}));
    }
    return;
  }
  // Android trace: the printable keypress is dispatched while composition is
  // active, then compositionend schedules a second copy from textarea.value.
  textarea.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
  fire('keydown','Shift',0,true);fire('keydown','P',0,true);fire('keypress','P',80,true);
  textarea.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'P'}));
  textarea.value='P';textarea.dispatchEvent(new InputEvent('input',{bubbles:true,composed:scenario!=='noncomposed-input',data:'P',inputType:'insertText'}));
  fire('keyup','P',0,true);fire('keyup','Shift',0,true);
},scenario);
try{
  core=await createCore({dataDir:join(dir,'data'),pluginDir:resolve('plugins'),files:false});
  core.store.project({name:'IME 隔离回归',goal:'只测试本地浏览器事件',directory:dir});
  server=await startHttp({core,dataDir:join(dir,'data'),distDir:resolve(process.env.SEQIVO_TEST_DIST_DIR||'.runtime/app206/r4-web'),port:0});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:390,height:800},serviceWorkers:'block'});
  await context.addInitScript(token=>sessionStorage.setItem('taskboard-token',token),server.tokens.owner);
  await context.addInitScript(socketMock);
  const page=await context.newPage();
  await context.route('**/api/terminal/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/terminal/status')return route.fulfill({json:{mode:'local',enabled:true,profiles:[{id:'default',label:'IME',enabled:true,tmuxAvailable:true}],grants:[],pendingDevices:[],connections:[],link:{status:'connected'}}});
    if(path==='/api/terminal/tickets')return route.fulfill({json:{ticket:'ime-ticket',connectionId:'ime-connection',wsUrl:'wss://terminal.example.test/api/terminal/ws',expiresAt:Date.now()+30000}});
    return route.abort();
  });
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'远程终端'}).click();
  await page.getByRole('button',{name:'连接终端'}).click();
  await page.waitForFunction(()=>window.__terminalFrames.some(frame=>frame.type==='auth'));
  await page.evaluate(()=>window.__terminalSockets[0].emit({type:'authenticated',connectionId:'ime-connection'}));
  await page.waitForFunction(()=>window.__terminalFrames.some(frame=>frame.type==='open'));
  await page.evaluate(()=>window.__terminalSockets[0].emit({type:'control',phase:'ai_ready',managed:false,owned:true}));
  await page.evaluate(value=>window.__terminalSockets[0].emit({type:'ready',connectionId:'ime-connection',epoch:1,sessionRef:value,offset:0,lastInputSeq:0}),ref);
  await page.waitForFunction(()=>document.activeElement?.classList.contains('xterm-helper-textarea'));
  await fireKey(page,'android');
  await page.waitForTimeout(100);
  const composed=await values(page);
  assert.deepEqual(composed,['P'],`one native composition key must send once, got ${JSON.stringify(composed)}; stacks ${JSON.stringify(await page.evaluate(()=>window.__terminalFrames.filter(frame=>frame.type==='input').map(frame=>frame.testStack)))}`);
  await acknowledge(page);
  const cases=[['plain-pp',['P','P']],['missing-start',['P']],['chinese',['中']],['enter',['中','\r']],['suffix',['中','X']],['active-enter',['中','\r']],['input-only-suffix',['中X']],['input-only',['😀']],['input-only-text',['好']]];
  const acceptanceResults={android:composed};
  const failures=[];
  for(const [scenario,expected] of cases){await fireKey(page,scenario);await page.waitForTimeout(100);const actual=await values(page);acceptanceResults[scenario]=actual;if(JSON.stringify(actual)!==JSON.stringify(expected))failures.push({scenario,expected,actual});await acknowledge(page);}
  assert.deepEqual(failures,[],`IME boundary failures: ${JSON.stringify(failures)}`);
  console.log(JSON.stringify({result:'PASS',acceptanceResults}));
  if(process.env.SEQIVO_IME_DIAGNOSTICS==='1'){
    // Synthetic late input without a textarea mutation is diagnostic only: no
    // native trace proves that a browser emits this sequence after a new key.
    const diagnosticObservations={};
    for(const scenario of ['noncomposed-input','late-before','late-after']){await fireKey(page,scenario);await page.waitForTimeout(100);diagnosticObservations[scenario]=await values(page);await acknowledge(page);}
    console.log(JSON.stringify({result:'UNVERIFIED_DIAGNOSTIC',diagnosticObservations}));
  }
  await context.close();
}finally{await browser?.close();await server?.close();await core?.close();await rm(dir,{recursive:true,force:true});}
