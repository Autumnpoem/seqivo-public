import {useCallback,useEffect,useRef,useState} from 'react';
import {errorMessage,request} from './api';
import './preview-retest.css';

type Criterion={id:string;text:string};
type Change={path:string;change:'modified'|'deleted'|'restored'};
type RetestItem={criterionId:string;text:string;status:'needs_retest'|'unknown';reason:string;reasonCode:string;changedPaths:Change[];checkSteps:string[]};
type Comparison={previewId:string;previousPreviewId:string;sourceState:'verified'|'unknown';reasonCode:string|null;reason:string|null;currentTaskMatchesPreview:boolean;
  binding:{projectId:string;taskId:string;contentVersion:number|string;criteriaDigest:string;sourceDigest:string|null};
  changedFiles:Change[];items:RetestItem[];comparisonDigest?:string|null;totalChanged?:number;truncated?:boolean};
type MappingItem={criterionId:string;paths:string[];checkSteps:string[]};
type EligiblePath={path:string;kind:string};
type Mapping={previewId:string;projectId:string;taskId:string;contentVersion:number|string;taskRevision:number;criteriaDigest:string;
  sourceDigest:string;mapRevision:number;mappingDigest:string;eligiblePaths:EligiblePath[];items:MappingItem[];editable:boolean;blockedReason?:string};
export type PreviewRetestProps={currentPreviewId:string;previousPreviewId:string|null;projectId:string;taskId:string;
  contentVersion:number|string;currentSourceDigest:string|null;criteria:Criterion[];accountScope:string;mode:'local'|'hub';canEdit:boolean;online:boolean};
const sha=/^[a-f0-9]{64}$/;
const excludedParts=new Set(['.git','node_modules','dist','build','out','.next','coverage']);
const safePath=(path:unknown):path is string=>typeof path==='string'&&path.length>0&&new TextEncoder().encode(path).length<=1024&&
  !path.startsWith('/')&&!path.includes('\\')&&!/[\p{Cc}\p{Cf}]/u.test(path)&&
  path.split('/').every(part=>part!==''&&part!=='.'&&part!=='..'&&!excludedParts.has(part)&&!part.toLowerCase().endsWith('.srl'));
const sameVersion=(a:number|string,b:number|string)=>a===b;
const sameItems=(a:MappingItem[],b:MappingItem[])=>JSON.stringify(a.map(item=>({criterionId:item.criterionId,paths:[...item.paths].sort(),checkSteps:item.checkSteps})).sort((x,y)=>x.criterionId.localeCompare(y.criterionId)))===
  JSON.stringify(b.map(item=>({criterionId:item.criterionId,paths:[...item.paths].sort(),checkSteps:item.checkSteps})).sort((x,y)=>x.criterionId.localeCompare(y.criterionId)));
