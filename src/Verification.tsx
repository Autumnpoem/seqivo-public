import {Check, CheckCircle2, Circle, Clock3, AlertCircle} from 'lucide-react';
import type {Task} from './types';

export type VerificationState = 'unverified' | 'passed' | 'partial' | 'failed' | 'stale';
export const verificationLabels: Record<VerificationState, string> = {
  unverified: '待验证', passed: '已验证', partial: '部分验证', failed: '验证未通过', stale: '需重新验证',
};

export function verificationState(task: Task): VerificationState {
  const result = task.verification;
  if (!result) return 'unverified';
  if (result.contentVersion !== task.contentVersion) return 'stale';
  if (result.status === 'passed' && (task.status !== 'submitted' || task.issues.some(issue => issue.open)
    || !task.criteria.length || !task.criteria.every(criterion => result.criterionIds.includes(criterion.id)))) return 'stale';
  return result.status;
}

export function VerificationBadge({task}: {task: Task}) {
  const status = verificationState(task);
  return <span className={`verification-badge verification-${status}`} data-verification={status}>{verificationLabels[status]}</span>;
}

export function VerificationDetails({task, canToggleChecks=false, saving=false, onToggleCheck}: {
  task: Task;
  canToggleChecks?: boolean;
  saving?: boolean;
  onToggleCheck?: (checkId: string, completed: boolean) => void;
}) {
  const result = task.verification;
  const status = verificationState(task);
  const current = status !== 'stale';
  const covered = current ? task.criteria.filter(criterion => result?.criterionIds.includes(criterion.id)).length : 0;
  const checks = result?.pendingChecks || [];
  const checkedCriteria = new Set(current ? checks.flatMap(check => check.criterionIds) : []);
  const uncovered = task.criteria.filter(criterion =>
    !(current && result?.criterionIds.includes(criterion.id)) && !checkedCriteria.has(criterion.id),
  );
  const addFallback = status !== 'passed' && uncovered.length > 0;
  const addStatusPlan = checks.length === 0 && uncovered.length === 0 && (status === 'partial' || status === 'failed');
  const totalCount = checks.length + (addFallback ? uncovered.length : 0) + (addStatusPlan ? 1 : 0);
  const completedCount = checks.filter(check => Boolean(check.completed)).length;
  const Icon = status === 'passed' ? CheckCircle2 : status === 'failed' ? AlertCircle : status === 'stale' ? Clock3 : Circle;
  return <section className="verification-panel" aria-label="测试验证">
    <div className="verification-heading"><span className="eyebrow">测试验证</span><VerificationBadge task={task}/></div>
    {totalCount > 0 && <section className="verification-todos" aria-label="验证待办">
      <h3>验证待办 · 已办结 {completedCount} / {totalCount} 项</h3>
      {status === 'stale' && <p className="verification-stale-note">以下计划来自旧版本；请核对后再用于当前版本。当前标准未覆盖的部分列为待补充计划。</p>}
      {task && !canToggleChecks && <p className="verification-stale-note">当前连接只读；请在拥有者桌面端或本机服务中更新待办状态。</p>}
      <div className="verification-todo-list">
        {checks.map((check, index) => {
          const CheckIcon = check.kind === 'implementation' ? AlertCircle : check.kind === 'decision' ? Clock3 : Circle;
          const completed = Boolean(check.completed);
          const kindLabel = completed ? '已办结' : check.kind === 'implementation' ? '待实现' : check.kind === 'decision' ? '待确认' : '未验证';
          const canEdit = canToggleChecks && status !== 'stale' && Boolean(check.id) && Boolean(onToggleCheck);
          const related = current ? check.criterionIds.map(id => task.criteria.find(criterion => criterion.id === id)?.text).filter(Boolean) : [];
          const hasOldCriteria = check.criterionIds.some(id => !task.criteria.some(criterion => criterion.id === id));
          return <div className={`verification-todo-row ${completed ? 'is-completed' : ''}`} key={check.id || `legacy-${index}`}>
            {canEdit ? <button type="button" className={`verification-check-toggle ${completed ? 'is-completed' : ''}`} aria-label={completed ? `重新打开：${check.title}` : `标记为已办结：${check.title}`} aria-pressed={completed} disabled={saving} onClick={() => onToggleCheck?.(check.id, !completed)} title={completed ? '重新打开待办' : '标记为已办结'}>
              {completed ? <Check size={15}/> : <span aria-hidden="true"/>}
            </button> : <span className={`verification-check-state ${completed ? 'is-completed' : ''}`} aria-label={completed ? '已办结' : '未验证'} title={completed ? '已办结' : '未验证'}>{completed ? <Check size={14}/> : <span/>}</span>}
            <details className="verification-todo" open={index === 0}>
            <summary><span className="verification-todo-title">{check.title}</span><span className={`verification-todo-kind ${completed ? 'is-completed' : ''}`}>{completed || check.kind === 'test' ? null : <CheckIcon size={13}/>} {kindLabel}</span></summary>
            {status === 'stale' && <p className="verification-old-plan">旧版本计划{hasOldCriteria ? ' · 关联标准已变化' : ''}</p>}
            {related.length > 0 && <p className="verification-todo-criteria">关联标准：{related.join('；')}</p>}
            <div className="verification-todo-content">
              <strong>怎么验证</strong>
              {check.steps.length ? <ol>{check.steps.map((step, stepIndex) => <li key={`${check.id}-${stepIndex}`}>{step}</li>)}</ol> : <p>尚未提供验证步骤。</p>}
              <strong>通过标准</strong><p>{check.expectedResult || '尚未提供通过标准。'}</p>
              {check.blockedReason && <p className="verification-blocker"><strong>需提供条件：</strong>{check.blockedReason}</p>}
            </div>
            </details>
          </div>;
        })}
        {addStatusPlan && <details className="verification-todo verification-plan-gap" open={checks.length === 0}>
          <summary><span className="verification-todo-title">待补充后续验证计划</span><span className="verification-todo-kind"><Circle size={13}/>待验证</span></summary>
          <div className="verification-todo-content"><strong>怎么验证</strong><p>{status === 'failed' ? '本次记录为验证未通过；后续步骤尚未记录，请补充修正方案后再验证。' : '当前记录为部分验证；后续步骤尚未记录，请补充计划后再继续。'}</p><strong>通过标准</strong><p>尚未记录后续验证的通过标准。</p><p className="verification-blocker"><strong>需提供条件：</strong>后续验证步骤和预期结果尚未提供。</p></div>
        </details>}
        {addFallback && uncovered.map((criterion, index) => <details className="verification-todo verification-plan-gap" key={`plan-gap-${criterion.id}`} open={checks.length === 0 && index === 0}>
          <summary><span className="verification-todo-title">待补充验证计划：{criterion.text}</span><span className="verification-todo-kind"><Circle size={13}/>待验证</span></summary>
          {status === 'stale' && <p className="verification-old-plan">当前版本的标准；旧版本结果不能覆盖此项。</p>}
          <div className="verification-todo-content"><strong>怎么验证</strong><p>尚未记录具体步骤，请先补充验证方法。</p><strong>通过标准</strong><p>{criterion.text}</p><p className="verification-blocker"><strong>需提供条件：</strong>验证步骤和预期结果尚未提供。</p></div>
        </details>)}
      </div>
      <small className="verification-manual-note">子项办结为人工标记，整项测试与验收独立。</small>
    </section>}
    <p>{status === 'stale' ? '任务内容或条件已变化，原测试结果需要重新核对。' : status === 'unverified' && result ? `验证计划已记录，尚未执行。${result.summary ? ` ${result.summary}` : ''}` : result?.summary || '尚未记录测试结果。'}</p>
    {result && <>
      <div className="verification-meta"><Icon size={14}/><span>已验证 {covered} / {task.criteria.length} 项标准</span><time dateTime={result.createdAt}>{new Date(result.createdAt).toLocaleDateString('zh-CN')}</time></div>
      <details><summary>查看验证范围与证据</summary>
        {status === 'stale' && <p>上次记录：{result.summary}</p>}
        <ul>{task.criteria.map(criterion => <li key={criterion.id}>{current && result.criterionIds.includes(criterion.id) ? <CheckCircle2 size={14}/> : <Circle size={14}/>}<span>{criterion.text}</span></li>)}</ul>
        <code>{result.reference}</code>
      </details>
    </>}
    <small>测试记录与人工验收分别保存。</small>
  </section>;
}
