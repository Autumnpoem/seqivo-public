// Called from xterm's custom key handler before xterm turns a key into data.
export function handleTerminalFocusEscape(event:KeyboardEvent,focusOutside:()=>void):boolean {
  if(!event.shiftKey||event.ctrlKey||event.altKey||event.metaKey||event.isComposing||
    !(event.code==='Escape'||event.key==='Escape'||event.key==='Esc'))return false;
  event.preventDefault();
  event.stopPropagation();
  if(event.type==='keydown')focusOutside();
  return true;
}

export function focusTerminalEscapeTarget(
  sessionButton:{disabled:boolean;focus:()=>void}|null,
  neutralHelp:{focus:()=>void}|null,
):void {
  if(sessionButton&&!sessionButton.disabled)sessionButton.focus();
  else neutralHelp?.focus();
}
