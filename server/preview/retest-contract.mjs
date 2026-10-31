import {createHash} from 'node:crypto';

const ID=/^[A-Za-z0-9_-]{1,100}$/;
const SHA=/^[a-f0-9]{64}$/;
const MAX_RESULT=64*1024;
const MAX_PATHS=1000;
const SHA256=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reasons={
  current_task_changed:'当前任务标准或内容已变化，请重新构建并核对',
  source_unknown:'两版源码来源无法完整核实',
  source_binding_changed:'两版源码目录或工作树不同，不能直接比较',
  file_set_ambiguous:'源码集合不完整或疑似增删、重命名，无法确定影响',
  mapping_invalid:'标准映射记录不能核实',
  result_limit:'比较结果超过显示上限，无法判断影响',
  node_offline:'预览节点暂不可用，请稍后重新核实',
  node_unsupported:'预览节点尚不支持源码影响核实',
  node_busy:'预览节点正在核实其他版本，请稍后重试',
  node_timeout:'预览节点未及时完成核实，请稍后重试',
  result_invalid:'预览节点的比较结果无法核实',
  authority_changed:'预览节点或项目授权已变化，请重新核实'
};
const itemReasons={
  mapped_file_changed:'已映射源码路径发生可核实变化，需要按步骤重验',
  check_steps_missing:'源码路径已变化，但未提供检查步骤',
  no_proven_impact:'映射路径未发现可证变化，不能据此免除验收',
  mapping_missing:'未设置此标准的源码路径映射'
};
export function previewRetestScope(manifest){
  if(!manifest||![manifest.previewId,manifest.projectId,manifest.taskId].every(value=>ID.test(value))||
    !Number.isSafeInteger(manifest.contentVersion)||manifest.contentVersion<1||
    !SHA.test(manifest.artifactDigest))throw Error('Invalid preview retest scope');
  const sourceDigest=manifest.provenance?.sourceDigest??null;
  if(sourceDigest!==null&&!SHA.test(sourceDigest))throw Error('Invalid preview source digest');
  return {previewId:manifest.previewId,projectId:manifest.projectId,taskId:manifest.taskId,
    contentVersion:manifest.contentVersion,artifactDigest:manifest.artifactDigest,sourceDigest};
}
export const sameRetestScope=(a,b)=>!!a&&!!b&&
  ['previewId','projectId','taskId','contentVersion','artifactDigest','sourceDigest']
    .every(key=>a[key]===b[key]);
export const previewCriteriaDigest=criteria=>SHA256(criteria.map(item=>[item.id,item.text]));
const validPath=path=>typeof path==='string'&&path.length>0&&Buffer.byteLength(path)<=1024&&
  !path.startsWith('/')&&!path.includes('\\')&&!/[\u0000-\u001f\u007f]/u.test(path)&&
  path.split('/').every(part=>part&&part!=='.'&&part!=='..'&&
    !['.git','node_modules','dist','build','out','.next','coverage'].includes(part)&&
    !part.toLowerCase().endsWith('.srl'));
