import test from 'node:test';
import assert from 'node:assert/strict';
import {focusTerminalEscapeTarget,handleTerminalFocusEscape} from '../src/lib/terminal-keyboard-escape.ts';

function key(overrides={}){
  const calls={prevented:0,stopped:0};
  return {calls,event:{type:'keydown',key:'Escape',code:'Escape',shiftKey:true,ctrlKey:false,altKey:false,
    metaKey:false,isComposing:false,preventDefault(){calls.prevented++;},stopPropagation(){calls.stopped++;},...overrides}};
}

test('Shift+Escape leaves xterm without forwarding bytes in ready, readonly or disconnected state',()=>{
  for(const state of ['ready','readonly','disconnected']){
    const {event,calls}=key();let focused=0,emitted=0;
    const accepted=handleTerminalFocusEscape(event,()=>{focused++;});
    if(!accepted)emitted++;
    assert.equal(accepted,true,state);assert.equal(focused,1,state);assert.equal(emitted,0,state);
    assert.deepEqual(calls,{prevented:1,stopped:1});
  }
  const {event,calls}=key({type:'keyup'});let focused=0;
  assert.equal(handleTerminalFocusEscape(event,()=>focused++),true);
  assert.equal(focused,0);assert.deepEqual(calls,{prevented:1,stopped:1});
});

test('ordinary Tab, unmodified Escape and composing keys remain xterm input',()=>{
  for(const overrides of [{key:'Tab',code:'Tab'}, {shiftKey:false}, {isComposing:true},
    {ctrlKey:true}, {altKey:true}, {metaKey:true}]){
    const {event,calls}=key(overrides);let focused=0;
    assert.equal(handleTerminalFocusEscape(event,()=>focused++),false);
    assert.equal(focused,0);assert.deepEqual(calls,{prevented:0,stopped:0});
  }
});

test('only an enabled session button is preferred; unavailable sessions focus neutral help',()=>{
  let session=0,neutral=0;
  const button={disabled:false,focus(){session++;}};
  const help={focus(){neutral++;}};
  focusTerminalEscapeTarget(button,help);
  assert.deepEqual({session,neutral},{session:1,neutral:0});
  button.disabled=true;
  focusTerminalEscapeTarget(button,help);
  focusTerminalEscapeTarget(null,help);
  assert.deepEqual({session,neutral},{session:1,neutral:2});
});
