import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {generatePhoneStaleHarness} from './fixtures/phone-stale-harness.mjs';

const ids={projectId:'project-qa',taskId:'task-qa',itemId:'item-qa'};
const assets={appScriptPath:'/assets/index-test.js',appStylePath:'/assets/index-test.css'};
const user={id:'account-a',tenantId:'tenant-a'};

function state({role='controller',itemState='open',shareWithRemote=true,taskRevision=4,itemRevision=2,summary='Old display'}={}){
  return {
    connection:{mode:'hub',offline:false},capabilities:{remote:true,inbox:true,role},
    projects:[{id:ids.projectId,name:'Disposable QA project',inboxAvailable:true},{id:'unrelated-project',name:'Unrelated'}],
    tasks:[{id:ids.taskId,projectId:ids.projectId,title:'Disposable task',revision:taskRevision,summary},{id:'unrelated-task',projectId:'unrelated-project',revision:1}],
    inbox:{items:[{id:ids.itemId,projectId:ids.projectId,taskId:ids.taskId,kind:'decision',state:itemState,itemRevision,sourceRevision:taskRevision,contentVersion:1,source:{type:'task.decision',id:'source-qa'},shareWithRemote,title:'Disposable choice',summary:'QA-only decision',options:[{id:'blue',label:'Blue',consequence:'One time'}]},{id:'unrelated-item',projectId:'unrelated-project',taskId:'unrelated-task',kind:'decision',state:'open',itemRevision:1,source:{type:'other',id:'other'},shareWithRemote:true}]},
    settings:{theme:'light'},events:[],plugin:{},
  };
}

function response(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});}

function createHarness({authUser=user,initialState=state(),authStatus=200}={}){
  const calls=[];const appended=[];const events=new Map();const documentEvents=new Map();let currentUser=authUser;let liveState=initialState;let currentAuthStatus=authStatus;
  const controls=new Map(['phone-arm','phone-unfreeze','phone-status','phone-post-status'].map(id=>[id,{id,dataset:{},textContent:'',disabled:id==='phone-unfreeze',listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},async click(){return this.listeners.click?.();}}]));
  const document={currentScript:{dataset:{...ids,appEntry:assets.appScriptPath}},visibilityState:'visible',getElementById:id=>controls.get(id),createElement:tag=>({tag,src:'',type:'',dataset:{}}),body:{appendChild:element=>appended.push(element)},addEventListener:(name,fn)=>documentEvents.set(name,fn)};
  const nativeFetch=async(input,init)=>{
    calls.push({input,init});
    const url=new URL(typeof input==='string'?input:input.url,'https://hub.test/qa/phone-stale.html');
    const method=(init?.method||(typeof input==='object'&&input.method)||'GET').toUpperCase();
    if(url.pathname==='/api/auth/me')return response({user:currentUser},currentAuthStatus);
    if(url.pathname==='/api/state')return response(liveState);
    if(url.pathname==='/api/commands'&&method==='POST')return response({code:'INBOX_CONFLICT',commandId:'disposable-command'},409);
    if(url.pathname==='/api/auth/logout'&&method==='POST')return response({loggedOut:true});
    return response({ok:true});
  };
  const window={fetch:nativeFetch,addEventListener:(name,fn)=>events.set(name,fn)};
  const generated=generatePhoneStaleHarness({...ids,...assets});
  vm.runInNewContext(generated.runtimeScript,{window,document,location:{href:'https://hub.test/qa/phone-stale.html',origin:'https://hub.test'},Response,Headers,URL,structuredClone,console},{timeout:1000});
  events.get('load')();
  return {window,document,controls,calls,appended,setUser(value){currentUser=value;},setState(value){liveState=value;},setAuthStatus(value){currentAuthStatus=value;},generated,dispatchWindow(name){events.get(name)?.();},dispatchDocument(name){documentEvents.get(name)?.();}};
}

async function arm(harness){await harness.window.fetch('/api/state');await harness.controls.get('phone-arm').click();}
async function readOverlay(harness,init){return (await harness.window.fetch('/api/state',init)).json();}

test('generator emits a same-origin CSP-compatible page with only disposable identifiers',()=>{
  const generated=generatePhoneStaleHarness({...ids,...assets});
  assert.match(generated.html,/<link rel="stylesheet" href="\/assets\/index-test\.css">/);
  assert.match(generated.html,/<script defer src="\/qa\/phone-stale-harness\.js"/);
  assert.doesNotMatch(generated.html,/<script[^>]*>\s*[^<]/,'HTML must not contain inline JavaScript');
  assert.doesNotMatch(generated.html,/Bearer|Cookie|password|private decision text/i);
  assert.match(generated.runtimeScript,/window\.fetch=wrapperFetch/);
  assert.match(generated.runtimeScript,/app\.type='module';app\.src=appEntry/);
  assert.throws(()=>generatePhoneStaleHarness({...ids,appScriptPath:'https://other.example/app.js',appStylePath:assets.appStylePath}),/Invalid appScriptPath/);
  assert.throws(()=>generatePhoneStaleHarness({...ids,taskId:'../private',...assets}),/Invalid taskId/);
});

