import { createServer } from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, resolve, extname, sep } from 'node:path';
import { attachLocalTerminalServer } from './terminal/socket.mjs';

export async function credentials(dataDir){
  const path=join(dataDir,'access.json');await mkdir(dataDir,{recursive:true});
  try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const value={owner:randomBytes(32).toString('hex'),viewer:randomBytes(32).toString('hex'),reporter:randomBytes(32).toString('hex')};await writeFile(path,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});return value;
}
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.webmanifest':'application/manifest+json'};
export async function startHttp({core,dataDir,distDir,host='127.0.0.1',port=4317,publicOrigin}){
  if(!['127.0.0.1','localhost','::1'].includes(host))throw new Error('本机任务服务仅允许回环地址；远程访问请使用 HTTPS Hub');
  if(core.terminal&&publicOrigin)throw new Error('终端启用的本机服务不接受公开来源；请通过 HTTPS Hub 配对访问');
  const tokens=await credentials(dataDir);const streams=new Set(),sockets=new Map();
  let closing=false,closePromise;
  const server=createServer(async(req,res)=>{
    const socketState=sockets.get(req.socket);let dispatched=false;
    const protect=()=>{if(!dispatched){dispatched=true;if(socketState)socketState.dispatched++;}};
    res.once('close',()=>{if(dispatched&&socketState)socketState.dispatched--;if(closing&&socketState?.dispatched===0)req.socket.destroy();});
    const send=(code,data)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    if(closing){if(!socketState?.dispatched)req.destroy();return;}
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try{
      const actualPort=server.address()?.port||port;
      const allowedHosts=new Set([`127.0.0.1:${actualPort}`,`localhost:${actualPort}`,`[::1]:${actualPort}`]);if(publicOrigin)allowedHosts.add(new URL(publicOrigin).host);
      if(!allowedHosts.has(req.headers.host))return send(403,{error:'Host 不在允许范围'});
      const url=new URL(req.url,'http://127.0.0.1');
      const allowedOrigins=new Set([`http://127.0.0.1:${actualPort}`,`http://localhost:${actualPort}`,`http://[::1]:${actualPort}`]);if(publicOrigin)allowedOrigins.add(new URL(publicOrigin).origin);
      const previewAsset=req.method==='GET'&&/^\/api\/previews\/[^/]+\/site\/[^/]+\//.test(url.pathname);
      const previewData=['GET','POST','OPTIONS'].includes(req.method)&&/^\/api\/previews\/[^/]+\/data\/records$/.test(url.pathname);
      if(previewAsset&&core.previewTransport)for(const origin of ['tauri://localhost','http://tauri.localhost','https://tauri.localhost'])allowedOrigins.add(origin);
      if(req.headers.origin&&!allowedOrigins.has(req.headers.origin)&&!((previewAsset||previewData)&&req.headers.origin==='null'))return send(403,{error:'请求来源不受信任'});
      if(previewAsset&&core.previewLocal){protect();if(await core.previewLocal.handleSite(req,res,url.pathname))return;}
      if(previewData&&core.previewLocal){protect();if(await core.previewLocal.handleData(req,res,url.pathname))return;}
      if(url.pathname.startsWith('/api/')){
        const bearer=req.headers.authorization?.replace(/^Bearer /,'');const role=Object.keys(tokens).find(k=>equal(tokens[k],bearer));
        if(!role)return send(401,{error:'请输入有效的访问密钥',code:'UNAUTHORIZED'});
        if(req.method==='GET'&&url.pathname==='/api/events'){
          res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write('data: {"type":"connected"}\n\n');streams.add(res);const beat=setInterval(()=>res.write(': heartbeat\n\n'),15000);req.on('close',()=>{streams.delete(res);clearInterval(beat);});return;
        }
        let body={};if(!['GET','HEAD'].includes(req.method)){
          if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:'请使用 application/json'});
          let raw='';const maxBody=url.pathname==='/api/backup/restore'?16_100_000:1_000_000;
          for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>maxBody)return send(413,{error:'请求过大'});}
          try{body=raw?JSON.parse(raw):{};}catch{return send(400,{error:'JSON 格式不正确'});}
        }
        protect();
        return send(200,await core.request(req.method,url.pathname+url.search,body,role));
      }
      if(req.method!=='GET'&&req.method!=='HEAD')return send(405,{error:'不支持该操作'});
      let file=resolve(distDir,'.'+decodeURIComponent(url.pathname));if(!file.startsWith(resolve(distDir)+sep)&&file!==resolve(distDir))return send(403,{error:'路径不允许'});
      try{if(!(await stat(file)).isFile())file=join(distDir,'index.html');}catch{file=join(distDir,'index.html');}
      protect();const data=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:data);
    }catch(e){send(e.status||500,{error:e.message,code:e.code||'ERROR'});}
  });
  server.on('connection',socket=>{const state={dispatched:0};sockets.set(socket,state);socket.once('close',()=>sockets.delete(socket));});
  const sshUpgrade=(req,socket,head)=>{const actualPort=server.address()?.port||port;core.ssh?.upgrade(req,socket,head,{hosts:new Set([`127.0.0.1:${actualPort}`,`localhost:${actualPort}`,`[::1]:${actualPort}`]),origins:new Set([`http://127.0.0.1:${actualPort}`,`http://localhost:${actualPort}`,`http://[::1]:${actualPort}`,'tauri://localhost','http://tauri.localhost','https://tauri.localhost'])});};
  if(core.ssh)server.on('upgrade',sshUpgrade);
  const terminal=core.terminal?attachLocalTerminalServer({server,manager:core.terminal,policy:()=>{
    const actualPort=server.address()?.port||port;
    const hosts=new Set([`127.0.0.1:${actualPort}`,`localhost:${actualPort}`,`[::1]:${actualPort}`]);
    const origins=new Set([`http://127.0.0.1:${actualPort}`,`http://localhost:${actualPort}`,`http://[::1]:${actualPort}`,'tauri://localhost','http://tauri.localhost','https://tauri.localhost']);
    if(publicOrigin){hosts.add(new URL(publicOrigin).host);origins.add(new URL(publicOrigin).origin);}
    return {hosts,origins};
  }}):null;
  const notify=()=>{for(const res of streams)res.write('data: {"type":"changed"}\n\n');};core.events.on('change',notify);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  try{core.previewTransport?.bind(server);}
  catch(error){core.events.off('change',notify);await terminal?.close();await new Promise(resolve=>server.close(resolve));throw error;}
  core.ssh?.setOrigin(`http://${server.address().address==='::1'?'[::1]':'127.0.0.1'}:${server.address().port}`);
  core.terminal?.setOrigin(`http://${server.address().address==='::1'?'[::1]':'127.0.0.1'}:${server.address().port}`);
  return {server,tokens,port:server.address().port,close:()=>closePromise??=(async()=>{
    closing=true;core.events.off('change',notify);
    server.off('upgrade',sshUpgrade);
    await core.ssh?.close();
    await terminal?.close();
    for(const res of streams)res.end();
    // Headers and JSON bodies can remain unfinished forever. Keep sockets with dispatched work until responses close.
    for(const [socket,state] of sockets)if(state.dispatched===0)socket.destroy();
    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  })()};
}
