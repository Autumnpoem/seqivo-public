import {mkdtemp,writeFile} from 'node:fs/promises';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';import {createCore} from '../server/core.mjs';
if(process.env.TUIJIN_REAL_PROVIDER_TEST!=='1')throw Error('Explicit TUIJIN_REAL_PROVIDER_TEST=1 required');
const dir=await mkdtemp(join(tmpdir(),'tuijin-live-workflow-'));const core=await createCore({dataDir:join(dir,'data'),pluginDir:resolve('plugins'),files:false});
const evidence={startedAt:new Date().toISOString(),provider:'codex',scenario:'durable workflow -> owned Codex turn -> verified terminal -> separate human acceptance',passed:false};
try{
 await core.plugin.configure({codexPath:process.env.TUIJIN_CODEX_PATH||'',pythonPath:process.env.TUIJIN_PYTHON_PATH||''});
 const p=core.store.project({name:'独立协作验收',directory:dir});let task=core.store.createTask({projectId:p.id,title:'协作调度链路验证',goal:'只回复 TUIJIN_WORKFLOW_OK，不调用工具，不读写文件，不委派，不启动其他会话。',criteria:['provider starts and completes; acceptance stays separate']});
 const session=await core.plugin.createSession({taskId:task.id,expectedRevision:task.revision,commandId:randomUUID()});if(session.status!=='created')throw Error(session.error||session.status);
 const plan=await core.request('POST','/api/workflow/plans',{projectId:p.id,members:[{taskId:task.id,provider:'codex-autocontinue',role:'connection_tester',dependsOn:[]}],maxConcurrent:1,maxStarts:1,budgetMinutes:2});
 await core.request('POST',`/api/workflow/plans/${plan.id}/start`,{});
 const until=Date.now()+120000;
 let state;
 while(Date.now()<until){await core.workflow.tick();state=core.workflow.state().plans.find(p=>p.id===plan.id);if(state.members[0].status==='awaiting_review'||['failed','stale','unknown'].includes(state.members[0].status))break;await new Promise(r=>setTimeout(r,1000));}
 task=core.store.getTask(task.id);evidence.beforeReview={member:state.members[0].status,task:task.status,acceptance:task.acceptance,starts:state.starts};
 const execution=await core.plugin.getExecution({taskId:task.id,commandId:state.members[0].commandId});evidence.execution=execution;
 if(state.members[0].status!=='awaiting_review'||task.acceptance==='passed'||execution.status!=='completed')throw Error('Provider completion or separated acceptance not verified');
 task=core.store.addEvidence(task.id,{expectedRevision:task.revision,summary:'独立真实 Codex 回合开始和完成，协作状态等待人工验收',reference:'design/qa/v0.2/real-workflow.json'});
 core.store.review(task.id,{expectedRevision:task.revision,decision:'pass',summary:'仅验收此独立连接场景，非正式项目功能验收'});await core.workflow.tick();
 evidence.finalPlan=core.workflow.state().plans.find(p=>p.id===plan.id).status;evidence.passed=evidence.finalPlan==='complete';if(!evidence.passed)throw Error('Acceptance did not close plan');
}catch(error){evidence.error=error.message;process.exitCode=1;}finally{try{await core.close();evidence.cleanShutdown=true;}catch(error){evidence.shutdownError=error.message;process.exitCode=1;}evidence.finishedAt=new Date().toISOString();await writeFile(process.env.TUIJIN_TEST_EVIDENCE || 'design/qa/v0.2/real-workflow.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));}
