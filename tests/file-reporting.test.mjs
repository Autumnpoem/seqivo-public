import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, appendFile, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../server/store.mjs';
import { FileBridge } from '../server/files.mjs';
import { legacyReportingInstructions, reportingInstructions } from '../server/file-reporting.mjs';

async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'file-reporting-')));
  const directory = join(root, 'project'); await mkdir(directory);
  const store = new Store(join(root,'store.sqlite'));
  const project = store.project({name:'Project',directory});
  const bridge = new FileBridge(store);
  t.after(async () => { await bridge.pause(); bridge.close(); store.close(); await rm(root,{recursive:true,force:true}); });
  return {root,directory,store,project,bridge};
}

test('real worker reports accepted, rejected, recovery, restart and rebind', async t => {
  const {root,directory,store,project,bridge} = await setup(t);
  assert.equal(bridge.reporting(project.id).phase,'preparing');
  assert.ok(bridge.reporting(project.id).prompt.includes(directory));
  assert.match(bridge.reporting(project.id).prompt,/\.taskboard\/CONTEXT\.md/);
  assert.match(bridge.reporting(project.id).prompt,/\.taskboard\/tasks\.json/);
  await bridge.tick();
  assert.equal(bridge.reporting(project.id).phase,'waiting');
  assert.match(await readFile(join(directory,'.taskboard','REPORTING.md'),'utf8'),/decision\.request/);
  const inbox=join(directory,'.taskboard','inbox');
  await writeFile(join(inbox,'one.json'),JSON.stringify({eventId:'one',type:'task.create',payload:{title:'Task'}}));
  await bridge.tick();
  const first=bridge.reporting(project.id); assert.equal(first.phase,'connected'); assert.equal(first.lastReport.file,'.taskboard/inbox/one.json');
  assert.equal(first.lastAccepted.eventId, 'one');
  assert.equal(first.lastAccepted.taskId, first.lastReport.taskId);
  assert.equal(first.lastAccepted.receivedAt, first.lastReport.receivedAt);
  const taskId=first.lastReport.taskId;
  await writeFile(join(inbox,'bad.json'),'{'); await bridge.tick();
  assert.equal(bridge.reporting(project.id).phase,'attention');
  assert.equal(bridge.reporting(project.id).lastAccepted.eventId,'one');
  await writeFile(join(inbox,'bad.json'),JSON.stringify({eventId:'fixed',type:'task.update',taskId,expectedRevision:1,payload:{summary:'done'}})); await bridge.tick();
  assert.equal(bridge.reporting(project.id).phase,'connected'); assert.equal(store.getTask(taskId).revision,2);
  await writeFile(join(inbox,'conflict.json'),JSON.stringify({eventId:'conflict',type:'task.update',taskId,expectedRevision:1,payload:{summary:'stale'}})); await bridge.tick();
  assert.equal(bridge.reporting(project.id).phase,'attention'); assert.equal(store.getTask(taskId).summary,'done');
  const other=store.project({name:'Other'}); const foreign=store.createTask({projectId:other.id,title:'Foreign'});
  await writeFile(join(inbox,'foreign.json'),JSON.stringify({eventId:'foreign',type:'task.update',taskId:foreign.id,expectedRevision:1,payload:{summary:'bad'}})); await bridge.tick();
  assert.match(bridge.reporting(project.id).problem,/其他项目/); assert.equal(store.getTask(foreign.id).revision,1);
  await writeFile(join(inbox,'last.json'),JSON.stringify({eventId:'last',type:'task.update',taskId,expectedRevision:2,payload:{summary:'final'}})); await bridge.tick();
  const acceptedAt=bridge.reporting(project.id).lastAccepted.receivedAt;
  await new Promise(resolve=>setTimeout(resolve,30));
  await rm(inbox,{recursive:true});
  const restarted = new FileBridge(store); t.after(async()=>{await restarted.pause(); restarted.close();});
  await restarted.tick(); assert.equal(restarted.reporting(project.id).phase,'connected'); assert.equal(store.getTask(taskId).revision,3);
  assert.equal(restarted.reporting(project.id).lastAccepted.receivedAt,acceptedAt);
  const next=join(root,'next'); await mkdir(next);
  store.db.prepare('UPDATE projects SET directory=?, data=? WHERE id=?').run(next,JSON.stringify({...project,directory:next}),project.id);
  assert.equal(bridge.reporting(project.id).phase,'preparing'); assert.equal(bridge.reporting(project.id).lastReport,null);
  assert.equal(bridge.reporting(project.id).lastAccepted,null);
  await bridge.tick(); assert.equal(bridge.reporting(project.id).phase,'waiting');
});

test('known generated version upgrades, while edited marker and custom text stay intact', async t => {
  const {directory,project,bridge}=await setup(t);
  const path=join(directory,'.taskboard','REPORTING.md');
  await mkdir(join(directory,'.taskboard'));
  await writeFile(path,legacyReportingInstructions);
  await bridge.tick();
  assert.equal(await readFile(path,'utf8'),reportingInstructions);
  assert.equal(bridge.reporting(project.id).instructions.status,'current');
  const edited=reportingInstructions+'\n用户补充规则：保留。\n';
  await writeFile(path,edited); await bridge.tick();
  assert.equal(await readFile(path,'utf8'),edited);
  const report=bridge.reporting(project.id);
  assert.equal(report.instructions.status,'customized');
  assert.equal(report.instructions.currentText,edited);
  assert.equal(report.instructions.recommendedText,reportingInstructions);
  await writeFile(path,'custom'); await bridge.tick();
  assert.equal(await readFile(path,'utf8'),'custom');
});