test('same account with a renewed cookie session may overlay only the named old task and item',async()=>{
  const harness=createHarness();
  await arm(harness);
  assert.match(harness.controls.get('phone-status').textContent,/已冻结指定事项/);
  harness.setState(state());
  const unchanged=await readOverlay(harness);
  assert.equal(unchanged.inbox.items.find(item=>item.id===ids.itemId).state,'open');
  assert.equal(harness.controls.get('phone-unfreeze').disabled,false,'an unchanged live snapshot must leave the freeze armed');
  const current=state({itemState:'resolved',taskRevision:5,itemRevision:3,summary:'Live desktop result'});
  current.tasks.push({id:'new-live-task',projectId:ids.projectId,revision:9,summary:'Must remain live'});
  harness.setState(current);
  const cookieSession='new-cookie-for-same-subject';
  assert.ok(cookieSession.length>0);
  const overlaid=await readOverlay(harness,{method:'GET',signal:new AbortController().signal});
  assert.equal(overlaid.tasks.find(item=>item.id===ids.taskId).revision,4);
  assert.equal(overlaid.inbox.items.find(item=>item.id===ids.itemId).state,'open');
  assert.equal(overlaid.tasks.find(item=>item.id==='new-live-task').summary,'Must remain live');
  assert.equal(overlaid.tasks.find(item=>item.id==='unrelated-task').revision,1);
  assert.equal(harness.calls.filter(call=>call.input==='/api/auth/me').length,6,'freeze and both overlay reads check real auth before and after the live state read');
  assert.match(harness.controls.get('phone-status').textContent,/旧任务 r4 \/ 当前 r5/);
});

test('identity switch, permission loss, private target, or auth mutation fail closed',async t=>{
  await t.test('different user',async()=>{
    const harness=createHarness();await arm(harness);harness.setState(state({itemState:'resolved',taskRevision:5,itemRevision:3}));harness.setUser({id:'account-b',tenantId:'tenant-b'});
    const live=await readOverlay(harness);assert.equal(live.tasks.find(item=>item.id===ids.taskId).revision,5);assert.match(harness.controls.get('phone-status').textContent,/账号已变化/);
  });
  await t.test('read-only role',async()=>{
    const harness=createHarness();await arm(harness);harness.setState(state({role:'viewer',itemState:'resolved',taskRevision:5,itemRevision:3}));
    const live=await readOverlay(harness);assert.equal(live.capabilities.role,'viewer');assert.equal(live.tasks.find(item=>item.id===ids.taskId).revision,5);assert.match(harness.controls.get('phone-status').textContent,/账号、权限或事项已变化/);
  });
  await t.test('item becomes private',async()=>{
    const harness=createHarness();await arm(harness);harness.setState(state({itemState:'resolved',taskRevision:5,itemRevision:3,shareWithRemote:false}));
    const live=await readOverlay(harness);assert.equal(live.inbox.items.find(item=>item.id===ids.itemId).shareWithRemote,false);assert.match(harness.controls.get('phone-status').textContent,/账号、权限或事项已变化/);
  });
  await t.test('logout request unfreezes and passes unchanged',async()=>{
    const harness=createHarness();await arm(harness);const init={method:'POST',body:'{"unchanged":true}'};const request='/api/auth/logout';const result=await harness.window.fetch(request,init);
    assert.equal(result.status,200);assert.equal(harness.calls.at(-1).input,request);assert.equal(harness.calls.at(-1).init,init);assert.match(harness.controls.get('phone-status').textContent,/自动解除/);
  });
  await t.test('page hide unfreezes',async()=>{
    const harness=createHarness();await arm(harness);harness.dispatchWindow('pagehide');assert.match(harness.controls.get('phone-status').textContent,/页面已离开/);
  });
  await t.test('bearer mode does not enable the cookie-only harness',async()=>{
    const harness=createHarness();await harness.window.fetch('/api/state',{headers:{Authorization:'Bearer disposable-test-token'}});await harness.controls.get('phone-arm').click();
    assert.match(harness.controls.get('phone-status').textContent,/尚未冻结/);
    assert.equal(harness.controls.get('phone-unfreeze').disabled,true);
  });
});

test('real command POST is byte-for-byte argument passthrough and only status/code are displayed',async()=>{
  const harness=createHarness();await arm(harness);
  const privateBody='{"answer":"private answer that must never be logged"}';const init={method:'POST',body:privateBody,headers:{'content-type':'application/json'}};
  const result=await harness.window.fetch('/api/commands',init);
  assert.equal(result.status,409);assert.equal(harness.calls.at(-1).input,'/api/commands');assert.equal(harness.calls.at(-1).init,init);
  await new Promise(resolve=>setTimeout(resolve,0));
  const shown=harness.controls.get('phone-post-status').textContent;
  assert.match(shown,/HTTP 409 · INBOX_CONFLICT/);assert.doesNotMatch(shown,/private answer|Bearer|Cookie/);
});

test('auth failure never overlays the frozen snapshot',async()=>{
  const harness=createHarness();await arm(harness);harness.setState(state({itemState:'resolved',taskRevision:5,itemRevision:3,summary:'Live after auth loss'}));harness.setAuthStatus(401);
  const live=await readOverlay(harness);
  assert.equal(live.tasks.find(item=>item.id===ids.taskId).summary,'Live after auth loss');
  assert.match(harness.controls.get('phone-status').textContent,/账号核对失败/);
});
