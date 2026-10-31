/** Mock transport UI contract. This does not verify Core snapshots or Hub authorization. */
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';

const digest=character=>character.repeat(64);
let vite,browser;
try{
  vite=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:0},plugins:[{
    name:'preview-retest-harness',configureServer(server){server.middlewares.use('/retest-harness',async(_req,res)=>{
      const html=await server.transformIndexHtml('/retest-harness',`<!doctype html><html><body><div id="root"></div><script type="module">
        import React from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import PreviewRetestSection from '/src/PreviewRetestSection.tsx';
        const root=createRoot(document.getElementById('root'));window.renderRetest=(extra={})=>flushSync(()=>root.render(React.createElement(PreviewRetestSection,{
          currentPreviewId:'new-preview',previousPreviewId:'old-preview',projectId:'project-a',taskId:'task-a',contentVersion:4,
          currentSourceDigest:'${digest('a')}',criteria:[{id:'criterion-a',text:'按钮能保存内容'},{id:'criterion-b',text:'权限仍然正确'}],
          accountScope:'local-owner',mode:'local',canEdit:true,online:true,...extra})));window.renderRetest();
      </script></body></html>`);
      res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);
    });server.middlewares.use('/retest-panel-harness',async(_req,res)=>{
      const html=await server.transformIndexHtml('/retest-panel-harness',`<!doctype html><html><body><div id="root"></div><script type="module">
        import React from 'react';import{createRoot}from'react-dom/client';import PreviewPanel from '/src/PreviewPanel.tsx';
        createRoot(document.getElementById('root')).render(React.createElement(PreviewPanel,{taskId:'task-a',projectId:'project-a',
          accountScope:'local-owner',connectionMode:'local',contentVersion:4,expectedRevision:7,canRegister:true,
          criteria:[{id:'criterion-a',text:'按钮能保存内容'},{id:'criterion-b',text:'权限仍然正确'}]}));
      </script></body></html>`);
      res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);
    });server.middlewares.use((req,res,next)=>{
      if(req.url!==`/api/previews/new-preview/site/${'A'.repeat(43)}/index.html`)return next();
      res.statusCode=200;res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end('<!doctype html><html><body><button type="button">隔离预览</button></body></html>');
    });}
  }]});
  await vite.listen();
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  // Fresh contexts have no registered SW. Playwright's SW block init reads navigator.serviceWorker
  // inside the opaque sandbox iframe and itself throws SecurityError; retain pageerror assertions.
  const context=await browser.newContext({viewport:{width:390,height:844}});
  await context.addInitScript(()=>{
    if(window!==window.top)return;
    const sha=x=>x.repeat(64);
    window.__calls=[];window.__writeMode='ok';window.__mappingOverride=null;window.__comparisonOverride=null;window.__resolvePendingPut=null;
    window.__mapping={previewId:'new-preview',projectId:'project-a',taskId:'task-a',contentVersion:4,taskRevision:7,
      criteriaDigest:sha('b'),sourceDigest:sha('a'),mapRevision:1,mappingDigest:sha('c'),
      eligiblePaths:Array.from({length:1000},(_,n)=>({path:`src/file-${String(n).padStart(4,'0')}.ts`,kind:'file'})),
      items:[],editable:true};
    window.__longPath=`src/${Array.from({length:5},(_,n)=>`${n}${'a'.repeat(84)}`).join('/')}/source.ts`;
    window.__mapping.eligiblePaths[999]={path:window.__longPath,kind:'file'};
    window.__comparison={previewId:'new-preview',previousPreviewId:'old-preview',sourceState:'verified',reasonCode:null,reason:null,
      currentTaskMatchesPreview:true,binding:{projectId:'project-a',taskId:'task-a',contentVersion:4,criteriaDigest:sha('b'),sourceDigest:sha('a')},
      changedFiles:[{path:'src/file-0001.ts',change:'modified'},{path:window.__longPath,change:'modified'}],items:[
        {criterionId:'criterion-a',text:'按钮能保存内容',status:'needs_retest',reason:'对应文件已修改',reasonCode:'mapped_change',changedPaths:[{path:'src/file-0001.ts',change:'modified'},{path:window.__longPath,change:'modified'}],checkSteps:['点击保存并确认内容']},
        {criterionId:'criterion-b',text:'权限仍然正确',status:'unknown',reason:'没有对应关系',reasonCode:'unmapped',changedPaths:[],checkSteps:[]} ]};
    window.taskboard={request:async(method,path,body)=>{
      window.__calls.push({method,path,body});
      if(path.startsWith('/api/previews/')&&path.includes('/retest?'))return structuredClone(window.__comparisonOverride||window.__comparison);
      if(path==='/api/preview/retest-mappings/new-preview'&&method==='GET')return structuredClone(window.__mappingOverride||window.__mapping);
      if(path==='/api/preview/retest-mappings/new-preview'&&method==='PUT'){
        if(window.__writeMode==='lost')throw new Error('回执丢失');
        if(window.__writeMode==='pending')return new Promise(resolve=>{window.__resolvePendingPut=()=>{
          window.__mapping={...window.__mapping,items:structuredClone(body.items),mapRevision:2,mappingDigest:'d'.repeat(64)};
          resolve({mapRevision:2});};});
        window.__mapping={...window.__mapping,items:structuredClone(body.items),mapRevision:2,mappingDigest:'d'.repeat(64)};
        return {mapRevision:2};
      }
      throw new Error(`unexpected ${method} ${path}`);
    }};
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(new URL('/retest-harness',vite.resolvedUrls.local[0]).href);
  const section=page.getByRole('region',{name:'逐项重验清单'});
  await section.getByText('按钮能保存内容').first().waitFor();
  const longPath=await page.evaluate(()=>window.__longPath);
  assert.ok(longPath.length>400&&new TextEncoder().encode(longPath).length<=1024);
  await section.getByText('查看关联文件（2）').click();
  await section.getByText('src/file-0001.ts · 修改',{exact:true}).waitFor();
  await section.getByText(`${longPath} · 修改`,{exact:true}).waitFor();
  assert.equal(await section.getByText('请重新检查',{exact:true}).count(),1);
  assert.equal(await section.getByText('影响尚不确定',{exact:true}).count(),1);
  assert.equal(await section.getByText('点击保存并确认内容').count(),1);
  const compareReads=await page.evaluate(()=>window.__calls.filter(call=>call.path.includes('/retest?')).length);
  await section.getByRole('button',{name:'重新读取重验说明'}).click();
  await page.waitForFunction(count=>window.__calls.filter(call=>call.path.includes('/retest?')).length===count+1,compareReads);
  await page.evaluate(()=>window.renderRetest({currentPreviewId:'other-preview'}));
  assert.equal(await section.getByText('请重新检查',{exact:true}).count(),0,'old B comparison is hidden in the first C render');
  assert.equal(await section.getByRole('button',{name:'保存这版的检查说明'}).count(),0,'old mapping cannot enable C write');
  await page.evaluate(()=>window.renderRetest());
  await section.getByText('请重新检查',{exact:true}).waitFor();
  await section.getByText('指定这版的对应文件和检查方法').click();
  await section.getByLabel('选择要填写的标准').selectOption('criterion-a');
  assert.equal(await section.locator('.preview-retest-candidates input[type=checkbox]').count(),80,'1000 candidates do not render per criterion');
  await section.getByLabel('搜索可选文件').fill('source.ts');
  assert.equal(await section.locator('.preview-retest-candidates input[type=checkbox]').count(),1);
  await section.locator('.preview-retest-candidates input[type=checkbox]').check();
  await section.getByLabel('搜索可选文件').fill('file-0001');
  await section.locator('.preview-retest-candidates input[type=checkbox]').check();
  assert.equal(await section.locator('.preview-retest-selected li').count(),2,'hidden selection survives search');
  await section.getByLabel('检查步骤（每行一步，最多 5 步）').fill('点击保存\n核对结果');
  await page.evaluate(()=>{window.__writeMode='lost';});
  await section.getByRole('button',{name:'保存这版的检查说明'}).click();
  await section.getByText('保存结果尚未确认',{exact:false}).first().waitFor();
  assert.equal(await section.getByRole('button',{name:'保存这版的检查说明'}).isDisabled(),true);
  assert.equal(await page.evaluate(()=>window.__calls.filter(call=>call.method==='PUT').length),1);
  await page.evaluate(()=>window.renderRetest({online:false}));
  await section.getByText('当前离线',{exact:false}).waitFor();
  await page.evaluate(()=>window.renderRetest({online:true}));
  await section.getByText('原保存结果尚未确认',{exact:false}).waitFor();
  assert.equal(await page.evaluate(()=>window.__calls.filter(call=>call.method==='PUT').length),1,'online wake does not repeat uncertain PUT');
  await section.getByRole('button',{name:'重新读取当前设置'}).click();
  await section.getByText('当前设置与本次填写不同',{exact:false}).waitFor();
  assert.equal(await page.evaluate(()=>window.__calls.filter(call=>call.method==='PUT').length),1);
  await page.evaluate(()=>{window.__writeMode='pending';window.__mappingOverride=null;window.renderRetest({accountScope:'pending-write'});});
  if(!await section.locator('details.preview-retest-editor').evaluate(element=>element.open))
    await section.getByText('指定这版的对应文件和检查方法').click();
  await section.getByLabel('选择要填写的标准').selectOption('criterion-a');
  await section.getByLabel('检查步骤（每行一步，最多 5 步）').fill('超时后核对');
  await section.getByRole('button',{name:'保存这版的检查说明'}).click();
  await section.getByText('保存结果尚未确认',{exact:false}).first().waitFor({timeout:12000});
  assert.equal(await section.getByRole('button',{name:'保存这版的检查说明'}).isDisabled(),true);
  assert.equal(await section.getByRole('button',{name:'重新读取当前设置'}).isEnabled(),true,'timeout releases read-only verification');
  const putCount=await page.evaluate(()=>window.__calls.filter(call=>call.method==='PUT').length);
  assert.equal(putCount,2);
  await page.evaluate(()=>window.__resolvePendingPut());
  await section.getByText('原保存结果尚未确认',{exact:false}).waitFor();
  assert.equal(await page.evaluate(()=>window.__calls.filter(call=>call.method==='PUT').length),putCount,'late PUT reply cannot replay');
  await section.getByRole('button',{name:'重新读取当前设置'}).click();
  await section.getByText('当前设置与本次填写一致',{exact:false}).waitFor();
  assert.equal(await page.evaluate(()=>window.__calls.filter(call=>call.method==='PUT').length),putCount);
  await page.evaluate(()=>{window.__comparisonOverride={...window.__comparison,sourceState:'unknown',reasonCode:'source_unknown',reason:'来源无法核实',binding:{...window.__comparison.binding,sourceDigest:null},changedFiles:[],items:window.__comparison.items.map(item=>({...item,status:'unknown',reason:'来源无法核实',reasonCode:'source_unknown',changedPaths:[],checkSteps:[]}))};window.renderRetest({accountScope:'unknown-source'});});
  await section.getByText('两版源码暂时无法完整核对',{exact:false}).waitFor();
  assert.equal(await section.getByText('重验清单与所选版本不匹配',{exact:false}).count(),0,'real unknown DTO with null source digest is accepted conservatively');
  await page.evaluate(()=>{window.__mappingOverride={...window.__mapping,eligiblePaths:[],editable:false,blockedReason:'path_limit'};window.renderRetest({accountScope:'path-limit'});});
  await section.getByText('候选文件超过本版范围',{exact:false}).waitFor();
  assert.equal(await section.getByRole('button',{name:'保存这版的检查说明'}).count(),0,'Core path-limit DTO is read-only');
  await page.evaluate(()=>{window.__mappingOverride={...window.__mapping,eligiblePaths:[{path:`src/${'界'.repeat(341)}.ts`,kind:'file'}]};window.renderRetest({accountScope:'oversized-path'});});
  await section.getByRole('alert').getByText('检查说明与所选版本不匹配',{exact:false}).waitFor();
  assert.equal(await section.getByRole('button',{name:'保存这版的检查说明'}).count(),0,'over-1024 UTF-8 bytes rejects mapping DTO');
  await page.evaluate(()=>{window.__comparisonOverride={...window.__comparison,binding:{...window.__comparison.binding,taskId:'task-b'}};window.renderRetest({accountScope:'other-account'});});
  await section.getByText('重验清单与所选版本不匹配',{exact:false}).waitFor();
  assert.equal(await section.getByText('请重新检查',{exact:true}).count(),0,'wrong-scope comparison cannot claim verified impact');
  await page.evaluate(()=>window.renderRetest({mode:'hub',canEdit:false,accountScope:'viewer'}));
  await section.getByText('指定这版的对应文件和检查方法').waitFor({state:'detached'});
  assert.equal(await section.getByRole('button',{name:'保存这版的检查说明'}).count(),0);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,checks:['real-verified-DTO-null-reason','human-three-line-card','old-comparison-hidden-on-identity-render','real-unknown-DTO-null-digest','long-valid-utf8-path','1000-candidate-bounded-editor','search-preserves-selection','lost-PUT-lock','offline-online-no-replay','manual-current-read','never-settling-PUT-timeout','late-PUT-reply-ignored','Core-path-limit-read-only','overlong-utf8-path-rejected','wrong-scope-rejected','hub-read-only']}));
  await context.close();
  const panelContext=await browser.newContext({viewport:{width:390,height:844}});
  let siteResponses=0;
  await panelContext.route(`**/api/previews/new-preview/site/${'A'.repeat(43)}/index.html`,route=>{
    siteResponses++;
    return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:'<!doctype html><html><body><button type="button">隔离预览</button></body></html>'});
  });
  await panelContext.addInitScript(origin=>{
    if(window!==window.top)return;
    const sha=character=>character.repeat(64),preview=(previewId,version,createdAt)=>({previewId,projectId:'project-a',taskId:'task-a',contentVersion:version,
      sourceTaskRevision:7,sourceCommit:sha('1').slice(0,40),artifactDigest:sha('2'),environment:'隔离测试',dataMode:'simulated',
      capability:'static-interactive',backendApi:'unsupported',createdAt,
      provenance:{kind:'managed-vite-vanilla-v1',sourceDigest:sha('a'),inputDigest:sha('3'),buildReceiptDigest:sha('4'),toolDigest:sha('5'),profileDigest:sha('6')}});
    window.__panelCalls=[];window.__panelIssueCount=0;window.__panelCompareCount=0;window.__panelMapping={previewId:'new-preview',projectId:'project-a',taskId:'task-a',
      contentVersion:4,taskRevision:7,criteriaDigest:sha('b'),sourceDigest:sha('a'),mapRevision:0,mappingDigest:sha('c'),
      eligiblePaths:[{path:'src/file.ts',kind:'file'}],items:[],editable:true};
    const previews=[preview('new-preview',4,'2026-10-19T00:00:00Z'),preview('old-preview',3,'2026-10-18T00:00:00Z')];
    const intent=(state)=>({id:'i'.repeat(43),previewId:'new-preview',projectId:'project-a',taskId:'task-a',state,expiresAt:Date.now()+600000});
    window.taskboard={request:async(method,path,body)=>{
      window.__panelCalls.push({method,path});
      if(method==='GET'&&path==='/api/preview/transport')return {kind:'desktop-loopback',origin};
      if(method==='GET'&&path.startsWith('/api/previews?'))return {previews:structuredClone(previews)};
      if(method==='GET'&&path==='/api/preview/retest-mappings/new-preview')return structuredClone(window.__panelMapping);
      if(method==='PUT'&&path==='/api/preview/retest-mappings/new-preview'){
        window.__panelMapping={...window.__panelMapping,items:structuredClone(body.items),mapRevision:1,mappingDigest:sha('d')};return {mapRevision:1};
      }
      if(method==='GET'&&path==='/api/previews/new-preview/retest?previous=old-preview'){
        window.__panelCompareCount++;
        const mapped=window.__panelMapping.items.length>0;
        return {previewId:'new-preview',previousPreviewId:'old-preview',sourceState:mapped?'verified':'unknown',
          reasonCode:mapped?null:'mapping_missing',reason:mapped?null:'尚未设置检查说明',currentTaskMatchesPreview:true,
          binding:{projectId:'project-a',taskId:'task-a',contentVersion:4,criteriaDigest:sha('b'),sourceDigest:mapped?sha('a'):null},
          changedFiles:mapped?[{path:'src/file.ts',change:'modified'}]:[],items:[{criterionId:'criterion-a',text:'按钮能保存内容',
            status:mapped?'needs_retest':'unknown',reason:mapped?'文件已修改':'来源待核对',reasonCode:mapped?'mapped_file_changed':'mapping_missing',
            changedPaths:mapped?[{path:'src/file.ts',change:'modified'}]:[],checkSteps:mapped?['点击并核对保存']:[]}]};
      }
      if(method==='POST'&&path==='/api/previews/new-preview/access-intents')return {intent:intent('registered')};
      if(method==='POST'&&path.endsWith('/issue')){window.__panelIssueCount++;return {preview:structuredClone(previews[0]),
        launchUrl:`/api/previews/new-preview/site/${'A'.repeat(43)}/index.html`,intent:intent('issued')};}
      throw new Error(`unexpected ${method} ${path}`);
    }};
  },new URL(vite.resolvedUrls.local[0]).origin);
  const panel=await panelContext.newPage(),panelErrors=[];panel.on('pageerror',error=>panelErrors.push(error.message));
  await panel.goto(new URL('/retest-panel-harness',vite.resolvedUrls.local[0]).href);
  const integrated=panel.getByRole('region',{name:'逐项重验清单'});
  await integrated.getByText('两版源码暂时无法完整核对',{exact:false}).waitFor();
  await panel.locator('iframe').waitFor();
  const before=await panel.evaluate(()=>{const frame=document.querySelector('iframe');frame.dataset.retestProbe='kept';return {src:frame.src,issues:window.__panelIssueCount,compares:window.__panelCompareCount};});
  await integrated.getByText('指定这版的对应文件和检查方法').click();
  await integrated.getByLabel('选择要填写的标准').selectOption('criterion-a');
  await integrated.locator('.preview-retest-candidates input[type=checkbox]').check();
  await integrated.getByLabel('检查步骤（每行一步，最多 5 步）').fill('点击并核对保存');
  await integrated.getByRole('button',{name:'保存这版的检查说明'}).click();
  await integrated.getByText('当前设置与本次填写一致',{exact:false}).waitFor();
  await integrated.getByText('请重新检查',{exact:true}).waitFor();
  const after=await panel.evaluate(()=>{const frame=document.querySelector('iframe');return {sameNode:frame?.dataset.retestProbe==='kept',src:frame?.src,issues:window.__panelIssueCount,compares:window.__panelCompareCount};});
  assert.equal(after.sameNode,true,'mapping refresh does not replace iframe');
  assert.equal(after.src,before.src,'mapping refresh preserves the exact preview URL');
  assert.equal(after.issues,before.issues,'mapping refresh does not issue another preview access');
  assert.ok(after.compares>before.compares,'confirmed mapping read refreshes only comparison');
  assert.equal(siteResponses,1,'only the exact preview site was loaded once');
  const compareBeforeRead=after.compares;
  await integrated.getByRole('button',{name:'重新读取重验说明'}).click();
  await panel.waitForFunction(count=>window.__panelCompareCount===count+1,compareBeforeRead);
  assert.equal(await panel.evaluate(()=>window.__panelIssueCount),before.issues,'manual comparison read does not issue a new iframe access');
  assert.deepEqual(panelErrors,[]);
  console.log(JSON.stringify({passed:true,checks:['panel-selected-preview-binding','mapping-readback-refreshes-comparison','mapping-does-not-reissue-or-remount-iframe','manual-comparison-read-no-new-access']}));
  await panelContext.close();
}finally{await browser?.close();await vite?.close();}
