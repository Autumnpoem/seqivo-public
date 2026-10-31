import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';

async function fixture(t, files = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seqivo-onboarding-core-')));
  const directory = join(root, 'project');
  await mkdir(directory);
  const core = await createCore({dataDir:join(root, 'data'), pluginDir:join(root, 'no-plugins'), files});
  t.after(async () => {await core.close(); await rm(root, {recursive:true, force:true});});
  const project = await core.request('POST', '/api/projects', {name:'Existing code', directory});
  const path = `/api/projects/${project.id}/file-reporting`;
  return {core, project, directory, path};
}

async function until(fn) {
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw Error('File reporting state did not arrive');
}

test('owner onboarding receives a real file report without execution plugins or a business API', async t => {
  const {core, project, directory, path} = await fixture(t);
  const waiting = await until(async () => {
    const status = await core.request('GET', path);
    return status.phase === 'waiting' && status;
  });
  assert.equal(waiting.enabled, true);
  assert.equal(waiting.lastReport, null);
  assert.match(waiting.prompt, /REPORTING\.md/);
  assert.equal(core.store.tasks(project.id).length, 0, 'setup must not create fake tasks');
  assert.match(await readFile(join(directory, '.taskboard', 'REPORTING.md'), 'utf8'), /task\.create/);
  for (const role of ['viewer', 'reporter', 'remote-controller']) {
    await assert.rejects(core.request('GET', path, {}, role), {code:'FILE_REPORTING_FORBIDDEN'});
  }
  await writeFile(join(directory, '.taskboard', 'inbox', 'first.json'), JSON.stringify({
    eventId:'onboarding-first', type:'task.create', payload:{title:'Count files', criteria:['Counts match']},
  }));
  const received = await until(async () => {
    const status = await core.request('GET', path);
    return status.phase === 'connected' && status;
  });
  assert.equal(received.lastReport.status, 'accepted');
  assert.equal(received.lastReport.eventId, 'onboarding-first');
  const task = core.store.getTask(received.lastReport.taskId);
  assert.equal(task.projectId, project.id);
  assert.equal(task.acceptance, 'unverified');
  assert.equal(task.conversationId, '');
});

test('disabled file service is explicit and never advertised as ready', async t => {
  const {core, directory, path} = await fixture(t, false);
  const status = await core.request('GET', path);
  assert.equal(status.enabled, false);
  assert.equal(status.phase, 'disabled');
  assert.equal(status.prompt, '');
  assert.equal(status.lastReport, null);
  await assert.rejects(readFile(join(directory, '.taskboard', 'REPORTING.md')), {code:'ENOENT'});
});

test('rule installation requires owner click, preserves rules, and is idempotent', async t => {
  const {core,directory,path}=await fixture(t);
  const state=await until(async()=>{ const value=await core.request('GET',path); return value.phase==='waiting'&&value; });
  const agents=join(directory,'AGENTS.md');
  await assert.rejects(readFile(agents),{code:'ENOENT'});
  assert.equal(state.rule.codex.installed,false);
  assert.match(state.rule.codex.block,/Seqivo reporting rule: begin/);
  for(const role of ['viewer','reporter','remote-controller'])
    await assert.rejects(core.request('POST',path+'/rule',{provider:'codex',expectedDirectory:directory},role),{code:'FILE_REPORTING_FORBIDDEN'});
  await writeFile(agents,'# Existing rules\nKeep this line.\n');
  await core.request('POST',path+'/rule',{provider:'codex',expectedDirectory:directory});
  const once=await readFile(agents,'utf8');
  assert.ok(once.startsWith('# Existing rules\nKeep this line.\n'));
  assert.equal(once.split('<!-- Seqivo reporting rule: begin -->').length,2);
  await core.request('POST',path+'/rule',{provider:'codex',expectedDirectory:directory});
  assert.equal(await readFile(agents,'utf8'),once);
  assert.equal((await core.request('GET',path)).rule.codex.installed,true);
  const edited=once.replace('Do not invent tasks or test results.','Keep my custom wording.');
  await writeFile(agents,edited);
  await assert.rejects(core.request('POST',path+'/rule',{provider:'codex',expectedDirectory:directory}),/内容已修改/);
  assert.equal(await readFile(agents,'utf8'),edited);
  const claude=join(directory,'CLAUDE.md');
  await core.request('POST',path+'/rule',{provider:'claude',expectedDirectory:directory});
  assert.match(await readFile(claude,'utf8'),/Seqivo reporting rule: begin/);
});

test('stale binding and symlinked rule target are rejected without modifying files', async t => {
  const {core,project,directory,path}=await fixture(t);
  const preview=await until(async()=>{const value=await core.request('GET',path); return value.phase==='waiting'&&value;});
  const next=join(await realpath(join(directory,'..')),'next-project'); await mkdir(next);
  core.store.db.prepare('UPDATE projects SET directory=?, data=? WHERE id=?').run(next,JSON.stringify({...project,directory:next}),project.id);
  await assert.rejects(core.request('POST',path+'/rule',{provider:'codex',expectedDirectory:preview.directory}),{code:'FILE_REPORTING_REBOUND'});
  await assert.rejects(readFile(join(next,'AGENTS.md')),{code:'ENOENT'});
  const external=join(directory,'external.txt'); await writeFile(external,'secret target');
  await symlink(external,join(next,'AGENTS.md'));
  await assert.rejects(core.request('POST',path+'/rule',{provider:'codex',expectedDirectory:next}));
  assert.equal(await readFile(external,'utf8'),'secret target');
  assert.equal((await core.request('GET',path)).rule.codex.installed,false);
  await until(async()=>{const value=await core.request('GET',path); return value.phase==='waiting'&&value;});
  await writeFile(join(next,'.taskboard','inbox','after-symlink.json'),JSON.stringify({eventId:'after-symlink',type:'task.create',payload:{title:'Still received'}}));
  const received=await until(async()=>{const value=await core.request('GET',path); return value.lastAccepted?.eventId==='after-symlink'&&value;});
  assert.equal(core.store.getTask(received.lastAccepted.taskId).title,'Still received');
});
