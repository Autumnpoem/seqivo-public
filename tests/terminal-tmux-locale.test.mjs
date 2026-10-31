import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createTmuxAdapter } from '../server/terminal/tmux.mjs';

const exec = promisify(execFile);
const executable = resolve(process.env.TASKBOARD_TEST_TMUX || '.tools/terminal-build/install/bin/tmux');

test('tmux metadata retains tab delimiters and a Unicode pane cwd under the C locale', async t => {
  try { await access(executable, constants.X_OK); }
  catch { t.skip('Isolated tmux executable unavailable'); return; }
  const root = await mkdtemp(join(tmpdir(), 'seqivo-tmux-locale-'));
  const cwd = join(root, '中文目录');
  await mkdir(cwd);
  const expectedCwd = await realpath(cwd);
  const serverName = `seqivo_locale_${randomBytes(6).toString('hex')}`;
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C', SHELL: '/bin/sh' };
  t.after(async () => {
    await exec(executable, ['-L', serverName, 'kill-server'], { env, timeout: 3000 }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const adapter = createTmuxAdapter({ executable, serverName, env });
  const created = await adapter.create({ name: 'locale', cwd });
  const listed = await adapter.list();
  assert.deepEqual(listed.sessions.map(row => row.sessionRef), [created.sessionRef]);
  const sessions = await adapter.sessionsPanes([created.sessionRef]);
  assert.deepEqual(sessions.map(row => row.sessionRef), [created.sessionRef]);
  assert.equal(sessions[0].panes.length, 1);
  assert.equal(sessions[0].panes[0].cwd, expectedCwd);

  const sessionRaw = (await exec(executable, ['-u', '-L', serverName, 'list-sessions', '-F', '#{session_id}\t#{session_name}'], { env, timeout: 3000 })).stdout;
  const paneRaw = (await exec(executable, ['-u', '-L', serverName, 'list-panes', '-a', '-F', '#{session_id}\t#{pane_id}\t#{pane_current_path}'], { env, timeout: 3000 })).stdout;
  assert.equal(sessionRaw.trim(), `${created.sessionRef.sessionId}\tlocale`);
  assert.equal(paneRaw.trim(), `${created.sessionRef.sessionId}\t${sessions[0].panes[0].paneId}\t${expectedCwd}`);
});
