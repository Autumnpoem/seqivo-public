import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { verifyControlledBuildView } from './controlled-build-profile.mjs';
import { loadVerifiedPreviewToolchain } from './toolchain.mjs';

// This file is launched only by the Core-owned, identity-tracked Mac job.
const path=process.argv[2];
if (!isAbsolute(path||'')) process.exit(2);
try {
  const config=JSON.parse(await readFile(path,'utf8'));
  if (config.v!==1 || !isAbsolute(config.root) || !isAbsolute(config.outDir) ||
    !isAbsolute(config.cacheDir) || !isAbsolute(config.tsconfig) ||
    !isAbsolute(config.viteEntry) || !/^[a-f0-9]{64}$/.test(config.toolDigest) ||
    config.profile!=='vite-vanilla-v1') throw Error('invalid_configuration');
  await verifyControlledBuildView({viewDir:config.root,files:config.files,inputDigest:config.inputDigest});
  const verified=loadVerifiedPreviewToolchain();
  if(verified.viteEntry!==config.viteEntry||verified.toolDigest!==config.toolDigest)
    throw Error('toolchain_changed');
  const { build }=await import(config.viteEntry);
  const selected=new Map(config.files.map(row=>[row.path,row]));
  const within=(root,p)=>{const rel=relative(root,p);return rel!==''&&rel!=='..'&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel);};
  const selectedFile=async value=>{
    if(typeof value!=='string'||value.includes('?')||value.includes('#')||value.startsWith('\0'))
      throw Error('source_reference_rejected');
    const absolute=resolve(value);
    if(!within(config.root,absolute)||await realpath(absolute)!==absolute)
      throw Error('source_outside_view');
    const rel=relative(config.root,absolute).split(sep).join('/'),expected=selected.get(rel);
    if(!expected)throw Error('source_not_selected');
    const stat=await lstat(absolute),bytes=await readFile(absolute);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==expected.size||
      createHash('sha256').update(bytes).digest('hex')!==expected.sha256)
      throw Error('source_changed');
    return {absolute,bytes};
  };
  const sourceGate={name:'seqivo-controlled-source-gate',enforce:'pre',
    async resolveId(source,importer){
      if(typeof source!=='string'||(!source.startsWith('./')&&!source.startsWith('../')&&
        !isAbsolute(source)))throw Error('source_reference_rejected');
      const base=importer?dirname(importer):config.root;
      return (await selectedFile(resolve(base,source))).absolute;
    },
    async load(id){
      const checked=await selectedFile(id);
      if(/\.(?:js|mjs|ts|jsx|tsx|css)$/.test(id))return checked.bytes.toString('utf8');
      return null;
    }};
  await build({ root:config.root, configFile:false, envFile:false, envDir:false,
    tsconfig:config.tsconfig,
    envPrefix:[], publicDir:false, cacheDir:config.cacheDir, base:'./', plugins:[sourceGate], logLevel:'silent',
    css:{postcss:{plugins:[]}}, esbuild:{tsconfigRaw:{compilerOptions:{jsx:'automatic',target:'ES2022'}}},
    build:{outDir:config.outDir,emptyOutDir:false,write:true,sourcemap:false,
      modulePreload:{polyfill:false},
      manifest:false,ssrManifest:false,watch:null,minify:false} });
  await verifyControlledBuildView({viewDir:config.root,files:config.files,inputDigest:config.inputDigest});
  process.stdout.write('{"v":1,"status":"built"}\n');
} catch {
  process.stdout.write('{"v":1,"status":"failed"}\n');
  process.exitCode=1;
}
