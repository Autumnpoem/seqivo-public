const controlSelector='.terminal-control,.terminal-transfer-panel';

export function isTerminalControlFocus(target:unknown):boolean {
  if(!target||typeof target!=='object')return false;
  const element=target as {closest?:(selector:string)=>unknown};
  return typeof element.closest==='function'&&Boolean(element.closest(controlSelector));
}

export function canAutoRevealTerminal(canReveal:boolean,manualView:boolean,activeElement:unknown):boolean {
  return canReveal&&!manualView&&!isTerminalControlFocus(activeElement);
}
