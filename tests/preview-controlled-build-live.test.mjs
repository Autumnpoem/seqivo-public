import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { createHub } from '../server/hub/http.mjs';
import { startHttp } from '../server/http.mjs';

const exec=promisify(execFile);
const PYTHON=process.env.SEQIVO_TEST_PYTHON;
const gitEnv={...Object.fromEntries(Object.entries(process.env)
  .filter(([key])=>!key.startsWith('GIT_'))),GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('owner HTTP build keeps one original request and Hub serves its fixed Vite artifact',
  {skip:process.platform!=='darwin'||!PYTHON?'Mac and explicit SEQIVO_TEST_PYTHON are required':false},async t=>{
    const root=await realpath(await mkdtemp(join(tmpdir(),'seqivo-preview-controlled-live-')));
    await chmod(root,0o700);
    let core,hub,local,bodyPassed=false;
    t.after(async()=>{
      const failures=[];
      for(const close of [()=>local?.close(),()=>core?.close(),()=>hub?.close()])
        try{await close();}catch(error){failures.push(error);}
      if(bodyPassed&&!failures.length)try{await rm(root,{recursive:true,force:true});}
        catch(error){failures.push(error);}
      if(failures.length)throw new AggregateError(failures,
        'Controlled preview live cleanup unconfirmed; isolated fixture retained');
    });
    const projectDir=join(root,'project'),coreData=join(root,'core');
    await mkdir(projectDir);await mkdir(coreData,{mode:0o700});
    await writeFile(join(projectDir,'index.html'),
      '<!doctype html><html><body><div id="app"></div><script type="module" src="./main.js"></script></body></html>');
    await writeFile(join(projectDir,'main.js'),
      'import "./style.css"; document.getElementById("app").textContent="controlled HTTP artifact";');
    await writeFile(join(projectDir,'style.css'),'body{color:#123456}');
    const git=async(...args)=>exec('/usr/bin/git',args,{cwd:projectDir,env:gitEnv,timeout:10000});
    await git('init','-q');
    await git('-c','core.hooksPath=/dev/null','add','index.html','main.js','style.css');
    await git('-c','core.hooksPath=/dev/null','-c','user.name=Preview Test',
      '-c','user.email=preview@example.invalid','commit','-qm','fixture');

    hub=await createHub({dataDir:join(root,'hub'),port:0});
    core=await createCore({dataDir:coreData,pluginDir:join(root,'plugins'),files:false,
      previewPythonPath:PYTHON});
    const project=core.store.project({name:'Controlled HTTP preview',directory:projectDir});
    const task=core.store.createTask({projectId:project.id,title:'Build and open'});
    const username=`preview_${randomBytes(5).toString('hex')}`;
    const password=randomBytes(24).toString('base64url');
    const account=await hub.accounts.register({username,password,source:'isolated'});
    const cookie=`hub_session=${account.sessionToken}`;
    await core.remote.login({url:hub.url,username,password,projectIds:[project.id]});
    const snapshotDeadline=Date.now()+10000;
    while(!hub.store.db.prepare('SELECT received_at FROM snapshots').get()?.received_at&&
      Date.now()<snapshotDeadline)await wait(50);
    assert.ok(hub.store.db.prepare('SELECT received_at FROM snapshots').get()?.received_at);
    local=await startHttp({core,dataDir:coreData,distDir:root,port:0});
    const localOrigin=`http://127.0.0.1:${local.port}`;
    const localCall=async(method,path,body,token=local.tokens.owner)=>{
      const response=await fetch(localOrigin+path,{method,headers:{Origin:localOrigin,
        Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
      const bytes=Buffer.from(await response.arrayBuffer());
      return {status:response.status,data:response.headers.get('content-type')?.includes('json')?
        JSON.parse(bytes.toString()):null,bytes};
    };
    const hubCall=async(method,path,body,sessionCookie=cookie)=>{
      const response=await fetch(hub.url+path,{method,headers:{Origin:hub.url,Cookie:sessionCookie,
        ...(body===undefined?{}:{'Content-Type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
      const bytes=Buffer.from(await response.arrayBuffer());
      return {status:response.status,data:response.headers.get('content-type')?.includes('json')?
        JSON.parse(bytes.toString()):null,bytes};
    };
    const requestId='controlled-http-original';
    const build={requestId,projectId:project.id,taskId:task.id,
      expectedRevision:task.revision,contentVersion:task.contentVersion,worktreeId:null,
      profile:'vite-vanilla-v1',apiTarget:'static',dataMode:'simulated'};
    assert.equal((await localCall('POST','/api/preview/controlled-builds',build,local.tokens.viewer)).status,403);
    assert.equal((await localCall('POST','/api/preview/controlled-builds',
      {...build,requestId:'wrong-version',expectedRevision:task.revision+1})).status,409);
    const started=await localCall('POST','/api/preview/controlled-builds',build);
    assert.equal(started.status,200);
    assert.equal(started.data.build.requestId,requestId);
    let current=started.data.build;
    const deadline=Date.now()+30000;
    while(!['ready','failed_no_publish','unknown'].includes(current.state)&&Date.now()<deadline){
      await wait(100);
      const status=await localCall('GET',`/api/preview/controlled-builds/${requestId}`);
      assert.equal(status.status,200);
      current=status.data.build;
    }
    assert.equal(current.state,'ready',`controlled build stopped at ${current.state}: ${current.errorCode||'none'}`);
    const repeated=await localCall('POST','/api/preview/controlled-builds',build);
    assert.equal(repeated.status,200);
    assert.equal(repeated.data.build.previewId,current.previewId);
    assert.equal(core.store.db.prepare('SELECT count(*) AS n FROM preview_controlled_builds').get().n,1);
    const listing=await hubCall('GET',`/api/previews?taskId=${task.id}`);
    assert.equal(listing.status,200);
    assert.equal(listing.data.previews.length,1);
    assert.equal(listing.data.previews[0].previewId,current.previewId);
    const intent=await hubCall('POST',`/api/previews/${current.previewId}/access-intents`,{});
    assert.equal(intent.status,200);
    const issued=await hubCall('POST',
      `/api/previews/${current.previewId}/access-intents/${intent.data.intent.id}/issue`,{});
    assert.equal(issued.status,200);
    const html=await hubCall('GET',issued.data.launchUrl);
    assert.equal(html.status,200);
    assert.match(html.bytes.toString(),/assets\//);
    const assetPath=/src="([^"]+\.js)"/.exec(html.bytes.toString())?.[1];
    assert.ok(assetPath);
    const assetUrl=new URL(assetPath,hub.url+issued.data.launchUrl);
    const asset=await hubCall('GET',assetUrl.pathname);
    assert.equal(asset.status,200);
    assert.match(asset.bytes.toString(),/controlled HTTP artifact/);
    const other=await hub.accounts.register({username:`other_${randomBytes(5).toString('hex')}`,
      password:randomBytes(24).toString('base64url'),source:'isolated'});
    assert.notEqual((await hubCall('GET',`/api/previews/${current.previewId}`,undefined,
      `hub_session=${other.sessionToken}`)).status,200);
    // The Hub has committed the exact preview while the local registration
    // receipt write fails. Reconciliation must query that historical ID after
    // a revision-only edit, then restore the local asset-read gate.
    const originalMark=core.previewRegistry.markRegistered;
    let rejectOriginalAck=true;
    core.previewRegistry.markRegistered=(...args)=>{
      if(rejectOriginalAck){rejectOriginalAck=false;throw Error('isolated_registration_receipt_write_failure');}
      return originalMark(...args);
    };
    const lostId='controlled-http-lost-ack';
    const lost=await localCall('POST','/api/preview/controlled-builds',{...build,requestId:lostId});
    assert.equal(lost.status,200);
    let lostState=lost.data.build;
    const lostDeadline=Date.now()+30000;
    while(!(lostState.state==='output_ready'&&lostState.errorCode==='BUILD_PUBLISH_UNKNOWN')&&
      !['failed_no_publish','unknown','ready'].includes(lostState.state)&&Date.now()<lostDeadline){
      await wait(100);
      lostState=(await localCall('GET',`/api/preview/controlled-builds/${lostId}`)).data.build;
    }
    assert.equal(lostState.state,'output_ready');
    assert.equal(lostState.errorCode,'BUILD_PUBLISH_UNKNOWN');
    assert.equal(rejectOriginalAck,false);
    assert.equal(await core.previewRegistry.isRegistered(lostState.previewId),false);
    assert.equal(hub.store.db.prepare('SELECT count(*) AS n FROM preview_builds WHERE preview_id=?')
      .get(lostState.previewId).n,1);
    core.previewRegistry.markRegistered=originalMark;
    const revised=core.store.updateTask(task.id,{nextStep:'Revision-only edit after Hub commit'},task.revision);
    assert.equal(revised.revision,task.revision+1);
    assert.equal(revised.contentVersion,task.contentVersion);
    const recovered=await localCall('POST',`/api/preview/controlled-builds/${lostId}/reconcile`,{});
    assert.equal(recovered.status,200);
    assert.equal(recovered.data.build.state,'ready');
    assert.equal(recovered.data.build.previewId,lostState.previewId);
    assert.equal(await core.previewRegistry.isRegistered(lostState.previewId),true);
    const restoredIntent=await hubCall('POST',`/api/previews/${lostState.previewId}/access-intents`,{});
    assert.equal(restoredIntent.status,200);
    const restoredIssue=await hubCall('POST',
      `/api/previews/${lostState.previewId}/access-intents/${restoredIntent.data.intent.id}/issue`,{});
    assert.equal(restoredIssue.status,200);
    const restoredHtml=await hubCall('GET',restoredIssue.data.launchUrl);
    assert.equal(restoredHtml.status,200);
    const restoredJsPath=/src="([^"]+\.js)"/.exec(restoredHtml.bytes.toString())?.[1];
    assert.ok(restoredJsPath);
    const restoredJs=await hubCall('GET',new URL(restoredJsPath,hub.url+restoredIssue.data.launchUrl).pathname);
    assert.equal(restoredJs.status,200);
    assert.match(restoredJs.bytes.toString(),/controlled HTTP artifact/);
    bodyPassed=true;
  });
