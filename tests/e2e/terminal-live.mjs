/** Real isolated Core + HTTP + browser + PTY/tmux flow. No terminal route mocking. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {createCore} from '../../server/core.mjs';
import {startHttp} from '../../server/http.mjs';
import {inspectWorkspaceWriters} from '../../server/terminal/process-inspection.mjs';

const tmux=resolve(process.env.TMUX_TEST_EXECUTABLE||'.tools/terminal-build/install/bin/tmux');
const serverName=`seqivo-live-${process.pid}-${randomBytes(4).toString('hex')}`;
const dir=await mkdtemp(join(tmpdir(),'seqivo-terminal-live-'));
const qa=resolve('design/qa/terminal-live');
let core,web,browser;
const tmuxCall=(...args)=>execFileSync(tmux,['-L',serverName,...args],{timeout:5000,encoding:'utf8'});
const marker=`SHELL_OUTPUT_${randomBytes(6).toString('hex')}`;
try {
  await access(tmux).catch(()=>{throw new Error(`tmux test executable is unavailable: ${tmux}`)});
  await mkdir(qa,{recursive:true});
  await writeFile(join(dir,'terminal-marker.txt'),`${marker}\n`);
  core=await createCore({dataDir:join(dir,'data'),pluginDir:resolve('plugins'),files:false});
  const project=core.store.project({name:'终端实测项目',goal:'只在临时目录验证真实终端。',directory:dir});
  web=await startHttp({core,dataDir:join(dir,'data'),distDir:resolve(process.env.SEQIVO_TEST_DIST_DIR||'dist'),port:0});
  const base=`http://127.0.0.1:${web.port}`;
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  const page=await context.newPage(),pageErrors=[];
  page.on('pageerror',error=>pageErrors.push(error.message));
  await page.addInitScript(token=>sessionStorage.setItem('taskboard-token',token),web.tokens.owner);
  await page.addInitScript(()=>{
    window.__terminalLiveFrames=[];
    window.__terminalLiveOutput=[];
    window.__terminalLiveSent=[];
    const NativeWebSocket=window.WebSocket;
    window.WebSocket=class extends NativeWebSocket {
      constructor(url,protocols){if(protocols===undefined)super(url);else super(url,protocols);
        this.addEventListener('message',event=>{try{const frame=JSON.parse(event.data);window.__terminalLiveFrames.push(frame);if(frame.type==='output')window.__terminalLiveOutput.push(atob(frame.data));}catch{/* Observe only; leave transport untouched. */}});
      }
      send(data){try{const frame=JSON.parse(data);if(['select','list','detach'].includes(frame.type))window.__terminalLiveSent.push({type:frame.type,requestId:frame.requestId,epoch:frame.epoch,sessionRef:frame.sessionRef});}catch{/* Observe only. */}return super.send(data);}
    };
  });
  await page.goto(base);
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'远程终端'}).click();
  await page.getByRole('heading',{name:'远程终端'}).last().waitFor();
  await page.getByText('本机终端尚未启用').waitFor();
  await page.getByText('tmux 高级设置').click();
  await page.getByLabel('tmux server 名称（留空使用独立服务）').fill(serverName);
  assert.equal(await page.getByRole('button',{name:'启用默认终端'}).isDisabled(),true,'explicit shared tmux server requires acknowledgement');
  await page.getByRole('checkbox',{name:/我确认此配置可访问/}).check();
  await page.getByLabel('tmux 可执行文件路径（可选）').fill(tmux);
  await page.getByRole('button',{name:'启用默认终端'}).click();
  await page.waitForFunction(()=>document.querySelector('.terminal-target-label select')?.value==='local/default');
  await page.getByRole('checkbox',{name:/使用临时普通 Shell/}).check();
  await page.getByRole('button',{name:'连接终端'}).click();
  await page.getByRole('button',{name:'我来处理'}).waitFor({timeout:12000});
  assert.equal(await page.locator('.terminal-keys').getByRole('button',{name:'Ctrl',exact:true}).isDisabled(),true,'input stays sealed before verified takeover');
  await page.getByRole('button',{name:'我来处理'}).click();
  await page.getByRole('button',{name:'确认停止并接管'}).click();
  try{await page.getByText('任务执行权：由我处理').waitFor({timeout:12000});}
  catch(error){console.error('Takeover diagnostic',await page.evaluate(()=>({control:document.querySelector('.terminal-control')?.textContent,state:document.querySelector('.terminal-state')?.textContent,frames:window.__terminalLiveFrames.slice(-12).map(frame=>({type:frame.type,phase:frame.phase,managed:frame.managed,owned:frame.owned,reason:frame.reason,code:frame.code,message:frame.message}))})));throw error;}
  await page.getByText('已连接',{exact:true}).waitFor({timeout:12000});
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.insertText('cat terminal-marker.txt');
  await page.keyboard.press('Enter');
  try{await page.waitForFunction(expected=>window.__terminalLiveOutput.join('').includes(expected),marker,{timeout:10000});}
  catch(error){console.error('PTY diagnostic',await page.evaluate(()=>({output:window.__terminalLiveOutput.join('').slice(-1500),frames:window.__terminalLiveFrames.slice(-12).map(frame=>({type:frame.type,code:frame.code,message:frame.message,epoch:frame.epoch,seq:frame.seq})),status:document.querySelector('.terminal-state')?.textContent})));throw error;}
  assert.ok(await page.evaluate(()=>window.__terminalLiveFrames.some(frame=>frame.type==='inputAck'&&frame.status==='written')),'real PTY acknowledged input');
  await page.keyboard.insertText('printf changed-by-terminal > changed-file.txt');
  await page.keyboard.press('Enter');
  let changed='';for(let attempt=0;attempt<40;attempt++){changed=await readFile(join(dir,'changed-file.txt'),'utf8').catch(()=>'');if(changed==='changed-by-terminal')break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(changed,'changed-by-terminal','real Shell changed the isolated project file');
  await page.keyboard.insertText('exit');await page.keyboard.press('Enter');
  await page.getByText('已断开',{exact:true}).waitFor({timeout:12000});
  await page.getByRole('button',{name:'交还给 AI'}).click();
  await page.getByText('任务执行权：由 AI 管理').waitFor({timeout:12000});
  tmuxCall('new-session','-d','-s','A','-c',dir);
  tmuxCall('new-session','-d','-s','B','-c',dir);
  assert.deepEqual(tmuxCall('list-sessions','-F','#{session_name}').trim().split('\n').sort(),['A','B']);
  const panePid=name=>Number(tmuxCall('display-message','-p','-t',`${name}:0.0`,'#{pane_pid}').trim());
  const originalPids={A:panePid('A'),B:panePid('B')};
  assert.ok(originalPids.A>0&&originalPids.B>0);
  await page.getByRole('checkbox',{name:/使用临时普通 Shell/}).uncheck();
  await page.getByRole('button',{name:'连接终端'}).click();
  await page.getByText('请选择会话',{exact:true}).waitFor({timeout:12000});
  const drawer=page.locator('#terminal-session-drawer');await drawer.getByText('A',{exact:true}).waitFor({timeout:12000});await drawer.getByText('B',{exact:true}).waitFor({timeout:12000});
  await drawer.locator('.terminal-session-row').filter({hasText:'A'}).getByRole('button',{name:'设为默认'}).click();
  await drawer.locator('.terminal-session-row').filter({hasText:'A'}).getByText(/默认/).waitFor({timeout:10000});
  await page.getByRole('button',{name:'操作已有会话'}).click();
  await drawer.getByRole('checkbox',{name:'选择会话 A'}).check();
  await drawer.getByRole('checkbox',{name:'选择会话 B'}).check();
  await drawer.getByRole('button',{name:'确认接入并保留程序'}).click();
  await page.getByText('任务执行权：由我处理').waitFor({timeout:12000});
  await page.getByRole('button',{name:/会话：A/}).waitFor({timeout:12000});
  await page.getByText('已连接',{exact:true}).waitFor({timeout:12000});
  assert.equal(panePid('A'),originalPids.A,'existing A process survives writable adoption');
  assert.equal(panePid('B'),originalPids.B,'existing B process survives writable adoption');
  assert.equal(await page.locator('.terminal-keys').getByRole('button',{name:'Ctrl',exact:true}).isDisabled(),false,'authorized A accepts input');
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.insertText('printf adopted-A > adopted-A.txt');await page.keyboard.press('Enter');
  let adopted='';for(let attempt=0;attempt<40;attempt++){adopted=await readFile(join(dir,'adopted-A.txt'),'utf8').catch(()=>'');if(adopted==='adopted-A')break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(adopted,'adopted-A','real adopted pane executes authorized input');
  await page.keyboard.insertText('printf existing-change > tmux-handoff.txt');await page.keyboard.press('Enter');
  let handoff='';for(let attempt=0;attempt<40;attempt++){handoff=await readFile(join(dir,'tmux-handoff.txt'),'utf8').catch(()=>'');if(handoff==='existing-change')break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(handoff,'existing-change','this existing-session takeover creates its own reviewable change');
  tmuxCall('new-session','-d','-s','C','-c',dir);
  const cPid=panePid('C');
  await page.getByRole('button',{name:/会话：A/}).click();
  await drawer.getByRole('button',{name:'刷新列表'}).click();
  await drawer.getByText('C',{exact:true}).waitFor({timeout:10000});
  await drawer.locator('.terminal-session-row').filter({hasText:'C'}).getByRole('button',{name:/C/}).first().click();
  await page.waitForFunction(()=>window.__terminalLiveFrames.some(frame=>frame.type==='error'&&frame.code==='SESSION_NOT_AUTHORIZED'),null,{timeout:10000});
  assert.equal(await page.locator('.terminal-keys').getByRole('button',{name:'Ctrl',exact:true}).isDisabled(),true,'unapproved C switch seals input');
  await drawer.getByRole('checkbox',{name:'选择会话 C'}).waitFor({timeout:10000});
  await drawer.getByRole('button',{name:'确认扩展会话授权'}).click();
  await page.getByText('新会话已通过复核。',{exact:false}).waitFor({timeout:12000});
  await drawer.locator('.terminal-session-row').filter({hasText:'C'}).getByRole('button',{name:/C/}).first().click();
  await page.getByRole('button',{name:/会话：C/}).waitFor({timeout:12000});
  assert.equal(panePid('C'),cPid,'extension retains original C process');
  await page.getByRole('button',{name:/会话：C/}).click();
  await drawer.locator('.terminal-session-row').filter({hasText:'B'}).getByRole('button',{name:/B/}).first().click();
  await page.getByRole('button',{name:/会话：B/}).waitFor({timeout:12000});
  assert.equal(panePid('B'),originalPids.B,'switching to B keeps its process');
  assert.deepEqual(tmuxCall('list-sessions','-F','#{session_name}').trim().split('\n').sort(),['A','B','C'],'switching preserves all adopted tmux sessions');
  await page.getByRole('button',{name:'断开'}).click();
  await page.getByRole('button',{name:'连接终端'}).click();
  try{await page.getByRole('button',{name:/会话：A/}).waitFor({timeout:12000});}
  catch(error){
    const browserState=await page.evaluate(()=>({state:document.querySelector('.terminal-state')?.textContent,message:document.querySelector('.terminal-actions')?.textContent,control:document.querySelector('.terminal-control')?.textContent,sessionBar:document.querySelector('.terminal-session-bar')?.textContent,drawer:document.querySelector('#terminal-session-drawer')?.textContent,
      frames:window.__terminalLiveFrames.filter(frame=>['control','sessions','ready','error','exit'].includes(frame.type)).slice(-25)}));
    const tmuxSessions=tmuxCall('list-sessions','-F','#{session_name}|#{session_id}|#{pane_pid}');
    await writeFile(join(qa,'reconnect-diagnostic.json'),JSON.stringify({browserState,tmuxSessions},null,2));
    await page.screenshot({path:join(qa,'reconnect-diagnostic.png'),fullPage:true,animations:'disabled'});
    console.error('Reconnect diagnostic',{state:browserState.state,message:browserState.message,control:browserState.control,sessionBar:browserState.sessionBar,frames:browserState.frames.map(frame=>({type:frame.type,phase:frame.phase,owned:frame.owned,mode:frame.mode,code:frame.code,message:frame.message,defaultRef:frame.defaultRef,items:frame.items?.map(item=>item.name)})),tmuxSessions:tmuxSessions.trim()});
    throw error;
  }
  assert.equal(panePid('A'),originalPids.A,'reconnect keeps original A process');
  await page.getByRole('button',{name:/会话：A/}).click();
  const geometry=await drawer.evaluate(element=>({height:element.getBoundingClientRect().height,bottom:element.getBoundingClientRect().bottom,viewport:innerHeight,listHeight:element.querySelector('.terminal-session-list')?.getBoundingClientRect().height}));
  assert.ok(geometry.height>100&&geometry.bottom<=geometry.viewport+1&&geometry.listHeight>0,`mobile drawer accessible: ${JSON.stringify(geometry)}`);
  await page.screenshot({path:join(qa,'terminal-live-mobile.png'),fullPage:true,animations:'disabled'});
  await drawer.getByRole('button',{name:'关闭会话列表'}).click();
  const originalBId=tmuxCall('display-message','-p','-t','B','#{session_id}').trim();
  tmuxCall('kill-session','-t','B');tmuxCall('new-session','-d','-s','B','-c',dir);
  assert.notEqual(tmuxCall('display-message','-p','-t','B','#{session_id}').trim(),originalBId,'same-name session has a new identity');
  await page.getByRole('button',{name:/会话：A/}).click();
  await drawer.getByRole('button',{name:'刷新列表'}).click();
  const replacementBId=tmuxCall('display-message','-p','-t','B','#{session_id}').trim();
  await page.waitForFunction(expected=>{
    const latest=[...window.__terminalLiveFrames].reverse().find(frame=>frame.type==='sessions');
    const current=latest?.items?.find(item=>item.name==='B');
    const row=[...document.querySelectorAll('.terminal-session-row')].find(item=>item.querySelector('strong')?.textContent==='B');
    return current?.sessionRef?.sessionId===expected&&row&&!row.textContent.includes('已可操作');
  },replacementBId,{timeout:10000});
  await drawer.locator('.terminal-session-row').filter({hasText:'B'}).getByRole('button',{name:/B/}).first().click();
  try{await page.waitForFunction(()=>window.__terminalLiveFrames.filter(frame=>frame.type==='error'&&frame.code==='SESSION_NOT_AUTHORIZED').length>=2,null,{timeout:10000});}
  catch(error){
    const browserState=await page.evaluate(()=>({state:document.querySelector('.terminal-state')?.textContent,message:document.querySelector('.terminal-actions')?.textContent,drawer:document.querySelector('#terminal-session-drawer')?.textContent,rows:[...document.querySelectorAll('.terminal-session-row')].map(row=>row.textContent),sent:window.__terminalLiveSent.slice(-12),frames:window.__terminalLiveFrames.filter(frame=>['control','sessions','ready','error','exit'].includes(frame.type)).slice(-18).map(frame=>({type:frame.type,code:frame.code,message:frame.message,requestId:frame.requestId,epoch:frame.epoch,sessionRef:frame.sessionRef,items:frame.items?.map(item=>({name:item.name,sessionRef:item.sessionRef}))}))}));
    const tmuxSessions=tmuxCall('list-sessions','-F','#{session_name}|#{session_id}|#{pane_pid}');
    await writeFile(join(qa,'same-name-diagnostic.json'),JSON.stringify({browserState,tmuxSessions},null,2));
    await page.screenshot({path:join(qa,'same-name-diagnostic.png'),fullPage:true,animations:'disabled'});
    console.error('Same-name diagnostic',{state:browserState.state,sent:browserState.sent,errors:browserState.frames.filter(frame=>frame.type==='error'),rows:browserState.rows,tmuxSessions:tmuxSessions.trim()});
    throw error;
  }
  assert.equal(await page.locator('.terminal-keys').getByRole('button',{name:'Ctrl',exact:true}).isDisabled(),true,'same-name replacement cannot inherit B write authorization');
  await drawer.getByRole('button',{name:'关闭会话列表'}).click();
  await page.getByLabel('交还说明（可选）').fill('Shell 已更新隔离测试文件；tmux 会话已核对。');
  await page.getByRole('button',{name:'交还给 AI'}).click();
  await page.getByText('任务执行权：现场待核对').waitFor({timeout:12000});
  assert.equal(await page.locator('.terminal-keys').getByRole('button',{name:'Ctrl',exact:true}).isDisabled(),true,'unknown return stays input-sealed');
  tmuxCall('kill-server');
  // The detached PTY can outlive tmux kill-server briefly; reconcile only after independent lsof proof.
  let quiescent=false;
  for(let attempt=0;attempt<40;attempt++){
    const evidence=await inspectWorkspaceWriters({workspace:dir});
    if(evidence.verified&&evidence.quiescent){quiescent=true;break;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(quiescent,true,'isolated tmux writer exits before release reconciliation');
  await page.getByRole('button',{name:'核对并交还'}).click();
  await page.getByRole('button',{name:'确认核对并交还'}).click();
  try{await page.getByText('任务执行权：由 AI 管理').waitFor({timeout:12000});}
  catch(error){const writers=await inspectWorkspaceWriters({workspace:dir});const pids=writers.livePids||[];let processes='';if(pids.length)try{processes=execFileSync('ps',['-p',pids.join(','),'-o','pid,ppid,pgid,command'],{encoding:'utf8'});}catch(cause){processes=String(cause.message);}const browserState=await page.evaluate(()=>({control:document.querySelector('.terminal-control')?.textContent,frames:window.__terminalLiveFrames.slice(-10).map(frame=>({type:frame.type,phase:frame.phase,owned:frame.owned,reason:frame.reason,code:frame.code,message:frame.message}))}));await writeFile(join(qa,'release-writers.json'),JSON.stringify({writers,processes,browserState},null,2));console.error('Release diagnostic',{writers:writers.writers?.map(({pid,command,reason})=>({pid,command,reason})),processes,browserState});throw error;}
  await page.getByText('本次核对的文件变化').waitFor({timeout:5000});
  await page.getByText('本次核对的文件变化').click();
  await page.locator('.terminal-changes').getByText('tmux-handoff.txt').waitFor();
  assert.equal(await page.locator('.terminal-changes').getByText('changed-file.txt').count(),0,'a file returned by the earlier Shell handoff is not a new change in this takeover');
  // A writer that predates takeover must keep the new claim sealed.
  tmuxCall('new-session','-d','-s','preexisting-writer','-c',dir);
  await page.getByRole('button',{name:'断开'}).click();
  await page.getByRole('button',{name:'连接终端'}).click();
  await page.getByRole('button',{name:'我来处理'}).waitFor({timeout:12000});
  await page.getByRole('button',{name:'我来处理'}).click();
  await page.getByRole('button',{name:'确认停止并接管'}).click();
  await page.getByText('任务执行权：现场待核对').waitFor({timeout:12000});
  assert.match(await page.locator('.terminal-control').innerText(),/其他写入者未证明相关写入进程已停止/);
  assert.equal(await page.locator('.terminal-keys').getByRole('button',{name:'Ctrl',exact:true}).isDisabled(),true,'preexisting writer rejection remains input-sealed');
  await page.getByRole('button',{name:'断开'}).click();
  await page.getByRole('checkbox',{name:/只读查看已有 tmux 会话/}).check();
  await page.getByRole('button',{name:'连接终端'}).click();
  const readOnlyDrawer=page.locator('#terminal-session-drawer');
  await readOnlyDrawer.getByText('preexisting-writer',{exact:true}).waitFor({timeout:12000});
  assert.equal(await readOnlyDrawer.getByRole('button',{name:/新建真实会话/}).count(),0,'read-only drawer cannot create');
  const beforeViewOutput=await page.evaluate(()=>window.__terminalLiveFrames.filter(frame=>frame.type==='output').length);
  await readOnlyDrawer.locator('.terminal-session-row').filter({hasText:'preexisting-writer'}).getByRole('button',{name:/preexisting-writer/}).first().click();
  await page.getByText('已连接',{exact:true}).waitFor({timeout:12000});
  assert.equal(await page.locator('.terminal-keys').getByRole('button',{name:'Ctrl',exact:true}).isDisabled(),true,'read-only tmux cannot input');
  await page.waitForFunction(before=>window.__terminalLiveFrames.filter(frame=>frame.type==='output').length>before,beforeViewOutput,{timeout:10000});
  assert.equal(await page.evaluate(()=>window.__terminalLiveFrames.some(frame=>frame.type==='ready'&&frame.readOnly===true)),true,'real PTY declares immutable read-only attachment');
  assert.deepEqual(pageErrors,[]);
  console.log('terminal live: verified takeover, real Shell PTY/output/file change, tmux A/B default/switch/reconnect, unknown return with live sessions, release reconciliation and file changes, preexisting writer rejection, real read-only tmux viewing, mobile drawer passed');
} finally {
  await browser?.close();await web?.close();await core?.close();
  try{tmuxCall('kill-server');}catch{/* No isolated server remains. */}
  await rm(dir,{recursive:true,force:true});
}
