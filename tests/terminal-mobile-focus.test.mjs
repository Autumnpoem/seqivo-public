import test from 'node:test';
import assert from 'node:assert/strict';
import {canAutoRevealTerminal,isTerminalControlFocus} from '../src/lib/terminal-mobile-focus.ts';

const inCard=className=>({closest(selector){return selector.split(',').includes(`.${className}`)?{}:null;}});

test('IME closing while return notes or review control has focus cannot scroll to terminal',()=>{
  for(const card of ['terminal-control','terminal-transfer-panel']){
    const focused=inCard(card);
    assert.equal(isTerminalControlFocus(focused),true);
    assert.equal(canAutoRevealTerminal(true,false,focused),false);
    // focusin records viewing intent, retained when Tab moves focus and IME hides.
    const manualView=isTerminalControlFocus(focused);
    assert.equal(canAutoRevealTerminal(true,manualView,null),false);
  }
});

test('explicit connect or session selection can reveal after clearing manual-view intent',()=>{
  const terminalFocus=inCard('terminal-screen');
  assert.equal(isTerminalControlFocus(terminalFocus),false);
  assert.equal(canAutoRevealTerminal(true,true,terminalFocus),false);
  assert.equal(canAutoRevealTerminal(true,false,terminalFocus),true);
  assert.equal(canAutoRevealTerminal(false,false,terminalFocus),false);
});
