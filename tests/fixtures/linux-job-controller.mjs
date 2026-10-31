import { prepareLinuxExecutorJob } from '../../server/linux-executor-job.mjs';
import { fileURLToPath } from 'node:url';
const [recordRoot,workspace,taskId,projectId,mode]=process.argv.slice(2);
const pythonPath=process.env.TASKBOARD_TEST_PYTHON||'/usr/bin/python3';
const job=await prepareLinuxExecutorJob({recordRoot,workspace,taskId,projectId,
 command:pythonPath,args:['-B',fileURLToPath(new URL('./linux-job-workload.py',import.meta.url)),mode,workspace],
 env:{PATH:'/usr/bin:/bin',HOME:workspace,PYTHONDONTWRITEBYTECODE:'1'},pythonPath});
let launched, startUnknown=false;
try {
 launched=await job.spawn();
 launched.stdout.resume();launched.stderr.resume();
} catch(error) {
 // A leader that already exited must not be admitted as a live executor.
 // Its durable job still permits the new controller to inspect and retire descendants.
 if(mode!=='double-fork'||error.message!=='job_start_unconfirmed')throw error;
 startUnknown=true;
}
process.stdout.write(JSON.stringify({recordId:job.recordId,recordRoot:job.recordRoot,pid:launched?.pid??job.identity?.pid,identity:launched?.identity??job.identity,startUnknown})+'\n',()=>process.exit(0));
