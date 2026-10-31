import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HubStore } from './store.mjs';
import { createHub } from './http.mjs';

export { HubStore, HubError } from './store.mjs';
export { createHub } from './http.mjs';

function option(args, name, fallback) {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? fallback : args[at + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  const dataDir = option(args, 'data-dir');
  if (!dataDir) { process.stderr.write('Use --data-dir DIR\n'); process.exitCode = 2; }
  else if (command === 'bootstrap') {
    const tenantId = option(args, 'tenant-id');
    if (!tenantId) { process.stderr.write('Use --tenant-id ID\n'); process.exitCode = 2; }
    else {
      const store = new HubStore(dataDir);
      try { process.stdout.write(`${store.bootstrap(tenantId).tokenPath}\n`); }
      catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
      finally { store.close(); }
    }
  } else if (command === 'serve') {
    try {
      const hub = await createHub({
        dataDir, distDir: option(args, 'dist-dir'), host: option(args, 'host', '127.0.0.1'),
        port: Number(option(args, 'port', '4318')),
        publicOrigin: option(args, 'public-origin'),
        trustedProxy: args.includes('--trusted-proxy'),
        registrationEnabled: !args.includes('--disable-registration'),
        tls: option(args, 'tls-key') && option(args, 'tls-cert') ? { keyPath: option(args, 'tls-key'), certPath: option(args, 'tls-cert') } : undefined,
      });
      process.stdout.write(`Hub listening at ${hub.url}\n`);
      const shutdown = async () => { await hub.close(); process.exit(0); };
      process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  } else { process.stderr.write('Use bootstrap or serve\n'); process.exitCode = 2; }
}