function checkedComparison(value:unknown,props:PreviewRetestProps):Comparison{
  const result=value as Comparison;
  if(!result||result.previewId!==props.currentPreviewId||result.previousPreviewId!==props.previousPreviewId||
    !['verified','unknown'].includes(result.sourceState)||typeof result.currentTaskMatchesPreview!=='boolean'||
    (result.sourceState==='verified'?(result.reasonCode!==null||result.reason!==null||!sha.test(result.binding?.sourceDigest||'')||result.binding?.sourceDigest!==props.currentSourceDigest):
      (typeof result.reasonCode!=='string'||typeof result.reason!=='string'||result.binding?.sourceDigest!==null&&result.binding?.sourceDigest!==props.currentSourceDigest))||
    result.binding?.projectId!==props.projectId||result.binding.taskId!==props.taskId||
    !sameVersion(result.binding.contentVersion,props.contentVersion)||
    !sha.test(result.binding.criteriaDigest)||!Array.isArray(result.items)||result.items.length>100||
    !Array.isArray(result.changedFiles)||result.changedFiles.length>1000)throw new Error('重验清单与所选版本不匹配，不能据此判断影响。');
  const ids=new Set<string>();
  for(const item of result.items){
    if(!item||typeof item.criterionId!=='string'||!item.criterionId||ids.has(item.criterionId)||typeof item.text!=='string'||
      !['needs_retest','unknown'].includes(item.status)||typeof item.reason!=='string'||typeof item.reasonCode!=='string'||
      !Array.isArray(item.changedPaths)||item.changedPaths.length>20||!item.changedPaths.every(change=>safePath(change?.path)&&['modified','deleted','restored'].includes(change.change))||
      !Array.isArray(item.checkSteps)||item.checkSteps.length>5||!item.checkSteps.every(step=>typeof step==='string'&&step.length<=300))
      throw new Error('重验清单内容不完整，不能据此判断影响。');
    ids.add(item.criterionId);
  }
  if(new TextEncoder().encode(JSON.stringify(result)).length>64*1024||
    !result.changedFiles.every(change=>safePath(change?.path)&&['modified','deleted','restored'].includes(change.change)))
    throw new Error('重验清单的文件范围无法核对。');
  return result;
}
function checkedMapping(value:unknown,props:PreviewRetestProps):Mapping{
  const result=value as Mapping;
  if(!result||result.previewId!==props.currentPreviewId||result.projectId!==props.projectId||result.taskId!==props.taskId||
    !sameVersion(result.contentVersion,props.contentVersion)||result.sourceDigest!==props.currentSourceDigest||
    !Number.isSafeInteger(result.taskRevision)||!Number.isSafeInteger(result.mapRevision)||result.mapRevision<0||
    !sha.test(result.sourceDigest)||!sha.test(result.criteriaDigest)||!sha.test(result.mappingDigest)||typeof result.editable!=='boolean'||
    !Array.isArray(result.eligiblePaths)||result.eligiblePaths.length>1000||
    !result.eligiblePaths.every(entry=>safePath(entry?.path)&&typeof entry.kind==='string')||
    !Array.isArray(result.items)||result.items.length>100||
    !result.items.every(item=>item&&typeof item.criterionId==='string'&&item.criterionId.length>0&&Array.isArray(item.paths)&&item.paths.length<=20&&
      item.paths.every(safePath)&&Array.isArray(item.checkSteps)&&item.checkSteps.length<=5&&
      item.checkSteps.every(step=>typeof step==='string'&&step.length<=300))||
    new Set(result.items.map(item=>item.criterionId)).size!==result.items.length||
    new TextEncoder().encode(JSON.stringify(result)).length>64*1024)
    throw new Error('检查说明与所选版本不匹配，不能编辑。');
  return result;
}
const changeText:Record<Change['change'],string>={modified:'修改',deleted:'删除',restored:'恢复'};
const blockedText:Record<string,string>={mapping_limit:'检查说明超过可安全显示的范围，暂不能编辑。',mapping_invalid:'原检查说明无法核对，暂不能编辑。',path_limit:'候选文件超过本版范围，暂不能编辑；请缩小源码范围后重新构建。',current_task_changed:'任务内容或验收标准已变化，暂不能编辑这版说明。'};
const defaultSteps=(text:string)=>`按「${text}」在当前版本实际操作，并记录检查结果。`;
function boundedWrite<T>(write:Promise<T>):Promise<T>{
  let timer:number|undefined;
  const deadline=new Promise<T>((_,reject)=>{timer=window.setTimeout(()=>reject(new Error('保存请求仍未返回，结果待核实。')),8000);});
  return Promise.race([write,deadline]).finally(()=>{if(timer!==undefined)window.clearTimeout(timer);});
}

