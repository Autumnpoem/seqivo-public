import {createHash} from 'node:crypto';
import {BoardError} from '../store.mjs';

const ID=/^[A-Za-z0-9_-]{1,100}$/;
const SHA=/^[a-f0-9]{64}$/;
const MAX_PATHS=1000;
const MAX_ITEMS=100;
const MAX_STEPS=5;
const MAX_DTO_BYTES=64*1024;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(code,message,status=409)=>{throw new BoardError(message,status,code);};
const validPath=path=>typeof path==='string'&&path.length>0&&Buffer.byteLength(path)<=1024&&
  !path.startsWith('/')&&!path.includes('\\')&&!/[\u0000-\u001f\u007f]/u.test(path)&&
  path.split('/').every(part=>part&&part!=='.'&&part!=='..'&&
    !['.git','node_modules','dist','build','out','.next','coverage'].includes(part)&&
    !part.toLowerCase().endsWith('.srl'));
const criteriaDigest=items=>digest(items.map(item=>[item.id,item.text]));
const unknown=(current,previous,reasonCode,reason,extra={})=>{
  const criteria=JSON.parse(current.row.criteria_json);
  const result={previewId:current.manifest.previewId,
  previousPreviewId:previous.manifest.previewId,sourceState:'unknown',reasonCode,reason,
  binding:{projectId:current.manifest.projectId,taskId:current.manifest.taskId,
    contentVersion:current.manifest.contentVersion,
    criteriaDigest:criteriaDigest(JSON.parse(current.row.criteria_json)),sourceDigest:null},
  currentTaskMatchesPreview:false,comparisonDigest:null,changedFiles:[],
  totalCriteria:criteria.length,truncated:criteria.length>MAX_ITEMS,
  items:criteria.slice(0,MAX_ITEMS).map(item=>({criterionId:item.id,
    text:item.text,status:'unknown',reasonCode,reason,changedPaths:[],checkSteps:[]})),...extra};
  if(Buffer.byteLength(JSON.stringify(result))>MAX_DTO_BYTES){
    result.reasonCode='result_limit';result.reason='比较结果超过显示上限，无法判断影响';
    result.items=[];result.truncated=true;
  }
  return result;
};

