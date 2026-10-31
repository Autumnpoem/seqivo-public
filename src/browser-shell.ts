type BootState={state:'ready'|'reload'|'recovery';native:boolean};
const reloadKey='seqivo-android-sw-migration-reload-v1';
const deadlineMs=2500;

export function isAndroidWebView(userAgent=navigator.userAgent):boolean {
  return isSeqivoAndroid(userAgent)||/Android\b[^)]*;\s*wv(?:[;)]|$)/i.test(userAgent);
}
export function isSeqivoAndroid(userAgent=navigator.userAgent):boolean{return /SeqivoAndroid\/[\w.-]+/i.test(userAgent);}

function bounded<T>(work:Promise<T>):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('终端浏览器检查超时')),deadlineMs);});
  return Promise.race([work,deadline]).finally(()=>{if(timer!==undefined)clearTimeout(timer);});
}

/** The native container never opts into PWA installation or a new worker. */
export async function prepareBrowserShell():Promise<BootState>{
  const native=isAndroidWebView();
  if(!native||window.taskboard||!/^https?:$/.test(location.protocol))return {state:'ready',native};
  if(!('serviceWorker' in navigator))return {state:'ready',native};
  try{
    const worker=navigator.serviceWorker;
    // The legacy ; wv marker identifies a WebView, not this application's
    // native host. It may suppress new installs but cannot authorize cleanup.
    if(!isSeqivoAndroid())return {state:worker.controller?'recovery':'ready',native};
    const rootScope=new URL('/',location.origin).href;
    const oldScript=new URL('/sw.js',location.origin).href;
    const reloadIdentity=`${location.origin}|${oldScript}`;
    const registrations=await bounded(worker.getRegistrations());
    const ours=[];
    if(worker.controller&&worker.controller.scriptURL!==oldScript)return {state:'recovery',native};
    for(const registration of registrations){
      if(registration.scope!==rootScope)continue;
      const scripts=[registration.active,registration.waiting,registration.installing].flatMap(item=>item?[item.scriptURL]:[]);
      // A root registration with missing or different identity belongs to an
      // unknown owner. Never unregister it or launch the main interface.
      if(!scripts.length||scripts.some(script=>script!==oldScript))return {state:'recovery',native};
      ours.push(registration);
    }
    for(const registration of ours){
      if(!await bounded(registration.unregister()))return {state:'recovery',native};
    }
    // A successful unregister result does not prove another client has not
    // installed a root worker in the meantime. Never repeat the mutation.
    if((await bounded(worker.getRegistrations())).some(registration=>registration.scope===rootScope))return {state:'recovery',native};
    // unregister() does not release a controller attached to this document.
    // One reload is enough to detach it; never retry a reload automatically.
    const controller=worker.controller;
    if(controller&&controller.scriptURL!==oldScript)return {state:'recovery',native};
    if(controller?.scriptURL===oldScript){
      if(sessionStorage.getItem(reloadKey)===reloadIdentity)return {state:'recovery',native};
      sessionStorage.setItem(reloadKey,reloadIdentity);
      return {state:'reload',native};
    }
    if(sessionStorage.getItem(reloadKey)===reloadIdentity)sessionStorage.removeItem(reloadKey);
    return {state:'ready',native};
  }catch{return {state:'recovery',native};}
}

export function installBrowserPwa():void {
  if(window.taskboard||isAndroidWebView()||!/^https?:$/.test(location.protocol))return;
  if(!document.querySelector('link[rel="manifest"]')){
    const manifest=document.createElement('link');manifest.rel='manifest';manifest.href='/manifest.webmanifest';document.head.append(manifest);
  }
  if(!('serviceWorker' in navigator))return;
  const register=()=>{void navigator.serviceWorker.register('/sw.js').catch(()=>{});};
  if(document.readyState==='complete')register();
  else window.addEventListener('load',register,{once:true});
}
