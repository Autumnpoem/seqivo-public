/** Real TerminalPanel and TerminalClient in an isolated browser; only terminal transport is mocked. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {createCore} from '../../server/core.mjs';
import {startHttp} from '../../server/http.mjs';

const dir=await mkdtemp(join(tmpdir(),'seqivo-terminal-availability-'));
const device={deviceId:'test-device',label:'测试浏览器',status:'approved'};
const grant={nodeId:'test-node',profileId:'default',scopes:['view','input','takeover']};
const online={device,nodes:[{nodeId:'test-node',profiles:[{id:'default',label:'已授权终端',enabled:true,tmuxAvailable:true}]}],grants:[grant]};
let core,server,browser;
try{
  core=await createCore({dataDir:join(dir,'data'),pluginDir:resolve('plugins'),files:false});
  core.store.project({name:'终端状态文案测试',goal:'验证未授权与离线状态不混淆。',directory:dir});
  server=await startHttp({core,dataDir:join(dir,'data'),distDir:resolve(process.env.SEQIVO_TEST_DIST_DIR||'dist'),port:0});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  const page=await context.newPage();
  const pageErrors=[];
  page.on('pageerror',error=>pageErrors.push(error.message));
  await page.addInitScript(token=>sessionStorage.setItem('taskboard-token',token),server.tokens.owner);
  await page.addInitScript(()=>{
    window.__terminalSockets=[];
    class MockSocket{
      static OPEN=1;
      constructor(){this.readyState=0;window.__terminalSockets.push(this);setTimeout(()=>{this.readyState=1;this.onopen?.({});},0);}
      send(){}
      close(code=1000){this.readyState=3;this.onclose?.({code});}
      emit(frame){this.onmessage?.({data:JSON.stringify({v:1,...frame})});}
    }
    window.WebSocket=MockSocket;
  });
  let currentStatus={device:null,nodes:[],grants:[]};
  let statusMode='hold',pendingStatusRoute;
  let releaseHeldStatus;
  const heldStatus=new Promise(resolveStatus=>{releaseHeldStatus=resolveStatus;});
  await context.route('**/api/terminal/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/terminal/status'){
      if(statusMode==='hold'){pendingStatusRoute=route;releaseHeldStatus();return;}
      if(statusMode==='error')return route.fulfill({status:503,json:{error:'暂时无法读取终端状态'}});
      return route.fulfill({json:currentStatus});
    }
    if(path==='/api/terminal/devices/confirmation')return route.fulfill({status:429,json:{error:'请稍后再申请确认码'}});
    if(path==='/api/terminal/tickets')return route.fulfill({json:{ticket:'mock-ticket',connectionId:'availability-connection',wsUrl:'wss://terminal.example.test/api/terminal/ws',expiresAt:Date.now()+30000}});
    return route.abort();
  });
  const state=page.locator('.terminal-toolbar .terminal-state');
  const refresh=page.getByRole('button',{name:'刷新终端状态'});
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'远程终端'}).click();
  await state.filter({hasText:'正在检查终端'}).waitFor();
  assert.equal(await page.getByText('电脑离线',{exact:true}).count(),0,'pending status is not proof that a computer is offline');
  await heldStatus;
  statusMode='normal';
  await pendingStatusRoute.fulfill({json:currentStatus});
  await state.filter({hasText:'请先登记这台浏览器'}).waitFor();
  currentStatus={device:{...device,status:'pending'},nodes:[],grants:[]};
  await refresh.click();
  await state.filter({hasText:'等待电脑授权'}).waitFor();
  currentStatus={device,nodes:[],grants:[grant]};
  await refresh.click();
  await state.filter({hasText:'已授权终端暂不可连接'}).waitFor();
  assert.equal(await page.getByText('电脑离线',{exact:true}).count(),0,'filtered nodes reveal no unauthorized computer state');
  statusMode='error';
  await refresh.click();
  await page.getByRole('alert').getByText('暂时无法读取终端状态').waitFor();
  await state.filter({hasText:'终端状态获取失败'}).waitFor();
  statusMode='normal';
  currentStatus=online;
  await refresh.click();
  await state.filter({hasText:'已断开'}).waitFor();
  await page.evaluate(()=>window.dispatchEvent(new Event('offline')));
  await state.filter({hasText:'手机离线'}).waitFor();
  await page.evaluate(()=>window.dispatchEvent(new Event('pageshow')));
  await state.filter({hasText:'已断开'}).waitFor();
  await page.getByRole('button',{name:'申请新的授权确认码'}).click();
  await page.getByRole('alert').getByText('请稍后再申请确认码').waitFor();
  assert.equal(await state.innerText(),'已断开','a business request error does not become a status-fetch error');
  await page.getByRole('button',{name:'连接终端'}).click();
  await page.waitForFunction(()=>window.__terminalSockets.length===1);
  await page.evaluate(()=>{
    const socket=window.__terminalSockets[0];
    socket.emit({type:'authenticated',connectionId:'availability-connection'});
    socket.emit({type:'control',phase:'ai_ready',managed:false,owned:true});
    socket.emit({type:'ready',connectionId:'availability-connection',epoch:1,sessionRef:{serverName:'default',instanceId:'a'.repeat(64),sessionId:'$1'},offset:0,lastInputSeq:0});
  });
  await state.filter({hasText:'已连接'}).waitFor();
  statusMode='error';
  await refresh.click();
  await page.getByRole('alert').getByText('暂时无法读取终端状态').waitFor();
  assert.equal(await state.innerText(),'已连接','a failed background status refresh does not relabel an active connection');
  await context.setOffline(true);
  await state.filter({hasText:'手机离线'}).waitFor();
  assert.deepEqual(pageErrors,[]);
  console.log('terminal availability UI: loading, enrollment, grants, unavailable target, active connection, GET error, offline passed');
}finally{
  await browser?.close();await server?.close();await core?.close();await rm(dir,{recursive:true,force:true});
}
