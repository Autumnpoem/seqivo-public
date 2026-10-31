import {useCallback, useEffect, useState, type FormEvent} from 'react';
import {Cloud, RefreshCw} from 'lucide-react';
import {request} from './api';
import type {BoardState, Project, RemoteState} from './types';

const labels:Record<RemoteState['status'],string>={disconnected:'未连接',connecting:'正在连接',connected:'已连接',offline:'电脑离线',revoked:'连接已撤销',error:'连接出错'};
function message(error:unknown){return error instanceof Error?error.message:'操作未完成，请重试。'}
function time(value?:string){if(!value)return '暂无';const date=new Date(value);return Number.isNaN(date.getTime())?value:date.toLocaleString('zh-CN');}
interface HubSubject {id:string;role:string;projectIds:string[];revoked_at?:string|null;created_at?:string}

function HubAdmin({projects}:{projects:Project[]}){
  const [role,setRole]=useState<'node'|'viewer'|'controller'>('controller');
  const [grantText,setGrantText]=useState('');
  const [ttl,setTtl]=useState('600');
  const [code,setCode]=useState('');
  const [subjects,setSubjects]=useState<HubSubject[]>([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const load=useCallback(async()=>{try{const value=await request<{subjects:HubSubject[]}>('GET','/api/admin/subjects');setSubjects(value.subjects||[]);setError('');}catch(e){setError(message(e));}},[]);
  useEffect(()=>{void load()},[load]);
  function toggle(id:string){const ids=new Set(grantText.split(/[\s,，]+/).filter(Boolean));ids.has(id)?ids.delete(id):ids.add(id);setGrantText([...ids].join(', '));}
  async function create(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setBusy(true);setError('');setNotice('');setCode('');
    try{const projectIds=[...new Set(grantText.split(/[\s,，]+/).filter(Boolean))];if(!projectIds.length)throw Error('请至少填写一个项目 ID。');
      const value=await request<{code:string;expiresAt:string}>('POST','/api/admin/pairings',{role,projectIds,ttlSeconds:Number(ttl)});
      setCode(value.code);setNotice(`配对码将在 ${time(value.expiresAt)} 过期，只能使用一次。`);
    }catch(e){setError(message(e));}finally{setBusy(false);}
  }
  async function revoke(subject:HubSubject){
    if(!window.confirm(`确定撤销 ${subject.role} 的连接吗？未领取的请求将失效。`))return;
    setBusy(true);setError('');setNotice('');
    try{await request('POST',`/api/admin/subjects/${encodeURIComponent(subject.id)}/revoke`,{});await load();setNotice('连接已撤销。');}
    catch(e){setError(message(e));}finally{setBusy(false);}
  }
  return <><form className="setting-card" onSubmit={create}><div className="card-heading"><Cloud size={18}/><h3>生成一次性配对码</h3></div><label className="field" htmlFor="pairing-role"><span>连接权限</span><select id="pairing-role" value={role} onChange={e=>setRole(e.target.value as typeof role)}><option value="node">项目电脑</option><option value="viewer">仅查看</option><option value="controller">查看和操作</option></select></label><fieldset className="project-grants"><legend>授权项目</legend>{projects.map(project=><label key={project.id}><input type="checkbox" checked={grantText.split(/[\s,，]+/).includes(project.id)} onChange={()=>toggle(project.id)}/><span>{project.name}</span></label>)}<label className="field" htmlFor="grant-ids"><span>项目 ID（可粘贴桌面端项目 ID，用逗号分隔）</span><input id="grant-ids" value={grantText} onChange={e=>setGrantText(e.target.value)} required/></label></fieldset><label className="field" htmlFor="pairing-ttl"><span>有效时间（秒）</span><input id="pairing-ttl" type="number" min="30" max="3600" value={ttl} onChange={e=>setTtl(e.target.value)} required/></label><button className="primary" disabled={busy} type="submit">生成配对码</button>{code&&<div className="pairing-result"><strong>配对码（只显示这一次）</strong><code>{code}</code><button className="secondary" type="button" onClick={()=>void navigator.clipboard.writeText(code).then(()=>setNotice('配对码已复制。')).catch(e=>setError(message(e)))}>复制配对码</button></div>}</form><section className="setting-card"><div className="section-header"><div><h3>已配对连接</h3><p>可以撤销不再使用的手机或电脑。</p></div><button className="secondary" onClick={()=>void load()} disabled={busy}>刷新</button></div>{subjects.length?subjects.map(subject=><div className="policy-row" key={subject.id}><div><strong>{subject.role==='node'?'项目电脑':subject.role==='viewer'?'仅查看':subject.role==='controller'?'查看和操作':'管理员'} · {subject.id.slice(0,8)}</strong><span>{subject.projectIds.length} 个项目 · {subject.revoked_at?'已撤销':'有效'}</span></div>{subject.role!=='owner'&&!subject.revoked_at&&<button className="secondary" disabled={busy} onClick={()=>void revoke(subject)}>撤销</button>}</div>):<p>暂无已配对连接。</p>}</section>{error&&<p className="alert" role="alert">{error}</p>}{notice&&<p className="notice" role="status">{notice}</p>}</>;
}

export default function RemotePanel({board,projects}:{board:BoardState;projects:Project[]}){
  const [remote,setRemote]=useState<RemoteState|null>(null);
  const [url,setUrl]=useState('');
  const [pairingCode,setPairingCode]=useState('');
  const [username,setUsername]=useState('');
  const [password,setPassword]=useState('');
  const [connectMethod,setConnectMethod]=useState<'account'|'pairing'>('account');
  const [projectIds,setProjectIds]=useState<string[]>([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const onHub=board.connection.mode==='hub';
  const load=useCallback(async()=>{
    if(onHub)return;
    try{const value=await request<RemoteState>('GET','/api/remote');setRemote(value);setUrl(value.url||'');setProjectIds(value.projectIds||[]);setError('');}
    catch(e){setError(message(e));}
  },[onHub]);
  useEffect(()=>{void load()},[load]);
  function toggle(id:string){setProjectIds(current=>current.includes(id)?current.filter(value=>value!==id):[...current,id]);}
  async function connect(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setBusy(true);setError('');setNotice('');
    try{
      if(!projectIds.length)throw Error('请至少选择一个允许同步的项目。');
      const value=await request<RemoteState>('POST',connectMethod==='account'?'/api/remote/login':'/api/remote/connect',connectMethod==='account'?{url:url.trim(),username:username.trim(),password,projectIds}:{url:url.trim(),pairingCode:pairingCode.trim(),projectIds});
      setRemote(value);setPairingCode('');setPassword('');setNotice(value.status==='connected'?'已连接，所选项目将同步到手机端。':'连接请求已提交，请查看当前状态。');
      await load();
    }catch(e){setError(message(e));}
    finally{setBusy(false);}
  }
  async function disconnect(){
    setBusy(true);setError('');setNotice('');
    try{const value=await request<RemoteState>('POST','/api/remote/disconnect',{});setRemote(value);setPairingCode('');setNotice('远程连接已断开。');await load();}
    catch(e){setError(message(e));}
    finally{setBusy(false);}
  }
  if(onHub)return <div className="content-page"><div className="section-header"><div><h2>手机连接</h2><p>{board.capabilities.role==='owner'?'管理项目电脑和手机的访问范围。':'这里显示已同步的项目；连接和授权由管理员管理。'}</p></div></div><div className="setting-card"><p>电脑状态：{board.connection.offline?'离线':'已连接'}</p><p>最近同步：{time(board.connection.lastSeen||board.connection.updatedAt)}</p>{board.connection.offline&&<p className="alert">电脑离线时仍可查看已同步内容；操作会等待有效回执。</p>}</div>{board.capabilities.role==='owner'&&<HubAdmin projects={projects}/>}</div>;
  return <div className="content-page remote-page"><div className="section-header"><div><h2>手机连接</h2><p>选择允许同步的项目，再用账号密码或一次性配对码连接。</p></div><button className="secondary" type="button" onClick={()=>void load()} disabled={busy}><RefreshCw size={15}/> 刷新</button></div><div className="setting-card"><div className="card-heading"><Cloud size={18}/><h3>连接状态</h3></div><p>{remote?labels[remote.status]:'正在读取连接状态'}</p>{remote?.url&&<p>地址：{remote.url}</p>}{remote?.nodeId&&<p>设备：{remote.nodeId}</p>}{remote?.lastSyncAt&&<p>最近同步：{time(remote.lastSyncAt)}</p>}{remote?.lastError&&<p className="alert">{remote.lastError}</p>}{remote?.status!=='disconnected'&&remote&&<button className="secondary" type="button" onClick={()=>void disconnect()} disabled={busy}>断开连接</button>}</div><form className="setting-card" onSubmit={connect}><div className="card-heading"><Cloud size={18}/><h3>连接到自己的服务</h3></div><label className="field" htmlFor="remote-url"><span>服务器地址</span><input id="remote-url" type="url" value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://…" required/></label><div className="decision" role="group" aria-label="连接方式"><button type="button" aria-pressed={connectMethod==='account'} onClick={()=>setConnectMethod('account')}>账号密码</button><button type="button" aria-pressed={connectMethod==='pairing'} onClick={()=>setConnectMethod('pairing')}>一次性配对码</button></div>{connectMethod==='account'?<><label className="field" htmlFor="remote-username"><span>用户名</span><input id="remote-username" autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} required/></label><label className="field" htmlFor="remote-password"><span>密码</span><input id="remote-password" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required/></label></>:<label className="field" htmlFor="pairing-code"><span>一次性配对码</span><input id="pairing-code" type="password" autoComplete="off" value={pairingCode} onChange={e=>setPairingCode(e.target.value)} required/></label>}<fieldset className="project-grants"><legend>允许同步的项目</legend>{projects.length?projects.map(project=><label key={project.id}><input type="checkbox" checked={projectIds.includes(project.id)} onChange={()=>toggle(project.id)}/><span>{project.name}</span></label>):<p>先创建一个项目。</p>}</fieldset>{error&&<p className="alert" role="alert">{error}</p>}{notice&&<p className="notice" role="status">{notice}</p>}<button className="primary" type="submit" disabled={busy||!projects.length}>{busy?'正在连接…':'连接手机端'}</button></form></div>;
}
