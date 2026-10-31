import {readdir,readFile,realpath,mkdir,writeFile,rename,rm,lstat,copyFile} from 'node:fs/promises';
import {join,resolve,relative,sep,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const validId=id=>typeof id==='string'&&/^[a-z][a-z0-9-]{1,80}$/.test(id);
export async function inspectPackage(directory){
 const root=await realpath(directory),files=[];let bytes=0;
 async function walk(path){for(const entry of await readdir(path,{withFileTypes:true})){if(['.git','node_modules','__pycache__'].includes(entry.name))continue;const full=join(path,entry.name);if(entry.isSymbolicLink())throw Error('插件包不允许符号链接');if(entry.isDirectory())await walk(full);else if(entry.isFile()){if((await lstat(full)).size+bytes>20_000_000||files.length>=1000)throw Error('插件包超过 20 MB / 1000 文件');const data=await readFile(full);bytes+=data.length;if(bytes>20_000_000)throw Error('插件包超过 20 MB');files.push({path:relative(root,full).split(sep).join('/'),hash:createHash('sha256').update(data).digest('hex')});}else throw Error('插件包含特殊文件');}}
 await walk(root);files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
 const manifest=JSON.parse(await readFile(join(root,'plugin.json'),'utf8'));
 if(!validId(manifest.id)||manifest.apiVersion!==1||typeof manifest.name!=='string'||typeof manifest.version!=='string'||typeof manifest.entry!=='string'||!Array.isArray(manifest.permissions)||manifest.permissions.some(p=>typeof p!=='string'))throw Error('插件清单不符合 v1 接口');
 const entry=await realpath(join(root,manifest.entry));if(!entry.startsWith(root+sep)||!(await lstat(entry)).isFile())throw Error('插件入口超出包目录');
 if(!files.some(f=>f.path===relative(root,entry).split(sep).join('/')))throw Error('插件入口未包含在包中');
 return {root,manifest,files,bytes,sha256:createHash('sha256').update(JSON.stringify(files)).digest('hex')};
}
export async function installPackage({source,target,expectedSha256,trustLocalCode}){
 if(trustLocalCode!==true)throw Error('插件可以使用本机 Node 权限；需显式信任本地代码');
 const checked=await inspectPackage(source);if(checked.sha256!==expectedSha256)throw Error('插件哈希与已审查版本不一致');
 const root=resolve(target);await mkdir(root,{recursive:true});const final=join(root,checked.manifest.id),staging=join(root,`.stage-${randomUUID()}`);await mkdir(staging);
 let backup=null;
 try{
  for(const file of checked.files){const to=join(staging,file.path);await mkdir(dirname(to),{recursive:true});await copyFile(join(checked.root,file.path),to);}
  if((await inspectPackage(staging)).sha256!==expectedSha256)throw Error('复制过程中插件内容变化');
  try{const previous=await inspectPackage(final);if(previous.manifest.id!==checked.manifest.id)throw Error('已有目录不属于该插件');backup=join(root,`.rollback-${checked.manifest.id}-${randomUUID()}`);await rename(final,backup);}catch(e){if(e.code!=='ENOENT')throw e;}
  try{await rename(staging,final);}catch(e){if(backup)await rename(backup,final);throw e;}
  return {id:checked.manifest.id,version:checked.manifest.version,sha256:checked.sha256,path:final,previousPackage:backup,restartRequired:true};
 }finally{await rm(staging,{recursive:true,force:true});}
}
export async function scaffoldPackage({id,directory}){
 if(!validId(id))throw Error('插件 ID 需为小写字母、数字、连字符');await mkdir(directory);
 const manifest={id,name:id,version:'0.1.0',apiVersion:1,entry:'host.mjs',permissions:[],capabilities:[],defaultEnabled:false,configSchema:{type:'object',properties:{}}};
 await writeFile(join(directory,'plugin.json'),JSON.stringify(manifest,null,2)+'\n');
 await writeFile(join(directory,'host.mjs'),`export async function createPlugin({emit}) {\n let enabled=false;\n const state=()=>({enabled,available:true,status:enabled?'ready':'disabled'});\n return {state,configure:async()=>state(),enable:async()=>{enabled=true;await emit();return state()},disable:async()=>{enabled=false;await emit();return state()},check:async()=>state(),close:async()=>{enabled=false}};\n}\n`);
 return {path:resolve(directory),id};
}
