import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {createCore} from '../server/core.mjs';import {startHttp} from '../server/http.mjs';
test('MCP process exchanges context and reports through restricted HTTP role',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'tuijin-mcp-')),core=await createCore({dataDir,pluginDir:resolve('plugins'),files:false}),web=await startHttp({core,dataDir,distDir:resolve('dist'),port:0});
 const child=spawn(process.execPath,['server/mcp.mjs'],{env:{...process.env,TUIJIN_DATA_DIR:dataDir,TUIJIN_URL:`http://127.0.0.1:${web.port}`},stdio:['pipe','pipe','pipe']});
 const pending=new Map();let id=0;const lines=createInterface({input:child.stdout});lines.on('line',line=>{const value=JSON.parse(line);pending.get(value.id)?.(value.result);pending.delete(value.id);});const call=(method,params)=>new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>reject(Error('MCP timeout')),5000);pending.set(key,result=>{clearTimeout(timer);resolve(result);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:key,method,params})+'\n');});
 t.after(async()=>{child.stdin.end();await new Promise(resolve=>child.once('exit',resolve));lines.close();await web.close();await core.close();await rm(dataDir,{recursive:true,force:true});});
 const init=await call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'integration-test',version:'1'}});assert.equal(init.serverInfo.name,'tuijin-taskboard');assert.equal((await call('tools/list')).tools.length,6);
 const project=core.store.project({name:'真实MCP传输测试',goal:'新对话可读取已有背景'});const result=await call('tools/call',{name:'task_create',arguments:{projectId:project.id,title:'验证接口',goal:'真实HTTP汇报',criteria:['状态持久化']}});const created=JSON.parse(result.content[0].text);assert.equal(created.status,'accepted');
 const report=await call('tools/call',{name:'task_report',arguments:{taskId:created.taskId,expectedRevision:1,summary:'完成进度汇报',status:'submitted'}});assert.equal(report.isError,undefined);assert.equal(core.store.getTask(created.taskId).acceptance,'unverified');
 const baseline=await call('tools/call',{name:'task_report',arguments:{taskId:created.taskId,expectedRevision:2,summary:'改要求',goal:'降低标准'}});assert.equal(baseline.isError,true);
 const context=await call('tools/call',{name:'project_context',arguments:{projectId:project.id}});assert.match(context.content[0].text,/完成进度汇报/);
 const decision={taskId:created.taskId,expectedRevision:2,requestId:'storage-choice',title:'保存方案需要确认',summary:'数据需要持久保存',impact:'确认后才能实现',options:[{id:'sqlite',label:'SQLite',consequence:'在本机保存'}],shareWithRemote:true};
 const requested=await call('tools/call',{name:'task_decision',arguments:decision});assert.equal(requested.isError,undefined);
 const repeated=await call('tools/call',{name:'task_decision',arguments:decision});
 assert.equal(JSON.parse(requested.content[0].text).itemId,JSON.parse(repeated.content[0].text).itemId);
 assert.equal((await core.state()).inbox.items.filter(item=>item.kind==='decision').length,1);
 const invalid=await call('tools/call',{name:'task_decision',arguments:{...decision,requestId:'forged',decision:'pass'}});assert.equal(invalid.isError,true);
 assert.match((await call('tools/call',{name:'project_context',arguments:{projectId:project.id}})).content[0].text,/保存方案需要确认/);
});
