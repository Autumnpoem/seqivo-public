import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import ssh2 from 'ssh2';
import pty from 'node-pty';
import { generateKeyPairSync } from 'node:crypto';
const { Server } = ssh2;

export async function sshServer(t, { cwd, executable, serverName, authKey, password = 'only-test-password', hostKey, tmuxFailure } = {}) {
  const clients = new Set(), children = new Set(), auth = [], commands = [];
  const env = { ...process.env, HOME: cwd, PATH: `${executable ? dirname(executable) + ':' : ''}${process.env.PATH}`, TERM: 'xterm-256color' };
  const fixtureKey = hostKey || generateKeyPairSync('ec', {
    namedCurve: 'prime256v1', privateKeyEncoding: { type: 'sec1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
  const server = new Server({ hostKeys: [fixtureKey] }, client => {
    clients.add(client); client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => {
      auth.push(ctx.method);
      if (ctx.username !== 'tester') return ctx.reject();
      if (ctx.method === 'password' && ctx.password === password) return ctx.accept();
      if (ctx.method === 'publickey' && authKey && ctx.key.data.equals(authKey.getPublicSSH()) &&
        (!ctx.signature || authKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)) return ctx.accept();
      ctx.reject();
    });
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        const socket = createConnection({ host: info.destIP, port: info.destPort });
        socket.once('connect', () => { const stream = accept(); stream.pipe(socket).pipe(stream); stream.on('close', () => socket.destroy()); });
        socket.once('error', () => reject());
      });
      client.on('session', accept => {
        const session = accept(); let requestedPty = null, terminal = null;
        session.on('pty', (accept, _reject, info) => { requestedPty = info; accept(); });
        session.on('window-change', (accept, _reject, info) => { terminal?.resize(info.cols, info.rows); accept?.(); });
        const run = (accept, reject, command) => {
          if (command && tmuxFailure) {
            const stream = accept();
            stream.stderr.write(tmuxFailure.message);
            stream.exit(tmuxFailure.code); stream.end(); return;
          }
          if (command && (!serverName || !command.startsWith(`tmux -L '${serverName}' `))) return reject();
          commands.push(command || 'shell');
          const stream = accept();
          if (requestedPty) {
            terminal = pty.spawn('/bin/sh', command ? ['-c', command] : [], { cwd, env,
              cols: requestedPty.cols || 80, rows: requestedPty.rows || 24, name: 'xterm-256color' });
            children.add(terminal);
            terminal.onData(data => { if (!stream.destroyed) stream.write(data); });
            terminal.onExit(({ exitCode }) => { children.delete(terminal); if (!stream.destroyed) { stream.exit(exitCode); stream.end(); } });
            stream.on('data', data => terminal.write(data.toString()));
            stream.on('close', () => { try { terminal.kill(); } catch {} });
          } else {
            const child = spawn('/bin/sh', ['-c', command], { cwd, env });
            children.add(child);child.stdout.pipe(stream, { end: false });child.stderr.pipe(stream.stderr, { end: false });
            child.on('close', code => { children.delete(child); stream.exit(code ?? 1); stream.end(); });
          }
        };
        session.on('exec', (accept, reject, info) => run(accept, reject, info.command));
        session.on('shell', (accept, reject) => run(accept, reject, null));
      });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    t.diagnostic(`SSH fixture cleanup: ${clients.size} clients, ${children.size} children`);
    for (const client of clients) client.end();
    for (const child of children) { try { child.kill(); } catch {} }
    await new Promise(resolve => server.close(resolve));
  });
  return { port: server.address().port, auth, commands };
}
