import {useEffect,useState} from 'react';
import type {ReturnReview} from './terminal-types';
import './terminal-return-review.css';

const kindLabel={added:'新增',modified:'修改',deleted:'删除'} as const;

export default function TerminalReturnReview({review,canConfirm,canCancel,onConfirm,onCancel}:{review:ReturnReview;canConfirm:boolean;canCancel:boolean;onConfirm:()=>void;onCancel:()=>void}){
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{setNow(Date.now());const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>window.clearInterval(timer);},[review.reviewId]);
  const expired=now>=review.expiresAt;
  return <div className="terminal-return-review" aria-label="交还内容核对">
    <p>电脑已暂停输入并核对现场。请确认以下内容，再决定是否交还给 AI；此处不会自动通过任务验收。</p>
    <div className="terminal-return-review-facts">
      <div><strong>工作目录</strong><ul>{review.workspaceRelativeDirectories.length?review.workspaceRelativeDirectories.map((item,index)=><li key={`${item.sessionRef.instanceId}/${item.sessionRef.sessionId}/${index}`}><code>{item.path==='.'?'项目根目录':item.path}</code></li>):<li>没有受管会话目录</li>}</ul></div>
      <div><strong>当前检查</strong><p>已停驻 {review.parkedManagedSessions} 个受管会话；未发现其他工作区写入进程。</p></div>
    </div>
    <p>文件核对范围：{review.snapshotScope==='git-tracked-and-nonignored-untracked'?'Git 已跟踪及未忽略的未跟踪文件；Git 忽略文件未纳入。':'项目目录树，不含 Git 元数据。'}</p>
    <details open={review.changes.length>0&&review.changes.length<=8}><summary>本次文件变化（共 {review.totalChanges} 项）</summary>
      {review.changes.length?<ul>{review.changes.map((item,index)=><li key={`${item.path}/${index}`}><span>{kindLabel[item.kind]}</span><code>{item.path}</code></li>)}</ul>:<p>此次核对未列出文件变化。</p>}
      {review.omittedChanges>0&&<p>另有 {review.omittedChanges} 项未在此列出。请在电脑查看完整变化后再决定。</p>}
    </details>
    {review.notes&&<p>交还说明：{review.notes}</p>}
    <p className={expired?'terminal-return-review-expired':''}>{expired?'本次核对已过期，不能确认交还。请正式核对现场。':`核对有效至 ${new Date(review.expiresAt).toLocaleTimeString()}。`}</p>
    <div className="terminal-return-review-actions"><button className="primary" type="button" disabled={!canConfirm||expired} onClick={onConfirm}>确认交还给 AI</button><button className="secondary" type="button" disabled={!canCancel} onClick={onCancel}>{expired?'取消过期核对，重新核对现场':'取消本次交还，保持暂停'}</button></div>
  </div>;
}
