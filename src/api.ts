import type {BoardState} from './types';

const tokenKey = 'taskboard-token';
export const isDesktop = () => Boolean(window.taskboard);
export const getToken = () => sessionStorage.getItem(tokenKey) || '';
export const setToken = (value: string) => sessionStorage.setItem(tokenKey, value.trim());
export const clearToken = () => sessionStorage.removeItem(tokenKey);
// Browser reads must finish even when a mobile radio keeps a fetch pending.
// Writes are deliberately excluded: a timed-out POST could already have run.
export const browserReadDeadlineMs = 8000;
export class ReadTimeoutError extends Error {
  constructor(){super('连接状态待确认，请恢复连接后刷新。');this.name='ReadTimeoutError';}
}
export class ApiError extends Error {
  constructor(message:string, public status:number, public code?:string){super(message);this.name='ApiError';}
}
export function errorMessage(error:unknown){
  if(error instanceof ApiError&&['COMMAND_FENCED','CREATE_FENCED'].includes(error.code||''))return '上一次操作还没有明确结果。请先等待；若出现「结果待核实」，请到「需要我处理」中核对后再操作。';
  if(error instanceof TypeError&&/^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?|Network request failed)$/i.test(error.message))return '暂时连接不上服务器。恢复连接后，请先核对任务状态。';
  return error instanceof Error?error.message:'操作没有完成，请稍后重试。';
}

export async function redeemPairingCode(code:string):Promise<string>{
  const response=await fetch('/api/pairings/redeem',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
  const data=await response.json().catch(()=>({})) as {token?:string;error?:string};
  if(!response.ok||!data.token)throw new Error(data.error||'配对码无效或已过期。');
  return data.token;
}

export async function request<T>(method: string, path: string, body?: unknown, options?:{expectedPreviewActorId?:string}): Promise<T> {
  if (window.taskboard) {
    try { return await window.taskboard.request(method, path, body) as T; }
    catch(error) { throw error instanceof Error ? error : new Error(typeof error==='string' ? error : '桌面服务未能完成请求，请检查连接。'); }
  }
  const payload = body === undefined && !['GET','HEAD'].includes(method) ? {} : body;
  const controller=method==='GET'?new AbortController():null;
  const read=async()=>{
    const response = await fetch(path, {
      method,
      credentials:'same-origin',
      headers: {...(getToken()?{'Authorization': `Bearer ${getToken()}`}:{}) , ...(payload === undefined ? {} : {'Content-Type': 'application/json'}), ...(options?.expectedPreviewActorId?{'X-Preview-Actor-Id':options.expectedPreviewActorId}:{})},
      body: payload === undefined ? undefined : JSON.stringify(payload),
      ...(controller?{signal:controller.signal}:{}),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as {error?: string;code?:string};
      throw new ApiError(data.error || `请求失败（${response.status}）`,response.status,data.code);
    }
    return await response.json() as T;
  };
  if(!controller)return read();
  let timer:number|undefined;
  const deadline=new Promise<T>((_,reject)=>{timer=window.setTimeout(()=>{reject(new ReadTimeoutError());controller.abort();},browserReadDeadlineMs)});
  try{return await Promise.race([read(),deadline]);}
  finally{if(timer!==undefined)window.clearTimeout(timer);}
}

export const getState = () => request<BoardState>('GET', '/api/state');

export function subscribe(onChange: () => void, onConnection?: (connected: boolean) => void): () => void {
  if (window.taskboard) return window.taskboard.subscribe(onChange);
  const controller = new AbortController();
  let retry: number | undefined;
  let active = true;
  const connect = async () => {
    try {
      const response = await fetch('/api/events', {credentials:'same-origin',headers: getToken()?{Authorization: `Bearer ${getToken()}`}:{}, signal: controller.signal});
      if (!response.ok || !response.body) throw new Error('订阅中断');
      onConnection?.(true);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (active) {
        const {done, value} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, {stream: true});
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() || '';
        for (const part of parts) if (part.split(/\r?\n/).some(line => line.startsWith('data:'))) onChange();
      }
    } catch { /* reconnect after a temporary network interruption */ }
    if (active) onConnection?.(false);
    if (active) retry = window.setTimeout(connect, 3000);
  };
  void connect();
  return () => {active = false; controller.abort(); if (retry) window.clearTimeout(retry);};
}
