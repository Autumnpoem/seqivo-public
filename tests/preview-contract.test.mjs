import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { HubStore } from '../server/hub/store.mjs';
import { AccountService } from '../server/hub/accounts.mjs';
import { createPreviewRegistry, previewPath } from '../server/preview/registry.mjs';
import { createPreviewNodeLink } from '../server/preview/node-link.mjs';
import { createPreviewHub } from '../server/hub/preview.mjs';

const node = process.execPath;
const vite = join(process.cwd(), 'node_modules/vite/bin/vite.js');
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'pipe', timeout: 30000 });

async function source(t) {
  const root = await mkdtemp(join(tmpdir(), 'preview-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectDir = join(root, 'project'); await mkdir(projectDir);
  await writeFile(join(projectDir, '.gitignore'), 'dist/\n');
  await writeFile(join(projectDir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><button id="go">Click</button><span id="result">waiting</span><img id="asset" src="./image.svg"><script type="module" src="./main.js"></script></body></html>');
  await writeFile(join(projectDir, 'main.js'), "import './style.css';document.querySelector('#go').onclick=async()=>{const m=await import('./counter.js');document.querySelector('#result').textContent=m.value};");
  await writeFile(join(projectDir, 'style.css'), '#go{color:rgb(12,34,56)}');
  await writeFile(join(projectDir, 'counter.js'), "export const value='dynamic module worked';\n");
  run('git', ['init', '-q'], projectDir);
  run('git', ['config', 'user.email', 'preview@example.test'], projectDir);
  run('git', ['config', 'user.name', 'Preview Test'], projectDir);
  run('git', ['add', '.'], projectDir);
  run('git', ['commit', '-qm', 'Initial preview'], projectDir);
  run(node, [vite, 'build', '--base', './'], projectDir);
  await writeFile(join(projectDir, 'dist', 'attack.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script href="./svg-attack.js"></script><rect width="10" height="10"/></svg>');
  await writeFile(join(projectDir, 'dist', 'svg-attack.js'), 'document.documentElement.dataset.attack="ran";fetch("/api/state",{credentials:"include"}).then(()=>document.documentElement.dataset.api="allowed",()=>document.documentElement.dataset.api="blocked")');
  await writeFile(join(projectDir, 'dist', 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
  await writeFile(join(projectDir, 'dist', 'attack.HTML'), '<!doctype html><script src="./attack.js"></script>');
  await writeFile(join(projectDir, 'dist', 'attack.js'), 'document.documentElement.dataset.cookie=(()=>{try{return document.cookie}catch{return "denied"}})();fetch("/api/state",{credentials:"include"}).then(()=>document.documentElement.dataset.api="allowed",()=>document.documentElement.dataset.api="blocked")');
  await writeFile(join(projectDir, 'dist', 'unknown.xhtml'), '<script src="./attack.js"></script>');
  return { root, projectDir, distDir: join(projectDir, 'dist') };
}

async function fixture(t) {
  const dirs = await source(t);
  const registry = createPreviewRegistry({ dataDir: join(dirs.root, 'node-data') });
  const manifest = await registry.register({ projectId: 'p1', taskId: 't1', contentVersion: 1,
    projectDir: dirs.projectDir, distDir: dirs.distDir, environment: 'test', dataMode: 'simulated' });
  const store = new HubStore(join(dirs.root, 'hub'));
  const accounts = new AccountService(store);
  const owner = await accounts.register({ username: 'previewowner', password: 'correct horse long', source: 'test' });
  const other = await accounts.register({ username: 'previewother', password: 'correct horse long', source: 'test' });
  const ownerSubject = store.db.prepare('SELECT s.* FROM subjects s JOIN account_users u ON u.owner_subject_id=s.id WHERE u.id=?').get(owner.user.id);
  const pairing = store.createPairing(ownerSubject, { role: 'node', projectIds: ['p1'] });
  const redeemed = store.redeem(pairing.code);
  store.db.prepare('INSERT INTO project_owners VALUES(?,?,?,?)').run(ownerSubject.tenant_id, 'p1', redeemed.nodeId, redeemed.epoch);
  store.db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?,?,?)').run(redeemed.nodeId, ownerSubject.tenant_id, redeemed.epoch,
    1, 'test', Date.now(), JSON.stringify({ tasks: [{ id: 't1', projectId: 'p1', contentVersion: 1,
      criteria: [{ id: 'criterion1', text: 'Button works' }, { id: 'criterion2', text: 'Login works' }] }] }));
  const created = [];
  const hub = createPreviewHub({ store, accounts, createTask: async input => {
    created.push(input); return { taskId: 'feedback-task' };
  } });
  const server = createServer(async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      let raw = ''; for await (const part of req) raw += part;
      const path = new URL(req.url, 'http://localhost').pathname;
      if (!await hub.handleHttp({ req, res, method: req.method, path, body: raw ? JSON.parse(raw) : {}, send }))
        send(404, { code: 'NOT_FOUND' });
    } catch (error) { if (!res.headersSent) send(error.status || 500, { code: error.code || 'ERROR' }); else res.destroy(error); }
  });
  const hosts = new Set(), origins = new Set();
  hub.attachServer(server, { allowedHosts: hosts, allowedOrigins: origins });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  hosts.add(new URL(origin).host); origins.add(origin);
  const link = createPreviewNodeLink({ registry, credentials: () => ({ url: origin, token: redeemed.token,
    nodeId: redeemed.nodeId, epoch: redeemed.epoch }) });
  await link.refresh(); await link.register(manifest.previewId);
  t.after(async () => { await link.close(); await hub.close(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const call = async (method, path, { who = owner, body, requestOrigin = origin, headers = {} } = {}) => {
    const response = await fetch(origin + path, { method, headers: { Cookie: `hub_session=${who.sessionToken}`,
      ...(requestOrigin ? { Origin: requestOrigin } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, bytes,
      data: response.headers.get('content-type')?.includes('json') ? JSON.parse(bytes.toString()) : null };
  };
  return { ...dirs, registry, manifest, hub, store, accounts, owner, other, origin, call, created, link };
}

test('registry binds Git, task version and immutable Vite bytes; rejects path and symlink escape', async t => {
  const dirs = await source(t), registry = createPreviewRegistry({ dataDir: join(dirs.root, 'data') });
  const first = await registry.register({ projectId: 'p1', taskId: 't1', contentVersion: 3,
    projectDir: dirs.projectDir, distDir: dirs.distDir, environment: 'test', dataMode: 'real' });
  assert.equal(await registry.isRegistered(first.previewId), false);
  assert.equal(first.capability, 'static-interactive');
  await assert.rejects(registry.register({ projectId: 'p1', taskId: 't1', contentVersion: 3,
    projectDir: dirs.projectDir, distDir: dirs.distDir, environment: 'unsafe\nlabel', dataMode: 'real' }), { code: 'PREVIEW_ENVIRONMENT' });
  assert.equal(first.backendApi, 'unsupported');
  assert.match(first.artifactDigest, /^[a-f0-9]{64}$/);
  assert.equal((await registry.read(first.previewId, 'index.html')).bytes.includes('Click'), true);
  assert.throws(() => previewPath('../secret'), { code: 'PREVIEW_PATH' });
  await assert.rejects(registry.read(first.previewId, '../secret'), { code: 'PREVIEW_PATH' });
  await writeFile(join(dirs.projectDir, 'main.js'), 'changed');
  const second = await registry.register({ projectId: 'p1', taskId: 't1', contentVersion: 4,
    projectDir: dirs.projectDir, distDir: dirs.distDir, environment: 'test', dataMode: 'real' });
  assert.notEqual(second.dirtyDigest, first.dirtyDigest);
  assert.equal(second.artifactDigest, first.artifactDigest);
  await symlink('/etc/passwd', join(dirs.distDir, 'escape.txt'));
  await assert.rejects(registry.register({ projectId: 'p1', taskId: 't1', contentVersion: 4,
    projectDir: dirs.projectDir, distDir: dirs.distDir, environment: 'test', dataMode: 'real' }), { code: 'PREVIEW_SYMLINK' });
  await rm(join(dirs.distDir, 'escape.txt'));
  await writeFile(join(dirs.distDir, 'debug.js.map'), '{}');
  await assert.rejects(registry.register({ projectId: 'p1', taskId: 't1', contentVersion: 4,
    projectDir: dirs.projectDir, distDir: dirs.distDir, environment: 'test', dataMode: 'real' }), { code: 'PREVIEW_SOURCEMAP' });
  await rm(join(dirs.distDir, 'debug.js.map'));
  await writeFile(join(dirs.distDir, 'hidden.MAP '), '{}');
  await assert.rejects(registry.register({ projectId: 'p1', taskId: 't1', contentVersion: 4,
    projectDir: dirs.projectDir, distDir: dirs.distDir, environment: 'test', dataMode: 'real' }), { code: 'PREVIEW_SOURCEMAP' });
  await rm(join(dirs.distDir, 'hidden.MAP '));
  await writeFile(join(dirs.distDir, 'inline.js'), 'console.log(1);\n//# sourceMappingURL = data:application/json;base64,e30=');
  await assert.rejects(registry.register({ projectId: 'p1', taskId: 't1', contentVersion: 4,
    projectDir: dirs.projectDir, distDir: dirs.distDir, environment: 'test', dataMode: 'real' }), { code: 'PREVIEW_SOURCEMAP' });
  await rm(join(dirs.distDir, 'inline.js'));
  await writeFile(join(dirs.distDir, 'inline.css'), 'body{}\n/*# SOURCEMAPPINGURL\t= data:application/json;base64,e30= */');
  await assert.rejects(registry.register({ projectId: 'p1', taskId: 't1', contentVersion: 4,
    projectDir: dirs.projectDir, distDir: dirs.distDir, environment: 'test', dataMode: 'real' }), { code: 'PREVIEW_SOURCEMAP' });
  await rm(join(dirs.distDir, 'inline.css'));
  await writeFile(join(dirs.distDir, 'oversized.bin'), Buffer.alloc(4 * 1024 * 1024 + 1));
  await assert.rejects(registry.register({ projectId: 'p1', taskId: 't1', contentVersion: 4,
    projectDir: dirs.projectDir, distDir: dirs.distDir, environment: 'test', dataMode: 'real' }), { code: 'PREVIEW_LIMIT' });
});

test('Hub grants a bounded static preview and confirms feedback exactly once', async t => {
  const x = await fixture(t);
  assert.equal(await x.registry.isRegistered(x.manifest.previewId), true);
  const listing = await x.call('GET', '/api/previews?taskId=t1');
  assert.equal(listing.status, 200); assert.equal(listing.data.previews.length, 1);
  assert.equal(JSON.stringify(listing.data).includes(x.projectDir), false);
  assert.equal((await x.call('GET', '/api/previews?taskId=t1', { who: x.other })).data.previews.length, 0);
  const detail = await x.call('GET', `/api/previews/${x.manifest.previewId}`);
  assert.equal(detail.status, 200);
  const entry = await x.call('GET', detail.data.launchUrl);
  assert.equal(entry.status, 200);
  assert.match(entry.headers.get('content-security-policy'), /sandbox allow-scripts allow-forms/);
  assert.doesNotMatch(entry.headers.get('content-security-policy'), /allow-same-origin/);
  assert.equal((await x.call('GET', detail.data.launchUrl, { who: x.other })).status, 403);
  const denied = await x.call('GET', detail.data.launchUrl.replace('index.html', '../secret'));
  assert.notEqual(denied.status, 200);
  const feedbackBody = { pagePath: '/login', summary: 'Button fails', criterionIds: ['criterion1'], idempotencyKey: 'report1' };
  const draft = await x.call('POST', `/api/previews/${x.manifest.previewId}/feedback`, { body: feedbackBody });
  assert.equal(draft.data.feedback.status, 'draft'); assert.equal(x.created.length, 0);
  const repeat = await x.call('POST', `/api/previews/${x.manifest.previewId}/feedback`, { body: feedbackBody });
  assert.equal(repeat.data.feedback.id, draft.data.feedback.id);
  assert.equal((await x.call('POST', `/api/previews/${x.manifest.previewId}/feedback`,
    { body: { ...feedbackBody, summary: 'Different' } })).status, 409);
  const confirmPath = `/api/previews/${x.manifest.previewId}/feedback/${draft.data.feedback.id}/confirm`;
  assert.equal((await x.call('POST', confirmPath)).data.feedback.taskId, 'feedback-task');
  assert.equal((await x.call('POST', confirmPath)).data.feedback.taskId, 'feedback-task');
  assert.equal(x.created.length, 1);
  assert.equal(x.created[0].sourcePreview.artifactDigest, x.manifest.artifactDigest);
  assert.equal(x.created[0].pagePath, '/login');
  assert.equal((await x.call('POST', confirmPath, { requestOrigin: 'https://evil.example' })).status, 403);
  await writeFile(join(x.projectDir, 'counter.js'), "export const value='new build';\n");
  run(node, [vite, 'build', '--base', './'], x.projectDir);
  const snapshot = x.store.db.prepare('SELECT data_json FROM snapshots WHERE node_id=?').get(
    x.store.db.prepare('SELECT node_id FROM preview_builds WHERE preview_id=?').get(x.manifest.previewId).node_id);
  const data = JSON.parse(snapshot.data_json); data.tasks[0].contentVersion = 2;
  x.store.db.prepare('UPDATE snapshots SET data_json=?,sequence=sequence+1,received_at=?').run(JSON.stringify(data), Date.now());
  const newer = await x.registry.register({ projectId: 'p1', taskId: 't1', contentVersion: 2,
    projectDir: x.projectDir, distDir: x.distDir, environment: 'test', dataMode: 'simulated' });
  await x.link.register(newer.previewId);
  const impact = await x.call('GET', `/api/previews/${newer.previewId}/retest?previous=${x.manifest.previewId}`);
  assert.equal(impact.status, 200);
  assert.equal(impact.data.sourceState, 'unknown');
  assert.equal(impact.data.reasonCode, 'node_unsupported');
  assert.deepEqual(impact.data.items.map(item => [item.criterionId, item.status]),
    [['criterion1', 'unknown'], ['criterion2', 'unknown']]);
  x.accounts.logout(x.owner.sessionToken);
  assert.equal((await x.call('GET', detail.data.launchUrl)).status, 403);
});

test('opaque-origin page loads and executes dynamic Vite JavaScript', async t => {
  const x = await fixture(t);
  const detail = await x.call('GET', `/api/previews/${x.manifest.previewId}`);
  let browser;
  try { browser = await chromium.launch({ headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }); }
  catch (error) { t.skip(`Chrome unavailable: ${error.message}`); return; }
  try {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'hub_session', value: x.owner.sessionToken, url: x.origin, httpOnly: true, sameSite: 'Strict' }]);
    const page = await context.newPage();
    await page.goto(x.origin + detail.data.launchUrl);
    await page.locator('#go').click();
    await assert.doesNotReject(page.locator('#result').getByText('dynamic module worked').waitFor({ timeout: 5000 }));
    assert.equal(await page.locator('#asset').evaluate(image => image.complete && image.naturalWidth > 0), true);
    assert.equal(await page.locator('#go').evaluate(button => getComputedStyle(button).color), 'rgb(12, 34, 56)');
    assert.equal(await page.evaluate(() => window.origin), 'null');
    assert.equal(await page.evaluate(() => { try { return document.cookie; } catch { return 'denied'; } }), 'denied');
    assert.equal(await page.evaluate(async () => {
      try { await fetch('/api/auth/me', { credentials: 'include' }); return 'allowed'; }
      catch { return 'blocked'; }
    }), 'blocked');
    const assetUrl = file => x.origin + detail.data.launchUrl.replace(/index\.html$/, file);
    const unknown = await x.call('GET', detail.data.launchUrl.replace(/index\.html$/, 'unknown.xhtml'));
    assert.equal(unknown.headers.get('content-disposition'), 'attachment');
    assert.match(unknown.headers.get('content-security-policy'), /^sandbox;/);
    await page.goto(assetUrl('attack.svg'));
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.origin), 'null');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.attack), undefined);
    await page.goto(assetUrl('attack.HTML'));
    await page.waitForFunction(() => document.documentElement.dataset.api === 'blocked');
    assert.equal(await page.evaluate(() => window.origin), 'null');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.cookie), 'denied');
  } finally { await browser.close(); }
});