test('a project-written receipt cannot claim a valid accepted report', async t => {
  const {directory,store,project,bridge}=await setup(t);
  const task=store.createTask({projectId:project.id,title:'Existing task'});
  await bridge.tick();
  const name=Buffer.from('/inbox/forged.json').toString('base64url')+'.json';
  await writeFile(join(directory,'.taskboard','receipts',name),JSON.stringify({status:'accepted',eventId:'forged',taskId:task.id}));
  const restarted=new FileBridge(store);
  t.after(async()=>{await restarted.pause();restarted.close();});
  await restarted.tick();
  assert.equal(restarted.reporting(project.id).lastAccepted,null);
  assert.equal(restarted.reporting(project.id).phase,'waiting');
});

test('custom instructions are preserved and filesystem failure is visible', async t => {
  const {directory,project,bridge}=await setup(t);
  await mkdir(join(directory,'.taskboard')); await writeFile(join(directory,'.taskboard','REPORTING.md'),'custom');
  await bridge.tick(); const result=bridge.reporting(project.id);
  assert.equal(result.phase,'attention'); assert.match(result.problem,/自定义/);
  await writeFile(join(directory,'.taskboard','inbox','update.json'),JSON.stringify({eventId:'custom-create',type:'task.create',payload:{title:'Snapshot updated'}}));
  await bridge.tick();
  assert.match(await readFile(join(directory,'.taskboard','tasks.json'),'utf8'),/Snapshot updated/);
  assert.match(await readFile(join(directory,'.taskboard','CONTEXT.md'),'utf8'),/Snapshot updated/);
  assert.equal(bridge.reporting(project.id).lastReport.status,'accepted');
  assert.equal(await readFile(join(directory,'.taskboard','REPORTING.md'),'utf8'),'custom');
});

test('generated instructions with user additions remain intact while snapshots update', async t => {
  const {directory,project,bridge}=await setup(t);
  await bridge.tick();
  const instructions=join(directory,'.taskboard','REPORTING.md');
  await appendFile(instructions,'\n用户补充规则：保留此内容。\n');
  await writeFile(join(directory,'.taskboard','inbox','update.json'),JSON.stringify({eventId:'edited-report-create',type:'task.create',payload:{title:'Updated snapshot'}}));
  await bridge.tick();
  assert.match(await readFile(instructions,'utf8'),/用户补充规则：保留此内容/);
  assert.equal(bridge.reporting(project.id).phase,'attention');
  assert.match(await readFile(join(directory,'.taskboard','tasks.json'),'utf8'),/Updated snapshot/);
});

test('worker skips vanished temporary entry while importing stable event', async t => {
  const {root,directory,store,project,bridge}=await setup(t);
  await bridge.pause(); bridge.close();
  const inbox=join(directory,'.taskboard','inbox'); await mkdir(inbox,{recursive:true});
  await writeFile(join(inbox,'stable.json'),JSON.stringify({eventId:'stable',type:'task.create',payload:{title:'Stable'}}));
  await writeFile(join(inbox,'renaming.tmp'),'{}');
  const worker=join(root,'worker.mjs');
  const original=new URL('../server/file-bridge-worker.mjs',import.meta.url).href;
  await writeFile(worker, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.promises.lstat; fs.promises.lstat=async function(path,...args) {
      if (String(path).endsWith('renaming.tmp')) { fs.renameSync(path,String(path).replace(/\\.tmp$/,'.json')); }
      return original.call(this,path,...args); }; syncBuiltinESMExports(); await import(${JSON.stringify(original)});`);
  const injected=new FileBridge(store,{workerUrl:pathToFileURL(worker)});
  t.after(async()=>{await injected.pause();injected.close();});
  await injected.tick();
  assert.ok(store.tasks(project.id).some(task=>task.title==='Stable'));
});

test('custom instructions do not repeatedly export unchanged snapshots and recover when removed', async t => {
  const {directory,project,bridge}=await setup(t);
  await mkdir(join(directory,'.taskboard'));
  const instructions=join(directory,'.taskboard','REPORTING.md');
  await writeFile(instructions,'custom');
  await bridge.tick();
  const tasks=join(directory,'.taskboard','tasks.json');
  const before=(await stat(tasks)).mtimeMs;
  await new Promise(resolve=>setTimeout(resolve,30));
  await bridge.tick();
  assert.equal((await stat(tasks)).mtimeMs,before);
  assert.equal(bridge.reporting(project.id).phase,'attention');
  await rm(instructions); await bridge.tick();
  assert.equal(bridge.reporting(project.id).phase,'waiting');
  assert.match(await readFile(instructions,'utf8'),/task\.create/);
});
