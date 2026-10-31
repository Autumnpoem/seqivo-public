import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium,webkit} from '@playwright/test';
import {createCore} from '../../server/core.mjs';
import {startHttp} from '../../server/http.mjs';

const engine=process.env.TEST_BROWSER==='webkit'?'webkit':'chromium';
const root=await mkdtemp(join(tmpdir(),'seqivo-inbox-scroll-'));
const qa=resolve(process.env.QA_DIR||'design/qa/inbox-scroll');
await mkdir(qa,{recursive:true});
let core,web,browser,page;
const results=[],errors=[];
try{
  core=await createCore({dataDir:join(root,'data'),pluginDir:resolve('plugins'),files:false});
  const project=core.store.project({name:'滚动检查（隔离测试）',goal:'能滚到最后一项并操作'});
  for(let i=1;i<=8;i++){
    const task=core.store.createTask({projectId:project.id,title:`滚动测试任务 ${i}`,summary:'功能已经完成，仍有一个选择需要你决定。'.repeat(4),criteria:['能够看到并操作底部事项']});
    core.inbox.requestDecision(task.id,{expectedRevision:task.revision,requestId:`scroll-${i}`,title:`滚动测试事项 ${i}`,summary:'请查看完整内容并选择下一步。',impact:'选择之后继续处理。',options:[{id:'continue',label:'继续',consequence:'按当前方案继续'}],shareWithRemote:true});
  }
  web=await startHttp({core,dataDir:join(root,'data'),distDir:resolve(process.env.TEST_DIST_DIR||'dist'),port:0});
  browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(token=>sessionStorage.setItem('taskboard-token',token),web.tokens.owner);
  for(const [width,height] of [[1180,820],[900,500],[761,600],[760,600],[390,844],[320,640]]){
    await page.setViewportSize({width,height});
    await page.goto(`http://127.0.0.1:${web.port}`);
    if(width<=760){
      await page.getByRole('button',{name:/^更多页面/}).click();
      await page.getByRole('menuitem',{name:'需要我处理'}).click();
    }else{
      await page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name:'需要我处理'}).click();
    }
    await page.locator('.inbox-card').first().waitFor();
    assert.equal(await page.locator('.inbox-card').count(),5);
    const initialHeader=await page.locator('.main-header').boundingBox();
    async function wheelToBottom(selector){
      const box=await page.locator('.inbox-page').boundingBox();
      await page.mouse.move(Math.min(width-30,box.x+box.width/2),Math.min(height-120,Math.max(box.y+40,height/2)));
      await page.mouse.wheel(0,12000);
      await page.waitForFunction(({selector,height,mobile})=>{
        const node=document.querySelector(selector);if(!node)return false;
        const box=node.getBoundingClientRect();
        const bottom=mobile?(document.querySelector('.mobile-nav')?.getBoundingClientRect().top??height):height;
        return box.top>=0&&box.bottom<=bottom&&box.height>0;
      },{selector,height,mobile:width<=760},{timeout:2500});
    }
    // A locator.click() could scroll programmatically through overflow:hidden;
    // require wheel input to expose the button before clicking it.
    await wheelToBottom('.inbox-more');
    await page.getByRole('button',{name:'查看其余 3 项',exact:true}).click();
    assert.equal(await page.locator('.inbox-card').count(),8);
    await wheelToBottom('.inbox-card:last-child .inbox-actions button:last-child');
    await page.locator('.inbox-card').last().getByRole('button',{name:'答复决策',exact:true}).click();
    await wheelToBottom('.inbox-card:last-child .inbox-actions button:last-child');
    await page.locator('.inbox-card').last().getByRole('button',{name:'收起填写',exact:true}).click();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal clipping');
    if(width>760){
      const header=await page.locator('.main-header').boundingBox();
      assert.ok(Math.abs(header.y-initialHeader.y)<1,'desktop header stays in view');
      assert.ok(await page.locator('.inbox-page').evaluate(node=>node.scrollTop>0),'desktop content receives wheel scroll');
    }
    await page.screenshot({path:join(qa,`${engine}-${width}.png`)});
    results.push({width,height,wheelReachedMore:true,wheelReachedLastAction:true,lastCardOpenedAndClosed:true});
  }
  assert.deepEqual(errors,[]);
  await writeFile(join(qa,`result-${engine}.json`),JSON.stringify({engine,passed:true,physicalDevice:false,realAI:false,results},null,2));
  console.log(`PASS [${engine}]: wheel reaches more/last actions across ${results.length} desktop/mobile sizes`);
}catch(error){
  if(page)await page.screenshot({path:join(qa,`failure-${engine}.png`)}).catch(()=>{});
  await writeFile(join(qa,`failure-${engine}.json`),JSON.stringify({engine,passed:false,results,error:error.message},null,2));
  throw error;
}finally{await browser?.close();await web?.close();await core?.close();await rm(root,{recursive:true,force:true});}