function boundedUnknown(current,previous,criteria,code){
  const reason=reasons[code]||reasons.result_invalid;
  const result={previewId:current.previewId,previousPreviewId:previous.previewId,
    sourceState:'unknown',reasonCode:code in reasons?code:'result_invalid',reason,
    binding:{projectId:current.projectId,taskId:current.taskId,contentVersion:current.contentVersion,
      criteriaDigest:previewCriteriaDigest(criteria),sourceDigest:current.sourceDigest},
    currentTaskMatchesPreview:false,comparisonDigest:null,changedFiles:[],
    totalCriteria:criteria.length,truncated:false,
    items:criteria.map(item=>({criterionId:item.id,text:item.text,status:'unknown',
      reasonCode:code in reasons?code:'result_invalid',reason,changedPaths:[],checkSteps:[]}))};
  if(Buffer.byteLength(JSON.stringify(result))>MAX_RESULT){
    result.items=[];result.truncated=true;result.reasonCode='result_limit';result.reason=reasons.result_limit;
  }
  return result;
}
export const unknownRetestResult=boundedUnknown;
/** Hub accepts no free-form node text, paths or status without exact scope validation. */
export function sanitizeRetestResult(result,{current,previous,criteria}){
  const invalid=()=>boundedUnknown(current,previous,criteria,'result_invalid');
  if(!result||typeof result!=='object'||Array.isArray(result)||
    Buffer.byteLength(JSON.stringify(result))>MAX_RESULT||
    result.previewId!==current.previewId||result.previousPreviewId!==previous.previewId||
    !result.binding||result.binding.projectId!==current.projectId||
    result.binding.taskId!==current.taskId||result.binding.contentVersion!==current.contentVersion||
    (result.binding.sourceDigest!==current.sourceDigest&&
      !(result.sourceState==='unknown'&&result.binding.sourceDigest===null))||
    result.binding.criteriaDigest!==previewCriteriaDigest(criteria)||
    result.totalCriteria!==criteria.length||!Array.isArray(result.items))return invalid();
  if(result.sourceState==='unknown'){
    if(!Object.hasOwn(reasons,result.reasonCode)||result.changedFiles?.length||
      result.comparisonDigest!==null||result.items.some(item=>item.status!=='unknown'))return invalid();
    return boundedUnknown(current,previous,criteria,result.reasonCode);
  }
  if(result.sourceState!=='verified'||current.sourceDigest===null||previous.sourceDigest===null||
    !SHA.test(result.comparisonDigest)||
    result.currentTaskMatchesPreview!==true||result.truncated!==false||
    result.items.length!==criteria.length||!Array.isArray(result.changedFiles)||
    result.changedFiles.length>MAX_PATHS)return invalid();
  const files=[];const seen=new Set();
  for(const file of result.changedFiles){
    if(!file||!validPath(file.path)||!['modified','deleted','restored'].includes(file.change)||
      seen.has(file.path))return invalid();
    seen.add(file.path);files.push({path:file.path,change:file.change});
  }
  const fileByPath=new Map(files.map(file=>[file.path,file]));
  const items=[];
  for(let i=0;i<criteria.length;i++){
    const source=result.items[i],criterion=criteria[i];
    if(!source||source.criterionId!==criterion.id||source.text!==criterion.text||
      !['needs_retest','unknown'].includes(source.status)||
      !Array.isArray(source.changedPaths)||source.changedPaths.length>20||
      !Array.isArray(source.checkSteps)||source.checkSteps.length>5||
      source.checkSteps.some(step=>typeof step!=='string'||!step.trim()||step.length>300||
        /[\u0000-\u001f\u007f]/u.test(step)))return invalid();
    const paths=[];const selected=new Set();
    for(const file of source.changedPaths){
      if(!file||!fileByPath.has(file.path)||fileByPath.get(file.path).change!==file.change||
        selected.has(file.path))return invalid();
      selected.add(file.path);paths.push(fileByPath.get(file.path));
    }
    const expected=paths.length&&source.checkSteps.length?'mapped_file_changed':
      paths.length?'check_steps_missing':source.reasonCode==='mapping_missing'?'mapping_missing':'no_proven_impact';
    if(source.reasonCode!==expected||source.status!==(expected==='mapped_file_changed'?'needs_retest':'unknown'))
      return invalid();
    items.push({criterionId:criterion.id,text:criterion.text,status:source.status,
      reasonCode:expected,reason:itemReasons[expected],changedPaths:paths,
      checkSteps:source.checkSteps});
  }
  return {previewId:current.previewId,previousPreviewId:previous.previewId,
    sourceState:'verified',reasonCode:null,reason:null,
    binding:{projectId:current.projectId,taskId:current.taskId,contentVersion:current.contentVersion,
      criteriaDigest:previewCriteriaDigest(criteria),sourceDigest:current.sourceDigest},
    currentTaskMatchesPreview:true,comparisonDigest:result.comparisonDigest,
    changedFiles:files,totalCriteria:criteria.length,truncated:false,items};
}
