/** Isolated React + xterm/browser mock. WS frames are simulated; no real PTY is exercised. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {createCore} from '../../server/core.mjs';
import {startHttp} from '../../server/http.mjs';

const dir=await mkdtemp(join(tmpdir(),'seqivo-return-ui-'));
let core,server,browser,context,passed=false,failure=null;
const ref={serverName:'return-ui',instanceId:'a'.repeat(64),sessionId:'$1'};
try{
  core=await createCore({dataDir:join(dir,'data'),pluginDir:resolve('plugins'),files:false});
  const project=core.store.project({name:'交还核对界面',goal:'仅验证隔离界面。',directory:dir});
  server=await startHttp({core,dataDir:join(dir,'data'),distDir:resolve(process.env.SEQIVO_TEST_DIST_DIR||'dist'),port:0});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  const page=await context.newPage(),pageErrors=[];
  page.on('pageerror',error=>pageErrors.push(error.message));
  await page.addInitScript(token=>sessionStorage.setItem('taskboard-token',token),server.tokens.owner);
  await page.addInitScript(()=>{
    window.__returnFrames=[];window.__returnSockets=[];
    class Socket{
      static OPEN=1;
      constructor(url){this.url=url;this.readyState=0;window.__returnSockets.push(this);setTimeout(()=>{this.readyState=1;this.onopen?.({});},0);}
      send(raw){window.__returnFrames.push(JSON.parse(raw));}
      close(code=1000){this.readyState=3;this.onclose?.({code});}
      emit(frame){this.onmessage?.({data:JSON.stringify({v:1,...frame})});}
    }
    window.WebSocket=Socket;
  });
  await context.route('**/api/terminal/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/terminal/status')return route.fulfill({json:{mode:'local',enabled:true,profiles:[{id:'default',label:'交还测试',projectId:project.id,enabled:true,tmuxAvailable:true}],grants:[],pendingDevices:[],connections:[],link:{status:'connected'}}});
    if(path==='/api/terminal/tickets')return route.fulfill({json:{ticket:'mock-ticket',connectionId:'return-ui-connection',wsUrl:'ws://127.0.0.1/mock-terminal',expiresAt:Date.now()+30000}});
    return route.abort();
  });
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'远程终端'}).click();
  await page.getByRole('button',{name:'连接终端'}).click();
  await page.waitForFunction(()=>window.__returnFrames.some(frame=>frame.type==='auth'));
  await page.evaluate(()=>window.__returnSockets[0].emit({type:'authenticated',connectionId:'return-ui-connection'}));
  await page.waitForFunction(()=>window.__returnFrames.some(frame=>frame.type==='open'));
  await page.evaluate(({ref})=>{
    const socket=window.__returnSockets[0];
    socket.emit({type:'control',phase:'human',managed:true,owned:true,mode:'managed',generation:7,authorizedSessionRefs:[ref]});
    socket.emit({type:'ready',connectionId:'return-ui-connection',epoch:1,sessionRef:ref,offset:0,lastInputSeq:0});
  },{ref});
  await page.getByRole('button',{name:'核对交还内容'}).click();
  await page.waitForFunction(()=>window.__returnFrames.some(frame=>frame.type==='return-prepare'));
  assert.equal(await page.getByRole('button',{name:'确认交还给 AI'}).count(),0,'no confirmation before verified review');
  await page.evaluate(({ref})=>window.__returnSockets[0].emit({type:'control',phase:'return_review',managed:true,owned:true,mode:'managed',generation:7,authorizedSessionRefs:[ref],
    returnReview:{reviewId:'a'.repeat(64),expiresAt:Date.now()+60000,generation:7,workspaceRelativeDirectories:[{sessionRef:ref,path:'.'}],
      changes:[{path:'src/file.txt',kind:'modified'}],totalChanges:1,omittedChanges:0,snapshotScope:'git-tracked-and-nonignored-untracked',parkedManagedSessions:1,unownedWorkspaceWriters:0,notes:'仍需人工验收'}}),{ref});
  const review=page.getByLabel('交还内容核对');
  await review.getByText('项目根目录').waitFor();
  assert.equal(await review.getByText('仍需人工验收').count(),1);
  assert.equal(await page.getByRole('button',{name:'Ctrl',exact:true}).isDisabled(),true);
  await review.getByRole('button',{name:'确认交还给 AI'}).click();
  await page.waitForFunction(()=>window.__returnFrames.some(frame=>frame.type==='return-confirm'));
  assert.equal(await page.getByRole('button',{name:'Ctrl',exact:true}).isDisabled(),true);
  await page.evaluate(({ref})=>window.__returnSockets[0].emit({type:'control',phase:'ai_ready',managed:true,owned:false,mode:'managed',generation:7,authorizedSessionRefs:[ref]}),{ref});
  await page.getByText('任务执行权：由 AI 管理').waitFor();
  assert.equal(await page.getByLabel('交还内容核对').count(),0,'missing returnReview clears the old card');
  assert.equal(await page.getByRole('button',{name:'Ctrl',exact:true}).isDisabled(),true);
  await page.evaluate(({ref})=>window.__returnSockets[0].emit({type:'control',phase:'human',managed:true,owned:true,mode:'managed',generation:8,authorizedSessionRefs:[ref]}),{ref});
  await page.getByRole('button',{name:'核对交还内容'}).click();
  await page.waitForFunction(()=>window.__returnFrames.filter(frame=>frame.type==='return-prepare').length===2);
  await page.evaluate(({ref})=>window.__returnSockets[0].emit({type:'control',phase:'return_review',managed:true,owned:true,mode:'managed',generation:8,authorizedSessionRefs:[ref],
    returnReview:{reviewId:'b'.repeat(64),expiresAt:Date.now()-1,generation:8,workspaceRelativeDirectories:[{sessionRef:ref,path:'.'}],
      changes:[],totalChanges:0,omittedChanges:0,snapshotScope:'git-tracked-and-nonignored-untracked',parkedManagedSessions:1,unownedWorkspaceWriters:0,notes:''}}),{ref});
  await review.getByRole('button',{name:'取消过期核对，重新核对现场'}).waitFor();
  assert.equal(await review.getByRole('button',{name:'确认交还给 AI'}).isDisabled(),true);
  await review.getByRole('button',{name:'取消过期核对，重新核对现场'}).click();
  await page.waitForFunction(()=>window.__returnFrames.some(frame=>frame.type==='return-cancel'&&frame.reviewId==='b'.repeat(64)));
  assert.equal(await page.getByRole('button',{name:'Ctrl',exact:true}).isDisabled(),true);
  assert.deepEqual(pageErrors,[]);
  passed=true;
  console.log('return review browser mock: prepare -> explicit confirm -> ai_ready, input fenced, old review cleared');
}catch(error){failure=error;}finally{
  const closeErrors=[];
  for(const [name,resource] of [['context',context],['browser',browser],['http',server],['core',core]]){
    if(!resource)continue;
    try{await resource.close();}catch(error){closeErrors.push({name,error});console.error(`${name} close failed:`,error);}
  }
  if(closeErrors.length){passed=false;failure??=new AggregateError(closeErrors.map(item=>item.error),'Isolated return-review fixture did not close cleanly');}
  if(passed&&!failure)await rm(dir,{recursive:true,force:true});
  else console.error('failed isolated fixture:',dir);
}
if(failure)throw failure;
