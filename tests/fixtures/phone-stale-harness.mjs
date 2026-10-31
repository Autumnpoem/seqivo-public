const ID = /^[A-Za-z0-9_-]{1,128}$/;
const ASSET = /^\/assets\/[A-Za-z0-9._/-]+\.(?:js|css)$/;
const QA_PATH = /^\/[A-Za-z0-9._/-]+\.(?:js|css|html)$/;

function attr(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function safePath(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value) || value.includes('..') || value.includes('?') || value.includes('#')) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

export function generatePhoneStaleHarness({projectId, taskId, itemId, appScriptPath, appStylePath, runtimeScriptPath='/qa/phone-stale-harness.js', runtimeStylePath='/qa/phone-stale-harness.css'}) {
  for (const [name, value] of Object.entries({projectId, taskId, itemId})) {
    if (typeof value !== 'string' || !ID.test(value)) throw new TypeError(`Invalid ${name}`);
  }
  appScriptPath = safePath(appScriptPath, ASSET, 'appScriptPath');
  appStylePath = safePath(appStylePath, ASSET, 'appStylePath');
  runtimeScriptPath = safePath(runtimeScriptPath, QA_PATH, 'runtimeScriptPath');
  runtimeStylePath = safePath(runtimeStylePath, QA_PATH, 'runtimeStylePath');

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f5f5f7"><title>一次性旧决策测试</title><link rel="stylesheet" href="${attr(appStylePath)}"><link rel="stylesheet" href="${attr(runtimeStylePath)}"></head>
<body><section id="phone-harness" aria-label="一次性旧决策测试"><strong>真机 QA · 仅指定事项</strong><p>旧显示只覆盖本页内存读取；提交与回执仍真实发送。</p><div class="phone-harness-row"><button id="phone-arm" type="button">冻结当前显示</button><button id="phone-unfreeze" type="button" disabled>解除冻结</button></div><output id="phone-status" role="status" aria-live="polite">未冻结。确认一次性夹具后再开启。</output><output id="phone-post-status" aria-live="polite">最近提交：无</output></section><div id="root"></div><script defer src="${attr(runtimeScriptPath)}" data-project-id="${attr(projectId)}" data-task-id="${attr(taskId)}" data-item-id="${attr(itemId)}" data-app-entry="${attr(appScriptPath)}"></script></body></html>`;
  return {html, runtimeScript: runtimeSource, runtimeStyle: runtimeCss};
}

const runtimeSource = String.raw`(()=>{
  'use strict';
  const script=document.currentScript;
  const target={projectId:script.dataset.projectId,taskId:script.dataset.taskId,itemId:script.dataset.itemId};
  const appEntry=script.dataset.appEntry;
  const nativeFetch=window.fetch.bind(window);
  const armButton=document.getElementById('phone-arm');
  const unfreezeButton=document.getElementById('phone-unfreeze');
  const statusBox=document.getElementById('phone-status');
  const postBox=document.getElementById('phone-post-status');
  let frozen=null;
  let freezeEpoch=0;
  let cookieModeVerified=false;

  function setStatus(text){statusBox.textContent=text;}
  function identityMatches(left,right){return Boolean(left&&right&&left.id===right.id&&left.tenantId===right.tenantId);}
  function clearFreeze(reason){
    freezeEpoch++;
    frozen=null;armButton.disabled=false;unfreezeButton.disabled=true;
    if(reason)setStatus(reason);
    else setStatus('已解除冻结；后续读取与提交均使用实时状态。');
  }
  async function readIdentity(){
    const response=await nativeFetch('/api/auth/me',{method:'GET',credentials:'same-origin',cache:'no-store'});
    if(!response.ok)throw new Error('auth');
    const value=await response.json();
    const user=value&&value.user;
    if(!user||typeof user.id!=='string'||!user.id||typeof user.tenantId!=='string'||!user.tenantId)throw new Error('identity');
    return {id:user.id,tenantId:user.tenantId};
  }
  async function readLiveState(){
    const response=await nativeFetch('/api/state',{method:'GET',credentials:'same-origin',cache:'no-store'});
    if(!response.ok)throw new Error('state');
    return {response,value:await response.clone().json()};
  }
  function capabilityState(value){
    return value&&value.connection?.mode==='hub'&&value.connection.offline!==true&&value.capabilities?.remote===true&&value.capabilities?.inbox===true&&['owner','controller'].includes(value.capabilities.role);
  }
  function locate(value){
    const project=value?.projects?.find(item=>item.id===target.projectId);
    const task=value?.tasks?.find(item=>item.id===target.taskId&&item.projectId===target.projectId);
    const item=value?.inbox?.items?.find(entry=>entry.id===target.itemId&&entry.projectId===target.projectId&&entry.taskId===target.taskId);
    return {project,task,item};
  }
  function sameSource(a,b){return Boolean(a&&b&&a.type===b.type&&a.id===b.id);}
  function writableTarget(value){
    if(!capabilityState(value))return false;
    const {project,task,item}=locate(value);
    return Boolean(project&&task&&item&&item.kind==='decision'&&item.shareWithRemote===true&&sameSource(item.source,frozen?.oldItem?.source));
  }
  function revisionsText(live){
    const {task,item}=locate(live);
    return '旧任务 r'+frozen.oldTask.revision+' / 当前 r'+(task?.revision??'—')+'；旧事项 r'+frozen.oldItem.itemRevision+' / 当前 r'+(item?.itemRevision??'—');
  }
  async function freezeCurrent(){
    if(frozen)return;
    if(!cookieModeVerified){setStatus('等待应用确认 Cookie 登录方式；尚未冻结。');return;}
    const attempt=++freezeEpoch;
    armButton.disabled=true;setStatus('正在确认当前账号和一次性事项…');
    try{
      const before=await readIdentity();
      if(attempt!==freezeEpoch)return;
      const {value}=await readLiveState();
      if(attempt!==freezeEpoch)return;
      const after=await readIdentity();
      if(attempt!==freezeEpoch)return;
      if(!identityMatches(before,after)||!capabilityState(value))throw new Error('scope');
      const {project,task,item}=locate(value);
      if(!project||!task||!item||item.kind!=='decision'||item.state!=='open'||item.shareWithRemote!==true)throw new Error('target');
      frozen={identity:before,oldTask:structuredClone(task),oldItem:structuredClone(item)};
      unfreezeButton.disabled=false;
      setStatus('已冻结指定事项。'+revisionsText(value)+'。点「解除冻结」可立即恢复实时读取。');
    }catch{
      frozen=null;armButton.disabled=false;unfreezeButton.disabled=true;
      setStatus('未能确认账号、权限或事项；没有冻结，页面保持实时状态。');
    }
  }
  async function overlayState(input,init){
    const snapshot=frozen,epoch=freezeEpoch;
    const current=()=>frozen===snapshot&&freezeEpoch===epoch;
    let before;
    try{before=await readIdentity();}
    catch{clearFreeze('账号核对失败，已解除冻结；页面返回实时读取。');return nativeFetch(input,init);}
    if(!current())return nativeFetch(input,init);
    if(!identityMatches(before,snapshot.identity)){clearFreeze('账号已变化，已解除冻结；页面返回实时读取。');return nativeFetch(input,init);}
    let response;
    try{response=await nativeFetch(input,init);}
    catch(error){clearFreeze('读取失败，已解除冻结；请恢复连接后重试。');throw error;}
    if(!current())return response;
    if(!response.ok){clearFreeze('服务器状态不可用，已解除冻结；页面返回实时响应。');return response;}
    let value;
    try{value=await response.clone().json();}
    catch{clearFreeze('状态内容无法核对，已解除冻结；页面返回实时响应。');return response;}
    let after;
    try{after=await readIdentity();}
    catch{clearFreeze('账号复核失败，已解除冻结；页面返回实时响应。');return response;}
    if(!current())return response;
    if(!identityMatches(before,after)||!identityMatches(after,snapshot.identity)||!writableTarget(value)){
      clearFreeze('账号、权限或事项已变化，已解除冻结；页面返回实时状态。');return response;
    }
    const live=locate(value);
    if(live.item.state==='open'&&live.task.revision===snapshot.oldTask.revision&&live.item.itemRevision===snapshot.oldItem.itemRevision&&JSON.stringify(live.task)===JSON.stringify(snapshot.oldTask)&&JSON.stringify(live.item)===JSON.stringify(snapshot.oldItem)){
      setStatus('Hub 尚未显示桌面端的新状态；冻结保持开启，页面继续显示实时内容。');return response;
    }
    if(live.item.state!=='resolved'||live.task.revision<=snapshot.oldTask.revision||live.item.itemRevision<=snapshot.oldItem.itemRevision||!sameSource(live.item.source,snapshot.oldItem.source)){
      clearFreeze('目标尚未出现新的已处理状态，已解除冻结；页面返回实时状态。');return response;
    }
    const merged=structuredClone(value);
    merged.tasks=merged.tasks.map(item=>item.id===target.taskId?structuredClone(snapshot.oldTask):item);
    merged.inbox.items=merged.inbox.items.map(item=>item.id===target.itemId?structuredClone(snapshot.oldItem):item);
    setStatus('QA 模拟旧读取已开启（仅此事项；POST 仍真实）。'+revisionsText(value)+'。');
    const headers=new Headers(response.headers);
    for(const key of ['content-length','content-encoding','etag','content-md5'])headers.delete(key);
    return new Response(JSON.stringify(merged),{status:response.status,statusText:response.statusText,headers});
  }
  function safePostResult(response){
    response.clone().json().then(value=>{
      const code=typeof value?.code==='string'&&/^[A-Z0-9_]{1,64}$/.test(value.code)?value.code:'';
      const commandId=typeof value?.commandId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value.commandId)?value.commandId:'';
      postBox.textContent='最近提交：HTTP '+response.status+(code?' · '+code:'')+(commandId?' · ID '+commandId:'');
    }).catch(()=>{postBox.textContent='最近提交：HTTP '+response.status;});
  }
  function wrapperFetch(input,init){
    let url,method;
    try{url=new URL(typeof input==='string'?input:input.url,location.href);method=(init?.method||(typeof input==='object'&&input.method)||'GET').toUpperCase();}
    catch{return nativeFetch(input,init);}
    if(url.origin!==location.origin)return nativeFetch(input,init);
    if(url.pathname.startsWith('/api/auth/')&&method!=='GET')clearFreeze('账号操作已开始，冻结已自动解除。');
    if(url.pathname==='/api/state'&&method==='GET'){
      const headers=new Headers(typeof input==='object'&&input instanceof Request?input.headers:undefined);
      new Headers(init?.headers).forEach((value,key)=>headers.set(key,value));
      cookieModeVerified=!headers.has('authorization');
      if(!cookieModeVerified){clearFreeze('检测到访问令牌模式；本 Cookie QA 页不启用旧状态模拟。');return nativeFetch(input,init);}
      if(frozen)return overlayState(input,init);
    }
    return nativeFetch(input,init).then(response=>{
      if(url.pathname==='/api/commands'&&method==='POST')safePostResult(response);
      return response;
    });
  }
  armButton.addEventListener('click',()=>freezeCurrent());
  unfreezeButton.addEventListener('click',()=>clearFreeze('已解除冻结；后续读取与提交均使用实时状态。'));
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')clearFreeze('页面已隐藏，冻结自动解除。');});
  window.addEventListener('pagehide',()=>clearFreeze('页面已离开，冻结自动解除.'),{once:true});
  window.addEventListener('beforeunload',()=>clearFreeze('页面即将离开，冻结自动解除.'),{once:true});
  window.addEventListener('popstate',()=>clearFreeze('页面导航已变化，冻结自动解除。'));
  window.addEventListener('load',()=>{
    window.fetch=wrapperFetch;
    window.__phoneStaleHarnessReady=true;
    const app=document.createElement('script');app.type='module';app.src=appEntry;document.body.appendChild(app);
  },{once:true});
})();`;

const runtimeCss = `#phone-harness{box-sizing:border-box;width:100%;padding:12px max(14px,env(safe-area-inset-left));background:#fff5d8;border-bottom:1px solid #d9bd73;color:#29251b;font:14px/1.45 system-ui,sans-serif}#phone-harness strong{display:block;font-size:15px}#phone-harness p{margin:4px 0 8px}#phone-harness .phone-harness-row{display:flex;gap:8px;flex-wrap:wrap}#phone-harness button{min-height:42px;padding:8px 13px;border:1px solid #75602c;border-radius:8px;background:#fff;color:#29251b;font:600 14px/1.2 system-ui,sans-serif}#phone-harness button:disabled{opacity:.55}#phone-harness output{display:block;margin-top:6px;overflow-wrap:anywhere;font-size:12px}#root{min-height:60vh}`;
