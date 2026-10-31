import { BoardError } from '../store.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, constants } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

const KEY = 'terminal.plugin.v1';
const CONTRACT = 'terminal.local.v1';
const DISABLE_INCOMPLETE_ERROR = '终端附着关闭结果未确认，需要人工核实';
const validId = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validAttachment = item => item && typeof item === 'object' && !Array.isArray(item) &&
  Object.keys(item).sort().join(',') === 'connectionId,identity,profileBinding,profileId,sessionRef' &&
  typeof item.connectionId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(item.connectionId) &&
  typeof item.profileId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(item.profileId) &&
  validDigest(item.profileBinding) && item.sessionRef &&
  Object.keys(item.sessionRef).sort().join(',') === 'instanceId,serverName,sessionId' &&
  /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(item.sessionRef.serverName) &&
  validDigest(item.sessionRef.instanceId) && /^\$(0|[1-9]\d*)$/.test(item.sessionRef.sessionId) &&
  item.identity && Object.keys(item.identity).sort().join(',') === 'euid,pgid,pid,ruid,startSec,startUsec' &&
  Number.isSafeInteger(item.identity.pid) && item.identity.pid > 1 &&
  Number.isSafeInteger(item.identity.pgid) && item.identity.pgid > 1 &&
  Number.isSafeInteger(item.identity.euid) && item.identity.euid >= 0 &&
  Number.isSafeInteger(item.identity.ruid) && item.identity.ruid >= 0 &&
  Number.isSafeInteger(item.identity.startSec) && item.identity.startSec > 0 &&
  Number.isSafeInteger(item.identity.startUsec) && item.identity.startUsec >= 0 &&
  item.identity.startUsec < 1_000_000;
const validAttachmentWitness = (value, id) => value?.version === 3 && value.operation === 'disable' &&
  value.id === id && validId(value.id) &&
  Object.keys(value).sort().join(',') === 'attachments,connectionCount,id,operation,runtimeCount,version' &&
  Number.isSafeInteger(value.connectionCount) && value.connectionCount >= 1 && value.connectionCount <= 16 &&
  Number.isSafeInteger(value.runtimeCount) && value.runtimeCount >= 0 &&
  value.runtimeCount <= value.connectionCount && Array.isArray(value.attachments) &&
  value.attachments.length === value.runtimeCount && value.attachments.every(validAttachment) &&
  new Set(value.attachments.map(item => item.connectionId)).size === value.runtimeCount &&
  new Set(value.attachments.map(item => item.identity.pid)).size === value.runtimeCount;
const knownErrors = new Set([
  '终端插件状态无法读取，需要人工核实', '终端插件状态版本不受支持，需要人工核实',
  '终端停用结果未确认，需要人工核实', '终端插件原状态无法核实',
  '终端插件状态未能持久保存，输入已冻结', DISABLE_INCOMPLETE_ERROR,
  '终端切换意图未完成，需要人工核实',
]);
const fail = (message, code = 'TERMINAL_PLUGIN_DISABLED', status = 409) => {
  throw new BoardError(message, status, code);
};

