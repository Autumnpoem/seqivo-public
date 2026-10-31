import React from 'react';
import {createRoot} from 'react-dom/client';
import {installBrowserPwa,prepareBrowserShell} from './browser-shell';
import './styles.css';

const root=document.getElementById('root')!;
let checking=false;
function recovery(){
  root.replaceChildren();
  const title=document.createElement('h2');title.textContent='旧版离线页面状态未确认';
  const detail=document.createElement('p');detail.textContent='尚不能安全打开看板。请保持登录状态并手动重查；若仍失败，请更新应用或关闭后重开。';
  const retry=document.createElement('button');retry.type='button';retry.textContent='重新检查';retry.addEventListener('click',()=>{void boot();});
  root.append(title,detail,retry);
}
function loadingFailure(){
  root.replaceChildren();
  const title=document.createElement('h2');title.textContent='页面加载失败';
  const detail=document.createElement('p');detail.textContent='请检查网络后手动刷新页面。登录和本地记录不会因本次提示被清除。';
  const retry=document.createElement('button');retry.type='button';retry.textContent='刷新页面';retry.addEventListener('click',()=>location.reload());
  root.append(title,detail,retry);
}
async function boot(){
  if(checking)return;
  checking=true;
  try{
    const result=await prepareBrowserShell();
    if(result.state==='reload'){location.reload();return;}
    if(result.state==='recovery'){recovery();return;}
    const {default:App}=await import('./App');
    if(!result.native)installBrowserPwa();
    createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
  }catch{loadingFailure();}
  finally{checking=false;}
}
void boot();
