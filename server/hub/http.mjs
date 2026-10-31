import { createSshHub } from '../ssh/hub.mjs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { isIP } from 'node:net';
import { HubError, HubStore } from './store.mjs';
import { AccountService } from './accounts.mjs';
import { handleAccountRequest, authenticateRequest } from './account-http.mjs';
import { createTerminalHub } from './terminal.mjs';
import { createPreviewHub } from './preview.mjs';

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const loopback = host => ['127.0.0.1', '::1', 'localhost'].includes(host);

async function jsonBody(req, limit) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new HubError('application/json required', 415, 'UNSUPPORTED_MEDIA');
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HubError('Request too large', 413, 'TOO_LARGE');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new HubError('Invalid JSON object', 400, 'INVALID_JSON'); }
}

function route(store, subject, method, path, body) {
  const parts = path.split('/').filter(Boolean);
  if (method === 'POST' && path === '/api/admin/pairings') return store.createPairing(subject, body);
  if (method === 'GET' && path === '/api/admin/subjects') return { subjects: store.listSubjects(subject) };
  if (method === 'POST' && path === '/api/admin/grants') return store.setGrant(subject, body.subjectId, body.projectId, true);
  if (method === 'DELETE' && parts.length === 5 && parts[1] === 'admin' && parts[2] === 'grants') return store.setGrant(subject, parts[3], parts[4], false);
  if (method === 'POST' && parts.length === 5 && parts[1] === 'admin' && parts[2] === 'subjects' && parts[4] === 'revoke') return store.revoke(subject, parts[3]);
  if (method === 'POST' && path === '/api/admin/leases/reconcile') return store.reconcileLease(subject, body);
  if (method === 'GET' && path === '/api/state') return store.state(subject);
  if (method === 'GET' && path === '/api/inbox') return store.state(subject).inbox;
  if (method === 'POST' && path === '/api/conversations') return store.createConversation(subject,body);
  if (method === 'GET' && parts.length===4 && parts[1]==='tasks' && parts[3]==='conversation') return store.conversation(subject,parts[2]);
  if (method === 'POST' && path === '/api/commands') return store.command(subject, body);
  if (method === 'GET' && parts.length === 3 && parts[1] === 'commands') return store.commandStatus(subject, parts[2]);
  if (method === 'POST' && parts.length === 4 && parts[1] === 'commands' && parts[3] === 'reconcile') return store.requestRecovery(subject,parts[2]);
  if (method === 'GET' && path === '/api/node/session') return store.nodeSession(subject);
  if (method === 'POST' && path === '/api/node/revoke') return store.revokeSelf(subject);
  if (method === 'POST' && path === '/api/node/snapshot') return store.snapshot(subject, body);
  if (method === 'GET' && path === '/api/node/commands') return store.nodeCommands(subject);
  if (method === 'POST' && parts.length === 5 && parts[1] === 'node' && parts[2] === 'commands' && parts[4] === 'claim') return store.claim(subject, parts[3]);
  if (method === 'POST' && parts.length === 5 && parts[1] === 'node' && parts[2] === 'commands' && parts[4] === 'dispose-unknown') return store.disposeUnknown(subject, parts[3], body);
  if (method === 'POST' && parts.length === 5 && parts[1] === 'node' && parts[2] === 'commands' && parts[4] === 'validate') return store.validate(subject, parts[3]);
  if (method === 'POST' && parts.length === 5 && parts[1] === 'node' && parts[2] === 'commands' && parts[4] === 'sending') return store.markSending(subject, parts[3]);
  if (method === 'POST' && parts.length === 5 && parts[1] === 'node' && parts[2] === 'commands' && parts[4] === 'receipt') return store.receipt(subject, parts[3], body);
  if (method === 'POST' && parts.length === 5 && parts[1] === 'node' && parts[2] === 'commands' && parts[4] === 'reconcile') return store.reportRecovery(subject,parts[3],body);
  throw new HubError('Route not found', 404, 'NOT_FOUND');
}

