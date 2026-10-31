import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createCore } from '../../server/core.mjs';
import { createHub } from '../../server/hub/http.mjs';

async function openMobilePage(page,name){await page.getByRole('button',{name:/^更多页面/}).click();await page.getByRole('menuitem',{name,exact:true}).click();}

const root = await mkdtemp(join(tmpdir(), 'seqivo-receipt-loss-'));
const qa = resolve(process.env.QA_DIR || 'design/qa/v0.4/receipt-loss');
await mkdir(qa, { recursive: true });
let core, hub, browser, page;
let holdFirstReceiptPending=true;const heldReceiptIds=new Set();const receiptOverrides=new Map();const commandMetadata=new Map();let holdNextState401=false;let releaseStaleState;let holdNextConversationState=false;let releaseConversationState;
const evidence = { scenario: 'Hub accepts POST /api/commands; Playwright drops browser response', realAI: false, realAccount: false, physicalPhone: false,
  firstCommandId: null, secondCommandId: null, posts: [], browserReceiptGets: [], sessionStorageAfterLoss: null, firstReceiptByHarness: null,
  secondAccepted: false, browserCommandRequests: [], browserReceiptResponses: [], pendingAfterReload: null, continueCommandId: null, pauseCommandId: null, pauseReceiptGets: 0, conversationPosts: [], newCommandId: null, messageCommandId: null, status: 'running' };
const until = async (predicate, label) => { for (let i = 0; i < 300; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 100)); } throw Error(label); };

