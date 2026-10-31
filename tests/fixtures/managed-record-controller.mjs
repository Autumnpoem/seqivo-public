// A separate Node process, given only durable record coordinates. No live
// controller object or capability is inherited from the creating test process.
import { reconnectManagedTmuxSession, verifyManagedTmuxSession } from '../../server/terminal/managed-pane-record.mjs';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const coordinates = JSON.parse(process.argv[2]);
const subject = await reconnectManagedTmuxSession(coordinates);
try {
  const status = await subject.pane.status();
  await verifyManagedTmuxSession(coordinates);
  await subject.pane.resume();
  const record = JSON.parse(await readFile(coordinates.recordPath, 'utf8'));
  await promisify(execFile)(record.config.tmuxPath,
    ['-L', record.config.serverName, 'send-keys', '-t', subject.relayPaneId,
      "printf 'once\\n' >> cross-process-marker", 'Enter'], { timeout: 5000 });
  // Wait for the actual write before closing the controlling connection;
  // tmux accepting keys alone does not prove the shell executed them.
  const deadline = Date.now() + 5000;
  while (true) {
    const marker = await readFile(record.config.cwd + '/cross-process-marker', 'utf8').catch(error => {
      if (error.code === 'ENOENT') return ''; throw error;
    });
    if (marker === 'once\n') break;
    if (Date.now() > deadline) throw new Error('Cross-process shell write was not confirmed');
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  process.stdout.write(JSON.stringify({ identities: subject.identities,
    sessionId: subject.sessionRef.sessionId, inputInitiallyFrozen: status.inputFrozen }));
} finally {
  subject.pane.close();
}