export async function createHub({ dataDir, distDir, host = '127.0.0.1', port = 0, tls, publicOrigin, now = Date.now, trustedProxy = false, registrationEnabled = true, sshAllowPrivateTargets = false } = {}) {
  if (!dataDir) throw new TypeError('dataDir is required');
  if (!loopback(host) && !tls) throw new HubError('TLS is required outside loopback', 400, 'TLS_REQUIRED');
  if(publicOrigin){const origin=new URL(publicOrigin);if(origin.protocol!=='https:'||origin.origin!==publicOrigin)throw new HubError('publicOrigin must be an HTTPS origin');}
  const store = new HubStore(dataDir, { now });
  let accounts, terminal, preview, ssh;
  try {
    accounts = new AccountService(store,{now,registrationEnabled});
    ssh = createSshHub({dataDir,accounts,secure:Boolean(tls||publicOrigin),publicOrigin,allowPrivateTargets:sshAllowPrivateTargets});
    terminal = createTerminalHub({store,accounts,secure:Boolean(tls||publicOrigin),now,publicOrigin});
    preview = createPreviewHub({store,accounts,secure:Boolean(tls||publicOrigin),now,publicOrigin});
  } catch(error) {
    await Promise.allSettled([ssh?.close(), terminal?.close(), preview?.close()]);
    store.close(); throw error;
  }
  const buckets = new Map();
  const scheme = tls ? 'https' : 'http';
  const allowedHosts = new Set(), allowedOrigins = new Set();
  function networkPolicy(localPort) {
    allowedHosts.clear(); allowedOrigins.clear();
    for (const address of [`127.0.0.1:${localPort}`,`localhost:${localPort}`,`[::1]:${localPort}`]) {
      allowedHosts.add(address); allowedOrigins.add(`${scheme}://${address}`);
    }
    if (publicOrigin) allowedHosts.add(new URL(publicOrigin).host);
    if (!loopback(host) && tls) {
      const boundHost = `${host.includes(':') ? `[${host}]` : host}:${localPort}`;
      allowedHosts.add(boundHost); allowedOrigins.add(`${scheme}://${boundHost}`);
    }
    if (publicOrigin) allowedOrigins.add(publicOrigin);
  }
  const handler = async (req, res) => {
    const send = (status, data) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const peer = req.socket.remoteAddress || 'unknown';
      const forwarded = req.headers['x-forwarded-for'];
      const source = trustedProxy && loopback(peer) && typeof forwarded==='string' && isIP(forwarded) ? forwarded : peer;
      const current = now();
      if(buckets.size>10000) for(const [key,value] of buckets) if(current-value.since>=60000) buckets.delete(key);
      if(buckets.size>20000 && !buckets.has(source)) throw new HubError('Server busy',503,'BUSY');
      const bucket = buckets.get(source);
      if (!bucket || current - bucket.since >= 60000) buckets.set(source, { since: current, count: 1 });
      else if (++bucket.count > 600) throw new HubError('Rate limit exceeded', 429, 'RATE_LIMIT');
      const address = new URL(req.url, `${tls ? 'https' : 'http'}://localhost`);
      const path = address.pathname;
      if (address.search && !path.startsWith('/api/previews')) throw new HubError('Query strings are not accepted on Hub routes', 400, 'QUERY_NOT_ALLOWED');
      if(!allowedHosts.has(req.headers.host))throw new HubError('Host not allowed',403,'HOST');
      if (req.headers.origin) {
        const opaqueAsset = req.headers.origin === 'null' && req.method === 'GET' &&
          /^\/api\/previews\/[^/]+\/site\/[^/]+\//.test(path);
        const opaqueData=req.headers.origin==='null'&&['GET','POST','OPTIONS'].includes(req.method)&&
          /^\/api\/previews\/[^/]+\/data\/records$/.test(path);
        if (!opaqueAsset&&!opaqueData) {
        let origin;
        try { origin = new URL(req.headers.origin); } catch { throw new HubError('Origin not allowed',403,'ORIGIN'); }
        if (req.headers.origin !== origin.origin || !allowedOrigins.has(req.headers.origin) ||
          (!(publicOrigin&&origin.origin===publicOrigin) && (origin.host !== req.headers.host || origin.protocol !== `${scheme}:`)))
          throw new HubError('Origin not allowed', 403, 'ORIGIN');
        }
      }
      if (path.startsWith('/api/')) {
        const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await jsonBody(req,
          /^\/api\/previews\/[^/]+\/data\/records$/.test(path)?4096:path === '/api/node/snapshot' ? 2_000_000 : 32_000) : {};
        if(await handleAccountRequest({accounts,store,req,res,method:req.method,path,body,send,source,secure:Boolean(tls||publicOrigin),registrationEnabled})) return;
        if (ssh.handleHttp({req,method:req.method,path,body,send})) return;
        if (terminal.handleHttp({req,res,method:req.method,path,body,send})) return;
        if (await preview.handleHttp({req,res,method:req.method,path,body,send})) return;
        if (req.method === 'POST' && path === '/api/pairings/redeem') {
          const pairBucket = buckets.get(`${source}:pair`) || { since: current, count: 0 };
          if (current - pairBucket.since >= 60000) { pairBucket.since = current; pairBucket.count = 0; }
          if (++pairBucket.count > 10) throw new HubError('Pairing rate limit exceeded', 429, 'RATE_LIMIT');
          buckets.set(`${source}:pair`, pairBucket);
          return send(200, store.redeem(body.code, body.projectIds));
        }
        const subject = authenticateRequest({accounts,store,req,secure:Boolean(tls||publicOrigin)});
        return send(200, route(store, subject, req.method, path, body));
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HubError('Method not allowed', 405, 'METHOD');
      if (!distDir) throw new HubError('Hub UI not built', 404, 'NOT_FOUND');
      const root = resolve(distDir);
      let pathname;
      try { pathname = decodeURIComponent(path); } catch { throw new HubError('Invalid path', 400); }
      let file = resolve(root, `.${pathname}`);
      if (file !== root && !file.startsWith(root + sep)) throw new HubError('Path not allowed', 403, 'PATH');
      try { if (!(await stat(file)).isFile()) file = join(root, 'index.html'); }
      catch { file = join(root, 'index.html'); }
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      send(error.status || 500, { error: error.status ? error.message : 'Internal Hub error', code: error.code || 'ERROR' });
    }
  };
  let server, upgradeListener;
  try {
    server = tls
      ? createHttpsServer({ key: await readFile(tls.keyPath), cert: await readFile(tls.certPath) }, handler)
      : createHttpServer(handler);
    upgradeListener=(req,socket,head)=>{
      const policy={allowedHosts,allowedOrigins};
      if(ssh.handleUpgrade(req,socket,head,policy))return;
      if(preview.handleUpgrade(req,socket,head,policy))return;
      if(terminal.handleUpgrade(req,socket,head,policy))return;
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    };
    server.on('upgrade',upgradeListener);
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolveListen);
    });
    networkPolicy(server.address().port);
  } catch (error) {
    const failures = [error];
    if(server&&upgradeListener)server.off('upgrade',upgradeListener);
    try { await ssh?.close(); } catch (cleanupError) { failures.push(cleanupError); }
    try { await preview.close(); } catch (cleanupError) { failures.push(cleanupError); }
    try { await terminal.close(); } catch (cleanupError) { failures.push(cleanupError); }
    try { store.close(); } catch (cleanupError) { failures.push(cleanupError); }
    throw failures.length === 1 ? error : new AggregateError(failures,'Hub startup and cleanup failed');
  }
  const displayHost = host.includes(':') ? `[${host}]` : host;
  let closePromise;
  return {
    store, accounts, terminal, preview, server, port: server.address().port, url: `${scheme}://${displayHost}:${server.address().port}`,
    close: () => closePromise ??= (async () => {
      const errors=[];
      server.off('upgrade',upgradeListener);
      try { await ssh.close(); } catch(error) { errors.push(error); }
      try { await preview.close(); } catch(error) { errors.push(error); }
      try { await terminal.close(); } catch(error) { errors.push(error); }
      try { await new Promise((resolveClose,rejectClose) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? rejectClose(error) : resolveClose())); }
      catch(error) { errors.push(error); }
      try { store.close(); } catch(error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors,'Hub shutdown failed');
    })(),
  };
}
