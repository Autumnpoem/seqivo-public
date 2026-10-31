import {readdir,readFile,realpath,lstat} from 'node:fs/promises';
import {join,sep} from 'node:path';
import {createIsolatedPlugin} from './plugin-process.mjs';

const SHUTDOWN_CODES=new Set(['SHUTDOWN_UNCONFIRMED','PLUGIN_TIMEOUT','PLUGIN_UNAVAILABLE','UNKNOWN_RESULT','RPC_TOO_LARGE']);
const CODE_PRIORITY=['SHUTDOWN_UNCONFIRMED','PLUGIN_TIMEOUT','UNKNOWN_RESULT','RPC_TOO_LARGE','PLUGIN_UNAVAILABLE'];
const safePluginId=value=>typeof value==='string'&&/^[-a-z0-9]{1,64}$/.test(value)?value:'unknown';

// Diagnostic only: bound hostile or cyclic AggregateError trees without reading
// messages, stacks, paths, or arbitrary error-owned fields.
export function shutdownErrorCategory(error) {
 const seen=new WeakSet(),found=new Set(),queue=[{value:error,depth:0}];
 for(let index=0;index<queue.length&&index<24;index++){
  const {value,depth}=queue[index];
  if(!value||typeof value!=='object'||seen.has(value))continue;
  seen.add(value);
  try{if(SHUTDOWN_CODES.has(value.code))found.add(value.code);}catch{}
  if(depth>=6)continue;
  let nested;
  try{nested=value instanceof AggregateError?value.errors:null;}catch{}
  if(Array.isArray(nested))try{for(let i=0;i<Math.min(nested.length,24-queue.length);i++)
   queue.push({value:nested[i],depth:depth+1});}catch{}
 }
 return CODE_PRIORITY.find(code=>found.has(code))||'UNCLASSIFIED';
}

