import {useEffect,useState} from 'react';
import {Clock3} from 'lucide-react';
import type {Policy,Task} from './types';
import './autocontinue-policy.css';

export type PolicyChange={taskId:string;enabled:boolean;maxAttempts:number;budgetMinutes:number;restart?:boolean};

const statusLabels:Record<string,string>={idle:'待检查',waiting_quota:'等待额度恢复',sending:'正在发起本轮',running:'本轮执行中',paused:'已暂停',disabled:'已停用',unknown:'结果待核实',awaiting_approval:'等待人工批准',turn_completed:'本轮已结束',blocked:'需要处理',stale_result:'旧结果已忽略',completed:'已完成',retry_stopped:'自动重试已停止',budget_exhausted:'时间预算已用尽',attempts_exhausted:'尝试次数已用尽'};
const stopLabels:Record<string,string>={retry_failed:'一次尝试未能安全继续',budget_expired:'包含等待额度在内的计划时间已用尽',attempt_limit:'已达到最多尝试次数',legacy_plan_missing_deadline:'旧计划缺少截止时间，请核对后重新开始',attempt_unconfirmed:'上次尝试结果尚未确认',restart_binding_changed:'任务或执行位置已变化，请核对后重新开始计划',plan_intent_missing:'旧计划没有记录获准的下一步，请核对后重新开始',plan_intent_changed:'任务目标或下一步已变化，原计划授权失效，请核对后重新开始',repeated_quota_failure:'两次尝试恢复额度仍不可用，请检查账号额度后明确重新开始'};
const restartStatuses=new Set(['retry_stopped','budget_exhausted','attempts_exhausted','disabled','paused']);
const stoppedStatuses=new Set(['retry_stopped','budget_exhausted','attempts_exhausted']);
const unsafeStatuses=new Set(['unknown','awaiting_approval','blocked','running','sending']);
function when(value?:string|null){if(!value)return '尚未安排';const date=new Date(value);return Number.isNaN(date.getTime())?'时间待核对':date.toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});}
function duration(seconds:number){if(seconds<=0)return '0 分钟';const minutes=Math.ceil(seconds/60);if(minutes<60)return `${minutes} 分钟`;const hours=Math.floor(minutes/60),rest=minutes%60;return rest?`${hours} 小时 ${rest} 分钟`:`${hours} 小时`;}
function validInteger(value:string,min:number,max:number){const number=Number(value);return Number.isInteger(number)&&number>=min&&number<=max?number:null;}
function proposedAction(task:Task){return task.nextStep?.trim()||task.goal?.trim()||'';}
function savedAction(policy:Policy|undefined){const intent=policy?.planIntent;return intent?.version===1&&typeof intent.goal==='string'&&typeof intent.nextStep==='string'&&(intent.nextStep.trim()||intent.goal.trim())?intent:null;}
function savedActionText(policy:Policy|undefined){const intent=savedAction(policy);return intent?.nextStep.trim()||intent?.goal.trim()||'';}

