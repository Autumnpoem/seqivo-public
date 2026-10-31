import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const [role, rootArg, workspaceArg] = process.argv.slice(2);
const root = rootArg, workspace = workspaceArg;
const scriptPath = fileURLToPath(import.meta.url);
const marker = name => join(root, `${name}.${role === 'bridge' ? 'bridge' : role}.marker`);
const emit = value => { process.stdout.write(`${JSON.stringify(value)}\n`); };
async function waitFile(path) {
  while (true) {
    try { await import('node:fs/promises').then(fs => fs.access(path)); return; }
    catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
}

if (role === 'app' || role === 'outsider' || role === 'orphan') {
  const stop = join(root, `${role}.stop`), exited = join(root, `${role}.exited`);
  await mkdir(root, { recursive: true });
  await writeFile(marker('pid'), String(process.pid));
  await waitFile(stop);
  await writeFile(exited, String(process.pid));
} else if (role === 'bridge') {
  const app = spawn(process.execPath, [scriptPath, 'app', root, workspace], {
    cwd: workspace, stdio: 'ignore',
  });
  await waitFile(join(root, 'pid.app.marker'));
  emit({ type: 'ready', bridgePid: process.pid, appPid: app.pid });
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (line === 'orphan') {
      const elsewhere = join(root, 'elsewhere');
      const child = spawn(process.execPath, [scriptPath, 'orphan', root, elsewhere], {
        cwd: elsewhere, detached: true, stdio: 'ignore',
      });
      await waitFile(join(root, 'pid.orphan.marker'));
      emit({ type: 'orphan', pid: child.pid });
    } else if (line === 'stop') {
      const appExited = app.exitCode !== null || app.signalCode !== null ? Promise.resolve() : once(app, 'exit');
      await writeFile(join(root, 'app.stop'), 'stop');
      await appExited;
      await writeFile(join(root, 'bridge.exited'), String(process.pid));
      process.exit(0);
    }
  }
}
