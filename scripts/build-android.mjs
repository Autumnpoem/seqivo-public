#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const android = join(repo, 'android');
const output = join(repo, '.runtime', 'android', 'deliverables');

function fail(message) {
  console.error(`Android build: ${message}`);
  process.exit(1);
}

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: android,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error) fail(`${executable}: ${result.error.message}`);
  return result;
}

const args = process.argv.slice(2);
if (args.length !== 2 && args.length !== 4) {
  fail('usage: node scripts/build-android.mjs --version-code N [--gradle /path/to/gradle]');
}
let versionCode;
let gradle = process.env.SEQIVO_ANDROID_GRADLE || 'gradle';
const seen = new Set();
for (let i = 0; i < args.length; i += 2) {
  if (!args[i + 1] || seen.has(args[i])) fail('missing value or duplicate option');
  seen.add(args[i]);
  if (args[i] === '--version-code') versionCode = args[i + 1];
  else if (args[i] === '--gradle') gradle = resolve(args[i + 1]);
  else fail('unrecognized or duplicate option');
}
if (!/^[1-9][0-9]{0,8}$/.test(versionCode || '')) fail('--version-code must be a positive integer of at most nine digits');

const javaHome = process.env.JAVA_HOME;
const sdkRoot = process.env.ANDROID_SDK_ROOT;
if (!javaHome || !existsSync(join(javaHome, 'bin', 'java')) || !existsSync(join(javaHome, 'bin', 'javac')))
  fail('set JAVA_HOME to a JDK 17 installation');
if (!sdkRoot || !existsSync(join(sdkRoot, 'platforms', 'android-35', 'android.jar')))
  fail('set ANDROID_SDK_ROOT to an SDK with Platform 35');
const buildTools = join(sdkRoot, 'build-tools', '35.0.0');
const aapt = join(buildTools, 'aapt');
const apksigner = join(buildTools, 'apksigner');
if (!existsSync(aapt) || !existsSync(apksigner)) fail('install Android Build Tools 35.0.0');
const javaVersion = command(join(javaHome, 'bin', 'java'), ['-version']);
if (!/^\s*(?:openjdk|java) version "17(?:\.|\")/m.test(javaVersion.stderr)) fail('JDK 17 is required');
const debugKey = join(process.env.ANDROID_USER_HOME || join(homedir(), '.android'), 'debug.keystore');
if (!existsSync(debugKey)) fail('an existing Android debug.keystore is required; this script will not create a signing key');
const keyHash = createHash('sha256').update(readFileSync(debugKey)).digest('hex');

mkdirSync(output, { recursive: true });
const log = join(output, `build-v${versionCode}.log`);
const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_SDK_ROOT: sdkRoot };
// A deliverable must start at address entry and must never stage the isolated test CA.
delete env.SEQIVO_ANDROID_DEFAULT_ORIGIN;
delete env.SEQIVO_ANDROID_TEST_CA;
const build = command(gradle, [
  '--no-daemon', ':app:testDebugUnitTest', ':app:assembleDebug', ':app:assembleRelease',
  `-PseqivoVersionCode=${versionCode}`,
], { env });
writeFileSync(log, `${build.stdout || ''}${build.stderr || ''}`);
if (build.status !== 0) fail(`Gradle exited ${build.status}; see ${log}`);
if (createHash('sha256').update(readFileSync(debugKey)).digest('hex') !== keyHash)
  fail('Android debug signing key changed during build');
const buildConfig = join(android, 'app', 'build', 'generated', 'source', 'buildConfig', 'debug', 'app', 'seqivo', 'android', 'BuildConfig.java');
if (!existsSync(buildConfig) || !readFileSync(buildConfig, 'utf8').includes('DEFAULT_ORIGIN = "";'))
  fail('ordinary debug build unexpectedly contains a default server address');

const debug = join(android, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const release = join(android, 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk');
if (!existsSync(debug) || !existsSync(release)) fail(`expected APK missing; see ${log}`);
for (const apk of [debug, release]) {
  const badging = command(aapt, ['dump', 'badging', apk]);
  const expected = `package: name='app.seqivo.android' versionCode='${versionCode}'`;
  if (badging.status !== 0 || !badging.stdout.includes(expected)) fail(`unexpected package/version in ${apk}`);
  const resources = command(aapt, ['dump', 'resources', apk]);
  if (resources.status !== 0 || resources.stdout.includes('seqivo_test_ca')) fail(`test CA found in ${apk}`);
  const manifest = command(aapt, ['dump', 'xmltree', apk, 'AndroidManifest.xml']);
  if (manifest.status !== 0 || manifest.stdout.includes('networkSecurityConfig'))
    fail(`test network configuration found in ${apk}`);
}
const signature = command(apksigner, ['verify', '--print-certs', debug], { env });
if (signature.status !== 0 || !signature.stdout.includes('Signer #1 certificate SHA-256 digest:') ||
    !signature.stdout.includes('CN=Android Debug'))
  fail('ordinary debug APK signature verification failed');
const releaseSignature = command(apksigner, ['verify', release], { env });
if (releaseSignature.status === 0 || !releaseSignature.stderr.includes('DOES NOT VERIFY'))
  fail('release signing state unexpected; review before delivery');

const deliverable = join(output, `seqivo-debug-v${versionCode}.apk`);
copyFileSync(debug, deliverable);
const hash = createHash('sha256').update(readFileSync(deliverable)).digest('hex');
console.log(`Local debug APK: ${deliverable}`);
console.log(`SHA-256: ${hash}`);
console.log(`Build log: ${log}`);
console.log('Release APK built but unsigned and not copied for installation or distribution.');
