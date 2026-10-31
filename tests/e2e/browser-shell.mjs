/** Real Chromium service-worker lifecycle; no Hub account or Android device. */
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';

let vite,browser,harnessLoads=0;
const nativeUa='Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36 SeqivoAndroid/5';
const legacyUa='Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36';
try{
  vite=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:0},plugins:[{name:'browser-shell-harness',configureServer(server){server.middlewares.use((req,res,next)=>{
    if(req.url?.startsWith('/foreign-sw.js')){res.setHeader('Content-Type','text/javascript');res.end("self.addEventListener('fetch',()=>{});");return;}
    if(req.url?.startsWith('/seed')){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><body>seed</body></html>');return;}
    if(req.url?.startsWith('/shell-harness')){harnessLoads++;void server.transformIndexHtml('/shell-harness',`<!doctype html><html><head></head><body><div id="result">checking</div><script type="module">import{prepareBrowserShell,installBrowserPwa}from'/src/browser-shell.ts';const result=await prepareBrowserShell();if(result.state==='reload')location.reload();else{if(result.state==='ready'&&!result.native)installBrowserPwa();window.__boot=result;document.getElementById('result').textContent=result.state;}</script></body></html>`).then(html=>{res.setHeader('Content-Type','text/html');res.end(html);}).catch(next);return;}
    next();
  });}}]});
  await vite.listen();
  const base=vite.resolvedUrls.local[0];
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const clean=await browser.newContext({serviceWorkers:'allow'}),browserPage=await clean.newPage();
  await browserPage.goto(new URL('/shell-harness',base).href);
  await browserPage.getByText('ready',{exact:true}).waitFor();
  assert.equal(await browserPage.locator('link[rel="manifest"]').count(),1,'normal browser keeps manifest');
  await browserPage.waitForFunction(()=>navigator.serviceWorker.getRegistrations().then(items=>items.some(item=>item.scope===new URL('/',location.origin).href&&item.active?.scriptURL===new URL('/sw.js',location.origin).href)));
  await clean.close();

  const native=await browser.newContext({serviceWorkers:'allow',userAgent:nativeUa}),nativePage=await native.newPage();
  await nativePage.goto(new URL('/seed',base).href);
  await nativePage.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;localStorage.setItem('keep-native-value','yes');document.cookie='keep-native-cookie=yes;path=/';await new Promise((resolve,reject)=>{const request=indexedDB.open('keep-native-db',1);request.onupgradeneeded=()=>request.result.createObjectStore('data');request.onsuccess=()=>{const tx=request.result.transaction('data','readwrite');tx.objectStore('data').put('yes','saved');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);};request.onerror=()=>reject(request.error);});});
  await nativePage.reload();
  await nativePage.waitForFunction(()=>navigator.serviceWorker.controller?.scriptURL===new URL('/sw.js',location.origin).href);
  const beforeMigration=harnessLoads;
  await nativePage.goto(new URL('/shell-harness',base).href);
  await nativePage.getByText('ready',{exact:true}).waitFor();
  assert.equal(harnessLoads-beforeMigration,2,'controlled native page reloads once after unregister');
  assert.deepEqual(await nativePage.evaluate(async()=>({manifest:document.querySelectorAll('link[rel="manifest"]').length,registrations:(await navigator.serviceWorker.getRegistrations()).length,controller:navigator.serviceWorker.controller?.scriptURL||'',value:localStorage.getItem('keep-native-value'),cookie:document.cookie.includes('keep-native-cookie=yes'),marker:sessionStorage.getItem('seqivo-android-sw-migration-reload-v1'),database:await new Promise((resolve,reject)=>{const request=indexedDB.open('keep-native-db');request.onsuccess=()=>{const tx=request.result.transaction('data');const read=tx.objectStore('data').get('saved');read.onsuccess=()=>resolve(read.result);read.onerror=()=>reject(read.error);};request.onerror=()=>reject(request.error);})})),{manifest:0,registrations:0,controller:'',value:'yes',cookie:true,marker:null,database:'yes'});
  await native.close();

  const guarded=await browser.newContext({serviceWorkers:'allow',userAgent:nativeUa}),guardedPage=await guarded.newPage();
  await guardedPage.goto(new URL('/seed',base).href);
  await guardedPage.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;});
  await guardedPage.reload();
  await guardedPage.waitForFunction(()=>navigator.serviceWorker.controller?.scriptURL===new URL('/sw.js',location.origin).href);
  await guardedPage.evaluate(()=>sessionStorage.setItem('seqivo-android-sw-migration-reload-v1',`${location.origin}|${new URL('/sw.js',location.origin).href}`));
  const beforeGuarded=harnessLoads;
  await guardedPage.goto(new URL('/shell-harness',base).href);
  await guardedPage.getByText('recovery',{exact:true}).waitFor();
  assert.equal(harnessLoads-beforeGuarded,1,'a still-controlled page with used reload marker never loops');
  await guarded.close();

  const legacy=await browser.newContext({serviceWorkers:'allow',userAgent:legacyUa}),legacyPage=await legacy.newPage();
  await legacyPage.goto(new URL('/shell-harness',base).href);
  await legacyPage.getByText('ready',{exact:true}).waitFor();
  assert.equal(await legacyPage.locator('link[rel="manifest"]').count(),0,'legacy Android wv avoids manifest');
  assert.equal((await legacyPage.evaluate(()=>navigator.serviceWorker.getRegistrations())).length,0,'legacy Android wv avoids registration');
  await legacy.close();

  const legacyNoEnumeration=await browser.newContext({serviceWorkers:'allow',userAgent:legacyUa});
  await legacyNoEnumeration.addInitScript(()=>{window.__swEnumerations=0;const original=ServiceWorkerContainer.prototype.getRegistrations;Object.defineProperty(ServiceWorkerContainer.prototype,'getRegistrations',{value:function(){window.__swEnumerations++;return original.call(this);}});});
  const legacyNoEnumerationPage=await legacyNoEnumeration.newPage();
  await legacyNoEnumerationPage.goto(new URL('/shell-harness',base).href);
  await legacyNoEnumerationPage.getByText('ready',{exact:true}).waitFor();
  assert.equal(await legacyNoEnumerationPage.evaluate(()=>window.__swEnumerations),0,'uncontrolled legacy WebView never enumerates registrations');
  await legacyNoEnumeration.close();

  const legacyControlled=await browser.newContext({serviceWorkers:'allow',userAgent:legacyUa}),legacyControlledPage=await legacyControlled.newPage();
  await legacyControlledPage.goto(new URL('/seed',base).href);
  await legacyControlledPage.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;});
  await legacyControlledPage.reload();
  await legacyControlledPage.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));
  const beforeLegacyControlled=harnessLoads;
  await legacyControlledPage.goto(new URL('/shell-harness',base).href);
  await legacyControlledPage.getByText('recovery',{exact:true}).waitFor();
  assert.equal(harnessLoads-beforeLegacyControlled,1,'legacy controlled WebView never auto-reloads');
  assert.equal(await legacyControlledPage.evaluate(async()=>{const items=await navigator.serviceWorker.getRegistrations();return items.some(item=>item.active?.scriptURL===new URL('/sw.js',location.origin).href);}),true,'legacy marker alone never unregisters old Seqivo worker');
  await legacyControlled.close();

  const foreign=await browser.newContext({serviceWorkers:'allow',userAgent:nativeUa}),foreignPage=await foreign.newPage();
  await foreignPage.goto(new URL('/seed',base).href);
  await foreignPage.evaluate(async()=>{await navigator.serviceWorker.register('/foreign-sw.js');await navigator.serviceWorker.ready;});
  await foreignPage.goto(new URL('/shell-harness',base).href);
  await foreignPage.getByText('recovery',{exact:true}).waitFor();
  assert.equal(await foreignPage.evaluate(async()=>{const registrations=await navigator.serviceWorker.getRegistrations();return registrations.some(item=>item.scope===new URL('/',location.origin).href&&item.active?.scriptURL===new URL('/foreign-sw.js',location.origin).href);}),true,'unrelated root worker is preserved');
  await foreign.close();

  const nonroot=await browser.newContext({serviceWorkers:'allow',userAgent:nativeUa}),nonrootPage=await nonroot.newPage();
  await nonrootPage.goto(new URL('/seed',base).href);
  await nonrootPage.evaluate(async()=>{await navigator.serviceWorker.register('/foreign-sw.js',{scope:'/foreign/'});await new Promise(resolve=>setTimeout(resolve,250));});
  await nonrootPage.goto(new URL('/shell-harness',base).href);
  await nonrootPage.getByText('ready',{exact:true}).waitFor();
  assert.equal(await nonrootPage.evaluate(async()=>{const items=await navigator.serviceWorker.getRegistrations();return items.some(item=>item.scope===new URL('/foreign/',location.origin).href&&item.active?.scriptURL===new URL('/foreign-sw.js',location.origin).href);}),true,'nonroot foreign worker remains installed');
  await nonroot.close();

  // Fault injection: unregister reports true while the real root registration
  // remains. This models a concurrent reinstall without touching other sites.
  const sticky=await browser.newContext({serviceWorkers:'allow',userAgent:nativeUa}),stickyPage=await sticky.newPage();
  await stickyPage.goto(new URL('/seed',base).href);
  await stickyPage.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;});
  await sticky.addInitScript(()=>{window.__unregisterCalls=0;ServiceWorkerRegistration.prototype.unregister=function(){window.__unregisterCalls++;return Promise.resolve(true);};});
  const beforeSticky=harnessLoads;
  await stickyPage.goto(new URL('/shell-harness',base).href);
  await stickyPage.getByText('recovery',{exact:true}).waitFor();
  assert.equal(harnessLoads-beforeSticky,1,'remaining root registration prevents automatic reload');
  assert.equal(await stickyPage.evaluate(()=>window.__unregisterCalls),1,'root is not repeatedly unregistered');
  await sticky.close();

  // Fault injection: an unknown controller appears only after the second
  // asynchronous registration read, before the final ready decision.
  const lateController=await browser.newContext({serviceWorkers:'allow',userAgent:nativeUa});
  await lateController.addInitScript(()=>{let reads=0;Object.defineProperty(ServiceWorkerContainer.prototype,'getRegistrations',{value:async function(){reads++;if(reads===2)Object.defineProperty(this,'controller',{configurable:true,value:{scriptURL:new URL('/foreign-sw.js',location.origin).href}});return [];}});});
  const lateControllerPage=await lateController.newPage();
  await lateControllerPage.goto(new URL('/shell-harness',base).href);
  await lateControllerPage.getByText('recovery',{exact:true}).waitFor();
  assert.equal(await lateControllerPage.locator('link[rel="manifest"]').count(),0,'late unknown controller never enables the app or PWA');
  await lateController.close();

  const failure=await browser.newContext({serviceWorkers:'allow',userAgent:nativeUa});
  await failure.addInitScript(()=>{Object.defineProperty(ServiceWorkerContainer.prototype,'getRegistrations',{value:()=>Promise.reject(new Error('inspection failed'))});});
  const failurePage=await failure.newPage();
  await failurePage.goto(new URL('/shell-harness',base).href);
  await failurePage.getByText('recovery',{exact:true}).waitFor();
  await failure.close();
  const importFailure=await browser.newContext({serviceWorkers:'block',userAgent:nativeUa}),importFailurePage=await importFailure.newPage();
  await importFailurePage.route('**/src/App.tsx*',route=>route.abort());
  await importFailurePage.goto(new URL('/',base).href);
  await importFailurePage.getByRole('heading',{name:'页面加载失败'}).waitFor();
  assert.equal(await importFailurePage.getByRole('heading',{name:'旧版离线页面状态未确认'}).count(),0,'module load failure is not mislabeled as SW migration');
  await importFailure.close();
  console.log('Browser shell PASS: browser PWA; native exact SW migration; legacy controlled fence; unknown root fence; foreign nonroot preservation; injected unregister/controller races; bounded recovery');
}finally{await browser?.close();await vite?.close();}
