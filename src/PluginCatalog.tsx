import {useCallback, useEffect, useRef, useState, type FormEvent} from 'react';
import {Plug, RefreshCw} from 'lucide-react';
import {request} from './api';

interface ConfigField {type?:string|string[];title?:string;description?:string;minimum?:number;maximum?:number;exclusiveMinimum?:number;writeOnly?:boolean;default?:unknown}
interface Descriptor {id:string;name?:string;version?:string;enabled?:boolean;available?:boolean;status?:string;lastError?:string|null;contract?:string;isolation?:string;trust?:string;compatibilityNotice?:string;permissions?:string[];capabilities?:string[];config?:Record<string,unknown>;configSchema?:{properties?:Record<string,ConfigField>};configurationSchema?:{properties?:Record<string,ConfigField>}}
const labels:Record<string,string>={'thread.create':'创建会话','thread.verify':'核对会话','task.resume':'继续任务','task.pause':'暂停任务','task.reconcile':'核实状态','tasks.read':'读取任务','task.read':'读取任务','tasks.write':'汇报任务','task.write':'汇报任务','quota.read':'读取额度','process.spawn':'运行本机工具'};
function message(error:unknown){return error instanceof Error?error.message:'操作没有完成。'}
function display(value:unknown){return typeof value==='string'?value:String(value??'')}
function kinds(spec:ConfigField){return Array.isArray(spec.type)?spec.type:[spec.type||'string']}
function terminalPhase(plugin:Descriptor){if(plugin.contract!=='terminal.local.v1')return '状态待核实';if(plugin.status==='ready'&&plugin.enabled===true)return '已启用';if(plugin.status==='disabled'&&plugin.enabled===false)return '已停用';return ({disabling:'正在停用',disabled_unknown:'停用结果待核实'} as Record<string,string>)[plugin.status||'']||'状态待核实';}
function terminalAction(plugin:Descriptor):'enable'|'disable'|null{return plugin.contract==='terminal.local.v1'&&plugin.status==='ready'&&plugin.enabled?'disable':plugin.contract==='terminal.local.v1'&&plugin.status==='disabled'&&!plugin.enabled?'enable':null;}

