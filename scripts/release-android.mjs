#!/usr/bin/env node
// Build and sign the ordinary Android release without touching installed apps.
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const android = join(repo, 'android');
const output = join(repo, '.runtime/mobile1113');
const keyDir = join(homedir(), '.local/share/seqivo-release-signing/android');
const defaultKey = join(keyDir, 'seqivo-publisher.p12');
const defaultPass = join(keyDir, 'password');
const versionCode = '15';
const versionName = '0.4.1';
const alias = 'seqivo';
process.umask(0o077);

function fail(message) { throw new Error(message); }
function sha(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: android, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    timeout: 20 * 60 * 1000, ...options,
  });
  if (result.error) fail(`${executable} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`${executable} exited ${result.status}; see local build log if available`);
  return result.stdout + result.stderr;
}
function toolchain() {
  const javaHome = process.env.JAVA_HOME || join(repo, '.runtime/android/jdk/Contents/Home');
  const sdkRoot = process.env.ANDROID_SDK_ROOT || join(repo, '.runtime/android/sdk');
  const gradle = process.env.SEQIVO_ANDROID_GRADLE || join(repo, '.runtime/android/gradle-8.9/bin/gradle');
  const tools = join(sdkRoot, 'build-tools/35.0.0');
  for (const file of [join(javaHome, 'bin/java'), join(javaHome, 'bin/keytool'),
    join(sdkRoot, 'platforms/android-35/android.jar'), gradle,
    join(tools, 'aapt'), join(tools, 'apksigner'), join(tools, 'zipalign')]) {
    if (!existsSync(file)) fail(`required build tool missing: ${file}`);
  }
  const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_SDK_ROOT: sdkRoot };
  delete env.SEQIVO_ANDROID_DEFAULT_ORIGIN;
  delete env.SEQIVO_ANDROID_TEST_CA;
  return { javaHome, gradle, tools, env };
}
function protectedPassfile(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid())
    fail('signing passfile must be an owner-only regular file');
  const value = readFileSync(path, 'utf8').trim();
  if (value.length < 24) fail('signing passfile is too short');
  return value;
}
function signingEnv(base, password) {
  return { ...base, SEQIVO_ANDROID_KEY_PASSWORD: password };
}
function certFingerprint(javaHome, key, env) {
  const report = run(join(javaHome, 'bin/keytool'), ['-list', '-v', '-keystore', key,
    '-storepass:env', 'SEQIVO_ANDROID_KEY_PASSWORD', '-alias', alias], { env });
  const match = report.match(/SHA256:\s*([0-9A-F:]{95})/i);
  if (!match) fail('publisher certificate fingerprint not found');
  return match[1].toUpperCase();
}
function scanApk(apk, license, notice) {
  const code = String.raw`
import pathlib,re,sys,zipfile
apk,license,notice=sys.argv[1:]
home=pathlib.Path.home()
private=re.compile(rb'(?<![0-9])(?:10\.(?:[0-9]{1,3}\.){2}[0-9]{1,3}|192\.168\.(?:[0-9]{1,3}\.)[0-9]{1,3}|172\.(?:1[6-9]|2[0-9]|3[01])\.(?:[0-9]{1,3}\.)[0-9]{1,3})(?![0-9])')
with zipfile.ZipFile(apk) as z:
    names=set(z.namelist())
    assert 'assets/LICENSE' in names and 'assets/NOTICE.md' in names
    assert z.read('assets/LICENSE')==pathlib.Path(license).read_bytes()
    assert z.read('assets/NOTICE.md')==pathlib.Path(notice).read_bytes()
    hits=0
    for name in names:
        if name.endswith('/'):continue
        data=z.read(name)
        hits+=data.count(str(home).encode())+data.count(home.name.encode())
        hits+=len(private.findall(data))
    assert hits==0, 'private path or address detected in APK'
print('APK legal assets and privacy scan passed:',len(names),'entries')`;
  const result = spawnSync('python3', ['-c', code, apk, license, notice],
    { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 120000 });
  if (result.error || result.status !== 0) fail('APK legal assets or privacy scan failed');
  return result.stdout.trim();
}
function initKey() {
  const { javaHome, env } = toolchain();
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  chmodSync(keyDir, 0o700);
  if (existsSync(defaultKey) || existsSync(defaultPass)) fail('dedicated publisher key or passfile already exists; refusing overwrite');
  const password = randomBytes(36).toString('base64url');
  const fd = openSync(defaultPass, 'wx', 0o600);
  try { writeFileSync(fd, password + '\n'); } finally { closeSync(fd); }
  const secretEnv = signingEnv(env, password);
  run(join(javaHome, 'bin/keytool'), ['-genkeypair', '-alias', alias,
    '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000',
    '-dname', 'CN=Seqivo,O=Autumnpoem', '-storetype', 'PKCS12',
    '-keystore', defaultKey, '-storepass:env', 'SEQIVO_ANDROID_KEY_PASSWORD',
    '-keypass:env', 'SEQIVO_ANDROID_KEY_PASSWORD', '-noprompt'], { env: secretEnv });
  chmodSync(defaultKey, 0o600);
  const fingerprint = certFingerprint(javaHome, defaultKey, secretEnv);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  writeFileSync(join(output, 'publisher-public.json'), JSON.stringify({
    schema: 'mobile1113.publisher.v1', alias, certificateSha256: fingerprint,
    keyLocation: '~/.local/share/seqivo-release-signing/android/seqivo-publisher.p12',
    passfileLocation: '~/.local/share/seqivo-release-signing/android/password',
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`Dedicated publisher key created. Public certificate SHA-256: ${fingerprint}`);
}
function build() {
  const { javaHome, gradle, tools, env } = toolchain();
  const key = process.env.SEQIVO_ANDROID_SIGNING_KEYSTORE || defaultKey;
  const passfile = process.env.SEQIVO_ANDROID_SIGNING_PASSFILE || defaultPass;
  if (!existsSync(key) || !existsSync(passfile)) fail('signing key and protected passfile are required');
  const keyInfo = lstatSync(key);
  if (!keyInfo.isFile() || keyInfo.isSymbolicLink()) fail('signing keystore must be a regular file');
  const secretEnv = signingEnv(env, protectedPassfile(passfile));
  const fingerprint = certFingerprint(javaHome, key, secretEnv);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const apk = join(output, `Seqivo-${versionName}-android.apk`);
  const aligned = join(output, 'aligned-unsigned.apk');
  const receipt = join(output, 'build-result.json');
  if ([apk, aligned, receipt].some(existsSync)) fail('release output already exists; inspect before retry');
  const log = join(output, 'gradle-release.log');
  const result = spawnSync(gradle, ['--no-daemon', ':app:testReleaseUnitTest', ':app:lintRelease',
    ':app:assembleRelease', `-PseqivoVersionCode=${versionCode}`],
  { cwd: android, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 25 * 60 * 1000 });
  writeFileSync(log, `${result.stdout || ''}${result.stderr || ''}`, { mode: 0o600 });
  if (result.error || result.status !== 0) fail(`Gradle release build failed; see ${log}`);
  const unsigned = join(android, 'app/build/outputs/apk/release/app-release-unsigned.apk');
  if (!existsSync(unsigned)) fail('unsigned release APK missing');
  run(join(tools, 'zipalign'), ['-f', '4', unsigned, aligned], { env });
  run(join(tools, 'apksigner'), ['sign', '--ks', key, '--ks-key-alias', alias,
    '--ks-pass', 'env:SEQIVO_ANDROID_KEY_PASSWORD', '--key-pass', 'env:SEQIVO_ANDROID_KEY_PASSWORD',
    '--out', apk, aligned], { env: secretEnv });
  const signature = run(join(tools, 'apksigner'), ['verify', '--verbose', '--print-certs', apk], { env });
  const signer = signature.match(/Signer #1 certificate SHA-256 digest:\s*([0-9a-f]{64})/i)?.[1];
  if (!signer || signer.toUpperCase() !== fingerprint.replaceAll(':', '')) fail('APK signer certificate differs from dedicated publisher key');
  const badging = run(join(tools, 'aapt'), ['dump', 'badging', apk], { env });
  if (!badging.includes(`package: name='app.seqivo.android' versionCode='${versionCode}' versionName='${versionName}'`) ||
      !badging.includes("sdkVersion:'26'")) fail('APK package identity or minimum SDK differs');
  const manifest = run(join(tools, 'aapt'), ['dump', 'xmltree', apk, 'AndroidManifest.xml'], { env });
  const resources = run(join(tools, 'aapt'), ['dump', 'resources', apk], { env });
  if (/android:debuggable.*(?:0xffffffff|0x1\b)/i.test(manifest) ||
      manifest.includes('networkSecurityConfig') || resources.includes('seqivo_test_ca'))
    fail('APK is debuggable or contains fixture network configuration');
  const config = join(android, 'app/build/generated/source/buildConfig/release/app/seqivo/android/BuildConfig.java');
  if (!existsSync(config) || !readFileSync(config, 'utf8').includes('DEFAULT_ORIGIN = "";'))
    fail('release BuildConfig has a default origin');
  console.log(scanApk(apk, join(repo, 'LICENSE'), join(repo, 'NOTICE.md')));
  const receiptData = {
    schema: 'mobile1113.android-release.v1', versionName, versionCode: Number(versionCode),
    packageId: 'app.seqivo.android', minSdk: 26, debuggable: false, defaultOrigin: '',
    testCaBundled: false, certificateSha256: fingerprint, apkSha256: sha(apk),
    licenseSha256: sha(join(repo, 'LICENSE')), noticeSha256: sha(join(repo, 'NOTICE.md')),
    apk: `Seqivo-${versionName}-android.apk`,
  };
  writeFileSync(receipt, JSON.stringify(receiptData, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(receiptData));
  console.log(`Gradle log: ${log}`);
}

const action = process.argv[2];
if (process.argv.length !== 3 || !['init-key', 'build'].includes(action))
  fail('usage: node scripts/release-android.mjs init-key|build');
if (action === 'init-key') initKey(); else build();
