import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

const HASH = value => createHash('sha256').update(value).digest('hex');
const ALLOWED = new Set(['.html','.js','.mjs','.ts','.jsx','.tsx','.css','.json',
  '.svg','.png','.jpg','.jpeg','.webp','.gif','.ico','.woff','.woff2','.txt']);
const SOURCE_TEXT = new Set(['.html','.js','.mjs','.ts','.jsx','.tsx','.css']);
const FORBIDDEN = /(?:^|\/)(?:\.env(?:\..*)?|vite\.config\.[^/]+|postcss\.config\.[^/]+|tsconfig(?:\.[^/]+)?\.json|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|[^/]*\.srl)$/i;
const inside = (root, path) => { const r=relative(root,path); return r==='' || r!=='..' && !r.startsWith(`..${sep}`); };
const fail = () => Object.assign(new Error('受控构建源码不符合固定配置'), { code:'BUILD_SOURCE_INVALID' });

/** Copy only the v1 static profile from the already verified private snapshot. */
export async function prepareControlledBuildView({ snapshotDir, receipt, viewDir }) {
  const source = await realpath(snapshotDir);
  const entries = receipt?.files;
  if (!Array.isArray(entries) || entries.length > 5000 || !entries.some(row => row.path==='index.html'&&row.kind==='file')) throw fail();
  const includedPaths=new Set(entries.filter(row=>row.kind==='file'&&!FORBIDDEN.test(row.path||'')).map(row=>row.path));
  const localReference=(from,spec)=>{
    if(typeof spec!=='string'||!/^\.\.?\//.test(spec)||/[?#%\\]/.test(spec))throw fail();
    const target=resolve(dirname(join(viewDir,from)),spec);
    if(!inside(viewDir,target)||!includedPaths.has(relative(viewDir,target).split(sep).join('/')))throw fail();
  };
  const included = [];
  await mkdir(viewDir, { mode:0o700 });
  for (const row of entries) {
    if (row.kind === 'deleted' || FORBIDDEN.test(row.path)) continue;
    if (row.kind !== 'file' || typeof row.path !== 'string' || row.path.startsWith('/') ||
      row.path.includes('\\') || row.path.split('/').some(p=>!p||p==='.'||p==='..')) throw fail();
    const ext=extname(row.path).toLowerCase();
    if (!ALLOWED.has(ext)) throw fail();
    const original=resolve(source,row.path);
    if (!inside(source,original) || await realpath(original)!==original) throw fail();
    const st=await lstat(original);
    if (!st.isFile() || st.isSymbolicLink() || st.size!==row.size || st.size>4*1024*1024) throw fail();
    const bytes=await readFile(original);
    if (HASH(bytes)!==row.sha256) throw fail();
    if (SOURCE_TEXT.has(ext)) {
      const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      if(ext!=='.html'&&(text.includes('/*')||text.includes('//')))throw fail();
      // A strict v1 profile. Vite resolves local files only from this private
      // view; package imports, external URLs and dynamic imports are rejected.
      if (/\bimport\s*\(|\bimport\.meta\b|\bnew\s+URL\s*\(|\b(?:require|eval|Function)\s*\(/.test(text)) throw fail();
      if(['.js','.mjs','.ts','.jsx','.tsx'].includes(ext)){
        // v1 intentionally accepts only side-effect static imports. Everything
        // else, including legal no-whitespace export/import-from forms, fails
        // closed before the bundler can parse another dependency grammar.
        const remaining=text.replace(/\bimport\s*["']([^"']+)["']\s*;?/g,(_,spec)=>{
          localReference(row.path,spec);return ' ';});
        if(/\b(?:import|export)\b/.test(remaining))throw fail();
      }
      if(ext==='.html'){
        if(/<\s*(?:style|iframe|embed|object|base|template)\b|\bsrcdoc\s*=/i.test(text))throw fail();
        const scripts=[...text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
        if((text.match(/<script\b/gi)||[]).length!==scripts.length)throw fail();
        for(const script of scripts)
          if(script[2].trim()||!/\bsrc\s*=\s*["'][^"']+["']/i.test(script[1]))throw fail();
        const attributes=[...text.matchAll(/\b(?:src|href|srcset)\s*=/gi)];
        const quoted=[...text.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)];
        if(attributes.length!==quoted.length)throw fail();
        for(const match of quoted)localReference(row.path,match[1]);
        if(/url\s*\(/i.test(text))throw fail();
      }
      if(ext==='.css'){
        if(/@import\b|url\s*\(/i.test(text))throw fail();
      }
    }
    included.push({path:row.path,sha256:row.sha256,size:row.size});
    const target=join(viewDir,row.path);
    await mkdir(dirname(target),{recursive:true,mode:0o700});
    await writeFile(target,bytes,{flag:'wx',mode:0o600});
  }
  if (!included.some(row=>row.path==='index.html')) throw fail();
  included.sort((a,b)=>a.path.localeCompare(b.path));
  return { inputDigest:HASH(JSON.stringify(included)), files:included };
}

export async function verifyControlledBuildView({viewDir,files,inputDigest}){
  if(!Array.isArray(files)||files.length>5000||!Array.isArray(files)||
    HASH(JSON.stringify(files))!==inputDigest)throw fail();
  const root=await realpath(viewDir),expected=new Set(files.map(row=>row.path));
  if(expected.size!==files.length)throw fail();
  let count=0;
  async function walk(dir,prefix=''){
    for(const entry of await readdir(dir,{withFileTypes:true})){
      if(++count>10001)throw fail();
      const name=prefix?`${prefix}/${entry.name}`:entry.name;
      const path=join(dir,entry.name),st=await lstat(path);
      if(st.isSymbolicLink())throw fail();
      if(st.isDirectory()){await walk(path,name);continue;}
      if(!st.isFile()||!expected.has(name))throw fail();
    }
  }
  await walk(root);
  for(const row of files){
    if(!expected.has(row.path)||typeof row.sha256!=='string'||!Number.isSafeInteger(row.size))throw fail();
    const path=resolve(root,row.path);
    if(!inside(root,path)||await realpath(path)!==path)throw fail();
    const st=await lstat(path),bytes=await readFile(path);
    if(!st.isFile()||st.isSymbolicLink()||st.size!==row.size||HASH(bytes)!==row.sha256)throw fail();
  }
  return true;
}
