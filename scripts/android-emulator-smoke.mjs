#!/usr/bin/env node
// Runs only against the dedicated Seqivo Android emulator. Clears app data there.
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {createServer} from 'node:https';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sdk=process.env.ANDROID_SDK_ROOT;
const serial=process.env.SEQIVO_ANDROID_EMULATOR_SERIAL;
assert.ok(sdk,'Set ANDROID_SDK_ROOT to the isolated SDK');
assert.match(serial||'',/^emulator-[0-9]+$/,'Set SEQIVO_ANDROID_EMULATOR_SERIAL to the dedicated emulator');
const adb=path.join(sdk,'platform-tools','adb');
const apk=path.resolve(process.env.SEQIVO_ANDROID_APK||path.join(root,'.runtime/android/seqivo-debug.apk'));
const output=path.resolve(process.env.SEQIVO_ANDROID_SMOKE_OUTPUT||path.join(root,'.runtime/android/smoke'));
mkdirSync(output,{recursive:true});

function run(command,args,options={}) {
  return execFileSync(command,args,{encoding:options.binary?undefined:'utf8',maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']});
}
function device(...args) { return run(adb,['-s',serial,...args]).trim(); }
function shell(...args) { return device('shell',...args); }
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function snapshot(name) {
  shell('uiautomator','dump','/sdcard/seqivo-smoke.xml');
  const xml=device('exec-out','cat','/sdcard/seqivo-smoke.xml');
  writeFileSync(path.join(output,`${name}.xml`),xml);
  writeFileSync(path.join(output,`${name}.png`),run(adb,['-s',serial,'exec-out','screencap','-p'],{binary:true}));
  return xml;
}
function nodes(xml) {
  return [...xml.matchAll(/<node\s+([^>]*?)\s*\/>/g)].map(match=>{
    const attributes={};
    for (const item of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) attributes[item[1]]=item[2];
    return attributes;
  });
}
function click(xml,predicate) {
  const node=nodes(xml).find(predicate);
  assert.ok(node,'Expected UI control not found');
  const match=node.bounds?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  assert.ok(match,`Missing bounds for ${node.text||node.class}`);
  shell('input','tap',String(Math.round((Number(match[1])+Number(match[3]))/2)),String(Math.round((Number(match[2])+Number(match[4]))/2)));
}
function has(xml,text) { return nodes(xml).some(node=>node.text===text); }
async function waitFor(text,name,timeout=8000) {
  const until=Date.now()+timeout;
  do {
    const xml=snapshot(name);
    if(has(xml,text))return xml;
    await sleep(350);
  } while(Date.now()<until);
  throw new Error(`Timed out waiting for ${text}`);
}
async function fresh() {
  assert.equal(shell('pm','clear','app.seqivo.android'),'Success');
  shell('am','start','-n','app.seqivo.android/.MainActivity');
  return waitFor('连接序程','setup');
}
function enter(xml,value) {
  click(xml,node=>node.class==='android.widget.EditText');
  shell('input','text',value);
  const withInput=snapshot('entered');
  click(withInput,node=>node.class==='android.widget.Button'&&node.text==='连接');
}

assert.equal(shell('getprop','ro.kernel.qemu'),'1','Refusing a physical Android device');
assert.equal(shell('getprop','ro.boot.qemu.avd_name'),'seqivo_api35','Refusing another emulator');
assert.equal(shell('getprop','ro.build.version.sdk'),'35','Expected API 35 AVD');
console.log(`Verified isolated AVD ${serial}`);
console.log(device('install','-r',apk));

let xml=await fresh();
assert.ok(has(xml,'连接序程'));
click(xml,node=>node.class==='android.widget.EditText');
await sleep(400);
assert.match(shell('dumpsys','input_method'),/mInputShown=true/);
snapshot('keyboard');
shell('input','keyevent','4');
await sleep(300);
assert.match(shell('dumpsys','activity','activities'),/topResumedActivity=.*app\.seqivo\.android/);
console.log('Keyboard opens and Back dismisses it');

xml=await fresh();
enter(xml,'bad-origin');
xml=await waitFor('请输入完整的 HTTPS 地址，不含路径、账号或参数。','malformed');
assert.ok(has(xml,'连接序程'));
console.log('Malformed origin rejected');

xml=await fresh();
enter(xml,'http://example.invalid');
xml=await waitFor('请输入完整的 HTTPS 地址，不含路径、账号或参数。','http');
assert.ok(has(xml,'连接序程'));
console.log('HTTP origin rejected');

const key=path.join(output,'tls-key.pem');
const cert=path.join(output,'tls-cert.pem');
const generated=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-subj','/CN=10.0.2.2','-days','1','-addext','subjectAltName=IP:10.0.2.2'],{encoding:'utf8'});
assert.equal(generated.status,0,generated.stderr||'openssl failed');
const server=createServer({key:readFileSync(key),cert:readFileSync(cert)},(_request,response)=>{
  response.writeHead(200,{'Content-Type':'text/html'});
  response.end('<h1>Local TLS fixture</h1>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try {
  const origin=`https://10.0.2.2:${server.address().port}`;
  xml=await fresh();
  enter(xml,origin);
  xml=await waitFor('服务器证书未通过系统校验。请检查 HTTPS 地址和证书后重试。','tls-rejected',12000);
  assert.ok(!has(xml,'Local TLS fixture'));
  console.log('Untrusted HTTPS certificate rejected');

  const before=shell('pidof','app.seqivo.android');
  shell('am','force-stop','app.seqivo.android');
  shell('am','start','-n','app.seqivo.android/.MainActivity');
  xml=await waitFor('服务器证书未通过系统校验。请检查 HTTPS 地址和证书后重试。','process-recreated',12000);
  const after=shell('pidof','app.seqivo.android');
  assert.notEqual(before,after,'Process was not recreated');
  console.log('Persisted origin restored after process recreation');

  shell('input','keyevent','3');
  await sleep(350);
  assert.match(shell('dumpsys','activity','activities'),/topResumedActivity=.*launcher/);
  shell('am','start','-n','app.seqivo.android/.MainActivity');
  xml=await waitFor('连接未完成','foreground');
  assert.ok(has(xml,'更换服务器地址'));
  console.log('Background and foreground return succeeded');

  click(xml,node=>node.class==='android.widget.Button'&&node.text==='更换服务器地址');
  xml=await waitFor('连接序程','change-server');
  assert.ok(nodes(xml).some(node=>node.class==='android.widget.EditText'&&node.text===origin));
  shell('input','keyevent','4');
  await sleep(350);
  assert.doesNotMatch(shell('dumpsys','activity','activities'),/topResumedActivity=.*app\.seqivo\.android/);
  console.log('Saved address visible; Back exits from setup');
} finally {
  await new Promise(resolve=>server.close(resolve));
}
console.log(`All isolated emulator checks passed. Evidence: ${output}`);