export function createTerminalPluginLifecycle({ store, intentPath, emit = () => {} }) {
  if (!isAbsolute(intentPath || '')) throw Error('terminal plugin intent path must be absolute');
  const syncDirectory = () => {
    const fd = openSync(dirname(intentPath), constants.O_RDONLY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  };
  let intentPresent = false;
  try { intentPresent = Boolean(lstatSync(intentPath)); }
  catch (error) { if (error.code !== 'ENOENT') intentPresent = true; }
  const row = store.db.prepare('SELECT value FROM metadata WHERE key=?').get(KEY);
  let record;
  try { record = row ? JSON.parse(row.value) : { version: 1, status: 'ready', lastError: null }; }
  catch { record = { version: 1, status: 'disabled_unknown', lastError: '终端插件状态无法读取，需要人工核实' }; }
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      record.version !== 1 || !['ready', 'disabled', 'disabling', 'disabled_unknown'].includes(record.status) ||
      record.status === 'disabled_unknown' && !knownErrors.has(record.lastError) ||
      record.status !== 'disabled_unknown' && record.lastError !== null ||
      record.intentId !== undefined && !validId(record.intentId) ||
      (record.attachmentDigest !== undefined || record.attachmentCount !== undefined ||
        record.connectionCount !== undefined) &&
        (!validDigest(record.attachmentDigest) || !Number.isSafeInteger(record.attachmentCount) ||
          record.attachmentCount < 0 || record.attachmentCount > 16 ||
          !Number.isSafeInteger(record.connectionCount) || record.connectionCount < 1 ||
          record.connectionCount > 16 || record.attachmentCount > record.connectionCount ||
          !validId(record.intentId) || record.status === 'ready'))
    record = { version: 1, status: 'disabled_unknown', lastError: '终端插件状态版本不受支持，需要人工核实' };
  const coldDisableId = intentPresent && validId(record.intentId) &&
    (record.status === 'disabling' || record.status === 'disabled' ||
      record.status === 'disabled_unknown' && record.lastError === DISABLE_INCOMPLETE_ERROR)
    ? record.intentId : null;
  const coldAttachmentProof = coldDisableId && validDigest(record.attachmentDigest)
    ? { digest: record.attachmentDigest, attachmentCount: record.attachmentCount,
        connectionCount: record.connectionCount } : null;
  // A process lost while detaching PTYs cannot be declared clean after restart.
  if (record.status === 'disabling') record = { version: 1, status: 'disabled_unknown', lastError: '终端停用结果未确认，需要人工核实' };
  if (intentPresent) record = { version: 1, status: 'disabled_unknown', lastError: '终端切换意图未完成，需要人工核实' };
  let manager, retryableUnknown = false;
  let activeIntentId = null, activeAttachmentProof = null;
  const beginIntent = operation => {
    const id = randomUUID();
    activeAttachmentProof = null;
    try {
      writeFileSync(intentPath, JSON.stringify({ version: operation === 'disable' ? 2 : 1, id, operation }), { flag: 'wx', mode: 0o600 });
      const fd = openSync(intentPath, constants.O_RDONLY);
      try { fsyncSync(fd); } finally { closeSync(fd); }
      syncDirectory();
      activeIntentId = id;
    } catch {
      let present = true;
      try { present = existsSync(intentPath) || Boolean(lstatSync(intentPath)); }
      catch (error) { if (error.code === 'ENOENT') present = false; }
      if (present) record = { version: 1, status: 'disabled_unknown', lastError: '终端切换意图未完成，需要人工核实' };
      throw new BoardError('终端切换意图未能持久保存，操作未执行', 500,
        present ? 'TERMINAL_PLUGIN_UNKNOWN' : 'TERMINAL_PLUGIN_PERSIST_FAILED');
    }
  };
  const persistZeroWitness = id => {
    const temp = `${intentPath}.${randomUUID()}.tmp`;
    try {
      const stat = lstatSync(intentPath);
      const original = readFileSync(intentPath, 'utf8');
      const prior = JSON.parse(original);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() ||
          (stat.mode & 0o077) !== 0 || prior.version !== 2 || prior.operation !== 'disable' ||
          prior.id !== id || !validId(prior.id) ||
          Object.keys(prior).sort().join(',') !== 'id,operation,version') throw Error('intent changed');
      writeFileSync(temp, JSON.stringify({ ...prior, zeroAttachments: true }), { flag: 'wx', mode: 0o600 });
      const fd = openSync(temp, constants.O_RDONLY);
      try { fsyncSync(fd); } finally { closeSync(fd); }
      const currentStat = lstatSync(intentPath);
      if (!currentStat.isFile() || currentStat.isSymbolicLink() ||
          currentStat.dev !== stat.dev || currentStat.ino !== stat.ino ||
          currentStat.uid !== stat.uid || currentStat.mode !== stat.mode ||
          readFileSync(intentPath, 'utf8') !== original) throw Error('intent changed');
      renameSync(temp, intentPath);
      syncDirectory();
    } catch {
      record = { version: 1, status: 'disabled_unknown', lastError: '终端切换意图未完成，需要人工核实', intentId: id };
      throw new BoardError('终端停用空附着证明未能持久保存，输入已冻结', 500, 'TERMINAL_PLUGIN_UNKNOWN');
    }
  };
  const persistAttachmentWitness = (id, prepared) => {
    const witness = { version: 3, id, operation: 'disable', connectionCount: prepared?.connectionCount,
      runtimeCount: prepared?.runtimeCount, attachments: prepared?.attachments };
    if (!validAttachmentWitness(witness, id))
      throw new BoardError('终端附着身份不完整，输入已冻结', 500, 'TERMINAL_PLUGIN_UNKNOWN');
    const temp = `${intentPath}.${randomUUID()}.tmp`;
    try {
      const stat = lstatSync(intentPath);
      const original = readFileSync(intentPath, 'utf8');
      const prior = JSON.parse(original);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() ||
          (stat.mode & 0o077) !== 0 || prior.version !== 2 || prior.operation !== 'disable' ||
          prior.id !== id || Object.keys(prior).sort().join(',') !== 'id,operation,version')
        throw Error('intent changed');
      writeFileSync(temp, JSON.stringify(witness), { flag: 'wx', mode: 0o600 });
      const fd = openSync(temp, constants.O_RDONLY);
      try { fsyncSync(fd); } finally { closeSync(fd); }
      const current = lstatSync(intentPath);
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== stat.dev ||
          current.ino !== stat.ino || current.uid !== stat.uid || current.mode !== stat.mode ||
          readFileSync(intentPath, 'utf8') !== original) throw Error('intent changed');
      renameSync(temp, intentPath);
      syncDirectory();
    } catch {
      throw new BoardError('终端附着身份证明未能持久保存，输入已冻结', 500, 'TERMINAL_PLUGIN_UNKNOWN');
    }
    return { attachmentDigest: digest(witness), attachmentCount: witness.runtimeCount,
      connectionCount: witness.connectionCount };
  };
  const coldZeroWitness = id => {
    if (typeof process.getuid !== 'function') return false;
    try {
      const stat = lstatSync(intentPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)
        return false;
      const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
      return intent.version === 2 && intent.operation === 'disable' && intent.id === id &&
        intent.zeroAttachments === true && Object.keys(intent).sort().join(',') ===
        'id,operation,version,zeroAttachments';
    } catch { return false; }
  };
  const coldAttachedWitness = id => {
    if (!coldAttachmentProof || typeof process.getuid !== 'function') return null;
    try {
      const stat = lstatSync(intentPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() ||
          (stat.mode & 0o077) !== 0) return null;
      const witness = JSON.parse(readFileSync(intentPath, 'utf8'));
      if (!validAttachmentWitness(witness, id) ||
          witness.runtimeCount !== coldAttachmentProof.attachmentCount ||
          witness.connectionCount !== coldAttachmentProof.connectionCount ||
          digest(witness) !== coldAttachmentProof.digest) return null;
      return witness;
    } catch { return null; }
  };
  const clearIntent = (expectedWitnessDigest = null) => {
    try {
      const stat = lstatSync(intentPath);
      if (!stat.isFile() || stat.isSymbolicLink() ||
          typeof process.getuid === 'function' &&
          (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) throw Error('intent changed');
      const current = JSON.parse(readFileSync(intentPath, 'utf8'));
      if (current.id !== activeIntentId ||
          expectedWitnessDigest && digest(current) !== expectedWitnessDigest) throw Error('intent changed');
      unlinkSync(intentPath);
      syncDirectory();
      activeIntentId = null;
    } catch {
      record = { version: 1, status: 'disabled_unknown', lastError: '终端切换意图未完成，需要人工核实' };
      try { store.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run(KEY, JSON.stringify(record)); }
      catch { /* The in-memory gate and any surviving intent still fail closed. */ }
      throw new BoardError('终端切换意图未能确认清除，输入已冻结', 500, 'TERMINAL_PLUGIN_UNKNOWN');
    }
  };
  const persist = (next, { preEffect = false } = {}) => {
    // Change the in-memory gate first. A disk failure cannot reopen inputs.
    const previous = record;
    let previousRaw;
    if (preEffect) {
      try { previousRaw = store.db.prepare('SELECT value FROM metadata WHERE key=?').get(KEY)?.value ?? null; }
      catch {
        record = { version: 1, status: 'disabled_unknown', lastError: '终端插件原状态无法核实' };
        throw new BoardError('终端插件原状态无法核实，操作未执行', 500, 'TERMINAL_PLUGIN_UNKNOWN');
      }
    }
    record = next;
    try {
      store.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run(KEY, JSON.stringify(record));
    } catch {
      if (preEffect) {
        let unchanged = false;
        try { unchanged = (store.db.prepare('SELECT value FROM metadata WHERE key=?').get(KEY)?.value ?? null) === previousRaw; }
        catch { /* An unreadable commit outcome remains unknown. */ }
        if (unchanged) {
          record = previous;
          if (activeIntentId) clearIntent();
          throw new BoardError('终端插件状态未保存，操作未执行', 500, 'TERMINAL_PLUGIN_PERSIST_FAILED');
        }
      }
      record = { version: 1, status: 'disabled_unknown', lastError: '终端插件状态未能持久保存，输入已冻结' };
      throw new BoardError('终端插件状态未能保存，输入已冻结', 500, 'TERMINAL_PLUGIN_UNKNOWN');
    }
    try { emit(); } catch { /* Observer diagnostics cannot change durable authority. */ }
  };
  const status = () => record.status;
  const state = () => ({ id: 'local-terminal', name: 'Local Terminal', version: '1', apiVersion: 1,
    contract: CONTRACT, enabled: record.status === 'ready', available: true, status: record.status,
    lastError: record.lastError, capabilities: [CONTRACT], isolation: 'core', trust: 'built-in',
    permissions: [], configSchema: null });
  const assertEnabled = () => {
    if (record.status !== 'ready') fail(record.status === 'disabled_unknown' ?
      '终端停用结果未知，需要人工核实' : '终端插件已停用');
  };
  let operation = false;
  const serialized = work => {
    if (operation) fail('终端插件正在切换状态', 'TERMINAL_PLUGIN_BUSY');
    operation = true;
    // Execute the synchronous gate/persist prefix before another frame can enter.
    try { return Promise.resolve(work()).finally(() => { operation = false; }); }
    catch (error) { operation = false; throw error; }
  };
  return {
    state, status, assertEnabled, transitioning: () => operation,
    assertMetadataReplacementSafe(incoming) {
      if (!['ready', 'disabled'].includes(record.status) || !Array.isArray(incoming))
        fail('终端插件状态未核实，不能替换数据', 'TERMINAL_PLUGIN_UNKNOWN');
      const rows = incoming.filter(item => item?.key === KEY);
      if (rows.length > 1) fail('终端插件状态重复', 'TERMINAL_PLUGIN_UNKNOWN');
      let next;
      try { next = rows.length ? JSON.parse(rows[0].value) : { version: 1, status: 'ready', lastError: null }; }
      catch { fail('终端插件状态无法读取', 'TERMINAL_PLUGIN_UNKNOWN'); }
      if (!next || typeof next !== 'object' || Array.isArray(next) || next.version !== 1 ||
          next.status !== record.status || next.lastError !== null)
        fail('终端插件状态与当前现场不符', 'TERMINAL_PLUGIN_UNKNOWN');
    },
    bindManager(value) { manager = value; },
    configure(input = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)
        fail('本机终端插件没有可更改的配置', 'TERMINAL_PLUGIN_CONFIG', 400);
      return state();
    },
    check: () => serialized(async () => {
      if (record.status === 'disabled_unknown') {
        manager?.assertPluginLifecycleChangeSafe();
        // Only live handles from this same process can be retried. Restarted
        // unknown attachments have no exact process birth proof to adopt.
        if (!retryableUnknown) {
          const attached = coldDisableId ? coldAttachedWitness(coldDisableId) : null;
          if (!coldDisableId || (coldAttachmentProof ? !attached : !coldZeroWitness(coldDisableId)))
            fail('原终端进程身份无法核实，不能自动恢复', 'TERMINAL_PLUGIN_UNKNOWN');
          try {
            if (!manager?.verifyPluginRecovery || !manager?.assertPluginLifecycleChangeSafe)
              fail('终端管理器身份无法核实', 'TERMINAL_PLUGIN_UNKNOWN');
            await manager.verifyPluginRecovery(attached
              ? { coldAttachments: attached.attachments } : { coldZeroAttachments: true });
            manager.assertPluginLifecycleChangeSafe();
            persist({ version: 1, status: 'disabled', lastError: null, intentId: coldDisableId,
              ...(attached ? { attachmentDigest: coldAttachmentProof.digest,
                attachmentCount: coldAttachmentProof.attachmentCount,
                connectionCount: coldAttachmentProof.connectionCount } : {}) });
            activeIntentId = coldDisableId;
            clearIntent(attached ? coldAttachmentProof.digest : null);
          } catch {
            fail('原终端附着仍未核实，输入保持冻结', 'TERMINAL_PLUGIN_UNKNOWN');
          }
          return state();
        }
        try {
          await manager?.suspendForPlugin();
          await manager?.verifyPluginRecovery({ sameProcessRetry: true });
          persist({ version: 1, status: 'disabled', lastError: null });
          clearIntent();
          retryableUnknown = false;
        } catch {
          fail('原终端附着仍未核实，输入保持冻结', 'TERMINAL_PLUGIN_UNKNOWN');
        }
      }
      return state();
    }),
    enable: () => serialized(async () => {
      if (record.status === 'ready') return state();
      if (record.status !== 'disabled') fail('终端停用结果尚未确认，不能启用', 'TERMINAL_PLUGIN_UNKNOWN');
      manager?.assertPluginLifecycleChangeSafe();
      await manager?.verifyPluginRecovery();
      manager?.assertPluginLifecycleChangeSafe();
      beginIntent('enable');
      persist({ version: 1, status: 'ready', lastError: null }, { preEffect: true });
      clearIntent();
      return state();
    }),
    disable: () => serialized(async () => {
      if (record.status === 'disabled') return state();
      if (record.status !== 'ready') fail('终端状态需要核实，不能重复停用', 'TERMINAL_PLUGIN_UNKNOWN');
      manager?.assertPluginLifecycleChangeSafe();
      manager?.assertPluginDisableSafe();
      beginIntent('disable');
      persist({ version: 1, status: 'disabling', lastError: null, intentId: activeIntentId }, { preEffect: true });
      try {
        const prepared = await manager?.preparePluginDisable?.();
        // Windows has no process UID to bind a restart witness to. Keep its
        // ordinary disable path available while leaving cold recovery fenced.
        if (prepared?.zeroAttachments === true && typeof process.getuid === 'function')
          persistZeroWitness(activeIntentId);
        else if (prepared?.coldProofSupported === true && typeof process.getuid === 'function') {
          const proof = persistAttachmentWitness(activeIntentId, prepared);
          persist({ version: 1, status: 'disabling', lastError: null, intentId: activeIntentId, ...proof });
          activeAttachmentProof = proof;
        }
        await manager?.suspendForPlugin();
        persist({ version: 1, status: 'disabled', lastError: null, intentId: activeIntentId,
          ...activeAttachmentProof });
        clearIntent();
      } catch {
        retryableUnknown = true;
        persist({ version: 1, status: 'disabled_unknown', lastError: DISABLE_INCOMPLETE_ERROR,
          intentId: activeIntentId, ...activeAttachmentProof });
        fail('终端停用结果未确认，输入已冻结', 'TERMINAL_PLUGIN_UNKNOWN');
      }
      return state();
    }),
    async close() {
      if (['disabling', 'disabled_unknown'].includes(record.status))
        fail('终端附着关闭结果未确认', 'TERMINAL_PLUGIN_UNKNOWN');
    },
  };
}