export async function loadPlugins({pluginDir,dataDir,context,coreOwned={},onShutdown=()=>{}}) {
 const loaded=new Map(),failures=[],unsafe=[];
 const report=(pluginId,status,phase,error)=>{
  try{const result=onShutdown({stage:'plugin',status,phase,pluginId:safePluginId(pluginId),
   ...(status==='rejected'?{category:shutdownErrorCategory(error)}:{})});
   if(result&&typeof result.then==='function')void Promise.resolve(result).catch(()=>{});
  }catch{}
 };
 const builtInRoot=Array.isArray(pluginDir)?pluginDir[0]:pluginDir;
 if(coreOwned['local-terminal']){
  // This fixed, package-adjacent manifest describes the intrinsic Core
  // capability. Caller-supplied plugin roots cannot provide its authority.
  const path=new URL('../plugins/local-terminal/plugin.json',import.meta.url);
  const stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink())throw Error('内置终端插件清单无效');
  const manifest=JSON.parse(await readFile(path,'utf8'));
  if(manifest.id!=='local-terminal'||manifest.apiVersion!==1||manifest.coreOwned!==true||
     manifest.contract!=='terminal.local.v1'||manifest.entry!==undefined)
    throw Error('内置终端插件清单无效');
 }
 for(const root of (Array.isArray(pluginDir)?pluginDir:[pluginDir])){
 let entries;try{entries=await readdir(root,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')continue;throw e;}
 for(const entry of entries){
  if(entry.name.startsWith('.')||!entry.isDirectory()||entry.isSymbolicLink())continue;
  if(entry.name==='local-terminal'){
   // A side-loaded extension can never claim the Core-owned terminal authority.
   continue;
  }
  let manifest;
  try{
   const directory=await realpath(join(root,entry.name));
   manifest=JSON.parse(await readFile(join(directory,'plugin.json'),'utf8'));
   if(manifest.id==='local-terminal')continue;
   if(manifest.id!==entry.name||!/^[-a-z0-9]+$/.test(manifest.id))throw Error('插件 ID 与目录不一致');
   if(manifest.apiVersion!==1)throw Error('不支持此插件接口版本');
   if(loaded.has(manifest.id))throw Error('重复插件 ID');
   if(typeof manifest.entry!=='string')throw Error('缺少插件入口');
   const file=await realpath(join(directory,manifest.entry));if(!file.startsWith(directory+sep))throw Error('插件入口超出目录');
   const scopedContext={...context,authorizeExecution:input=>context.authorizeExecution?.({...input,provider:manifest.id}),revalidateExecution:input=>context.revalidateExecution?.({...input,provider:manifest.id}),
    verifyRetirementWorkspace:root===builtInRoot&&manifest.id==='codex-autocontinue'&&manifest.permissions?.includes('task.resume')
      ?input=>context.verifyRetirementWorkspace?.(input):undefined};
   if(root===builtInRoot&&manifest.id==='codex-autocontinue'&&manifest.permissions?.includes('task.resume'))
    for(const method of ['reserveExecutorStartup','bindExecutorStartup','confirmExecutorStartup','bindExecutorConversation','verifyExecutorStartup','retireExecutorStartup','disposeStoppedUnknownExecutor',
      'verifyLinuxExecutorAdmission','verifyLinuxBridgeRetirementWorkspace','verifyLinuxJobRetirement'])
      scopedContext[method]=input=>context[method]?.(input);
   const instance=await createIsolatedPlugin({entry:file,manifest,context:scopedContext,dataDir:join(dataDir,manifest.id),pluginDir:directory,
    trustedBuiltIn:root===builtInRoot});
   const required=['state','configure','enable','disable','check','close'];
   if(required.some(name=>typeof instance?.[name]!=='function')){await instance?.close?.();throw Error('插件生命周期接口不完整');}
   loaded.set(manifest.id,{manifest,instance});
  }catch(error){if(error instanceof AggregateError||error.code==='SHUTDOWN_UNCONFIRMED')unsafe.push({id:manifest?.id||entry.name,error});failures.push({id:manifest?.id||entry.name,name:manifest?.name||entry.name,enabled:false,available:false,status:'unavailable',lastError:error.message});}
 }
 }
 return {
  get:id=>coreOwned[id]||loaded.get(id)?.instance,
  async state(){return [...await Promise.all([...loaded].map(async([id,{manifest,instance}])=>{try{return {...await instance.state(),id,name:manifest.name,version:manifest.version,apiVersion:manifest.apiVersion,permissions:manifest.permissions||[],capabilities:manifest.capabilities||[],configSchema:manifest.configSchema||null,compatibilityNotice:manifest.compatibilityNotice||null,isolation:'process',trust:'local-trusted'};}catch(error){return {id,name:manifest.name,enabled:false,available:false,status:'unavailable',lastError:error.message};}})),...Object.values(coreOwned).map(instance=>instance.state()),...failures];},
  async close(){
   const entries=[...loaded].map(([id,{instance}])=>({id,instance})).concat(Object.entries(coreOwned).map(([id,instance])=>({id,instance})));
   const results=await Promise.allSettled(entries.map(({instance})=>instance.close()));
   // Report failures first so a bounded recorder retains their identities
   // before successful plugin rows consume its diagnostic budget.
   for(const {id,error} of unsafe)report(id,'rejected','startup',error);
   for(let i=0;i<results.length;i++)if(results[i].status==='rejected')report(entries[i].id,'rejected','close',results[i].reason);
   for(let i=0;i<results.length;i++)if(results[i].status==='fulfilled')report(entries[i].id,'fulfilled','close');
   const errors=[...unsafe.map(item=>item.error),...results.filter(r=>r.status==='rejected').map(r=>r.reason)];
   if(errors.length)throw new AggregateError(errors,'部分插件未能确认进程已停止，请检查进程状态后再启动');
  },
 };
}
export function unavailableAutocontinue(reason='自动继续插件未安装或无法加载'){
 const fail=async()=>{throw Error(reason);};const state=()=>({id:'codex-autocontinue',name:'Codex Auto Continue',version:'unknown',enabled:false,available:false,status:'unavailable',lastError:reason,config:{pythonPath:'',codexPath:'',graceSeconds:30,pollSeconds:60},quota:null,policies:[]});
 return {state,configure:fail,enable:fail,disable:async()=>state(),check:async()=>state(),setPolicy:fail,reconcile:fail,resume:fail,pause:fail,close:async()=>{}};
}
