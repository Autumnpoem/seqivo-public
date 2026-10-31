import {useState,type FormEvent} from 'react';
import {ArrowRight,Layers2} from 'lucide-react';
import {ApiError,clearToken,redeemPairingCode,request,setToken} from './api';
import type {AccountUser} from './types';

type AuthResult={user:AccountUser;expiresAt:string};
type LoginMode='account'|'register'|'pairing'|'token';
const describe=(error:unknown)=>error instanceof Error?error.message:'请求未完成，请稍后重试。';

export function LoginPanel({registrationEnabled,accountsAvailable,onAuthenticated}:{registrationEnabled:boolean;accountsAvailable:boolean;onAuthenticated:(user:AccountUser|null)=>void}){
  const [mode,setMode]=useState<LoginMode>(accountsAvailable?'account':'token');
  const [username,setUsername]=useState('');
  const [password,setPassword]=useState('');
  const [secret,setSecret]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy)return;setBusy(true);setError('');
    try{
      if(mode==='account'||mode==='register'){
        const result=await request<AuthResult>('POST',`/api/auth/${mode==='account'?'login':'register'}`,{username:username.trim(),password});
        clearToken();setPassword('');onAuthenticated(result.user);
      }else {
        try {await request('POST','/api/auth/logout',{});} catch(caught) {if(!(caught instanceof ApiError)||![401,404].includes(caught.status))throw caught;}
        if(mode==='pairing'){
        const token=await redeemPairingCode(secret.trim());setToken(token);setSecret('');onAuthenticated(null);
        }else{if(!secret.trim())throw Error('请输入访问令牌。');setToken(secret.trim());setSecret('');onAuthenticated(null);}
      }
    }catch(caught){setError(describe(caught));}finally{setBusy(false);}
  }
  const account=mode==='account'||mode==='register';
  return <div className="login-screen"><div className="login-card"><div className="brand-mark"><Layers2 size={20}/></div><h1>序程</h1><p>登录后查看自己的项目，并从手机继续与 Codex 对话。</p>{accountsAvailable&&<div className="decision login-options" role="group" aria-label="账号操作"><button type="button" aria-pressed={mode==='account'} onClick={()=>{setMode('account');setError('')}}>登录</button>{registrationEnabled&&<button type="button" aria-pressed={mode==='register'} onClick={()=>{setMode('register');setError('')}}>注册</button>}</div>}<form onSubmit={event=>void submit(event)}>{account?<><label className="field" htmlFor="account-username"><span>用户名</span><input id="account-username" autoComplete="username" value={username} onChange={event=>setUsername(event.target.value)} minLength={3} maxLength={40} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,39}" title="3 至 40 位，以字母或数字开头，可使用字母、数字、下划线、句点和短横线" required/></label><label className="field" htmlFor="account-password"><span>密码</span><input id="account-password" type="password" autoComplete={mode==='register'?'new-password':'current-password'} value={password} onChange={event=>setPassword(event.target.value)} minLength={mode==='register'?12:undefined} maxLength={128} required/></label>{mode==='register'&&<p className="form-help">密码至少 12 位。注册后会创建属于你的独立空间。</p>}</>:<label className="field" htmlFor="login-secret"><span>{mode==='pairing'?'一次性配对码':'访问令牌'}</span><input id="login-secret" type="password" autoComplete="off" value={secret} onChange={event=>setSecret(event.target.value)} required/></label>}<button className="primary full" type="submit" disabled={busy}>{busy?'正在连接…':mode==='register'?'创建账号':'进入看板'} <ArrowRight size={16}/></button></form>{error&&<p className="alert" role="alert">{error}</p>}<details className="detail-more login-advanced"><summary>其他连接方式</summary><div className="action-row"><button type="button" className="secondary" aria-pressed={mode==='pairing'} onClick={()=>{setMode('pairing');setError('')}}>手机配对码</button><button type="button" className="secondary" aria-pressed={mode==='token'} onClick={()=>{setMode('token');setError('')}}>访问令牌</button></div></details></div></div>;
}

export function AccountSettings({user,legacyOwner,onSignedIn,onLogout}:{user:AccountUser|null;legacyOwner:boolean;onSignedIn:(user:AccountUser)=>void;onLogout:()=>void}){
  const [username,setUsername]=useState('');const [password,setPassword]=useState('');
  const [currentPassword,setCurrentPassword]=useState('');const [nextPassword,setNextPassword]=useState('');
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');
  async function claim(event:FormEvent<HTMLFormElement>){event.preventDefault();setBusy(true);setError('');setNotice('');try{const result=await request<AuthResult>('POST','/api/auth/claim',{username:username.trim(),password});clearToken();setPassword('');onSignedIn(result.user);setNotice('当前空间已绑定账号，已有项目和任务会保留。');}catch(caught){setError(describe(caught));}finally{setBusy(false);}}
  async function changePassword(event:FormEvent<HTMLFormElement>){event.preventDefault();setBusy(true);setError('');setNotice('');try{await request('POST','/api/auth/password',{currentPassword,password:nextPassword});setCurrentPassword('');setNextPassword('');onLogout();}catch(caught){setError(describe(caught));}finally{setBusy(false);}}
  return <div className="content-page account-page"><div className="section-header"><div><h2>账号</h2><p>{user?`当前登录：${user.username}`:'当前通过配对码或访问令牌连接。'}</p></div></div>{legacyOwner&&!user&&<form className="setting-card" onSubmit={event=>void claim(event)}><h3>为当前空间设置账号</h3><p>绑定后可用账号密码从电脑和手机访问这里已有的项目与任务。</p><label className="field" htmlFor="claim-username"><span>用户名</span><input id="claim-username" autoComplete="username" value={username} onChange={event=>setUsername(event.target.value)} minLength={3} maxLength={40} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,39}" required/></label><label className="field" htmlFor="claim-password"><span>新密码</span><input id="claim-password" type="password" autoComplete="new-password" value={password} onChange={event=>setPassword(event.target.value)} minLength={12} maxLength={128} required/></label><button className="primary" disabled={busy} type="submit">绑定当前空间</button></form>}{user&&<form className="setting-card" onSubmit={event=>void changePassword(event)}><h3>修改密码</h3><label className="field" htmlFor="current-password"><span>当前密码</span><input id="current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={event=>setCurrentPassword(event.target.value)} required/></label><label className="field" htmlFor="next-password"><span>新密码</span><input id="next-password" type="password" autoComplete="new-password" minLength={12} value={nextPassword} onChange={event=>setNextPassword(event.target.value)} required/></label><button className="secondary" disabled={busy} type="submit">更新密码</button></form>}{error&&<p className="alert" role="alert">{error}</p>}{notice&&<p className="notice" role="status">{notice}</p>}<button className="secondary" type="button" onClick={onLogout}>退出登录</button></div>;
}
