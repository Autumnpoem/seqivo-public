import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {chromium,webkit} from '@playwright/test';
import {createCore} from '../../server/core.mjs';
import {createHub} from '../../server/hub/http.mjs';

const root=await mkdtemp(join(tmpdir(),'seqivo-account-conversation-ui-'));
const engine=process.env.TEST_BROWSER==='webkit'?'webkit':'chromium';
const qa=resolve(`design/qa/account-conversations/${engine}`);await mkdir(qa,{recursive:true});
const checks=[],errors=[];let core,hub,browser,page,scenario={};
async function protocolText(){return JSON.stringify((await readFile(join(root,'protocol.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse));}
async function saveScenario(next){scenario={...scenario,...next};await writeFile(join(root,'scenario.json'),JSON.stringify(scenario));}
async function until(fn,label){for(let i=0;i<40;i++){if(await fn())return;await new Promise(r=>setTimeout(r,300));}throw Error(label);}
try{
  process.env.TASKBOARD_FAKE_SCENARIO=join(root,'scenario.json');process.env.TASKBOARD_FAKE_LOG=join(root,'protocol.jsonl');
  process.env.TASKBOARD_FAKE_PID=join(root,'pid');process.env.TASKBOARD_FAKE_CWD=await realpath(root);
  await saveScenario({});
  core=await createCore({dataDir:join(root,'local'),pluginDir:resolve('plugins'),files:false});
  await core.plugin.configure({pythonPath:'/usr/bin/python3',codexPath:resolve('tests/plugin-fake-codex.py')});
  const project=core.store.project({name:'手机开发验收项目',directory:root});
  const excluded=core.store.project({name:'未授权私有项目'});
  core.store.createTask({projectId:excluded.id,title:'不可同步任务'});
  hub=await createHub({dataDir:join(root,'hub'),distDir:resolve('dist')});
  browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844}});
  page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(hub.url);await page.getByRole('button',{name:'注册',exact:true}).click();
  const password=randomBytes(24).toString('base64url');
  await page.getByLabel('用户名',{exact:true}).fill('mobile_tester');await page.getByLabel('密码',{exact:true}).fill(password);
  await page.getByRole('button',{name:'创建账号'}).click();
  await page.getByRole('button',{name:'对话',exact:true}).waitFor();
  const auth=await context.request.get(hub.url+'/api/auth/me');assert.equal(auth.status(),200);
  const cookies=await context.cookies();assert.ok(cookies.some(c=>c.name==='hub_session'&&c.httpOnly&&c.sameSite==='Strict'));
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('taskboard-token')),null);
  checks.push('mobile public signup, HttpOnly cookie and empty own space');
  await core.request('POST','/api/remote/login',{url:hub.url,username:'mobile_tester',password,projectIds:[project.id]});
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'任务清单'}).click();
  await page.getByRole('heading',{name:'手机开发验收项目',exact:true}).waitFor({timeout:12000});
  assert.equal(await page.getByText('未授权私有项目').count(),0);
  const remoteFile=await readFile(join(root,'local','remote-link.json'),'utf8');assert.equal(remoteFile.includes(password),false);
  checks.push('desktop credential login pairs selected project only without persisting password');
  await page.getByRole('button',{name:'对话',exact:true}).click();
  await page.getByLabel('对话标题',{exact:true}).fill('修改按钮样式');
  await page.getByLabel('告诉 Codex 要做什么',{exact:true}).fill('请把按钮改成圆角，并运行相关测试。');
  await page.getByRole('button',{name:'创建并开始',exact:true}).click();
  await until(()=>core.store.tasks(project.id).some(t=>t.status==='running'),'new conversation did not reach local runtime');
  const task=core.store.tasks(project.id)[0];
  assert.equal(task.title,'修改按钮样式');assert.equal(task.conversationId,'new-thread');
  await page.getByLabel('已有对话',{exact:true}).selectOption(task.id,{timeout:15000});
  await saveScenario({turns:[{id:'fake-turn-1',status:'inProgress',items:[{id:'msg1',type:'agentMessage',text:'正在修改按钮样式。'},{id:'cmd1',type:'commandExecution',command:'npm test',aggregatedOutput:'1 test passed',status:'inProgress'},{id:'secret',type:'reasoning',text:'PRIVATE_REASONING_MUST_NOT_SYNC'}]}]});
  await page.getByText('正在修改按钮样式。',{exact:true}).waitFor({timeout:15000});
  assert.equal(await page.getByText('PRIVATE_REASONING_MUST_NOT_SYNC').count(),0);
  assert.ok((await protocolText()).includes('请把按钮改成圆角'));
  checks.push('phone new conversation -> actual Core -> fake provider session/turn -> scoped output returns');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:join(qa,'conversation-light.png'),fullPage:true});
  await saveScenario({turns:undefined,notifyInterrupted:true});
  const pause=page.getByRole('button',{name:/暂停/,exact:false}).first();await pause.click();
  await until(()=>core.store.getTask(task.id).status==='paused','phone pause did not reach local runtime');
  await saveScenario({turns:[{id:'fake-turn-1',status:'interrupted',items:[{id:'msg1',type:'agentMessage',text:'正在修改按钮样式。'}]}]});
  await until(async()=>{
    if(core.leases.state().active.some(lease=>lease.taskId===task.id))return false;
    const link=JSON.parse(await readFile(join(root,'local','remote-link.json'),'utf8'));
    const pauseReceipt=Object.entries(link.receipts||{}).find(([,receipt])=>receipt.status==='paused'&&receipt.reported===true);
    if(!pauseReceipt)return false;
    const response=await context.request.get(`${hub.url}/api/commands/${encodeURIComponent(pauseReceipt[0])}`);
    return response.status()===200&&(await response.json()).status==='paused';
  },'pause receipt or execution lease not confirmed');
  await until(async()=>{const r=await context.request.get(hub.url+'/api/state');return(await r.json()).tasks.some(t=>t.id===task.id&&t.status==='paused');},'paused state not synced');
  await page.getByLabel('继续说明需求',{exact:true}).fill('请继续把按钮文字改成保存。');
  await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await until(async()=>{const log=await protocolText();return log.includes('请继续把按钮文字改成保存');},'followup not sent to provider');
  checks.push('phone pause and followup instructions execute through existing guarded provider');
  await page.getByRole('combobox',{name:'外观模式'}).selectOption('dark');
  await page.screenshot({path:join(qa,'conversation-dark.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.reload();await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'任务清单'}).click();await page.getByRole('heading',{name:'手机开发验收项目',exact:true}).waitFor();
  checks.push('phone reload retains cookie login; light/dark no horizontal overflow');
  await page.getByRole('button',{name:'账号',exact:true}).click();await page.getByRole('button',{name:'退出登录',exact:true}).click();
  await page.getByLabel('用户名',{exact:true}).waitFor();
  assert.equal((await context.request.get(hub.url+'/api/state')).status(),401);
  await page.getByLabel('用户名',{exact:true}).fill('mobile_tester');await page.getByLabel('密码',{exact:true}).fill(password);
  await page.getByRole('button',{name:'进入看板'}).click();await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'任务清单'}).click();await page.getByRole('heading',{name:'手机开发验收项目',exact:true}).waitFor();
  checks.push('logout revokes session; password login returns same existing project');
  assert.deepEqual(errors,[]);
  await writeFile(join(qa,'results.json'),JSON.stringify({result:'passed',engine,checks,realAI:false,physicalPhone:false},null,2));
  console.log(JSON.stringify({result:'passed',engine,checks,realAI:false}));
}catch(error){
  const localLink=await readFile(join(root,'local','remote-link.json'),'utf8').then(JSON.parse).catch(()=>null);
  const localReceipts=Object.entries(localLink?.receipts||{}).map(([id,receipt])=>({id,phase:receipt.phase,status:receipt.status,error:receipt.error,reported:receipt.reported}));
  await writeFile(join(qa,'failure.json'),JSON.stringify({error:error.message,checks,remote:core?.remote.state(),localReceipts,leases:core?.leases.state(),tasks:core?.store.tasks().map(t=>({id:t.id,status:t.status,conversationId:t.conversationId})),plugin:await core?.plugin.state(),page:await page?.locator('body').innerText().catch(()=>''),protocol:await readFile(join(root,'protocol.jsonl'),'utf8').catch(()=>null)},null,2));
  await page?.screenshot({path:join(qa,'failure.png'),fullPage:true}).catch(()=>{});throw error;
}finally{
  await browser?.close();await core?.close();await hub?.close();await rm(root,{recursive:true,force:true});
}
