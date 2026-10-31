import { cpSync, mkdirSync, chmodSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import './prepare-native-dependencies.mjs';
import { prepareTerminalRuntime } from './prepare-terminal-runtime.mjs';
import { preparePreviewRuntime } from './prepare-preview-runtime.mjs';
import { preparePreviewPython } from './prepare-preview-python.mjs';
import { writeDesktopPackageBoundary } from './desktop-package-boundary.mjs';
const target=execFileSync('rustc',['--print','host-tuple'],{encoding:'utf8'}).trim();
if(Number(process.versions.node.split('.')[0])<24)throw Error('请使用 Node.js 24 或更高版本打包');
const root=resolve(import.meta.dirname,'..'),dir=join(root,'src-tauri');
const nodeVersion=process.versions.node;
const officialLicense=`https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`;
const nodeRoot=dirname(dirname(realpathSync(process.execPath)));
const localLicense=[process.env.NODE_LICENSE_PATH,join(nodeRoot,'LICENSE'),join(nodeRoot,'LICENSE.md')].find(path=>path&&existsSync(path));
let license,licenseSource;
if(localLicense){license=readFileSync(localLicense,'utf8');licenseSource=officialLicense;}
else {
  let response;
  try{response=await fetch(officialLicense,{signal:AbortSignal.timeout(20000)});}
  catch(error){throw Error(`无法获取 Node.js ${nodeVersion} 官方许可证。离线构建请设置 NODE_LICENSE_PATH：${error.message}`);}
  if(!response.ok)throw Error(`无法获取 Node.js ${nodeVersion} 许可证（HTTP ${response.status}）。离线构建可设置 NODE_LICENSE_PATH。`);
  license=await response.text();licenseSource=officialLicense;
}
if(license.length<1000||!license.includes('Node.js'))throw Error('Node.js 许可证内容不完整，已停止打包');
if(!existsSync(join(root,'plugins','codex-autocontinue','vendor','LICENSE')))throw Error('缺少上游插件许可证，已停止打包');
mkdirSync(join(dir,'binaries'),{recursive:true});
const sidecar=join(dir,'binaries',`taskboard-node-${target}${process.platform==='win32'?'.exe':''}`);
cpSync(process.execPath,sidecar);chmodSync(sidecar,0o755);
rmSync(join(dir,'resources'),{recursive:true,force:true});mkdirSync(join(dir,'resources'),{recursive:true});
writeDesktopPackageBoundary(join(dir,'resources'));
for(const name of ['server','plugins','dist'])cpSync(join(root,name),join(dir,'resources',name),{recursive:true,filter:source=>!source.includes('__pycache__')&&!source.endsWith('.pyc')});
const preview=preparePreviewRuntime({productRoot:join(dir,'resources'),target});
// The sidecar resolves dependencies from resources, independently of this checkout.
const copied=new Set();
function copyRuntimePackage(name,from=createRequire(import.meta.url)){
  if(copied.has(name))return;copied.add(name);
  const manifest=from.resolve(`${name}/package.json`),source=dirname(manifest);
  const pkg=JSON.parse(readFileSync(manifest,'utf8'));
  cpSync(source,join(dir,'resources','node_modules',name),{recursive:true,filter:path=>{
    const rel=path.slice(source.length+1).split(/[\\/]/);
    return !(rel[0]==='prebuilds'&&rel[1]&&rel[1]!==`${process.platform}-${process.arch}`);
  }});
  for(const dependency of Object.keys(pkg.dependencies||{}))copyRuntimePackage(dependency,createRequire(manifest));
}
for(const name of ['node-pty','ws','ssh2'])copyRuntimePackage(name);
const terminal=await prepareTerminalRuntime(join(dir,'resources'));
const previewPython=await preparePreviewPython(join(dir,'resources'));
mkdirSync(join(dir,'resources','licenses'),{recursive:true});
for(const name of ['LICENSE','NOTICE.md'])cpSync(join(root,name),join(dir,'resources',name));
cpSync(join(root,'docs','licenses'),join(dir,'resources','docs','licenses'),{recursive:true});
writeFileSync(join(dir,'resources','licenses','Node.js-LICENSE.txt'),license);
// Ship the license and modification notice for our statically linked Tao patch.
for(const [source,name] of [
  ['vendor/tao-0.35.3/LICENSE','Tao-LICENSE.txt'],
  ['vendor/tao-0.35.3/LICENSE.spdx','Tao-LICENSE.spdx'],
  ['vendor/README.md','Tao-Seqivo-modifications.md'],
])cpSync(join(dir,source),join(dir,'resources','licenses',name));
writeFileSync(join(dir,'resources','runtime.json'),JSON.stringify({node:nodeVersion,target,source:'Node.js runtime copied from build host',licenseSource,terminal:{...terminal,path:terminal.bundled?'terminal/bin/tmux':undefined},previewToolchain:{viteVersion:preview.viteVersion,toolDigest:preview.toolDigest,manifest:preview.manifest,packageCount:preview.packageCount},previewPython},null,2));
console.log(`已准备 ${target} 的 Node ${process.versions.node} 桌面运行时。`);
