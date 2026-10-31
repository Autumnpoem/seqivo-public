import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, readdir, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSshStore } from '../server/ssh/store.mjs';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/hub-backup.mjs', import.meta.url));

test('Hub backup preserves a live SQLite snapshot and owner token for isolated restore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'taskboard-hub-backup-'));
  const source = join(root, 'source');
  const output = join(root, 'backup');
  const restored = join(root, 'restored');
  const ownerToken = 'tenant-1-owner-owner-2.token';
  const secret = 'owner-token-fixture';
  let db;
  try {
    await mkdir(source);
    db = new DatabaseSync(join(source, 'hub.sqlite'));
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE proof (id INTEGER PRIMARY KEY, value TEXT NOT NULL);');
    db.prepare('INSERT INTO proof(value) VALUES (?)').run('record-in-live-wal');
    await writeFile(join(source, ownerToken), secret, { mode: 0o644 });
    await writeFile(join(source, 'other-secret.token'), 'must-not-copy');

    const { stdout } = await run(process.execPath, [script, '--data-dir', source, '--output', output], { timeout: 10000 });
    assert.equal(stdout.trim(), output);
    assert.deepEqual((await readdir(output)).sort(), ['hub.sqlite', 'manifest.json', ownerToken].sort());
    assert.equal((await readFile(join(output, ownerToken), 'utf8')), secret);
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    assert.deepEqual({ format: manifest.format, version: manifest.version, sshIncluded: manifest.sshIncluded, sshState: manifest.sshState }, { format: 'tuijin-hub-backup', version: 2, sshIncluded: false, sshState: 'absent' });
    assert.ok(Number.isFinite(Date.parse(manifest.createdAt)));
    for (const name of ['hub.sqlite', 'manifest.json', ownerToken]) {
      assert.equal((await stat(join(output, name))).mode & 0o777, 0o600, `${name} must be owner-readable only`);
    }

    await mkdir(restored);
    await copyFile(join(output, 'hub.sqlite'), join(restored, 'hub.sqlite'));
    await copyFile(join(output, ownerToken), join(restored, ownerToken));
    for (const name of ['hub.sqlite', ownerToken]) {
      assert.equal((await stat(join(restored, name))).mode & 0o777, 0o600, `${name} restore must retain owner-only access`);
    }
    const recovered = new DatabaseSync(join(restored, 'hub.sqlite'), { readOnly: true });
    try { assert.equal(recovered.prepare('SELECT value FROM proof WHERE id = 1').get().value, 'record-in-live-wal'); }
    finally { recovered.close(); }
    assert.equal(await readFile(join(restored, ownerToken), 'utf8'), secret);
  } finally {
    db?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Hub backup restores encrypted SSH host data and its vault key without exposing credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'taskboard-hub-ssh-backup-'));
  const source = join(root, 'source'), ssh = join(source, 'ssh');
  const output = join(root, 'backup'), restored = join(root, 'restored');
  try {
    await mkdir(source); await mkdir(ssh, { mode: 0o700 });
    const db = new DatabaseSync(join(source, 'hub.sqlite')); db.close();
    const store = createSshStore(ssh);
    const host = store.put('account-1', { name: 'Build host', host: 'build.example.test', port: 22,
      username: 'builder', kind: 'server', authMethod: 'password', rememberCredential: true,
      credentials: { password: 'backup-secret-fixture' } });
    assert.equal(store.list('account-1')[0].hasCredential, true);
    assert.equal(JSON.stringify(store.list('account-1')).includes('backup-secret-fixture'), false);
    await run(process.execPath, [script, '--data-dir', source, '--output', output], { timeout: 10000 });
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.sshIncluded, true);
    assert.equal((await stat(join(output, 'ssh'))).mode & 0o777, 0o700);
    for (const name of ['ssh-hosts.json', 'ssh-vault.key']) {
      assert.equal((await stat(join(output, 'ssh', name))).mode & 0o777, 0o600);
    }
    assert.equal((await readFile(join(output, 'ssh', 'ssh-hosts.json'), 'utf8')).includes('backup-secret-fixture'), false);
    await mkdir(restored); await mkdir(join(restored, 'ssh'), { mode: 0o700 });
    for (const name of ['ssh-hosts.json', 'ssh-vault.key'])
      await copyFile(join(output, 'ssh', name), join(restored, 'ssh', name));
    const recovered = createSshStore(join(restored, 'ssh'));
    assert.equal((await stat(join(restored, 'ssh'))).mode & 0o777, 0o700);
    for (const name of ['ssh-hosts.json', 'ssh-vault.key']) assert.equal((await stat(join(restored, 'ssh', name))).mode & 0o777, 0o600);
    assert.deepEqual(recovered.get('account-1', host.id), { ...host, hasCredential: true });
    assert.deepEqual(recovered.credential('account-1', host.id), { password: 'backup-secret-fixture' });
    assert.equal(JSON.stringify(recovered.get('account-1', host.id)).includes('backup-secret-fixture'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Hub backup and restore accept the real SSH store key-only empty state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'taskboard-hub-ssh-empty-'));
  const source = join(root, 'source'), ssh = join(source, 'ssh');
  const output = join(root, 'backup'), restored = join(root, 'restored');
  try {
    await mkdir(source); await mkdir(ssh, { mode: 0o700 });
    const db = new DatabaseSync(join(source, 'hub.sqlite')); db.close();
    createSshStore(ssh); // The real store creates only its key until the first host is saved.
    assert.deepEqual((await readdir(ssh)).sort(), ['ssh-vault.key']);
    await run(process.execPath, [script, '--data-dir', source, '--output', output], { timeout: 10000 });
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    assert.deepEqual({ sshIncluded: manifest.sshIncluded, sshState: manifest.sshState }, { sshIncluded: true, sshState: 'empty' });
    await mkdir(restored); await mkdir(join(restored, 'ssh'), { mode: 0o700 });
    for (const name of ['ssh-hosts.json', 'ssh-vault.key'])
      await copyFile(join(output, 'ssh', name), join(restored, 'ssh', name));
    const recovered = createSshStore(join(restored, 'ssh'));
    assert.deepEqual(recovered.list('no-hosts-yet'), []);
    assert.equal(JSON.parse(await readFile(join(restored, 'ssh', 'ssh-hosts.json'), 'utf8')).version, 1);
    assert.equal((await stat(join(restored, 'ssh'))).mode & 0o777, 0o700);
    for (const name of ['ssh-hosts.json', 'ssh-vault.key']) assert.equal((await stat(join(restored, 'ssh', name))).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Hub backup rejects incomplete SSH state and symbolic links without a success manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'taskboard-hub-ssh-incomplete-'));
  const source = join(root, 'source'), output = join(root, 'backup');
  try {
    await mkdir(source); await mkdir(join(source, 'ssh'));
    const db = new DatabaseSync(join(source, 'hub.sqlite')); db.close();
    await writeFile(join(join(source, 'ssh'), 'ssh-hosts.json'), JSON.stringify({ version: 1, owners: {} }));
    await assert.rejects(run(process.execPath, [script, '--data-dir', source, '--output', output], { timeout: 10000 }), error => /missing ssh-vault\.key/.test(error.stderr));
    await assert.rejects(readFile(join(output, 'manifest.json')));
    await rm(output, { recursive: true, force: true });
    await rm(join(source, 'ssh', 'ssh-hosts.json'));
    await symlink(join(root, 'outside'), join(source, 'ssh', 'ssh-hosts.json'));
    await writeFile(join(source, 'ssh', 'ssh-vault.key'), Buffer.alloc(32, 7));
    await assert.rejects(run(process.execPath, [script, '--data-dir', source, '--output', join(root, 'backup-link')], { timeout: 10000 }), error => /symbolic link/.test(error.stderr));
    await assert.rejects(readFile(join(root, 'backup-link', 'manifest.json')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
