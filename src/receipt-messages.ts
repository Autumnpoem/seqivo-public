import type {CommandReceipt} from './types';

const reviewFailures:Record<string,string>={
  REVIEW_NOT_SUBMITTED:'尚未提交当前成果。请先提交结果，再进行验收。',
  REVIEW_CRITERIA_REQUIRED:'还没有验收标准。请先补充标准，再进行验收。',
  REVIEW_CURRENT_EVIDENCE_REQUIRED:'缺少当前版本的验收证据。请添加证据后重新检查。',
  REVIEW_OPEN_ISSUES:'仍有未解决的交付偏差。请先处理问题，再进行验收。',
};

// Only explain a scoped, confirmed rejection. Unknown or unrelated receipts
// must never look safe to retry because they contain a familiar error code.
export function reviewRejectionText(receipt:CommandReceipt):string|null{
  if(receipt.action!=='review'||receipt.status!=='failed'||!receipt.taskId)return null;
  const result=receipt.result;
  if(!result||typeof result!=='object'||Array.isArray(result))return null;
  const value=result as Record<string,unknown>;
  if(value.status!=='rejected'||value.taskId!==receipt.taskId||typeof value.failureCode!=='string')return null;
  const reason=Object.hasOwn(reviewFailures,value.failureCode)?reviewFailures[value.failureCode]:null;
  return reason?`本次没有保存验收结论：${reason}`:null;
}

export function unknownStartQuotaText(receipt:CommandReceipt,expectedCommandId:string):string|null{
  if(!expectedCommandId||receipt.commandId!==expectedCommandId||receipt.action!=='start_task'||
    receipt.status!=='unknown'||typeof receipt.taskId!=='string'||!receipt.taskId)return null;
  const result=receipt.result;
  if(!result||typeof result!=='object'||Array.isArray(result))return null;
  const value=result as Record<string,unknown>;
  if(value.status!=='waiting_quota'||value.taskId!==receipt.taskId)return null;
  return 'AI 额度暂不可用。请等额度恢复后核对这次操作；结果未确认前请勿重复提交。';
}

export async function loadUnknownStartQuotaDiagnostic(
  commandId:string,
  readReceipt:(commandId:string)=>Promise<CommandReceipt>,
  isCurrent:()=>boolean,
  onMessage:(message:string)=>void,
):Promise<void>{
  let receipt:CommandReceipt;
  try{
    receipt=await readReceipt(commandId);
  }catch{
    // This is an opportunistic read-only hint; the existing recovery action remains available.
    return;
  }
  if(!isCurrent())return;
  const message=unknownStartQuotaText(receipt,commandId);
  if(message)onMessage(message);
}
