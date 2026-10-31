import {mkdirSync,readFileSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

// Serialize lock creation and stale-owner recovery too: two recovery callers must not remove each other's new lock.
export function acquireLock(dataDir) {
  mkdirSync(dataDir,{recursive:true});
  const path=join(dataDir,'core.lock'),guard=join(dataDir,'core.lock.guard'),token=randomUUID();
  try{mkdirSync(guard);}catch(error){if(error.code==='EEXIST')throw Error('任务服务正在获取数据目录锁，请稍后重试；若启动曾异常中断，请先确认没有运行中的服务');throw error;}
  try{
    let prior;
    try{prior=JSON.parse(readFileSync(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw Error('数据目录锁无法核实，请先确认没有运行中的推进服务');}
    if(prior){
      if(prior.uncleanShutdown){const error=Error('前次插件未能确认进程已停止。请核实相关进程已结束后，再移走数据目录 core.lock 重新启动');error.code='UNCLEAN_SHUTDOWN_REVIEW_REQUIRED';throw error;}
      if(!Number.isSafeInteger(prior.pid)||prior.pid<=0)throw Error('数据目录锁格式不正确');
      let alive=true;try{process.kill(prior.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}
      if(alive)throw Error('此数据目录已有运行中的推进服务，请使用现有服务或不同的数据目录');
      unlinkSync(path);
    }
    writeFileSync(path,JSON.stringify({pid:process.pid,token}),{flag:'wx',mode:0o600});
  }finally{rmdirSync(guard);}
  const release=()=>{try{if(JSON.parse(readFileSync(path,'utf8')).token===token)unlinkSync(path);}catch{}};
  release.markUnsafe=()=>writeFileSync(path,JSON.stringify({pid:process.pid,token,uncleanShutdown:true}),{mode:0o600});
  return release;
}