export default function AutoContinuePolicies({tasks,policies,pluginEnabled,busy,onSetPolicy,onReconcile}:{tasks:Task[];policies:Policy[];pluginEnabled:boolean;busy:boolean;onSetPolicy:(change:PolicyChange)=>void|Promise<void>;onReconcile:(task:Task)=>void|Promise<void>}){
  const [attemptsInput,setAttemptsInput]=useState('3');
  const [minutesInput,setMinutesInput]=useState('360');
  const [snapshotAt,setSnapshotAt]=useState(()=>performance.now());
  const [now,setNow]=useState(()=>performance.now());
  useEffect(()=>{setSnapshotAt(performance.now());},[policies]);
  useEffect(()=>{const timer=window.setInterval(()=>setNow(performance.now()),30000);return()=>window.clearInterval(timer);},[]);
  const attempts=validInteger(attemptsInput,1,10),minutes=validInteger(minutesInput,1,10080);
  const inputsValid=attempts!==null&&minutes!==null;
  const next=policies.filter(policy=>policy.enabled&&tasks.some(task=>task.id===policy.taskId)).sort((a,b)=>(a.wakeAt?Date.parse(a.wakeAt):0)-(b.wakeAt?Date.parse(b.wakeAt):0))[0];
  const nextTask=tasks.find(task=>task.id===next?.taskId);
  const elapsed=Math.max(0,Math.floor((now-snapshotAt)/1000));
  return <section className="setting-card policy-card auto-policies" aria-label="按任务自动继续">
    <div className="card-heading"><Clock3 size={18}/><h3>按任务自动继续</h3></div>
    <p>仅在任务尚未完成、额度实际可用，而且会话授权、控制权与工作区仍有效时，才尝试获准的下一步。人工暂停始终优先；每轮完成后会停下等待人工核对，不会自行连续执行。</p>
    <div className="auto-next" role="status">{nextTask?<><strong>下一次检查：{nextTask.title} · {next?.wakeAt?when(next.wakeAt):'待下一次检查，时间待确认'}</strong><span>已获准的下一步：{savedActionText(next)||'尚未记录，请核对后重新开始计划'}</span><small>到时先核对额度、任务与执行权限；这里的时间不是开始执行的承诺。</small></>:<strong>下一次检查：尚未安排任务</strong>}</div>
    <div className="auto-plan-inputs">
      <label className="field"><span>最多尝试次数</span><input aria-label="最多尝试次数" type="number" min="1" max="10" step="1" required value={attemptsInput} onChange={event=>setAttemptsInput(event.target.value)}/></label>
      <label className="field"><span>计划时长（分钟，含等待额度）</span><input aria-label="计划时长（分钟，含等待额度）" type="number" min="1" max="10080" step="1" required value={minutesInput} onChange={event=>setMinutesInput(event.target.value)}/></label>
    </div>
    <p className="auto-help">新计划默认 6 小时。重复启用原计划不会延长截止时间；更改上方数字也不会重置已有计划。</p>
    {tasks.length?<div className="policy-list">{tasks.map(task=>{
      const policy=policies.find(item=>item.taskId===task.id);
      const intent=savedAction(policy),proposed=proposedAction(task);
      const bound=Boolean(task.conversationId),taskStopped=['submitted','cancelled','paused','running'].includes(task.status)||task.acceptance==='passed';
      const unsafe=unsafeStatuses.has(policy?.status||'');
      const safeTask=bound&&!taskStopped&&!unsafe&&inputsValid&&!busy;
      const canEnable=pluginEnabled&&safeTask&&Boolean(proposed);
      const deadline=policy?.deadlineAt?Date.parse(policy.deadlineAt):NaN;
      const existingStopped=Boolean(policy&&(!intent||Boolean(policy.stopReason)||stoppedStatuses.has(policy.status)||!Number.isFinite(deadline)||deadline<=Date.now()));
      const canResumeOriginal=Boolean(policy&&!policy.enabled&&!existingStopped&&pluginEnabled&&safeTask);
      const canRestart=Boolean(policy&&!policy.enabled&&restartStatuses.has(policy.status)&&safeTask&&proposed);
      const remaining=policy?.remainingSeconds==null?null:Math.max(0,policy.remainingSeconds-elapsed);
      const budget=policy?.budgetMinutes;
      const submit=(enabled:boolean,restart=false)=>{
        if(enabled&&(restart?!canRestart:policy?!canResumeOriginal:!canEnable))return;
        const maxAttempts=restart||!policy?attempts:policy.maxAttempts;
        const budgetMinutes=restart||!policy?minutes:policy.budgetMinutes??360;
        if(maxAttempts===null||budgetMinutes===null)return;
        void onSetPolicy({taskId:task.id,enabled,maxAttempts,budgetMinutes,...(restart?{restart:true}:{})});
      };
      return <article className="policy-row auto-policy-row" key={task.id}>
        <div className="auto-policy-main"><strong>{task.title}</strong><span>{bound?'已绑定执行会话':'尚未绑定执行会话，不能启用'}</span>
          {policy?<p className="auto-intent"><span>已保存的授权下一步</span><strong>{savedActionText(policy)||'旧计划未记录；不能把当前任务建议当作已获准的行动'}</strong>{intent?.goal&&<small>目标：{intent.goal}</small>}</p>
            :<p className="auto-intent proposed"><span>当前建议（启用时才会保存为授权）</span><strong>{proposed||'任务尚未填写下一步或目标，请先补充'}</strong></p>}
          {canRestart&&<p className="auto-intent proposed"><span>重新开始将保存的当前下一步</span><strong>{proposed}</strong></p>}
          {policy&&<><span className="auto-policy-status">{statusLabels[policy.status]||'状态待核对'} · 已尝试 {policy.attempts}/{policy.maxAttempts} 次 · 还可启动 {Math.max(0,policy.maxAttempts-policy.attempts)} 次</span>
            <div className="auto-policy-facts"><span>计划时长：{budget?duration(budget*60):'旧计划未记录'}</span><span>开始：{when(policy.startedAt)}</span><span>截止：{when(policy.deadlineAt)}</span><span>当前剩余：{remaining===null?'待同步':duration(remaining)}</span>{policy.wakeAt&&<span>下次检查：{when(policy.wakeAt)}</span>}</div>
            {policy.stopReason&&<p className="auto-stop-reason">停止原因：{stopLabels[policy.stopReason]||'计划已停止，请核对详情'}{policy.stopReason==='repeated_quota_failure'&&policy.recoveryFailureCount!=null&&<span>（额度恢复已试 {policy.recoveryFailureCount} 次）</span>}</p>}
            {!intent&&!policy.stopReason&&<p className="auto-stop-reason">旧计划缺少下一步授权，请核对后重新开始；不会继续原计划。</p>}
            {policy.lastError&&<details className="auto-technical"><summary>查看技术原因</summary><code>{policy.lastError}</code></details>}
          </>}
        </div>
        <div className="auto-policy-actions">
          {policy&&['unknown','awaiting_approval','blocked'].includes(policy.status)&&<button className="secondary" type="button" disabled={busy} onClick={()=>void onReconcile(task)}>核实会话状态</button>}
          {(policy?.enabled||!policy||canResumeOriginal||unsafe)&&<button className="secondary" type="button" disabled={policy?.enabled?busy:policy?!canResumeOriginal:!canEnable} onClick={()=>submit(!policy?.enabled)}>{policy?.enabled?'停止自动继续':policy?'继续原计划':'启用自动继续'}</button>}
          {canRestart&&<button className="primary auto-restart" type="button" onClick={()=>submit(true,true)}>重新开始「{task.title}」计划（{attempts} 次、{minutes} 分钟）<span>下一步：{proposed}</span></button>}
        </div>
        {canRestart&&!pluginEnabled&&<p className="auto-stop-help">只重新开始「{task.title}」的计划；插件仍停用，保存后须手动启用插件才会执行。</p>}
        {canRestart&&pluginEnabled&&<p className="auto-stop-help">只重新开始「{task.title}」的计划，不影响其他任务。原执行尚未安全退出时，服务端会拒绝并在页面顶部说明原因；不会强行接续。</p>}
        {policy?.enabled&&<p className="auto-stop-help">“停止自动继续”仅停止后续轮次，不会暂停正在运行的 AI。若需暂停，请到任务详情操作。</p>}
      </article>;
    })}</div>:<p>当前项目还没有 Codex 任务。</p>}
  </section>;
}