export default function PluginCatalog({onChanged,liveCodex}:{onChanged:()=>Promise<void>;liveCodex?:Pick<Descriptor,'enabled'|'available'|'status'|'lastError'>}){
  const [items,setItems]=useState<Descriptor[]>([]);
  const [drafts,setDrafts]=useState<Record<string,Record<string,string|boolean>>>({});
  const [busy,setBusy]=useState('');
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const loadRevision=useRef(0),actionPending=useRef(false);
  const load=useCallback(async():Promise<Descriptor[]|null>=>{
    const revision=++loadRevision.current;
    try{
      const data=await request<Descriptor[]|{plugins:Descriptor[]}>('GET','/api/plugins');
      const plugins=Array.isArray(data)?data:data.plugins;
      if(!Array.isArray(plugins))throw Error('插件列表格式不正确');
      if(revision!==loadRevision.current)return null;
      setItems(plugins);setDrafts(Object.fromEntries(plugins.map(plugin=>[plugin.id,Object.fromEntries(Object.entries(plugin.config||{}).map(([key,value])=>[key,typeof value==='boolean'?value:display(value)]))])));setError('');
      return plugins;
    }catch(e){if(revision===loadRevision.current)setError(message(e));return null;}
  },[]);
  useEffect(()=>{void load()},[load]);
  async function action(id:string,verb:'check'|'enable'|'disable'){
    if(actionPending.current)return;
    actionPending.current=true;loadRevision.current++;
    setBusy(id);setError('');setNotice('');
    let failed:unknown=null;
    try{await request('POST',`/api/plugins/${encodeURIComponent(id)}/${verb}`,{});}catch(e){failed=e;}
    const refreshed=await load();
    try{await onChanged();}catch(e){failed=failed||e;}
    const current=refreshed?.find(item=>item.id===id);
    if(failed)setError(`${message(failed)}${current?` 当前状态：${id==='local-terminal'?terminalPhase(current):current.enabled?'已启用':'已停用'}。`:' 状态尚未核实，请刷新后再操作。'}`);
    else if(!current)setError('操作已发出，但状态尚未核实；请刷新后再操作。');
    else if(id==='local-terminal'){
      const phase=terminalPhase(current);
      if(verb==='check')setNotice(phase==='停用结果待核实'?'检查后仍无法确认终端已安全停用；请勿启用。':`检查完成。当前终端：${phase}。`);
      else if(verb==='enable'&&current.status==='ready'&&current.enabled)setNotice('本机终端已启用。');
      else if(verb==='disable'&&current.status==='disabled'&&!current.enabled)setNotice('本机终端入口已停用。原有 tmux 会话仍保留。');
      else setError(`操作结果尚未确认。当前终端：${phase}；请检查后再操作。`);
    }else if(verb==='check')setNotice('插件检查已完成。');
    else if((verb==='enable')===Boolean(current.enabled))setNotice(verb==='enable'?'插件已启用。':'插件已停用。');
    else setError('操作结果尚未确认，请刷新插件状态。');
    actionPending.current=false;setBusy('');
  }
  async function save(event:FormEvent<HTMLFormElement>,plugin:Descriptor){
    event.preventDefault();setBusy(plugin.id);setError('');setNotice('');
    try{
      const properties=plugin.configSchema?.properties||plugin.configurationSchema?.properties||{};
      const values=Object.fromEntries(Object.entries(properties).map(([key,spec])=>{
        const raw=drafts[plugin.id]?.[key];
        const types=kinds(spec);
        return [key,types.includes('number')||types.includes('integer')?(display(raw)===''&&types.includes('null')?null:Number(raw)):types.includes('boolean')?raw===true:display(raw)];
      }));
      await request('PATCH',`/api/plugins/${encodeURIComponent(plugin.id)}/config`,values);
      await load();await onChanged();setNotice('插件设置已保存。');
    }catch(e){setError(message(e));}
    finally{setBusy('');}
  }
  return <section className="generic-plugins"><div className="section-header"><div><h2>已安装插件</h2><p>查看每项插件的能力，并分别控制其状态。</p></div><button className="secondary" disabled={Boolean(busy)} onClick={()=>void load()}><RefreshCw size={15}/> 刷新</button></div>{error&&<p className="alert" role="alert">{error}</p>}{notice&&<p className="notice" role="status">{notice}</p>}{items.length?items.map(stored=>{const plugin=stored.id==='codex-autocontinue'&&liveCodex?{...stored,...liveCodex}:stored;const properties=plugin.configSchema?.properties||plugin.configurationSchema?.properties||{};const terminal=plugin.id==='local-terminal',next=terminal?terminalAction(plugin):plugin.enabled?'disable':'enable';return <article className="setting-card" key={plugin.id}><div className="card-heading"><Plug size={17}/><h3>{terminal?'本机终端':plugin.name||plugin.id}</h3><span className="pill">{terminal?terminalPhase(plugin):plugin.enabled?'已启用':plugin.available?'已停用':'不可用'}</span></div>{terminal?<p>管理电脑上的终端入口。停用不会删除原有 tmux 会话；活跃的普通 Shell 需要先退出，才能停用。</p>:<p>版本 {plugin.version||'未知'} · {plugin.status||'状态未知'}</p>}{terminal&&['disabling','disabled_unknown'].includes(plugin.status||'')&&<p className="alert">停用结果尚未核实。请先检查；未确认前不能启用或再次停用。</p>}{plugin.compatibilityNotice&&<p>{plugin.compatibilityNotice}</p>}{plugin.capabilities?.length&&!terminal?<p>可用能力：{plugin.capabilities.map(v=>labels[v]||v).join('、')}</p>:null}{plugin.permissions?.length&&!terminal?<p>所需权限：{plugin.permissions.map(v=>labels[v]||v).join('、')}</p>:null}{plugin.lastError&&<p className="alert">{plugin.lastError}</p>}<div className="action-row"><button className="secondary" disabled={Boolean(busy)} onClick={()=>void action(plugin.id,'check')}>{terminal?'检查终端状态':'检查'}</button><button className="secondary" disabled={Boolean(busy)||!next||(!terminal&&!plugin.available&&!plugin.enabled)} onClick={()=>next&&void action(plugin.id,next)}>{terminal?next==='disable'?'停用终端入口':next==='enable'?'启用终端入口':'核实后再操作':plugin.enabled?'停用':'启用'}</button></div>{Object.keys(properties).length>0&&<details className="plugin-config"><summary>插件设置</summary><form onSubmit={event=>void save(event,plugin)}>{Object.entries(properties).map(([key,spec])=>{const types=kinds(spec);const numeric=types.includes('integer')||types.includes('number');return <label className="field" key={key} htmlFor={`plugin-${plugin.id}-${key}`}><span>{spec.title||key}</span>{types.includes('boolean')?<input id={`plugin-${plugin.id}-${key}`} type="checkbox" checked={drafts[plugin.id]?.[key]===true} onChange={event=>setDrafts(current=>({...current,[plugin.id]:{...current[plugin.id],[key]:event.target.checked}}))}/>:<input id={`plugin-${plugin.id}-${key}`} type={spec.writeOnly?'password':numeric?'number':'text'} step={types.includes('integer')?'1':numeric?'any':undefined} min={spec.minimum??(spec.exclusiveMinimum===undefined?undefined:spec.exclusiveMinimum+Number.EPSILON)} max={spec.maximum} value={display(drafts[plugin.id]?.[key]??'')} onChange={event=>setDrafts(current=>({...current,[plugin.id]:{...current[plugin.id],[key]:event.target.value}}))}/>}<small>{spec.description||''}</small></label>})}<button className="secondary" type="submit" disabled={Boolean(busy)}>保存插件设置</button></form></details>}</article>}):<div className="setting-card"><p>暂无已安装插件。</p></div>}</section>;
}
