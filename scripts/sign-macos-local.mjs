#!/usr/bin/env node
// Sign a local Apple Silicon test bundle. This is not Developer ID signing or notarization.
import {execFileSync, spawnSync} from 'node:child_process';
import {lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';

const fail = message => { throw new Error(message); };
function run(command, args) {
  return execFileSync(command, args, {encoding:'utf8', stdio:['ignore','pipe','pipe'], timeout:30000});
}
function inside(app, suffix) {
  const path = join(app, suffix), resolved = realpathSync(path), rel = relative(app, resolved);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep) || lstatSync(path).isSymbolicLink())
    fail('Bundle component must remain inside the supplied app: ' + suffix);
  return path;
}
const plist = keys => '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
  '<plist version="1.0"><dict>' + keys.map(key => '<key>' + key + '</key><true/>').join('') + '</dict></plist>\n';

if (process.platform !== 'darwin' || process.arch !== 'arm64')
  fail('Local signing is currently verified only on Apple Silicon macOS.');
if (process.argv.length !== 3 || !process.argv[2].endsWith('.app'))
  fail('Usage: node scripts/sign-macos-local.mjs /absolute/path/to/序程.app');
const input = resolve(process.argv[2]);
if (lstatSync(input).isSymbolicLink()) fail('Refusing an app symlink.');
const app = realpathSync(input);
const info = JSON.parse(run('/usr/bin/plutil', ['-convert','json','-o','-',inside(app,'Contents/Info.plist')]));
if (info.CFBundleIdentifier !== 'com.autumnpoem.tuijin' || info.CFBundleExecutable !== 'tuijin')
  fail('This command only signs a Seqivo local test bundle.');
const main = inside(app,'Contents/MacOS/tuijin');
const node = inside(app,'Contents/MacOS/taskboard-node');
const runtime = JSON.parse(readFileSync(inside(app,'Contents/Resources/resources/runtime.json'),'utf8'));
if (runtime.target !== 'aarch64-apple-darwin') fail('Bundle target must be aarch64-apple-darwin.');
const processes = run('/bin/ps', ['-axo','comm=']).split('\n').map(line=>line.trim());
if (processes.some(path=>path===main || path===node)) fail('Close this exact app before signing its files.');
const addonDir = 'Contents/Resources/resources/node_modules/node-pty/prebuilds/darwin-arm64/';
const nativeFiles = ['pty.node','spawn-helper'].map(name=>inside(app,addonDir+name));
// Inspect every target before the first write, including nested vendor code.
// Do not downgrade an existing Developer ID signature to ad-hoc.
for (const path of [...nativeFiles,node,main,app]) {
  const described = spawnSync('/usr/bin/codesign', ['-dvv',path], {encoding:'utf8',timeout:10000});
  if (described.status !== 0) fail('A target signature cannot be inspected; no files were signed.');
  const team = /^TeamIdentifier=(.*)$/m.exec(described.stderr)?.[1];
  if (!team || team !== 'not set') fail('Refusing to replace a team-signed target; no files were signed.');
}

const stage = mkdtempSync(join(tmpdir(),'seqivo-local-sign-'));
let signingStarted = false;
try {
  const nodeEntitlements = join(stage,'node.plist'), appEntitlements = join(stage,'app.plist');
  writeFileSync(nodeEntitlements, plist([
    'com.apple.security.cs.allow-jit',
    // Ad-hoc binaries have no signing team. Restrict this exception to Node,
    // which loads the bundled node-pty addon; keep it off the main application.
    'com.apple.security.cs.disable-library-validation',
  ]), {mode:0o600});
  writeFileSync(appEntitlements, plist([]), {mode:0o600});
  const sign = (path, entitlements) => run('/usr/bin/codesign', [
    '--force','--sign','-','--timestamp=none','--options','runtime',
    ...(entitlements ? ['--entitlements',entitlements] : []),path,
  ]);
  signingStarted = true;
  for (const path of nativeFiles) sign(path);
  sign(node,nodeEntitlements);
  const probe = JSON.parse(run(node,['-e',
    'const p=require(process.argv[1]);console.log(JSON.stringify({jit:Function("return 6*7")(),pty:typeof p.spawn}));',
    inside(app,'Contents/Resources/resources/node_modules/node-pty'),
  ]));
  if (probe.jit !== 42 || probe.pty !== 'function') fail('Signed Node runtime probe failed.');
  // Sign inside out. --deep is for verification only, never for signing.
  sign(app,appEntitlements);
  run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
  console.log(JSON.stringify({signed:true,kind:'local-ad-hoc',hardenedRuntime:true,
    nodeRuntimeProbe:true,notarized:false,platform:'darwin',architecture:'arm64'}));
} catch (error) {
  if (signingStarted) console.error('Local bundle signing did not finish. Rebuild an isolated copy before retrying; do not install this partially signed copy.');
  throw error;
} finally {
  rmSync(stage,{recursive:true,force:true});
}
