/** Preview links must remain a single, relative, capability-bound entry point. */
export function previewSiteCapability(value:unknown,previewId:string):string|null{
  if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||/[\\\s#?]/.test(value)||/%(?:2f|5c|00)/i.test(value))return null;
  const prefix=`/api/previews/${encodeURIComponent(previewId)}/site/`;
  if(!value.startsWith(prefix))return null;
  const match=/^([A-Za-z0-9_-]{32,100})\/index\.html$/.exec(value.slice(prefix.length));
  return match?.[1]||null;
}

/** This is a transport hint, never an authentication decision. */
export function desktopPreviewOrigin(value:unknown):string|null{
  if(!value||typeof value!=='object'||!('kind'in value)||(value as {kind?:unknown}).kind!=='desktop-loopback')return null;
  const origin='origin'in value?(value as {origin?:unknown}).origin:null;
  if(typeof origin!=='string')return null;
  const match=/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(origin);
  if(!match||Number(match[1])>65535)return null;
  try{
    const parsed=new URL(origin);
    return parsed.origin===origin&&parsed.pathname==='/'&&!parsed.username&&!parsed.password&&!parsed.search&&!parsed.hash?origin:null;
  }catch{return null;}
}

export function previewSiteUrl(value:unknown,previewId:string,trustedOrigin:string):string|null{
  if(!previewSiteCapability(value,previewId))return null;
  try{
    const url=new URL(value as string,trustedOrigin);
    return url.origin===trustedOrigin&&url.pathname===value&&url.search===''&&url.hash===''?url.href:null;
  }catch{return null;}
}
