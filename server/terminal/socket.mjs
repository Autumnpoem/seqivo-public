import {WebSocket,WebSocketServer} from 'ws';

/** Loopback transport: a one-use owner ticket is sent in the first frame, never the URL. */
export function attachLocalTerminalServer({server,manager,policy}){
  const wss=new WebSocketServer({noServer:true,maxPayload:65536,perMessageDeflate:false,clientTracking:false});
  const sockets=new Set(),sessions=new Map();let closed=false;
  const send=(ws,frame)=>{
    if(ws.readyState!==WebSocket.OPEN)return;
    if(ws.bufferedAmount>1_048_576){ws.close(4008,'Slow consumer');return;}
    ws.send(JSON.stringify(frame));
  };
  function connected(ws){
    sockets.add(ws);let ctx=null,alive=true,pending=0,count=0,bytes=0,windowStart=Date.now();
    const timer=setTimeout(()=>ws.close(4001,'Authentication timeout'),5000);timer.unref();
    ws.on('error',()=>{});
    ws.on('message',(raw,binary)=>{
      try{
        if(binary)throw Error('INVALID_FRAME');
        if(Date.now()-windowStart>=1000){windowStart=Date.now();count=0;bytes=0;}
        if(++count>150||(bytes+=raw.length)>1_048_576||pending>=32)throw Error('RATE_LIMIT');
        const frame=JSON.parse(raw.toString());
        if(!frame||typeof frame!=='object'||frame.v!==1)throw Error('INVALID_FRAME');
        if(!ctx){
          if(frame.type!=='auth')throw Error('UNAUTHORIZED');
          const ticket=manager.consumeTicket(frame.ticket);
          const prior=sessions.get(ticket.connectionId);if(prior)prior.close(4001,'Connection replaced');
          ctx={...ticket,isCurrent:()=>alive&&sessions.get(ticket.connectionId)===ws};
          sessions.set(ctx.connectionId,ws);clearTimeout(timer);
          send(ws,{type:'authenticated',v:1,connectionId:ctx.connectionId});return;
        }
        if(frame.connectionId!==undefined&&frame.connectionId!==ctx.connectionId||frame.profileId!==undefined&&frame.profileId!==ctx.profileId)throw Error('BINDING_MISMATCH');
        pending++;
        manager.frame(ctx,frame,data=>{if(ctx.isCurrent())send(ws,data);}).catch(error=>{
          if(ctx.isCurrent())send(ws,{type:'error',v:1,code:error.code||'TERMINAL_FAILED',message:error.message});
        }).finally(()=>{pending--;});
      }catch(error){send(ws,{type:'error',v:1,code:error.code||'INVALID_FRAME',message:'终端连接验证失败，请重新连接。'});ws.close(4003,'Terminal denied');}
    });
    ws.on('close',()=>{alive=false;clearTimeout(timer);sockets.delete(ws);if(ctx&&sessions.get(ctx.connectionId)===ws){sessions.delete(ctx.connectionId);manager.disconnect(ctx.connectionId);}});
  }
  const upgrade=(req,socket,head)=>{
    if(new URL(req.url,'http://localhost').pathname==='/api/ssh/ws')return;
    try{
      const url=new URL(req.url,'http://localhost'),allowed=policy();
      if(closed||url.pathname!=='/api/terminal/ws'||url.search||!allowed.hosts.has(req.headers.host)||!req.headers.origin||!allowed.origins.has(req.headers.origin)||sockets.size>=32)throw Error('Upgrade denied');
      wss.handleUpgrade(req,socket,head,connected);
    }catch{socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');}
  };
  server.on('upgrade',upgrade);
  return {async close(){if(closed)return;closed=true;server.off('upgrade',upgrade);for(const ws of sockets)ws.terminate();await new Promise(resolve=>wss.close(resolve));}};
}
