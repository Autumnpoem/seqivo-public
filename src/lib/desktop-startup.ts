import type {DesktopStartupStatus} from '../types';

type StartupBridge={
  startupStatus?:()=>Promise<DesktopStartupStatus>;
  subscribeStartup?:(callback:(status:DesktopStartupStatus)=>void)=>Promise<()=>void>;
};

export function createDesktopStartupGate(bridge:StartupBridge,handlers:{
  onStatus:(status:DesktopStartupStatus)=>void;
  onReady:()=>void;
  onError?:(error:unknown)=>void;
}){
  let stopped=false;
  let revision=-1;
  let phase:DesktopStartupStatus['phase']|null=null;
  let unsubscribe:(()=>void)|null=null;
  let listening=false;
  let registrationTask:Promise<void>|null=null;
  let listenerResolved:()=>void=()=>{};
  const listenerReady=new Promise<void>(resolve=>{listenerResolved=resolve;});
  const apply=(status:DesktopStartupStatus)=>{
    if(stopped||!status||!['starting','ready','failed','stopping'].includes(status.phase)||
      !Number.isSafeInteger(status.revision)||status.revision<0||status.revision<revision)return;
    if(status.revision===revision&&status.phase===phase)return;
    if(status.revision===revision)return;
    const wasReady=phase==='ready';
    revision=status.revision;phase=status.phase;
    handlers.onStatus(status);
    if(status.phase==='ready'&&!wasReady)handlers.onReady();
  };
  const fail=(error:unknown)=>{if(!stopped)handlers.onError?.(error);};
  const readSnapshot=async()=>{
    if(stopped||!listening||!bridge.startupStatus)return;
    try{
      const status=await bridge.startupStatus();
      const previousRevision=revision,previousPhase=phase;
      apply(status);
      // A retry also clears a transient snapshot error when the native status
      // itself has not changed. It never starts a second initial board read.
      if(!stopped&&status?.revision===previousRevision&&status.phase===previousPhase)handlers.onStatus(status);
    }
    catch(error){fail(error);}
  };
  const retry=async()=>{
    const alreadyListening=listening;
    await listenerReady;
    if(stopped)return;
    if(!listening){await start();return;}
    if(alreadyListening)await readSnapshot();
  };
  const start=():Promise<void>=>{
    if(registrationTask)return registrationTask;
    const task=(async()=>{
    if(!bridge.startupStatus||!bridge.subscribeStartup){
      listenerResolved();apply({phase:'ready',revision:0});return;
    }
    try{
      const off=await bridge.subscribeStartup(apply);
      if(stopped){off();return;}
      unsubscribe=off;listening=true;
      listenerResolved();
      await readSnapshot();
    }catch(error){fail(error);}
    finally{listenerResolved();}
    })();
    registrationTask=task;
    void task.finally(()=>{if(registrationTask===task)registrationTask=null;});
    return task;
  };
  void start();
  return {retry,dispose:()=>{stopped=true;unsubscribe?.();unsubscribe=null;}};
}
