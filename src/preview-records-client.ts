/** Board-origin recovery identity only. No preview capability, cookie or record title is stored. */
export interface PreviewRecordAttempt {
  v:1; account:string; projectId:string; taskId:string; previewId:string; dataStoreId:string;
  contentVersion:string; intentId:string; clientMutationId:string; payloadHash:string; createdAt:number;
  result?:'confirmed'|'not_applied';
}
const prefix='seqivo-preview-record-v1:';
const id=/^[A-Za-z0-9_-]{1,100}$/;
const sha=/^[a-f0-9]{64}$/;
const key=(r:PreviewRecordAttempt)=>`${prefix}${encodeURIComponent(r.account)}:${r.previewId}:${r.intentId}`;
function valid(value:unknown):value is PreviewRecordAttempt {
  if(!value||typeof value!=='object')return false;
  const r=value as Partial<PreviewRecordAttempt>;
  return r.v===1&&typeof r.account==='string'&&r.account.length>0&&r.account.length<200&&
    [r.projectId,r.taskId,r.previewId,r.dataStoreId,r.intentId,r.clientMutationId].every(x=>typeof x==='string'&&id.test(x))&&
    typeof r.contentVersion==='string'&&r.contentVersion.length<=100&&typeof r.payloadHash==='string'&&sha.test(r.payloadHash)&&
    Number.isSafeInteger(r.createdAt)&&Number(r.createdAt)>0&&
    (r.result===undefined||r.result==='confirmed'||r.result==='not_applied');
}
export function previewRecordAttempts(account:string,projectId:string,taskId:string):PreviewRecordAttempt[]{
  if(!account)return [];
  try{
    const values:PreviewRecordAttempt[]=[];
    for(let i=0;i<localStorage.length;i++){
      const storageKey=localStorage.key(i);
      if(!storageKey?.startsWith(`${prefix}${encodeURIComponent(account)}:`))continue;
      const raw=localStorage.getItem(storageKey),item=raw&&JSON.parse(raw);
      if(!valid(item)||key(item)!==storageKey||item.account!==account)throw new Error('invalid record');
      if(item.projectId===projectId&&item.taskId===taskId)values.push(item);
    }
    return values.sort((a,b)=>a.createdAt-b.createdAt);
  }catch{throw new Error('无法读取原预览保存编号；本次写入保持锁定。');}
}
export function persistPreviewRecordAttempt(value:PreviewRecordAttempt):PreviewRecordAttempt {
  if(!valid(value))throw new Error('预览保存身份无效，未发送写入。');
  try{
    const storageKey=key(value),raw=localStorage.getItem(storageKey);
    if(raw){const existing:unknown=JSON.parse(raw);
      if(!valid(existing)||existing.account!==value.account||existing.projectId!==value.projectId||
        existing.taskId!==value.taskId||existing.previewId!==value.previewId||
        existing.dataStoreId!==value.dataStoreId||existing.contentVersion!==value.contentVersion||
        existing.intentId!==value.intentId||existing.payloadHash!==value.payloadHash)
        throw new Error('conflict');
      return existing;
    }
    if(previewRecordAttempts(value.account,value.projectId,value.taskId).some(item=>
      item.previewId===value.previewId&&!item.result))throw new Error('unresolved');
    const serialized=JSON.stringify(value);
    localStorage.setItem(storageKey,serialized);
    if(localStorage.getItem(storageKey)!==serialized)throw new Error('write failed');
    return value;
  }catch{throw new Error('无法持久保存原操作编号，未允许预览页写入。');}
}
export function settlePreviewRecordAttempt(value:PreviewRecordAttempt,result:'confirmed'|'not_applied'){
  const prior=persistPreviewRecordAttempt(value);
  if(prior.result&&prior.result!==result)throw new Error('预览保存回执冲突，保持锁定。');
  const updated={...prior,result};
  const serialized=JSON.stringify(updated);
  localStorage.setItem(key(updated),serialized);
  if(localStorage.getItem(key(updated))!==serialized)throw new Error('预览保存回执未能持久化。');
}