try {
  evidence.startedAt = new Date().toISOString();
  evidence.scenarios = ['update response loss + reload', 'same-tick duplicate update', 'stale refresh 401 after logout/login', 'stale send GET after navigation', 'pending continue blocks message while allowing pause', 'pause 5xx receipt survives reload', 'new conversation response loss + reload', 'message response loss + reload', 'legacy token SHA-256 scope is stable across reload and isolated across tokens'];
  evidence.scriptSha256 = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
  await cp(resolve('dist'), join(root, 'dist'), { recursive: true });
  const bundle = (await readdir(join(root, 'dist', 'assets'))).find(name => /^index-.*\.js$/.test(name));
  assert.ok(bundle, 'built browser bundle missing');
  evidence.bundle = bundle;
  evidence.bundleSha256 = createHash('sha256').update(await readFile(join(root, 'dist', 'assets', bundle))).digest('hex');

  // Bind the temporary Core to the protocol-only fixture; no system Codex/provider is called.
  process.env.TASKBOARD_FAKE_SCENARIO = join(root, 'fake-scenario.json');
  process.env.TASKBOARD_FAKE_LOG = join(root, 'fake-provider.jsonl');
  process.env.TASKBOARD_FAKE_PID = join(root, 'fake-provider.pid');
  process.env.TASKBOARD_FAKE_CWD = root;
  await writeFile(process.env.TASKBOARD_FAKE_SCENARIO, JSON.stringify({}));
  core = await createCore({ dataDir: join(root, 'node'), pluginDir: resolve('plugins'), files: false });
  await core.plugin.configure({ pythonPath: '/usr/bin/python3', codexPath: resolve('tests/plugin-fake-codex.py') });
  const project = core.store.project({ name: '回执丢失复现项目', directory: root });
  const task = core.store.createTask({ projectId: project.id, title: '仅修改进度文字', goal: '验证远程命令回执丢失后的浏览器行为', summary: '等待修改', criteria: ['确认远程命令回执'] });
  hub = await createHub({ dataDir: join(root, 'hub'), distDir: join(root, 'dist') });
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  page = await context.newPage();
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/commands') evidence.browserCommandRequests.push({ method: request.method(), url: request.url(), ...(request.method()==='POST'?{body:request.postDataJSON()}: {}) }); });
  await page.goto(hub.url);
  await page.getByRole('button', { name: '注册', exact: true }).click();
  const password = randomBytes(24).toString('base64url');
  await page.getByLabel('用户名', { exact: true }).fill('receipt_tester');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '创建账号' }).click();
  await page.getByRole('button', { name: '对话', exact: true }).waitFor();
  await core.request('POST', '/api/remote/login', { url: hub.url, username: 'receipt_tester', password, projectIds: [project.id] });
  await page.getByRole('navigation', { name: '移动导航' }).getByRole('button', { name: '任务清单' }).click();
  await page.getByRole('heading', { name: project.name, exact: true }).waitFor();

  await page.route('**/api/state', async route => {
    if(holdNextConversationState){holdNextConversationState=false;await new Promise(resolve=>{releaseConversationState=resolve;});}
    if(holdNextState401){holdNextState401=false;await new Promise(resolve=>{releaseStaleState=resolve;});return route.fulfill({status:401,json:{error:'stale pre-logout response'}});}
    const response=await route.fetch();const state=await response.json();state.tasks=state.tasks.map(item=>item.id===task.id?{...item,hasExecutionBinding:true}:item);return route.fulfill({status:response.status(),headers:{...response.headers(),'content-type':'application/json'},body:JSON.stringify(state)});
  });
  await page.route('**/api/commands/**', async route => {
    if (route.request().method() === 'GET') {
      const path=new URL(route.request().url()).pathname;evidence.browserReceiptGets.push(path);
      const commandId=decodeURIComponent(path.split('/').pop());
      if((holdFirstReceiptPending&&commandId===evidence.firstCommandId)||heldReceiptIds.has(commandId))return route.fulfill({json:{commandId,action:commandId===evidence.newCommandId?'new':commandId===evidence.messageCommandId?'message':'update',status:'queued',...commandMetadata.get(commandId)}});
      if(receiptOverrides.has(commandId))return route.fulfill({json:{...receiptOverrides.get(commandId),...commandMetadata.get(commandId)}});
      const response=await route.fetch();const body=await response.json();evidence.browserReceiptResponses.push({path,status:body.status,result:body.result,error:body.error});
      return route.fulfill({status:response.status(),headers:{...response.headers(),'content-type':'application/json'},body:JSON.stringify(body)});
    }
    await route.continue();
  });
  await page.route('**/api/commands', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const request = route.request().postDataJSON();
    commandMetadata.set(request.commandId,{action:request.action,projectId:request.projectId,taskId:request.taskId});
    if(request.action==='continue'){evidence.continueCommandId=request.commandId;evidence.posts.push({commandId:request.commandId,action:'continue',httpStatus:200,receiptStatus:'queued',synthetic:true});return route.fulfill({json:{commandId:request.commandId,action:'continue',taskId:request.taskId,status:'queued'}});}
    if(request.action==='pause'){evidence.pauseCommandId=request.commandId;evidence.posts.push({commandId:request.commandId,action:'pause',httpStatus:500,receiptStatus:'unknown',synthetic:true});return route.fulfill({status:500,json:{error:'temporary pause response failure'}});}
    const response = await route.fetch(); // Real temporary Hub accepts the command.
    const receipt = await response.json();
    evidence.posts.push({ commandId: request.commandId, action: request.action, httpStatus: response.status(), receiptStatus: receipt.status });
    if (request.action==='update'&&evidence.firstCommandId===null) {
      evidence.firstCommandId = request.commandId;
      await route.abort('failed'); // Only the browser response is lost.
    } else if(request.action==='message') {
      evidence.messageCommandId=request.commandId;heldReceiptIds.add(request.commandId);await route.abort('failed');
    } else {
      evidence.secondCommandId = request.commandId;
      await route.fulfill({ response });
    }
  });
  await page.route('**/api/conversations',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    const body=route.request().postDataJSON();commandMetadata.set(body.commandId,{action:'create_conversation',projectId:body.projectId,taskId:body.commandId});const response=await route.fetch();const receipt=await response.json();
    evidence.conversationPosts.push({commandId:body.commandId,projectId:body.projectId,httpStatus:response.status(),receiptStatus:receipt.status});
    evidence.newCommandId=body.commandId;heldReceiptIds.add(body.commandId);await route.abort('failed');
  });

  await page.getByRole('button', { name: /仅修改进度文字/ }).click();
  await page.getByRole('button', { name: '编辑任务' }).click();
  await page.getByLabel('当前进展', { exact: true }).fill('同一目标进度');
  await page.locator('[role=dialog] form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
  await until(() => evidence.posts.length >= 1, 'first Hub command not accepted');
  await page.waitForTimeout(150);
  assert.equal(evidence.posts.length,1,'same-tick duplicate form submissions must create exactly one command');
  evidence.sessionStorageAfterLoss = await page.evaluate(() => JSON.parse(sessionStorage.getItem('tuijin-pending-commands') || '[]'));
  assert.equal(evidence.posts[0].httpStatus, 200);
  assert.ok(evidence.sessionStorageAfterLoss.some(item => item.id === evidence.firstCommandId && item.taskId === task.id && item.action === 'update'), 'first command ID and scope must be persisted before/through response loss');
  await until(() => evidence.browserReceiptGets.some(path => path.endsWith(`/${evidence.firstCommandId}`)), 'browser did not query the original receipt ID');
  evidence.browserQueriedFirstReceiptBeforeRetry = true;
  assert.equal(evidence.browserQueriedFirstReceiptBeforeRetry, true);
  await page.locator('[role=dialog] form').evaluate(form => form.requestSubmit());
  assert.equal(evidence.posts.length,1,'submit handler must reject a same-task retry while receipt is unresolved');

  await until(async () => { await core.remote.sync(); return core.store.getTask(task.id).summary === '同一目标进度'; }, 'first accepted command did not reach temporary Core');
  const firstReceipt = await context.request.get(`${hub.url}/api/commands/${evidence.firstCommandId}`);
  evidence.firstReceiptByHarness = { httpStatus: firstReceipt.status(), status: (await firstReceipt.json()).status };

  // Reload must keep the task locked while the same receipt ID remains unresolved.
  await page.reload();
  await page.getByRole('navigation', { name: '移动导航' }).getByRole('button', { name: '任务清单' }).click();
  await page.getByRole('button', { name: /仅修改进度文字/ }).click();
  const editButton=page.getByRole('button', { name: '编辑任务' });
  assert.equal(await editButton.isDisabled(), true, 'same-task edit must stay blocked while the original receipt is unresolved');
  await page.waitForTimeout(3500);
  evidence.pendingAfterReload=await page.evaluate(() => JSON.parse(sessionStorage.getItem('tuijin-pending-commands') || '[]'));
  evidence.browserQueriedFirstReceiptAfterRetry=evidence.browserReceiptGets.some(path => path.endsWith(`/${evidence.firstCommandId}`));
  assert.equal(evidence.posts.length,1,'reload and form requestSubmit must not issue a second command');
  assert.ok(evidence.pendingAfterReload.some(item=>item.id===evidence.firstCommandId),'original command ID must survive reload');
  assert.equal(evidence.browserQueriedFirstReceiptAfterRetry,true,'browser must query the same receipt ID after reload');

  // Keep a refresh in flight across logout/login and deliver a stale 401 only after the fresh login state loads.
  holdNextState401=true;
  await page.getByRole('button',{name:'刷新'}).click();
  await until(()=>Boolean(releaseStaleState),'pre-logout state refresh did not start');
  await openMobilePage(page,'账号');
  await page.getByRole('button',{name:'退出登录'}).click();
  await page.getByLabel('用户名',{exact:true}).fill('receipt_tester');
  await page.getByLabel('密码',{exact:true}).fill(password);
  await page.getByRole('button',{name:'进入看板'}).click();
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'任务清单'}).click();
  await page.getByRole('button',{name:/仅修改进度文字/}).waitFor();
  const journalAfterLogout=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]'));
  assert.ok(journalAfterLogout.some(item=>item.id===evidence.firstCommandId&&item.accountId),'scoped pending command ID must survive logout');
  releaseStaleState();
  await page.waitForTimeout(250);
  assert.equal(await page.getByLabel('用户名',{exact:true}).count(),0,'stale pre-logout 401 must not log out the fresh session');
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'任务清单'}).click();
  await page.getByRole('button',{name:/仅修改进度文字/}).click();
  assert.equal(await page.getByRole('button',{name:'编辑任务'}).isDisabled(),true,'same-account login must continue to block the unresolved task intent');
  await until(()=>evidence.browserReceiptGets.filter(path=>path.endsWith(`/${evidence.firstCommandId}`)).length>4,'same-account login did not resume GET-only receipt checks');
  holdFirstReceiptPending=false;
  await until(async()=>{const pending=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]'));return !pending.some(item=>item.id===evidence.firstCommandId);},'verified final receipt did not release task intent');
  assert.equal(await editButton.isDisabled(),false,'verified receipt should release same-task edit block');
  await editButton.click();
  const saveButton=page.getByRole('button', { name: '保存', exact: true });
  assert.equal(await saveButton.isDisabled(),false,'verified receipt should enable editing');
  assert.equal(evidence.posts.length,1,'receipt polling must never replay the POST');
  await page.getByRole('button',{name:'取消',exact:true}).click();

  // A conversation send waiting on its fresh state must not POST after navigating away and starting Continue.
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'对话',exact:true}).click();
  await page.getByLabel('已有对话').selectOption(task.id);
  await page.getByLabel('继续说明需求').fill('导航期间不得发送');
  holdNextConversationState=true;
  await page.getByRole('button',{name:'发送消息'}).click();
  await until(()=>Boolean(releaseConversationState),'conversation fresh state GET did not pause');
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'任务清单'}).click();
  await page.getByRole('button',{name:/仅修改进度文字/}).click();
  await page.getByRole('button',{name:'继续任务'}).click();
  await until(async()=>{const list=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]'));return list.some(item=>item.action==='continue'&&item.taskId===task.id);},'continue intent was not persisted');
  releaseConversationState();
  await page.waitForTimeout(250);
  assert.equal(evidence.browserCommandRequests.filter(item=>item.method==='POST'&&item.body?.action==='message').length,0,'unmounted stale send must not POST after a same-task Continue');

  // A pending Continue must follow its task into Conversations: block another message but keep safety Pause available.
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'对话',exact:true}).click();
  await page.getByLabel('已有对话').selectOption(task.id);
  await until(async()=>{const list=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]'));return list.some(item=>item.action==='continue'&&item.taskId===task.id);},'continue intent was not persisted');
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'对话',exact:true}).click();
  await page.getByLabel('已有对话').selectOption(task.id);
  const sendButton=page.getByRole('button',{name:'发送消息'});
  assert.equal(await sendButton.isDisabled(),true,'pending Continue must block a new message for the same task');
  const postCountBeforeBlockedMessage=evidence.posts.length;
  await page.locator('.conversation-compose form').evaluate(form=>form.requestSubmit());
  assert.equal(evidence.posts.length,postCountBeforeBlockedMessage,'blocked same-task message must not issue a command');
  const pauseButton=page.getByRole('button',{name:'暂停执行'});
  assert.equal(await pauseButton.isDisabled(),false,'safety Pause must remain available while Continue receipt is unresolved');
  await pauseButton.evaluate(button=>{button.dispatchEvent(new MouseEvent('click',{bubbles:true}));button.dispatchEvent(new MouseEvent('click',{bubbles:true}));});
  await until(()=>Boolean(evidence.pauseCommandId),'synthetic Pause 5xx was not reached');
  await until(()=>evidence.browserReceiptGets.some(path=>path.endsWith(`/${evidence.pauseCommandId}`)),'Pause 5xx must retain and query its original receipt ID');
  evidence.pauseReceiptGets=evidence.browserReceiptGets.filter(path=>path.endsWith(`/${evidence.pauseCommandId}`)).length;
  assert.equal(await pauseButton.isDisabled(),true,'uncertain Pause must prevent duplicate Pause commands');
  const pauseCount=evidence.posts.filter(item=>item.action==='pause').length;
  assert.equal(pauseCount,1,'Pause 5xx must not be automatically replayed');
  const pauseJournal=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]'));
  assert.ok(pauseJournal.some(item=>item.id===evidence.pauseCommandId&&item.action==='pause'&&item.accountId),'Pause 5xx command ID must be synchronously persisted with account scope');
  await page.reload();
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'对话',exact:true}).click();
  await page.getByLabel('已有对话').selectOption(task.id);
  const pauseButtonAfterReload=page.getByRole('button',{name:'暂停执行'});
  assert.equal(await pauseButtonAfterReload.isDisabled(),true,'pending Pause must remain locked after reload');
  await until(()=>evidence.browserReceiptGets.filter(path=>path.endsWith(`/${evidence.pauseCommandId}`)).length>evidence.pauseReceiptGets,'reloaded page must query the same pending Pause ID');
  evidence.pauseReceiptGets=evidence.browserReceiptGets.filter(path=>path.endsWith(`/${evidence.pauseCommandId}`)).length;
  assert.equal(evidence.posts.filter(item=>item.action==='pause').length,1,'reload must not replay a Pause 5xx');

  // Resolve the earlier synthetic safety intents so the next tests are isolated.
  for(const id of [evidence.continueCommandId,evidence.pauseCommandId]){receiptOverrides.set(id,{commandId:id,status:'failed',error:'synthetic terminal fixture'});heldReceiptIds.delete(id);}
  await until(async()=>{const ids=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]').map(item=>item.id));return !ids.includes(evidence.continueCommandId)&&!ids.includes(evidence.pauseCommandId);},'synthetic safety intents did not resolve');

  // New conversation: Hub accepts the real POST, browser loses only its response, reload queries the same ID.
  await page.reload();
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'对话',exact:true}).click();
  await page.getByLabel('已有对话').selectOption('');
  await page.getByLabel('对话标题',{exact:true}).fill('响应丢失的新对话');
  await page.getByLabel('告诉 Codex 要做什么',{exact:true}).fill('只创建临时Hub命令，不连接AI。');
  await page.getByRole('button',{name:'创建并开始'}).click();
  await until(()=>evidence.conversationPosts.length===1,'temporary Hub did not accept new conversation POST');
  assert.equal(evidence.conversationPosts[0].httpStatus,200,'Hub accepted new conversation request');
  assert.ok((await page.evaluate(()=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]'))).some(item=>item.id===evidence.newCommandId&&item.action==='new'&&item.projectId===project.id&&!item.taskId),'new conversation intent must persist synchronously before/through lost response');
  await page.reload();
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'对话',exact:true}).click();
  await page.getByLabel('已有对话').selectOption('');
  await page.getByLabel('对话标题',{exact:true}).fill('重复创建检查');
  await page.getByLabel('告诉 Codex 要做什么',{exact:true}).fill('重复提交必须被拦截。');
  assert.equal(await page.getByRole('button',{name:'创建并开始'}).isDisabled(),true,'reload must keep unresolved new-conversation create disabled');
  await page.locator('.conversation-compose form').evaluate(form=>form.requestSubmit());
  await until(()=>evidence.browserReceiptGets.some(path=>path.endsWith(`/${evidence.newCommandId}`)),'reloaded page did not GET the same new-conversation receipt ID');
  assert.equal(evidence.conversationPosts.length,1,'reload must not replay new-conversation POST');
  receiptOverrides.set(evidence.newCommandId,{commandId:evidence.newCommandId,action:'new',status:'failed',error:'synthetic terminal fixture'});heldReceiptIds.delete(evidence.newCommandId);
  await until(async()=>!(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]'))).some(item=>item.id===evidence.newCommandId),'final new-conversation receipt did not unlock project create');
  assert.equal(await page.getByRole('button',{name:'创建并开始'}).isDisabled(),false,'final new-conversation receipt should unlock project create');

  // Message: Hub accepts /api/commands, response is dropped, and reload only queries that command ID.
  await page.getByLabel('已有对话').selectOption(task.id);
  await page.getByLabel('继续说明需求').fill('响应丢失的会话消息');
  await page.getByRole('button',{name:'发送消息'}).click();
  await until(()=>Boolean(evidence.messageCommandId),'temporary Hub did not accept conversation message command');
  assert.ok((await page.evaluate(()=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]'))).some(item=>item.id===evidence.messageCommandId&&item.action==='message'&&item.taskId===task.id&&item.projectId===project.id),'message intent must persist synchronously before/through lost response');
  await page.reload();
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'对话',exact:true}).click();
  await page.getByLabel('已有对话').selectOption(task.id);
  await page.getByLabel('继续说明需求').fill('不要重复发消息');
  const sendAfterReload=page.getByRole('button',{name:'发送消息'});
  assert.equal(await sendAfterReload.isDisabled(),true,'reload must keep unresolved same-task message disabled');
  await page.locator('.conversation-compose form').evaluate(form=>form.requestSubmit());
  await until(()=>evidence.browserReceiptGets.some(path=>path.endsWith(`/${evidence.messageCommandId}`)),'reloaded page did not GET the same message receipt ID');
  assert.equal(evidence.browserCommandRequests.filter(item=>item.method==='POST'&&item.body?.action==='message').length,1,'reload must not replay the accepted message command');
  receiptOverrides.set(evidence.messageCommandId,{commandId:evidence.messageCommandId,action:'message',status:'failed',error:'synthetic terminal fixture'});heldReceiptIds.delete(evidence.messageCommandId);
  await until(async()=>!(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]'))).some(item=>item.id===evidence.messageCommandId),'final message receipt did not unlock same-task message');
  assert.equal(await sendAfterReload.isDisabled(),false,'final message receipt should unlock same-task messaging');

  // Legacy bearer identities use a stable non-secret fingerprint; a different token must not see or inherit the first token's intent.
  const legacyStateResponse=await context.request.get(`${hub.url}/api/state`);assert.equal(legacyStateResponse.status(),200);
  const legacyState=await legacyStateResponse.json();
  const legacyTokenA='synthetic-legacy-token-alpha-0123456789';const legacyTokenB='synthetic-legacy-token-beta-0123456789';
  const legacyIntentId='legacy-scope-intent-a';const legacyTaskId=task.id;
  const fingerprintFor=token=>page.evaluate(async value=>{const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return `legacy-token:${Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')}`;},token);
  const scopeA=await fingerprintFor(legacyTokenA);const scopeB=await fingerprintFor(legacyTokenB);
  assert.notEqual(scopeA,scopeB,'different legacy bearer tokens must derive distinct scopes');
  evidence.legacyTokenScopes={fingerprintA:scopeA,fingerprintB:scopeB};
  await page.route('**/api/auth/me',async route=>route.request().headers().authorization?.startsWith('Bearer synthetic-legacy-token-')?route.fulfill({json:{user:null}}):route.continue());
  await page.route('**/api/state',async route=>route.request().headers().authorization?.startsWith('Bearer synthetic-legacy-token-')?route.fulfill({json:legacyState}):route.continue());
  let scopedReceiptGets=0;
  await page.route(`**/api/commands/${legacyIntentId}`,async route=>{if(route.request().method()==='GET'){scopedReceiptGets++;return route.fulfill({json:{commandId:legacyIntentId,action:'new',status:'unknown'}});}return route.continue();});
  let directUnknownId='';
  await page.route('**/api/conversations',async route=>{
    if(route.request().method()==='POST'&&route.request().headers().authorization==='Bearer '+legacyTokenB){
      directUnknownId=route.request().postDataJSON().commandId;
      await page.route(`**/api/commands/${directUnknownId}`,async receiptRoute=>receiptRoute.request().method()==='GET'?receiptRoute.fulfill({json:{commandId:directUnknownId,action:'new',status:'unknown',error:'synthetic unknown receipt'}}):receiptRoute.continue());
      return route.fulfill({json:{commandId:directUnknownId,action:'new',status:'unknown',error:'synthetic unknown receipt'}});
    }
    return route.continue();
  });
  await page.evaluate(({token,intent,scope,projectId,taskId})=>{
    sessionStorage.setItem('taskboard-token',token);
    const journal=JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]').filter(item=>item.id!==intent.id);
    journal.push({id:intent.id,action:'new',projectId,taskId,accountId:scope,status:'unknown'});
    sessionStorage.setItem('tuijin-pending-commands',JSON.stringify(journal));
  },{token:legacyTokenA,intent:{id:legacyIntentId},scope:scopeA,projectId:project.id,taskId:legacyTaskId});
  await page.reload();
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'对话',exact:true}).click();
  await page.getByLabel('已有对话').selectOption('');
  const createForLegacyA=page.getByRole('button',{name:'创建并开始'});
  await until(async()=>await createForLegacyA.isDisabled(),'same token reload did not recover its pending new-conversation intent');
  await until(()=>scopedReceiptGets>0,'same token did not query its original command ID');
  const getsAfterA=scopedReceiptGets;
  const journalForA=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]'));
  assert.ok(journalForA.some(item=>item.id===legacyIntentId&&item.accountId===scopeA),'same-token reload must retain the scoped intent');
  assert.equal(JSON.stringify(journalForA).includes(legacyTokenA),false,'journal must never store the raw legacy token');
  await page.evaluate(token=>sessionStorage.setItem('taskboard-token',token),legacyTokenB);
  await page.reload();
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'对话',exact:true}).click();
  await page.getByLabel('已有对话').selectOption('');
  const createForLegacyB=page.getByRole('button',{name:'创建并开始'});
  await until(async()=>!(await createForLegacyB.isDisabled()),'a different token was incorrectly blocked by the first token\'s pending intent');
  await page.waitForTimeout(1800);
  assert.equal(scopedReceiptGets,getsAfterA,'a different token must not query the first token\'s receipt');
  const journalForB=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]'));
  assert.ok(journalForB.some(item=>item.id===legacyIntentId&&item.accountId===scopeA),'switching identity must retain the other token\'s intent without presenting it as current');
  evidence.legacyTokenIsolation={sameTokenRecovered:true,differentTokenUnblocked:true,receiptGetsForA:getsAfterA,receiptGetsAfterB:scopedReceiptGets,rawTokenPersisted:false};
  await page.getByLabel('对话标题',{exact:true}).fill('未知回执提示检查');
  await page.getByLabel('告诉 Codex 要做什么',{exact:true}).fill('确认手机端不能假装解除未知操作。');
  await createForLegacyB.click();
  await until(()=>Boolean(directUnknownId),'synthetic unknown new-conversation response was not returned');
  await page.getByText('结果仍待电脑确认。手机端不能解除这条操作的锁定', {exact:false}).waitFor();
  assert.equal(await page.getByRole('button',{name:'我已核对结果'}).count(),0,'Hub unknown receipt must not offer a local-only false unlock');
  evidence.hubUnknownUi={shown:true,manualUnlockButton:false};
  evidence.status='fixed';
  console.log(JSON.stringify({status:evidence.status,firstCommandId:evidence.firstCommandId,posts:evidence.posts.length,pendingFirst:evidence.pendingAfterReload.some(item=>item.id===evidence.firstCommandId),browserQueriedFirst:evidence.browserQueriedFirstReceiptAfterRetry,verifiedReceipts:evidence.browserReceiptResponses,firstReceiptByHarness:evidence.firstReceiptByHarness}));
} catch (error) {
  evidence.status = 'failed'; evidence.error = error.message;
  evidence.pageText = await page?.locator('body').innerText().catch(() => null);
  evidence.pageUrl = page?.url();
  evidence.taskAtFailure = core?.store.tasks().map(item => ({ id: item.id, summary: item.summary, revision: item.revision }));
  throw error;
} finally {
  await writeFile(join(qa, 'result.json'), JSON.stringify(evidence, null, 2));
  await browser?.close(); await core?.close(); await hub?.close(); await rm(root, { recursive: true, force: true });
}
