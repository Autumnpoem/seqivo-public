// Explicit opt-in, one isolated new conversation; never select an existing task.
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createCore} from '../server/core.mjs';
if(process.env.TUIJIN_REAL_PROVIDER_TEST!=='1')throw Error('Set TUIJIN_REAL_PROVIDER_TEST=1 to run one isolated live Codex turn');
const dir=await mkdtemp(join(tmpdir(),'tuijin-live-codex-'));const core=await createCore({dataDir:join(dir,'data'),pluginDir:resolve('plugins'),files:false});
const evidence={startedAt:new Date().toISOString(),workspace:dir,provider:'codex',test:'new session + observed turn started + terminal result',passed:false};
try{
 await core.plugin.configure({codexPath:process.env.TUIJIN_CODEX_PATH||'',pythonPath:process.env.TUIJIN_PYTHON_PATH||''});
 const p=core.store.project({name:'推进独立连接验证',directory:dir});let task=core.store.createTask({projectId:p.id,title:'独立连接验证',goal:'只回复 TUIJIN_CONNECTION_OK，不调用工具，不读写任何文件，不委派 Agent。该测试仅检查真实会话与任务状态回传。',criteria:['真实 Codex turn 开始并完成；看板仅提交待验收']});
 const session=await core.plugin.createSession({taskId:task.id,expectedRevision:task.revision,commandId:randomUUID()});evidence.session={status:session.status,model:session.model};if(session.status!=='created')throw Error(session.error||'session not created');
 task=core.store.getTask(task.id);const result=await core.plugin.resume({taskId:task.id,expectedRevision:task.revision,commandId:randomUUID()});evidence.command={status:result.status,turnId:result.turnId};if(!['running','completed'].includes(result.status))throw Error('Provider did not start: '+result.status);
 const deadline=Date.now()+120000;
 while(Date.now()<deadline){task=core.store.getTask(task.id);if(['submitted','failed','blocked'].includes(task.status))break;await new Promise(r=>setTimeout(r,1000));}
 evidence.task={status:task.status,acceptance:task.acceptance,revision:task.revision};evidence.passed=task.status==='submitted'&&task.acceptance!=='passed';if(!evidence.passed)throw Error('Terminal result not observed');
} catch(error){evidence.error=error.message;process.exitCode=1;} finally {try{await core.close();evidence.cleanShutdown=true;}catch(error){evidence.shutdownError=error.message;process.exitCode=1;}evidence.finishedAt=new Date().toISOString();await writeFile(process.env.TUIJIN_TEST_EVIDENCE || 'design/qa/v0.2/real-codex.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));}