export default function PreviewRetestSection(props:PreviewRetestProps){
  const {currentPreviewId,previousPreviewId,projectId,taskId,contentVersion,currentSourceDigest,criteria,accountScope,mode,canEdit,online}=props;
  const identity=JSON.stringify([mode,accountScope,projectId,taskId,currentPreviewId,previousPreviewId,contentVersion,currentSourceDigest]);
  const identityRef=useRef(identity);identityRef.current=identity;
  const compareSeq=useRef(0),mapSeq=useRef(0);
  const [comparisonRecord,setComparisonRecord]=useState<{identity:string;value:Comparison}|null>(null);
  const [compareErrorRecord,setCompareErrorRecord]=useState<{identity:string;value:string}|null>(null),[compareBusy,setCompareBusy]=useState(false);
  const [mappingRecord,setMappingRecord]=useState<{identity:string;value:Mapping}|null>(null),[draft,setDraft]=useState<MappingItem[]>([]);
  const [mapErrorRecord,setMapErrorRecord]=useState<{identity:string;value:string}|null>(null);
  const [mapNoticeRecord,setMapNoticeRecord]=useState<{identity:string;value:string}|null>(null),[mapBusy,setMapBusy]=useState(false);
  const [writeUnknownFor,setWriteUnknownFor]=useState<string|null>(null);
  const comparison=comparisonRecord?.identity===identity?comparisonRecord.value:null;
  const compareError=compareErrorRecord?.identity===identity?compareErrorRecord.value:'';
  const mapping=mappingRecord?.identity===identity?mappingRecord.value:null;
  const mapError=mapErrorRecord?.identity===identity?mapErrorRecord.value:'';
  const mapNotice=mapNoticeRecord?.identity===identity?mapNoticeRecord.value:'';
  const writeUnknown=writeUnknownFor===identity;
  const setMapError=(value:string)=>setMapErrorRecord({identity,value});
  const setMapNotice=(value:string)=>setMapNoticeRecord({identity,value});
  const [editingId,setEditingId]=useState(''),[pathSearch,setPathSearch]=useState(''),[pathOffset,setPathOffset]=useState(0);
  const pendingItems=useRef<{identity:string;items:MappingItem[]}|null>(null);
  const actor=mode==='hub'?{expectedPreviewActorId:accountScope}:undefined;
  const comparisonPath=`/api/previews/${encodeURIComponent(currentPreviewId)}/retest?previous=${encodeURIComponent(previousPreviewId||'')}`;
  const mappingPath=`/api/preview/retest-mappings/${encodeURIComponent(currentPreviewId)}`;
  const loadComparison=useCallback(async()=>{
    const captured=identity,seq=++compareSeq.current;
    setCompareErrorRecord(null);setCompareBusy(Boolean(previousPreviewId));setComparisonRecord(null);
    if(!previousPreviewId||!online||mode==='hub'&&!accountScope){setCompareBusy(false);return;}
    try{
      const result=checkedComparison(await request<unknown>('GET',comparisonPath,undefined,actor),props);
      if(identityRef.current===captured&&compareSeq.current===seq)setComparisonRecord({identity:captured,value:result});
    }catch(cause){if(identityRef.current===captured&&compareSeq.current===seq)setCompareErrorRecord({identity:captured,value:errorMessage(cause)});}
    finally{if(identityRef.current===captured&&compareSeq.current===seq)setCompareBusy(false);}
  },[identity,online]);
  const readMapping=useCallback(async(reconcile=false)=>{
    const captured=identity,seq=++mapSeq.current;
    setMapBusy(true);setMapError('');
    try{
      const result=checkedMapping(await request<unknown>('GET',mappingPath),props);
      if(identityRef.current!==captured||mapSeq.current!==seq)return;
      setMappingRecord({identity:captured,value:result});setDraft(result.items.map(item=>({...item,paths:[...item.paths],checkSteps:[...item.checkSteps]})));
      if(reconcile&&pendingItems.current?.identity===captured){const matches=sameItems(result.items,pendingItems.current.items);
        setMapNotice(matches?'当前设置与本次填写一致；这是当前设置核对，不是原请求的独立回执。':
          '当前设置与本次填写不同。已读取当前设置；请核对后再明确保存。');
        pendingItems.current=null;setWriteUnknownFor(null);
        if(matches)void loadComparison();}
      else if(reconcile)setMapNotice('已读取当前检查说明。');
    }catch(cause){if(identityRef.current===captured&&mapSeq.current===seq)setMapError(`检查说明暂时无法核对：${errorMessage(cause)}`);}
    finally{if(identityRef.current===captured&&mapSeq.current===seq)setMapBusy(false);}
  },[identity,loadComparison]);
  useEffect(()=>{void loadComparison();},[loadComparison]);
  useEffect(()=>{
    ++mapSeq.current;setMappingRecord(null);setDraft([]);setMapError('');setMapNotice('');setMapBusy(false);setWriteUnknownFor(null);pendingItems.current=null;
    setEditingId('');setPathSearch('');setPathOffset(0);
  },[identity]);
  useEffect(()=>{if(mode==='local'&&canEdit&&online&&!writeUnknown)void readMapping();},[identity,canEdit,online,readMapping,writeUnknown]);
  function updateItem(id:string,update:(item:MappingItem)=>MappingItem){
    setDraft(current=>{
      const existing=current.find(item=>item.criterionId===id)||{criterionId:id,paths:[],checkSteps:[]};
      return [...current.filter(item=>item.criterionId!==id),update(existing)];
    });setMapNotice('');
  }
  async function saveMapping(){
    if(!mapping||mappingRecord?.identity!==identity||!online||mapBusy||writeUnknown||mode!=='local'||!canEdit||!mapping.editable)return;
    const allowed=new Set(mapping.eligiblePaths.map(item=>item.path));
    const items=draft.filter(item=>item.paths.length||item.checkSteps.some(step=>step.trim())).map(item=>({
      criterionId:item.criterionId,paths:[...item.paths].sort(),checkSteps:item.checkSteps.map(step=>step.trim()).filter(Boolean)}));
    if(items.length>100||items.some(item=>item.paths.length>20||item.checkSteps.length>5||
      item.checkSteps.some(step=>step.length>300)||item.paths.some(path=>!allowed.has(path)))||
      new TextEncoder().encode(JSON.stringify(items)).length>64*1024){
      setMapError('对应文件或检查步骤超过范围，请核对后保存。');return;
    }
    const captured=identity,seq=++mapSeq.current;
    pendingItems.current={identity:captured,items};setMapBusy(true);setMapError('');setMapNotice('');
    try{
      await boundedWrite(request('PUT',mappingPath,{expectedTaskRevision:mapping.taskRevision,contentVersion:mapping.contentVersion,
        sourceDigest:mapping.sourceDigest,expectedMapRevision:mapping.mapRevision,items}));
      if(identityRef.current!==captured||mapSeq.current!==seq)return;
      // Read the current metadata, rather than treating an unbound write reply as proof.
      setWriteUnknownFor(captured);setMapNotice('正在读取当前检查说明，确认本次填写是否已保存。');
      void readMapping(true);
    }catch(cause){if(identityRef.current===captured&&mapSeq.current===seq){
      setWriteUnknownFor(captured);setMapError(`保存结果尚未确认；不会自动重发。请重新读取当前设置。${errorMessage(cause)}`);
    }}finally{if(identityRef.current===captured&&mapSeq.current===seq)setMapBusy(false);}
  }
  const trusted=Boolean(comparison?.sourceState==='verified'&&sha.test(comparison.binding.sourceDigest||'')&&comparison.currentTaskMatchesPreview&&!comparison.truncated&&online);
  const fallback=criteria.filter(item=>!comparison?.items.some(compared=>compared.criterionId===item.id)).map(item=>({criterionId:item.id,text:item.text,status:'unknown' as const,
    reason:'',reasonCode:'unavailable',changedPaths:[],checkSteps:[]}));
  const shown=[...(comparison?.items||[]),...fallback];
  const editingCriterion=criteria.find(item=>item.id===editingId);
  const editingItem=draft.find(item=>item.criterionId===editingId)||{criterionId:editingId,paths:[],checkSteps:[]};
  const searchedPaths=mapping?.eligiblePaths.filter(entry=>entry.path.toLocaleLowerCase().includes(pathSearch.trim().toLocaleLowerCase()))||[];
  const visiblePaths=searchedPaths.slice(pathOffset,pathOffset+80);
  const needs=shown.filter(item=>trusted&&item.status==='needs_retest'&&item.changedPaths.length>0).length;
  return <section className="preview-retest-section" aria-label="逐项重验清单">
    <div className="preview-retest-heading"><div><h3>这版要核对什么</h3><p>说明变化与检查方法；原来的人工验收记录不会自动改变。</p></div><span>{needs} 项请重新检查 · {shown.length-needs} 项影响尚不确定</span></div>
    {previousPreviewId&&<button type="button" className="secondary" disabled={!online||compareBusy||mode==='hub'&&!accountScope}
      onClick={()=>void loadComparison()}>重新读取重验说明</button>}
    {!previousPreviewId&&<p className="preview-retest-state">还没有可比较的上一版。请按当前标准实际检查。</p>}
    {!online&&<p className="preview-retest-state">当前离线，无法核对两版源码。以下只供参考，不能据此免检。</p>}
    {mode==='hub'&&!accountScope&&<p className="preview-retest-state">正在确认当前账号，暂不读取源码比较。</p>}
    {compareBusy&&<p className="preview-retest-state">正在读取这两版的重验说明…</p>}
    {compareError&&<p className="preview-retest-state" role="alert">重验说明暂时无法读取：{compareError}。仍请按标准检查。</p>}
    {comparison?.sourceState!=='verified'&&previousPreviewId&&comparison&&!compareError&&<p className="preview-retest-state">两版源码暂时无法完整核对：{comparison.reason||'当前无法取得可靠的比较结果'}。所有标准仍需人工确认。</p>}
    {comparison?.reasonCode==='current_task_changed'&&<p className="preview-retest-state">任务要求已变化，这份预览不能当作当前任务的验收结论。</p>}
    {comparison?.truncated&&<p className="preview-retest-state">变更范围超过可完整核对的限额，不能据截断结果判断未受影响。</p>}
    <div className="preview-retest-items">{shown.map(item=>{
      const affected=trusted&&item.status==='needs_retest'&&item.changedPaths.length>0;
      const steps=affected?item.checkSteps:[];
      return <article className="preview-retest-item" key={item.criterionId}>
        <div className="preview-retest-item-title"><strong>{item.text}</strong><span>{affected?'请重新检查':'影响尚不确定'}</span></div>
        <p><b>改了什么：</b>{affected?`与这项标准关联的 ${item.changedPaths.length} 处文件有变化。`:'还没有找到足以判断这项受影响或不受影响的对应变化。'}</p>
        <p><b>为什么要查：</b>{affected?'上次核对后，明确关联的文件已变化；请在这一版重新确认。':
          comparison?.reasonCode==='same_artifact'?'打包文件相同也不能证明权限、数据或外部服务仍符合要求。':
          !trusted?'这次无法完整核对来源，不能据此免检。':item.reason||'尚未明确哪些改动关联这项标准，仍需人工核对。'}</p>
        <div className="preview-retest-steps"><b>怎么检查：</b>{steps.length?<ol>{steps.map((step,index)=><li key={index}>{step}</li>)}</ol>:<p>{defaultSteps(item.text)}</p>}</div>
        {affected&&<details><summary>查看关联文件（{item.changedPaths.length}）</summary><ul>{item.changedPaths.map(change=><li key={`${change.path}:${change.change}`}>{change.path} · {changeText[change.change]}</li>)}</ul></details>}
      </article>;
    })}</div>
    {mode==='local'&&canEdit&&<details className="preview-retest-editor"><summary>指定这版的对应文件和检查方法</summary>
      <p>仅保存检查说明，不会自动通过验收或重新打开预览。</p>
      {!mapping&&<p>当前没有可编辑的已核实文件清单。{mapError}</p>}
      {mapping&&!mapping.editable&&<p>{blockedText[mapping.blockedReason||'']||'当前任务或版本已变化，暂不能编辑这版检查说明。'}</p>}
      {mapping?.editable&&<><label>选择要填写的标准<select value={editingId} onChange={event=>{setEditingId(event.target.value);setPathSearch('');setPathOffset(0);}}>
        <option value="">请选择一条标准</option>{criteria.map(item=><option key={item.id} value={item.id}>{item.text}</option>)}
      </select></label>
      {editingCriterion&&<fieldset disabled={!online||mapBusy||writeUnknown}><legend>{editingCriterion.text}</legend>
        <div className="preview-retest-selected"><b>已选文件（{editingItem.paths.length}/20）</b>{editingItem.paths.length?<ul>{editingItem.paths.map(path=><li key={path}><span>{path}</span><button type="button" className="secondary" onClick={()=>updateItem(editingId,old=>({...old,paths:old.paths.filter(value=>value!==path)}))}>移除</button></li>)}</ul>:<p>尚未选择。</p>}</div>
        <label>搜索可选文件<input type="search" value={pathSearch} onChange={event=>{setPathSearch(event.target.value);setPathOffset(0);}} placeholder="输入文件名或目录"/></label>
        <p>找到 {searchedPaths.length} 条，当前显示 {visiblePaths.length} 条。搜索只帮助选择，不会裁剪版本比较。</p>
        <ul className="preview-retest-candidates">{visiblePaths.map(entry=><li key={entry.path}><label><input type="checkbox" checked={editingItem.paths.includes(entry.path)}
          onChange={event=>{if(event.target.checked&&editingItem.paths.length>=20){setMapError('每项最多选择 20 条文件。');return;}
            updateItem(editingId,old=>({...old,paths:event.target.checked?[...old.paths,entry.path]:old.paths.filter(path=>path!==entry.path)}));}}/>
          <span>{entry.path}{['deleted','tracked_deleted'].includes(entry.kind)?' · 已删除':''}</span></label></li>)}</ul>
        {searchedPaths.length>80&&<div className="preview-retest-actions"><button type="button" className="secondary" disabled={pathOffset===0} onClick={()=>setPathOffset(Math.max(0,pathOffset-80))}>上一页</button>
          <button type="button" className="secondary" disabled={pathOffset+80>=searchedPaths.length} onClick={()=>setPathOffset(pathOffset+80)}>下一页</button></div>}
        <label>检查步骤（每行一步，最多 5 步）<textarea rows={3} value={editingItem.checkSteps.join('\n')} maxLength={1500}
          onChange={event=>{const steps=event.target.value.split('\n');if(steps.length>5){setMapError('每项最多填写 5 条检查步骤。');return;}updateItem(editingId,old=>({...old,checkSteps:steps}));}}/></label>
      </fieldset>}<div className="preview-retest-actions"><button type="button" disabled={!online||mapBusy||writeUnknown} onClick={()=>void saveMapping()}>{mapBusy?'正在核对…':'保存这版的检查说明'}</button>
          <button type="button" className="secondary" disabled={!online||mapBusy} onClick={()=>void readMapping(true)}>重新读取当前设置</button></div></>}
      {mapError&&<p className="preview-retest-state" role="alert">{mapError}</p>}{mapNotice&&<p className="preview-retest-state" role="status">{mapNotice}</p>}
      {writeUnknown&&<p className="preview-retest-state">原保存结果尚未确认；不会自动重发。请读取当前设置核对。</p>}
    </details>}
  </section>;
}
