import {useEffect, useRef, useState} from 'react';
import {RefreshCw} from 'lucide-react';
import {ApiError, request} from './api';
import type {CommandReceipt} from './types';
import {loadUnknownStartQuotaDiagnostic,reviewRejectionText,unknownStartQuotaText} from './receipt-messages';

type Props={
  commandId:string;
  identityKey:string;
  canReconcile:boolean;
  isRecoveryCurrent?:()=>boolean;
  onResolved:(receipt:CommandReceipt)=>void;
};

function confirmed(receipt:CommandReceipt){
  const recovery=receipt.recovery;
  if(!recovery||!['applied','not_applied'].includes(recovery.outcome)||!recovery.requestedAt||!recovery.checkedAt)return false;
  const requested=Date.parse(recovery.requestedAt),checked=Date.parse(recovery.checkedAt);
  return Number.isFinite(requested)&&Number.isFinite(checked)&&checked>=requested;
}

function errorText(error:unknown){
  if(error instanceof ApiError){
    if(error.status===403)return '当前账号暂时没有核实权限。';
    if(error.status===404)return '找不到这条操作，或当前账号无权查看。';
    if(error.code==='RECOVERY_NODE_UNAVAILABLE')return '项目电脑暂时无法核实，请稍后再试。';
    if(error.code==='RECOVERY_NOT_ELIGIBLE')return '这条操作已不在待核实状态，正在读取最新回执。';
  }
  return '暂时无法核实这条操作，请检查连接后重试。';
}

export default function CommandRecovery({commandId,identityKey,canReconcile,isRecoveryCurrent=()=>true,onResolved}:Props){
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [quotaDiagnostic,setQuotaDiagnostic]=useState('');
  const busyRef=useRef(false);
  const generation=useRef(0);
  const initialDiagnosticActive=useRef(false);
  const currentIdentity=useRef(identityKey);
  const currentCommand=useRef(commandId);
  const enabled=useRef(canReconcile);
  const isCurrentRef=useRef(isRecoveryCurrent);
  const onResolvedRef=useRef(onResolved);
  currentIdentity.current=identityKey;currentCommand.current=commandId;enabled.current=canReconcile;isCurrentRef.current=isRecoveryCurrent;onResolvedRef.current=onResolved;

  useEffect(()=>{
    const current=++generation.current;
    busyRef.current=false;setBusy(false);setMessage('');setQuotaDiagnostic('');
    initialDiagnosticActive.current=true;
    const expectedIdentity=identityKey,expectedCommand=commandId,requestGuard=isRecoveryCurrent;
    const diagnosticCurrent=()=>generation.current===current&&currentIdentity.current===expectedIdentity&&
      currentCommand.current===expectedCommand&&initialDiagnosticActive.current&&requestGuard()&&isCurrentRef.current();
    if(expectedCommand&&expectedIdentity&&diagnosticCurrent()){
      void loadUnknownStartQuotaDiagnostic(expectedCommand,
        id=>request<CommandReceipt>('GET',`/api/commands/${encodeURIComponent(id)}`),
        diagnosticCurrent,setQuotaDiagnostic);
    }
    return()=>{if(generation.current===current)generation.current++;initialDiagnosticActive.current=false;busyRef.current=false;};
  },[commandId,identityKey]);

  async function check(){
    if(busyRef.current||!enabled.current||!isCurrentRef.current())return;
    initialDiagnosticActive.current=false;setQuotaDiagnostic('');
    busyRef.current=true;setBusy(true);setMessage('正在请求目标电脑核实原操作…');
    const expectedGeneration=generation.current,expectedIdentity=identityKey,expectedCommand=commandId;
    const requestGuard=isCurrentRef.current;
    const valid=()=>generation.current===expectedGeneration&&currentIdentity.current===expectedIdentity&&currentCommand.current===expectedCommand&&enabled.current&&requestGuard()&&isCurrentRef.current();
    try{
      try{await request<CommandReceipt>('POST',`/api/commands/${encodeURIComponent(commandId)}/reconcile`,{});}
      catch(error){
        if(!(error instanceof ApiError&&error.code==='RECOVERY_NOT_ELIGIBLE'))throw error;
      }
      if(!valid())return;
      setMessage('电脑正在核对原操作；不会重新执行。');
      const deadline=Date.now()+30000;
      while(valid()&&Date.now()<deadline){
        const receipt=await request<CommandReceipt>('GET',`/api/commands/${encodeURIComponent(commandId)}`);
        if(!valid())return;
        if(receipt.commandId!==expectedCommand){setQuotaDiagnostic('');setMessage('暂时无法核实这条操作，请刷新任务后重试。');return;}
        setQuotaDiagnostic(unknownStartQuotaText(receipt,expectedCommand)||'');
        const recovery=receipt.recovery;
        if(recovery&&confirmed(receipt)){
          setMessage(reviewRejectionText(receipt)||(recovery.outcome==='applied'?'电脑已确认这次操作已执行。任务是否完成仍需查看进展和输出。':'电脑已确认这次操作没有执行。查看最新任务后，可决定是否重新提交。'));
          onResolvedRef.current(receipt);
          return;
        }
        if(recovery?.outcome==='unknown'&&recovery.checkedAt&&recovery.requestedAt&&Date.parse(recovery.checkedAt)>=Date.parse(recovery.requestedAt)){
          setMessage('电脑已核对，但仍无法确定结果。请在项目电脑查看当前任务和输出；手机端不能解除这条操作的限制。');
          return;
        }
        await new Promise(resolve=>window.setTimeout(resolve,1500));
      }
      if(valid())setMessage('还在等待项目电脑核实，可稍后再次核实。');
    }catch(error){if(valid())setMessage(errorText(error));}
    finally{if(generation.current===expectedGeneration){busyRef.current=false;setBusy(false);}}
  }

  return <div className="command-recovery" data-command-id={commandId} aria-live="polite">
    <button type="button" className="secondary" onClick={()=>void check()} disabled={!canReconcile||busy}>
      <RefreshCw size={15}/>{busy?'正在核实…':'核实这次操作'}
    </button>
    {message&&<p className="small-note">{message}</p>}
    {quotaDiagnostic&&<p className="small-note">{quotaDiagnostic}</p>}
  </div>;
}
