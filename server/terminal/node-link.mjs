import {WebSocket} from 'ws';

/** Separate outbound transport; reuses the configured node identity without exposing its token. */
export function createTerminalNodeLink({manager,credentials,emit=()=>{}}){
  let closed=false,ws=null,key=null,generation=0,status='disconnected',ownerUserId=null,epoch=null,attachmentCloseV1=false;
  let timer=null,refreshing=null,mutations=Promise.resolve();
  const requests=new Set(),connections=new Map(),retiredConnections=new Set();
  const state=()=>({status,nodeId:credentials()?.nodeId,ownerUserId});
  const emitState=next=>{if(status!==next){status=next;emit();}};
  function current(){const value=credentials();if(!value?.url||!value.token||!value.nodeId)return null;const url=new URL(value.url);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw Error('HTTPS required');return value;}
  async function network(method,path,body){
    const identity=current();if(!identity)throw Error('请先连接服务器');
    const abort=new AbortController();requests.add(abort);const timeout=setTimeout(()=>abort.abort(),5000);
    try{
      const response=await fetch(identity.url+path,{method,redirect:'error',signal:abort.signal,
        headers:{Authorization:`Bearer ${identity.token}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
      const reader=response.body?.getReader(),chunks=[];let size=0;
      if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>262144){await reader.cancel();throw Error('终端响应过大');}chunks.push(Buffer.from(value));}
      const result=JSON.parse(Buffer.concat(chunks).toString()||'{}');
      if(!response.ok){const error=new Error(result.error||'终端授权请求失败');error.code=result.code;error.status=response.status;throw error;}
      const latest=current();if(closed||latest?.nodeId!==identity.nodeId||latest?.token!==identity.token)throw Error('服务器连接已变化');
      return result;
    }finally{clearTimeout(timeout);requests.delete(abort);}
  }
  function stopSocket(){
    generation++;epoch=null;ownerUserId=null;attachmentCloseV1=false;
    const old=ws;ws=null;if(old)old.terminate();
    for(const connection of connections.values())connection.active=false;
    connections.clear();
    retiredConnections.clear();
    // Retire attachments but never kill a user's tmux server or session.
    void manager.closeRemote().catch(()=>{emitState('close_failed');});
  }
  function schedule(){if(closed)return;clearTimeout(timer);timer=setTimeout(()=>void refresh(),2000);timer.unref();}
  async function refresh(){
    if(closed)return;if(refreshing)return refreshing;
    refreshing=(async()=>{
      const identity=current(),profiles=manager.profiles();
      const nextKey=identity&&profiles.length?JSON.stringify([identity.url,identity.nodeId,identity.token,profiles]):null;
      if(nextKey===key&&ws&&[WebSocket.OPEN,WebSocket.CONNECTING].includes(ws.readyState))return;
      stopSocket();key=nextKey;
      if(!nextKey){emitState('disconnected');return;}
      const linkGeneration=generation,url=new URL('/api/terminal/node',identity.url);url.protocol=url.protocol==='https:'?'wss:':'ws:';
      const socket=new WebSocket(url,{maxPayload:65536,perMessageDeflate:false,handshakeTimeout:5000});ws=socket;emitState('connecting');
      let authTimer=setTimeout(()=>socket.terminate(),5000);authTimer.unref();
      const isCurrent=()=>!closed&&generation===linkGeneration&&ws===socket;
      const send=frame=>{if(!isCurrent()||socket.readyState!==WebSocket.OPEN)return;if(socket.bufferedAmount>1_048_576){socket.terminate();return;}socket.send(JSON.stringify(frame));};
      const retireAttachment=(connectionId,frame)=>{
        // The Hub permits at most 16 live attachments per node. A much larger
        // retired set means close notifications are not arriving; stop the
        // link instead of retaining an unbounded set or reviving stale input.
        if(!retiredConnections.has(connectionId)&&retiredConnections.size>=64){socket.close(4003,'Too many retired attachments');return;}
        retiredConnections.add(connectionId);
        if(attachmentCloseV1)send({type:'terminal-attachment-close',v:1,connectionId,code:'INPUT_OVERLOADED'});
        else {
          // A previous Hub does not understand the new top-level event. Its
          // existing terminal frames still lock the browser without retiring
          // the shared node socket.
          send({type:'terminal',v:1,connectionId,frame:{type:'error',v:1,code:'INPUT_OVERLOADED',message:'输入积压，当前附件已停止。请重新连接核对。'}});
          if(Number.isSafeInteger(frame?.epoch)&&frame.epoch>0)
            send({type:'terminal',v:1,connectionId,frame:{type:'exit',v:1,epoch:frame.epoch,reason:'input_overloaded'}});
        }
        void manager.closeConnection(connectionId).catch(()=>{emitState('close_failed');});
      };
      socket.on('open',()=>send({type:'auth',v:1,nodeId:identity.nodeId,token:identity.token,profiles}));
      socket.on('error',()=>{if(isCurrent())emitState('offline');});
      socket.on('message',(raw,binary)=>{
        if(!isCurrent())return;
        try{
          if(binary)throw Error('Binary frame');const message=JSON.parse(raw.toString());if(message.v!==1)throw Error('Version');
          if(message.type==='ready'){
            if(message.nodeId!==identity.nodeId||!Number.isSafeInteger(message.epoch)||message.epoch!==identity.epoch)throw Error('Node changed');
            epoch=message.epoch;ownerUserId=typeof message.ownerUserId==='string'?message.ownerUserId:null;
            attachmentCloseV1=message.attachmentCloseV1===true;
            if(ownerUserId)void manager.bindOwner({nodeId:identity.nodeId,userId:ownerUserId}).catch(()=>{});
            clearTimeout(authTimer);emitState('online');return;
          }
          if(!epoch)throw Error('Not authenticated');
          if(['terminal-close','terminal-suspend'].includes(message.type)){
            const c=connections.get(message.connectionId);if(c)c.active=false;connections.delete(message.connectionId);
            retiredConnections.delete(message.connectionId);
            if(message.type==='terminal-close')void manager.closeConnection(message.connectionId).catch(()=>{});
            else manager.disconnect(message.connectionId,30_000);
            return;
          }
          if(message.type!=='terminal'||message.nodeEpoch!==epoch||typeof message.connectionId!=='string'||!message.frame)throw Error('Invalid terminal envelope');
          if(retiredConnections.has(message.connectionId))return;
          let connection=connections.get(message.connectionId);
          if(!connection){
            if(connections.size>=16){
              retireAttachment(message.connectionId,message.frame);
              return;
            }
            connection={active:true,pending:0};connections.set(message.connectionId,connection);
          }
          if(connection.pending>=32){
            // One slow attachment must not retire the node or another user's
            // attachment. Invalidate every queued frame before its final write.
            connection.active=false;connections.delete(message.connectionId);
            retireAttachment(message.connectionId,message.frame);
            return;
          }
          connection.pending++;
          const ctx={nodeId:identity.nodeId,nodeEpoch:epoch,connectionId:message.connectionId,deviceId:message.deviceId,userId:message.userId,profileId:message.profileId,grantRevision:message.grantRevision,
            isCurrent:()=>isCurrent()&&connection.active&&connections.get(message.connectionId)===connection};
          const reply=frame=>{if(ctx.isCurrent())send({type:'terminal',v:1,connectionId:ctx.connectionId,frame});};
          manager.frame(ctx,message.frame,reply).catch(error=>reply({type:'error',v:1,code:error.code||'TERMINAL_FAILED',message:error.message})).finally(()=>{connection.pending--;});
        }catch{socket.close(4003,'Terminal protocol rejected');}
      });
      socket.on('close',()=>{clearTimeout(authTimer);if(!isCurrent())return;stopSocket();key=null;emitState('offline');schedule();});
    })().catch(()=>{emitState('offline');}).finally(()=>{refreshing=null;schedule();});
    return refreshing;
  }
  const link={state,refresh,pending:()=>network('GET','/api/node/terminal/pending'),
    grant:body=>{const next=mutations.then(()=>network('POST','/api/node/terminal/grants',body));mutations=next.catch(()=>{});return next;},
    async close(){if(closed)return;closed=true;clearTimeout(timer);for(const request of requests)request.abort();stopSocket();await refreshing;await mutations;}
  };
  schedule();return link;
}
