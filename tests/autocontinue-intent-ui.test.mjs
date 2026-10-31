import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createServer} from 'vite';

let vite, Component;
before(async()=>{
  // Middleware mode transforms the real TSX but opens no HTTP port or product service.
  vite=await createServer({configFile:false,server:{middlewareMode:true},appType:'custom'});
  Component=(await vite.ssrLoadModule('/src/AutoContinuePolicies.tsx')).default;
});
after(async()=>{await vite?.close();});

const task={id:'task-a',title:'示例任务',goal:'完成用户可检查的页面',nextStep:'先修复表单错误',
  status:'planned',acceptance:'unverified',conversationId:'thread-a'};
const policy=(overrides={})=>({taskId:task.id,enabled:true,status:'waiting_quota',lastError:null,
  wakeAt:new Date(Date.now()+60000).toISOString(),attempts:1,maxAttempts:3,budgetMinutes:360,
  startedAt:new Date(Date.now()-60000).toISOString(),deadlineAt:new Date(Date.now()+3600000).toISOString(),
  remainingSeconds:3500,stopReason:null,planIntent:{version:1,goal:'原目标',nextStep:'先核对旧页面'},...overrides});
const render=(tasks,policies,pluginEnabled=true)=>renderToStaticMarkup(createElement(Component,
  {tasks,policies,pluginEnabled,busy:false,onSetPolicy:()=>{},onReconcile:()=>{}}));

test('new policy labels the current task action as a proposal to save, not existing authorization',()=>{
  const html=render([task],[]);
  assert.match(html,/当前建议（启用时才会保存为授权）/);
  assert.match(html,/先修复表单错误/);
  assert.doesNotMatch(html,/已保存的授权下一步/);
  assert.match(html,/启用自动继续/);
  const empty=render([{...task,nextStep:'',goal:''}],[]);
  assert.match(empty,/任务尚未填写下一步或目标，请先补充/);
  assert.match(empty,/<button[^>]*disabled=""[^>]*>启用自动继续<\/button>/);
});

test('active plan shows its persisted next action and check conditions, not changed task text',()=>{
  const html=render([{...task,nextStep:'后来修改的建议'}],[policy()]);
  assert.match(html,/已保存的授权下一步/);
  assert.match(html,/先核对旧页面/);
  assert.doesNotMatch(html,/后来修改的建议/);
  assert.match(html,/额度实际可用/);
  assert.match(html,/工作区仍有效/);
  assert.match(html,/时间不是开始执行的承诺/);
  assert.match(html,/每轮完成后会停下等待人工核对/);
});

test('captured goal-only intent stays authorized and can continue the original plan',()=>{
  const html=render([{...task,nextStep:'后来修改的建议'}],[policy({enabled:false,status:'disabled',
    planIntent:{version:1,goal:'只保存的目标',nextStep:''}})]);
  assert.match(html,/已保存的授权下一步/);
  assert.match(html,/只保存的目标/);
  assert.match(html,/>继续原计划<\/button>/);
  assert.doesNotMatch(html,/旧计划未记录|旧计划缺少下一步授权/);
  const saved=html.match(/<p class="auto-intent">([\s\S]*?)<\/p>/)?.[1];
  assert.ok(saved);
  assert.match(saved,/只保存的目标/);
  assert.doesNotMatch(saved,/后来修改的建议/);
  assert.match(html,/重新开始将保存的当前下一步/);
  assert.match(html,/后来修改的建议/);
});

test('missing old intent cannot resume and restart explicitly uses the current proposal and budget',()=>{
  const html=render([task],[policy({enabled:false,status:'retry_stopped',stopReason:'plan_intent_missing',planIntent:null})]);
  assert.match(html,/旧计划没有记录获准的下一步/);
  assert.doesNotMatch(html,/>继续原计划</);
  assert.match(html,/重新开始将保存的当前下一步/);
  assert.match(html,/重新开始「示例任务」计划（3 次、360 分钟）/);
  assert.match(html,/下一步：先修复表单错误/);
});

test('quota recovery stop is explained without claiming file progress; changed intent requires restart',()=>{
  const quota=render([task],[policy({enabled:false,status:'retry_stopped',stopReason:'repeated_quota_failure',recoveryFailureCount:2})]);
  assert.match(quota,/两次尝试恢复额度仍不可用/);
  assert.match(quota,/额度恢复已试 2 次/);
  assert.match(quota,/请检查账号额度后明确重新开始/);
  assert.doesNotMatch(quota,/文件已保存|文件进度/);
  const changed=render([task],[policy({enabled:false,status:'retry_stopped',stopReason:'plan_intent_changed'})]);
  assert.match(changed,/任务目标或下一步已变化，原计划授权失效/);
  assert.doesNotMatch(changed,/>继续原计划</);
});
