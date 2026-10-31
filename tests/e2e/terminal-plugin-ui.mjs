/** Isolated browser contract test: mock plugin HTTP, no terminal process. */
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';

const terminal=()=>({id:'local-terminal',name:'Local Terminal',version:'1',contract:'terminal.local.v1',isolation:'core',trust:'built-in',enabled:phase==='ready',available:true,status:phase,lastError:phase==='disabled_unknown'?'终端关闭结果未确认':null,capabilities:['terminal.local.v1']});
const old=()=>({id:'example',name:'旧插件',version:'1',enabled:oldEnabled,available:true,status:'ready',lastError:null,config:{label:'原值'},configSchema:{properties:{label:{type:'string',title:'显示名称'}}}});
let phase='ready',oldEnabled=false,disableResult='success',checkResult='clean',holdList=false,releaseList,listStarted,holdDisable=false,releaseDisable,disableStarted,terminalStatusPhase='disabled_unknown';
let vite,browser;
const requests=[];
try{
  vite=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:0},plugins:[{name:'terminal-plugin-harness',configureServer(server){server.middlewares.use('/terminal-plugin-harness',async(_req,res)=>{const html=await server.transformIndexHtml('/terminal-plugin-harness',`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">import React from 'react';import{createRoot}from'react-dom/client';import PluginCatalog from '/src/PluginCatalog.tsx';import TerminalPanel from '/src/TerminalPanel.tsx';window.__changed=0;const panel=new URLSearchParams(location.search).has('panel');createRoot(document.getElementById('root')).render(panel?React.createElement(TerminalPanel,{board:{connection:{mode:'local'},capabilities:{role:'owner'}}}):React.createElement(PluginCatalog,{onChanged:async()=>{window.__changed++}}));</script></body></html>`);res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);});}}]});
  await vite.listen();
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/api/plugins**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    requests.push(`${request.method()} ${path}`);
    if(path==='/api/plugins'&&request.method()==='GET'){
      const snapshot=[terminal(),old()];
      if(holdList){holdList=false;listStarted?.();await new Promise(resolve=>{releaseList=resolve;});}
      return route.fulfill({json:snapshot});
    }
    const action=path.match(/^\/api\/plugins\/(local-terminal|example)\/(enable|disable|check)$/);
    if(action&&request.method()==='POST'){
      const [,id,verb]=action;
      if(id==='example'){if(verb==='enable')oldEnabled=true;if(verb==='disable')oldEnabled=false;return route.fulfill({json:old()});}
      if(verb==='disable'){
        if(holdDisable){disableStarted?.();await new Promise(resolve=>{releaseDisable=resolve;});}
        if(disableResult==='reject')return route.fulfill({status:409,json:{code:'TERMINAL_SHELL_ACTIVE',error:'普通 Shell 仍在运行'}});
        if(disableResult==='unknown'){phase='disabled_unknown';return route.fulfill({status:503,json:{code:'TERMINAL_PLUGIN_UNKNOWN',error:'关闭回执未确认'}});}
        phase='disabled';
      }
      if(verb==='check'&&phase==='disabled_unknown'&&checkResult==='clean')phase='disabled';
      if(verb==='enable'&&phase==='disabled')phase='ready';
      return route.fulfill({json:terminal()});
    }
    if(path==='/api/plugins/example/config'&&request.method()==='PATCH')return route.fulfill({json:old()});
    return route.fulfill({status:404,json:{error:'not found'}});
  });
  await context.route('**/api/terminal/status',route=>route.fulfill({json:{mode:'local',enabled:false,profiles:[{id:'stored',label:'原有会话配置',enabled:true,tmuxAvailable:true}],grants:[],pendingDevices:[],plugin:{enabled:false,status:terminalStatusPhase,lastError:terminalStatusPhase==='disabled_unknown'?'终端关闭结果未确认':null,contract:'terminal.local.v1'}}}));
  await context.route('**/api/terminal/tickets',route=>{requests.push('POST /api/terminal/tickets');return route.fulfill({status:409,json:{error:'终端插件已停用'}});});
  await page.goto(new URL('/terminal-plugin-harness',vite.resolvedUrls.local[0]).href);
  const terminalCard=page.locator('article.setting-card').filter({has:page.getByRole('heading',{name:'本机终端'})});
  const oldCard=page.locator('article.setting-card').filter({has:page.getByRole('heading',{name:'旧插件'})});
  await terminalCard.getByText('已启用',{exact:true}).waitFor();
  await terminalCard.getByText('停用不会删除原有 tmux 会话',{exact:false}).waitFor();
  assert.equal(await oldCard.getByRole('button',{name:'启用'}).count(),1,'existing plugins retain generic controls');
  disableResult='reject';
  await terminalCard.getByRole('button',{name:'停用终端入口'}).click();
  await page.getByRole('alert').getByText('普通 Shell 仍在运行',{exact:false}).waitFor();
  assert.equal(await terminalCard.getByText('已启用',{exact:true}).count(),1,'rejected disable keeps actual ready state');
  assert.equal(await page.getByText('本机终端入口已停用。',{exact:false}).count(),0,'rejection cannot be announced as success');
  disableResult='success';
  await terminalCard.getByRole('button',{name:'停用终端入口'}).click();
  await terminalCard.getByText('已停用',{exact:true}).waitFor();
  await page.getByText('本机终端入口已停用。原有 tmux 会话仍保留。').waitFor();
  await terminalCard.getByRole('button',{name:'启用终端入口'}).click();
  await terminalCard.getByText('已启用',{exact:true}).waitFor();
  holdDisable=true;disableResult='success';
  const duplicateStarted=new Promise(resolve=>{disableStarted=resolve;});
  const disablesBeforeDuplicate=requests.filter(value=>value==='POST /api/plugins/local-terminal/disable').length;
  await terminalCard.getByRole('button',{name:'停用终端入口'}).evaluate(button=>{button.click();button.click();});
  await duplicateStarted;
  assert.equal(requests.filter(value=>value==='POST /api/plugins/local-terminal/disable').length,disablesBeforeDuplicate+1,'rapid duplicate clicks send one operation');
  holdDisable=false;releaseDisable();
  await terminalCard.getByText('已停用',{exact:true}).waitFor();
  await terminalCard.getByRole('button',{name:'启用终端入口'}).click();
  await terminalCard.getByText('已启用',{exact:true}).waitFor();
  disableResult='unknown';checkResult='unknown';
  await terminalCard.getByRole('button',{name:'停用终端入口'}).click();
  await terminalCard.getByText('停用结果待核实',{exact:true}).waitFor();
  assert.equal(await terminalCard.getByRole('button',{name:'核实后再操作'}).isDisabled(),true,'unknown cannot simply enable');
  await terminalCard.getByRole('button',{name:'检查终端状态'}).click();
  await page.getByText('检查后仍无法确认终端已安全停用',{exact:false}).waitFor();
  checkResult='clean';
  await terminalCard.getByRole('button',{name:'检查终端状态'}).click();
  await terminalCard.getByText('已停用',{exact:true}).waitFor();
  await terminalCard.getByRole('button',{name:'启用终端入口'}).click();
  await terminalCard.getByText('已启用',{exact:true}).waitFor();
  // A refresh started before disable must never repaint the new disabled state.
  disableResult='success';holdList=true;
  const oldListStarted=new Promise(resolve=>{listStarted=resolve;});
  await page.getByRole('button',{name:'刷新'}).click();
  await oldListStarted;
  await terminalCard.getByRole('button',{name:'停用终端入口'}).click();
  await terminalCard.getByText('已停用',{exact:true}).waitFor();
  releaseList();
  await page.waitForTimeout(100);
  assert.equal(await terminalCard.getByText('已停用',{exact:true}).count(),1,'late old GET cannot repaint ready');
  await oldCard.getByRole('button',{name:'启用'}).click();
  await oldCard.getByRole('button',{name:'停用'}).waitFor();
  assert.equal(await oldCard.locator('summary').filter({hasText:'插件设置'}).count(),1,'existing plugin configuration remains available');
  const panel=await context.newPage();
  await panel.goto(new URL('/terminal-plugin-harness?panel=1',vite.resolvedUrls.local[0]).href);
  await panel.getByRole('heading',{name:'本机终端状态待核实'}).waitFor();
  await panel.getByText('终端关闭结果未确认').waitFor();
  assert.equal(await panel.getByRole('button',{name:'连接终端'}).isDisabled(),true,'retained enabled profile cannot connect while plugin state is unknown');
  assert.equal(await panel.getByRole('option',{name:/原有会话配置/}).count(),0,'retained profile is not a connectable target');
  terminalStatusPhase='disabled';
  await panel.getByRole('button',{name:'刷新终端状态'}).click();
  await panel.getByRole('heading',{name:'本机终端入口已停用'}).waitFor();
  assert.equal(await panel.getByRole('button',{name:'连接终端'}).isDisabled(),true,'retained enabled profile cannot connect while disabled');
  assert.equal(requests.filter(value=>value==='POST /api/terminal/tickets').length,0,'disabled or unknown plugin never requests a ticket');
  await panel.close();
  assert.deepEqual(errors,[]);
  assert.ok(requests.includes('POST /api/plugins/local-terminal/check'));
  console.log('Terminal plugin UI PASS: old plugin; reject; disable/enable; unknown/check; late list; local status');
  await context.close();
}finally{await browser?.close();await vite?.close();}