/** Core-owned source comparison. No cap is created and no source bytes enter the DTO. */
export function createPreviewRetest({store,builds,local,resolveWorktree=()=>null}){
  store.db.exec(`CREATE TABLE IF NOT EXISTS preview_retest_maps(
    preview_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,task_id TEXT NOT NULL,
    content_version INTEGER NOT NULL,criteria_digest TEXT NOT NULL,source_digest TEXT NOT NULL,
    map_revision INTEGER NOT NULL,mapping_digest TEXT NOT NULL,items_json TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1);`);
  if(!store.db.prepare('PRAGMA table_info(preview_retest_maps)').all().some(row=>row.name==='schema_version'))
    store.db.exec('ALTER TABLE preview_retest_maps ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1');
  const mapFor=id=>store.db.prepare('SELECT * FROM preview_retest_maps WHERE preview_id=?').get(id);
  const assertCurrent=(preview,source)=>{
    const {manifest,row}=preview;
    const criteria=JSON.parse(row.criteria_json),task=store.getTask(manifest.taskId);
    const project=store.getProject(manifest.projectId);
    const bound=source.build.worktreeId?
      resolveWorktree({taskId:task.id,worktreeId:source.build.worktreeId}):project.directory;
    if(task.projectId!==project.id||row.project_id!==project.id||row.task_id!==task.id||
      row.project_dir!==project.directory||manifest.contentVersion!==source.build.contentVersion||
      manifest.sourceTaskRevision!==source.build.expectedRevision||
      manifest.previewId!==source.build.previewId||manifest.provenance?.sourceDigest!==source.receipt.sourceDigest)
      fail('PREVIEW_RETEST_SOURCE_UNKNOWN','当前预览来源或授权已变化');
    if(bound!==source.build.workspace)fail('PREVIEW_RETEST_SOURCE_UNKNOWN','原预览工作树绑定已变化');
    return {criteria,task,project,criteriaHash:criteriaDigest(criteria)};
  };
  const sourceFor=async id=>{
    try{return await builds.verifiedSourceForPreview(id);}catch(error){
      if(error instanceof BoardError&&error.status===404)throw error;
      fail('PREVIEW_RETEST_SOURCE_UNKNOWN','预览源码不能核实');
    }
  };
  function checkedMap(row,{previewId,projectId,taskId,contentVersion,criteriaHash,sourceDigest,criteria,eligible}){
    if(!row)return null;
    if(row.schema_version!==1||row.preview_id!==previewId||row.project_id!==projectId||
      row.task_id!==taskId||row.content_version!==contentVersion||
      row.criteria_digest!==criteriaHash||row.source_digest!==sourceDigest||
      !Number.isSafeInteger(row.map_revision)||row.map_revision<1||
      !SHA.test(row.mapping_digest)||typeof row.items_json!=='string'||
      Buffer.byteLength(row.items_json)>MAX_DTO_BYTES)return false;
    try{
      const parsed=JSON.parse(row.items_json),normalized=validateItems(parsed,criteria,eligible);
      return JSON.stringify(normalized)===row.items_json&&digest(normalized)===row.mapping_digest?
        normalized:false;
    }catch{return false;}
  }
  const mappingDto=({preview,source,task,criteriaHash,mapRevision,mappingDigest,items,
    paths,editable,mappingRetained,blockedReason})=>({
    previewId:preview.manifest.previewId,projectId:preview.manifest.projectId,
    taskId:preview.manifest.taskId,contentVersion:preview.manifest.contentVersion,
    taskRevision:task.revision,criteriaDigest:criteriaHash,sourceDigest:source.receipt.sourceDigest,
    mapRevision,mappingDigest,items,editable,mappingRetained,
    ...(editable?{eligiblePaths:paths}:{eligiblePaths:[],blockedReason})
  });
  async function mapping(previewId){
    const preview=await local.build(previewId),source=await sourceFor(previewId);
    const {criteria,task,criteriaHash}=assertCurrent(preview,source);
    const eligible=source.receipt.files.filter(item=>['file','deleted'].includes(item.kind));
    const paths=eligible.map(item=>({path:item.path,kind:item.kind}));
    const pathLimit=eligible.length>MAX_PATHS||Buffer.byteLength(JSON.stringify(paths))>MAX_DTO_BYTES;
    const editable=task.contentVersion===preview.manifest.contentVersion&&
      criteriaDigest(task.criteria)===criteriaHash&&!pathLimit;
    const current=mapFor(previewId);
    const oversized=!!current&&typeof current.items_json==='string'&&
      Buffer.byteLength(current.items_json)>MAX_DTO_BYTES;
    const checked=checkedMap(current,{previewId,projectId:preview.manifest.projectId,
      taskId:preview.manifest.taskId,contentVersion:preview.manifest.contentVersion,
      criteriaHash,sourceDigest:source.receipt.sourceDigest,criteria,eligible});
    const valid=checked!==false;
    const result=mappingDto({preview,source,task,criteriaHash,
      mapRevision:current?.map_revision??0,mappingDigest:current?.mapping_digest??digest([]),
      items:valid?checked??[]:[],paths,editable:editable&&valid,mappingRetained:!!current,
      blockedReason:oversized?'mapping_limit':!valid?'mapping_invalid':
        pathLimit?'path_limit':'current_task_changed'});
    if(Buffer.byteLength(JSON.stringify(result))>MAX_DTO_BYTES)
      return {...result,items:[],eligiblePaths:[],editable:false,blockedReason:'mapping_limit',
        mappingRetained:!!current,truncated:true};
    return result;
  }
  function validateItems(input,criteria,eligible){
    if(!Array.isArray(input)||input.length>MAX_ITEMS)fail('PREVIEW_RETEST_INPUT','标准映射列表无效',400);
    const byId=new Map(criteria.map(item=>[item.id,item]));
    const paths=new Set(eligible.map(item=>item.path)),seen=new Set();
    return input.map(item=>{
      if(!item||typeof item!=='object'||Array.isArray(item)||
        Object.keys(item).sort().join('|')!=='checkSteps|criterionId|paths'||
        !ID.test(item.criterionId)||!byId.has(item.criterionId)||seen.has(item.criterionId)||
        !Array.isArray(item.paths)||item.paths.length>20||!Array.isArray(item.checkSteps)||
        item.checkSteps.length>MAX_STEPS||item.paths.some(path=>!validPath(path)||!paths.has(path))||
        new Set(item.paths).size!==item.paths.length||
        item.checkSteps.some(step=>typeof step!=='string'||!step.trim()||step.length>300))
        fail('PREVIEW_RETEST_INPUT','标准映射内容无效',400);
      seen.add(item.criterionId);
      return {criterionId:item.criterionId,paths:[...item.paths].sort(),
        checkSteps:item.checkSteps.map(step=>step.trim())};
    }).sort((a,b)=>a.criterionId.localeCompare(b.criterionId));
  }
  async function put(previewId,input){
    if(!input||typeof input!=='object'||Array.isArray(input)||
      Object.keys(input).sort().join('|')!==
      'contentVersion|expectedMapRevision|expectedTaskRevision|items|sourceDigest'||
      !Number.isSafeInteger(input.expectedTaskRevision)||input.expectedTaskRevision<1||
      !Number.isSafeInteger(input.contentVersion)||input.contentVersion<1||
      !Number.isSafeInteger(input.expectedMapRevision)||input.expectedMapRevision<0||
      !SHA.test(input.sourceDigest))fail('PREVIEW_RETEST_INPUT','标准映射请求无效',400);
    const preview=await local.build(previewId),source=await sourceFor(previewId);
    const {criteria,task,criteriaHash}=assertCurrent(preview,source);
    const eligible=source.receipt.files.filter(item=>['file','deleted'].includes(item.kind));
    if(eligible.length>MAX_PATHS||Buffer.byteLength(JSON.stringify(eligible.map(item=>item.path)))>MAX_DTO_BYTES)
      fail('PREVIEW_RETEST_LIMIT','源码路径过多，不能编辑映射');
    if(task.revision!==input.expectedTaskRevision||task.contentVersion!==input.contentVersion||
      task.contentVersion!==preview.manifest.contentVersion||
      criteriaDigest(task.criteria)!==criteriaHash||input.sourceDigest!==source.receipt.sourceDigest)
      fail('PREVIEW_RETEST_STALE','当前任务或预览源码已变化');
    const items=validateItems(input.items,criteria,eligible),mappingDigest=digest(items);
    if(Buffer.byteLength(JSON.stringify(items))>MAX_DTO_BYTES||
      Buffer.byteLength(JSON.stringify({items,eligiblePaths:eligible.map(item=>({path:item.path,kind:item.kind}))}))>MAX_DTO_BYTES)
      fail('PREVIEW_RETEST_LIMIT','标准映射超过显示上限');
    const original=store.db.prepare('SELECT value FROM preview_controlled_builds WHERE request_id=?')
      .get(source.build.requestId)?.value;
    return store.transaction(()=>{
      const fresh=store.getTask(task.id),project=store.getProject(task.projectId),row=mapFor(previewId);
      const build=store.db.prepare('SELECT value FROM preview_controlled_builds WHERE request_id=?')
        .get(source.build.requestId)?.value;
      const registered=store.db.prepare('SELECT * FROM preview_local_builds WHERE preview_id=?').get(previewId);
      const bound=source.build.worktreeId?
        resolveWorktree({taskId:task.id,worktreeId:source.build.worktreeId}):project.directory;
      const checked=checkedMap(row,{previewId,projectId:project.id,taskId:task.id,
        contentVersion:input.contentVersion,criteriaHash,sourceDigest:input.sourceDigest,criteria,eligible});
      if(fresh.revision!==input.expectedTaskRevision||fresh.contentVersion!==input.contentVersion||
        fresh.projectId!==project.id||project.directory!==preview.row.project_dir||
        bound!==source.build.workspace||
        criteriaDigest(fresh.criteria)!==criteriaHash||build!==original||
        registered?.criteria_json!==preview.row.criteria_json||
        registered?.manifest_json!==preview.row.manifest_json||
        checked===false||
        (row?.map_revision??0)!==input.expectedMapRevision)
        fail('PREVIEW_RETEST_STALE','标准映射版本已变化');
      const revision=(row?.map_revision??0)+1;
      const projected=mappingDto({preview,source,task:fresh,criteriaHash,mapRevision:revision,
        mappingDigest,items,paths:eligible.map(item=>({path:item.path,kind:item.kind})),
        editable:true,mappingRetained:true});
      if(Buffer.byteLength(JSON.stringify(projected))>MAX_DTO_BYTES)
        fail('PREVIEW_RETEST_LIMIT','标准映射超过完整读取上限');
      store.db.prepare(`INSERT INTO preview_retest_maps VALUES(?,?,?,?,?,?,?,?,?,1)
        ON CONFLICT(preview_id) DO UPDATE SET project_id=excluded.project_id,
          task_id=excluded.task_id,content_version=excluded.content_version,
          criteria_digest=excluded.criteria_digest,source_digest=excluded.source_digest,
          map_revision=excluded.map_revision,mapping_digest=excluded.mapping_digest,
          items_json=excluded.items_json,schema_version=excluded.schema_version`).run(previewId,project.id,task.id,input.contentVersion,
          criteriaHash,input.sourceDigest,revision,mappingDigest,JSON.stringify(items));
      return {previewId,mapRevision:revision,mappingDigest,items};
    });
  }
  async function compare(current,previous){
    if(current.manifest.taskId!==previous.manifest.taskId||
      current.manifest.projectId!==previous.manifest.projectId)
      fail('PREVIEW_VERSION','预览版本不属于同一任务',400);
    const task=store.getTask(current.manifest.taskId),currentCriteria=JSON.parse(current.row.criteria_json);
    const taskMatches=task.projectId===current.manifest.projectId&&
      task.contentVersion===current.manifest.contentVersion&&
      criteriaDigest(task.criteria)===criteriaDigest(currentCriteria);
    if(!taskMatches)return unknown(current,previous,'current_task_changed','当前任务标准或内容已变化，请重新构建并核对');
    let a,b;
    try{[a,b]=await Promise.all([sourceFor(current.manifest.previewId),sourceFor(previous.manifest.previewId)]);
      assertCurrent(current,a);assertCurrent(previous,b);
    }catch{return unknown(current,previous,'source_unknown','两版源码来源无法完整核实',
      {currentTaskMatchesPreview:true});}
    if(a.build.workspace!==b.build.workspace||a.build.worktreeId!==b.build.worktreeId)
      return unknown(current,previous,'source_binding_changed','两版源码目录或工作树不同，不能直接比较',
        {currentTaskMatchesPreview:true});
    const old=new Map(b.receipt.files.map(item=>[item.path,item]));
    const next=new Map(a.receipt.files.map(item=>[item.path,item]));
    const names=new Set([...old.keys(),...next.keys()]);
    if(names.size>MAX_PATHS||[...names].some(path=>!old.has(path)||!next.has(path)))
      return unknown(current,previous,'file_set_ambiguous','源码集合不完整或存在疑似增删/重命名，无法确定影响',
        {currentTaskMatchesPreview:true});
    const changedFiles=[...names].filter(path=>{
      const x=old.get(path),y=next.get(path);
      return x.kind!==y.kind||x.sha256!==y.sha256;
    }).sort().map(path=>({path,change:old.get(path).kind==='deleted'?'restored':
      next.get(path).kind==='deleted'?'deleted':'modified'}));
    const map=mapFor(current.manifest.previewId);
    const mapping=checkedMap(map,{previewId:current.manifest.previewId,
      projectId:current.manifest.projectId,taskId:task.id,
      contentVersion:current.manifest.contentVersion,
      criteriaHash:criteriaDigest(currentCriteria),sourceDigest:a.receipt.sourceDigest,
      criteria:currentCriteria,eligible:a.receipt.files});
    if(mapping===false)return unknown(current,previous,'mapping_invalid','标准映射记录不能核实',
      {currentTaskMatchesPreview:true});
    const byId=new Map((mapping??[]).map(item=>[item.criterionId,item]));
    const result={previewId:current.manifest.previewId,previousPreviewId:previous.manifest.previewId,
      sourceState:'verified',reasonCode:null,reason:null,currentTaskMatchesPreview:true,
      binding:{projectId:current.manifest.projectId,taskId:current.manifest.taskId,
        contentVersion:current.manifest.contentVersion,criteriaDigest:criteriaDigest(currentCriteria),
        sourceDigest:a.receipt.sourceDigest},
      comparisonDigest:digest([previous.manifest.previewId,current.manifest.previewId,
        b.receipt.sourceDigest,a.receipt.sourceDigest,changedFiles,map?.mapping_digest??null,
        criteriaDigest(currentCriteria)]),changedFiles,totalCriteria:currentCriteria.length,truncated:false,
      items:currentCriteria.map(item=>{
        const selection=byId.get(item.id),changedPaths=changedFiles.filter(file=>selection?.paths.includes(file.path));
        const needs=changedPaths.length>0&&selection.checkSteps.length>0;
        return {criterionId:item.id,text:item.text,status:needs?'needs_retest':'unknown',
          reasonCode:needs?'mapped_file_changed':changedPaths.length?'check_steps_missing':
            selection?'no_proven_impact':'mapping_missing',
          reason:needs?'已映射源码路径发生可核实变化，需要按步骤重验':
            changedPaths.length?'源码路径已变化，但未提供检查步骤':
            selection?'映射路径未发现可证变化，不能据此免除验收':'未设置此标准的源码路径映射',
          changedPaths,checkSteps:selection?.checkSteps??[]};
      })};
    let stillBound=true;
    try{
      assertCurrent(current,a);assertCurrent(previous,b);
      for(const [preview,source] of [[current,a],[previous,b]]){
        const saved=store.db.prepare('SELECT value FROM preview_controlled_builds WHERE request_id=?')
          .get(source.build.requestId)?.value;
        const localRow=store.db.prepare('SELECT * FROM preview_local_builds WHERE preview_id=?')
          .get(preview.manifest.previewId);
        if(saved!==JSON.stringify(source.build)||
          localRow?.criteria_json!==preview.row.criteria_json||
          localRow?.manifest_json!==preview.row.manifest_json)stillBound=false;
      }
    }catch{stillBound=false;}
    const freshTask=store.getTask(task.id);
    if(!stillBound)return unknown(current,previous,'source_binding_changed','比较期间原预览来源或授权已变化');
    if(freshTask.contentVersion!==task.contentVersion||
      criteriaDigest(freshTask.criteria)!==criteriaDigest(currentCriteria))
      return unknown(current,previous,'current_task_changed','比较期间当前任务标准或内容已变化');
    if(Buffer.byteLength(JSON.stringify(result))>MAX_DTO_BYTES)
      return unknown(current,previous,'result_limit','比较结果超过显示上限，无法判断影响',
        {currentTaskMatchesPreview:true});
    return result;
  }
  return {mapping,put,compare};
}
