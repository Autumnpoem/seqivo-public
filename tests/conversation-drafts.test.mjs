import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = await readFile(new URL('../src/conversation-drafts.ts', import.meta.url), 'utf8');
const compiled = stripTypeScriptTypes(source, { mode: 'transform' });
const {
  conversationDraftKey,
  readConversationDraft,
  saveConversationDraft,
  removeSubmittedConversationDraft,
  clearConversationDrafts,
} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

class MemoryStorage {
  values = new Map();
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(String(key)) ?? null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
  clear() { this.values.clear(); }
}

const empty = { title: '', message: '' };
const key = (account = 'account-a', project = 'project-a', task = 'task-a') =>
  conversationDraftKey(account, project, task);

test('a draft key requires account and project but supports the new-task slot', () => {
  assert.equal(conversationDraftKey('', 'project-a', 'task-a'), null);
  assert.equal(conversationDraftKey('account-a', '', 'task-a'), null);
  assert.equal(typeof key('account-a', 'project-a', ''), 'string');
  assert.notEqual(key('account-a', 'project-a', ''), key());
  assert.notEqual(key('a:b', 'c', ''), key('a', 'b:c', ''));
});

test('account, project, task and new-task drafts remain isolated', () => {
  const storage = new MemoryStorage();
  const variants = [key(), key('account-b'), key('account-a', 'project-b'),
    key('account-a', 'project-a', 'task-b'), key('account-a', 'project-a', '')];
  for (const [index, draftKey] of variants.entries()) {
    assert.equal(saveConversationDraft(storage, draftKey, { title: `title-${index}`, message: `message-${index}` }), true);
  }
  for (const [index, draftKey] of variants.entries()) {
    assert.deepEqual(readConversationDraft(storage, draftKey),
      { title: `title-${index}`, message: `message-${index}` });
  }
  assert.deepEqual(readConversationDraft(storage, key('account-c')), empty);
});

test('saved drafts survive a new reader and empty values delete only their key', () => {
  const storage = new MemoryStorage();
  const first = key();
  const other = key('account-a', 'project-a', 'task-b');
  assert.equal(saveConversationDraft(storage, first, { title: 'unfinished', message: 'keep this' }), true);
  assert.equal(saveConversationDraft(storage, other, { title: '', message: 'other task' }), true);
  assert.deepEqual(readConversationDraft(storage, first), { title: 'unfinished', message: 'keep this' });
  assert.equal(saveConversationDraft(storage, first, empty), true);
  assert.equal(storage.getItem(first), null);
  assert.deepEqual(readConversationDraft(storage, first), empty);
  assert.deepEqual(readConversationDraft(storage, other), { title: '', message: 'other task' });
});

test('invalid and oversized stored drafts read as empty', () => {
  const storage = new MemoryStorage();
  const draftKey = key();
  for (const raw of ['not JSON', '[]', '{}', JSON.stringify({ title: 4, message: 'text' }),
    JSON.stringify({ title: 'x'.repeat(241), message: '' }),
    JSON.stringify({ title: '', message: 'x'.repeat(10001) })]) {
    storage.setItem(draftKey, raw);
    assert.deepEqual(readConversationDraft(storage, draftKey), empty);
  }
});

test('storage failures are reported without losing the current in-memory draft', () => {
  const storage = new MemoryStorage();
  storage.setItem = () => { throw new Error('quota'); };
  assert.equal(saveConversationDraft(storage, key(), { title: 'draft', message: 'still editing' }), false);
  storage.getItem = () => { throw new Error('storage denied'); };
  assert.deepEqual(readConversationDraft(storage, key()), empty);
  assert.equal(removeSubmittedConversationDraft(storage, key(), { title: 'draft', message: 'still editing' }), false);
  assert.equal(saveConversationDraft(storage, null, { title: 'draft', message: 'still editing' }), false);
});

test('late submission confirmation removes only the exact submitted snapshot', () => {
  const storage = new MemoryStorage();
  const first = key();
  const other = key('account-a', 'project-a', 'task-b');
  const submitted = { title: 'first', message: 'send this' };
  const revised = { title: 'first', message: 'new text after send' };
  assert.equal(saveConversationDraft(storage, first, submitted), true);
  assert.equal(saveConversationDraft(storage, other, submitted), true);
  assert.equal(saveConversationDraft(storage, first, revised), true);
  assert.equal(removeSubmittedConversationDraft(storage, first, submitted), false);
  assert.deepEqual(readConversationDraft(storage, first), revised);
  assert.deepEqual(readConversationDraft(storage, other), submitted);
  assert.equal(removeSubmittedConversationDraft(storage, first, revised), true);
  assert.deepEqual(readConversationDraft(storage, first), empty);
  assert.deepEqual(readConversationDraft(storage, other), submitted);
});

test('clearing an account removes only that account’s draft keys', () => {
  const storage = new MemoryStorage();
  const own = [key(), key('account-a', 'project-b', ''), key('account-a', 'project-b', 'task-b')];
  const other = key('account-b');
  for (const draftKey of [...own, other])
    assert.equal(saveConversationDraft(storage, draftKey, { title: 'saved', message: 'saved' }), true);
  storage.setItem('unrelated-app-data', 'keep');
  assert.equal(clearConversationDrafts(storage, 'account-a'), true);
  for (const draftKey of own) assert.deepEqual(readConversationDraft(storage, draftKey), empty);
  assert.deepEqual(readConversationDraft(storage, other), { title: 'saved', message: 'saved' });
  assert.equal(storage.getItem('unrelated-app-data'), 'keep');
});

test('the actual hook keeps a submitted draft visible when storage removal fails', async () => {
  const storage = new MemoryStorage();
  const draftKey = key();
  const draft = { title: 'Unsent title', message: 'Keep editing after failed removal' };
  assert.equal(saveConversationDraft(storage, draftKey, draft), true);
  const slots = [];
  let cursor = 0;
  const useState = initial => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], value => { slots[index] = value; }];
  };
  const useRef = initial => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = { current: initial };
    return slots[index];
  };
  const hookSource = (await readFile(new URL('../src/lib/use-conversation-draft.ts', import.meta.url), 'utf8'))
    .replace("import {useRef,useState} from 'react';", '')
    .replace("import {readConversationDraft,saveConversationDraft,removeSubmittedConversationDraft,type ConversationDraft} from '../conversation-drafts';", '');
  const hookCompiled = stripTypeScriptTypes(hookSource, { mode: 'transform' });
  const previousWindow = globalThis.window;
  const previousHarness = globalThis.__draftHookHarness;
  globalThis.window = { localStorage: storage };
  globalThis.__draftHookHarness = { useRef, useState, readConversationDraft,
    saveConversationDraft, removeSubmittedConversationDraft };
  try {
    const wrapped = 'const {useRef,useState,readConversationDraft,saveConversationDraft,' +
      'removeSubmittedConversationDraft}=globalThis.__draftHookHarness;\n' + hookCompiled;
    const { useConversationDraft } = await import(`data:text/javascript;base64,${Buffer.from(wrapped).toString('base64')}`);
    const render = () => { cursor = 0; return useConversationDraft(draftKey); };
    let view = render();
    assert.deepEqual(view.value, draft);
    const submitted = view.capture();
    storage.removeItem = () => { throw new Error('storage removal denied'); };
    view.clearSubmitted(submitted);
    view = render();
    assert.deepEqual(view.value, draft, 'failed deletion must not clear the displayed draft');
    assert.deepEqual(readConversationDraft(storage, draftKey), draft);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousHarness === undefined) delete globalThis.__draftHookHarness;
    else globalThis.__draftHookHarness = previousHarness;
  }
});
