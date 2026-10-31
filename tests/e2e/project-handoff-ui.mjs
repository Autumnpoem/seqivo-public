/** Isolated React transport mock. Hub/Core authorization is covered by their own tests. */
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';

let vite,browser;
try{
  vite=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:0},plugins:[{
    name:'handoff-harness',configureServer(server){server.middlewares.use('/handoff-harness',async(_req,res)=>{
      const html=await server.transformIndexHtml('/handoff-harness',`<!doctype html><html><body><div id="root"></div><script type="module">
        import React from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import ProjectHandoff from '/src/ProjectHandoff.tsx';
        const task=(id,projectId)=>({id,projectId,title:'任务'+id,goal:'目标'+id,summary:'进展'+id,nextStep:'下一步'+id,status:'running',acceptance:'unverified',issues:[]});
        window.__board={connection:{mode:'hub',lastSeen:'2026-10-19T00:00:00Z',offline:false},projects:[{id:'a',name:'甲项目',goal:'甲目标'},{id:'b',name:'乙项目',goal:'乙目标'}],tasks:[task('a','a'),task('b','b')]};
        window.__props={projectId:'a',accountId:'account-a',online:true,checking:false};window.__valid=true;
        const root=createRoot(document.getElementById('root'));
        window.renderHandoff=(extra={})=>{window.__props={...window.__props,...extra};flushSync(()=>root.render(React.createElement(ProjectHandoff,{key:window.__props.accountId+':'+window.__props.projectId,
          board:window.__board,...window.__props,isCurrent:()=>window.__valid&&window.__board.projects.some(p=>p.id===window.__props.projectId)})));};
        window.renderHandoff();
      </script></body></html>`);res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);
    });}
  }]});await vite.listen();
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844}});
  await context.addInitScript(()=>{if(window!==window.top)return;window.__copied=[];window.__requests=[];
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copied.push(text);}}});
    window.taskboard={request:async(method,path)=>{window.__requests.push({method,path});if(path==='/api/projects/a/context')return new Promise(resolve=>{window.__resolveLocal=resolve;});
      if(path==='/api/projects/b/context')return {markdown:'# 乙本机交接'};throw new Error('unexpected request');}};
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(new URL('/handoff-harness',vite.resolvedUrls.local[0]).href);
  await page.getByText('甲目标').first().waitFor();
  assert.match(await page.locator('.handoff-card').innerText(),/任务a.*进展a.*下一步a/s);
  assert.doesNotMatch(await page.locator('.handoff-card').innerText(),/乙项目|任务b/);
  await page.getByRole('button',{name:'复制交接摘要'}).click();
  assert.equal(await page.evaluate(()=>window.__copied.length),1);
  await page.evaluate(()=>window.renderHandoff({online:false}));
  await page.getByText('当前内容可能已过期',{exact:false}).waitFor();
  assert.equal(await page.getByRole('button',{name:'复制交接摘要'}).isDisabled(),true);
  await page.evaluate(()=>{window.__board={...window.__board,projects:window.__board.projects.filter(p=>p.id!=='a')};window.renderHandoff({online:true});});
  await page.getByText('先选择项目').waitFor();
  assert.equal(await page.getByRole('button',{name:'复制交接摘要'}).count(),0);
  await page.evaluate(()=>window.renderHandoff({projectId:'b',accountId:'account-b'}));
  await page.getByText('乙目标').first().waitFor();
  assert.doesNotMatch(await page.locator('.handoff-card').innerText(),/任务a|甲目标/);
  await page.evaluate(()=>{window.__valid=false;});
  await page.getByRole('button',{name:'复制交接摘要'}).click();
  assert.equal(await page.evaluate(()=>window.__copied.length),1,'stale account cannot copy');
  await page.evaluate(()=>{window.__valid=true;window.__board={...window.__board,projects:[{id:'a',name:'甲项目',goal:'甲目标'},...window.__board.projects],connection:{mode:'local'}};window.renderHandoff({projectId:'a',accountId:'local'});});
  await page.waitForFunction(()=>Boolean(window.__resolveLocal));
  await page.evaluate(()=>window.renderHandoff({projectId:'b'}));
  await page.getByText('# 乙本机交接').waitFor();
  await page.evaluate(()=>window.__resolveLocal({markdown:'# 迟到甲本机交接'}));
  assert.doesNotMatch(await page.locator('.handoff-card').innerText(),/迟到甲/);
  assert.deepEqual(await page.evaluate(()=>window.__requests.filter(r=>r.method!=='GET')),[],'handoff never writes tasks');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,checks:['scoped-project-summary','copy-visible-authorized-text','offline-copy-disabled','revoked-project-hidden','account-switch-no-old-summary','stale-identity-copy-rejected','local-context-preserved','late-local-result-ignored','no-task-writes']}));
  await context.close();
}finally{await browser?.close();await vite?.close();}
