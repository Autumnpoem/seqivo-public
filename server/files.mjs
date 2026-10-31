import { fork } from 'node:child_process';
import { relative, sep } from 'node:path';
import { legacyReportingInstructions, reportingInstructions, reportingPrompt, reportingRuleBlock, reportingVersion } from './file-reporting.mjs';

const WORKER_URL = new URL('./file-bridge-worker.mjs', import.meta.url);
const MAX_IPC_BYTES = 8 * 1024 * 1024;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounded = value => Buffer.byteLength(JSON.stringify(value)) <= MAX_IPC_BYTES;
const exitedWithin = (exit, timeoutMs) => new Promise(resolve => {
  let settled = false;
  const finish = value => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(value);
  };
  const timer = setTimeout(() => finish(false), timeoutMs);
  exit.then(() => finish(true), () => finish(false));
});

export class FileBridge {
  constructor(store, { workerUrl = WORKER_URL } = {}) {
    this.store = store;
    this.workerUrl = workerUrl;
    this.busy = false;
    this.paused = false;
    this.closed = false;
    this.pending = true;
    this.errors = new Map();
    this.reportingStates = new Map();
    this.timer = null;
    this.worker = null;
    this.workerExit = null;
    this.stopPromise = null;
    this.pauseComplete = false;
    this.unsafeStop = false;
    this.requests = new Map();
    this.nextId = 0;
    this.generation = 0;
    this.changed = () => { this.pending = true; };
    store.on('change', this.changed);
  }

  start() {
    this.timer = setInterval(() => this.tick().catch(() => {}), 900);
    this.timer.unref?.();
    return this.tick();
  }

  #ensureWorker() {
    if (this.paused || this.closed || this.unsafeStop) throw Error('文件桥已暂停');
    if (this.worker) return this.worker;
    const child = fork(this.workerUrl, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
    this.worker = child;
    let finish;
    this.workerExit = new Promise(resolve => { finish = resolve; });
    let exitObserved = false;
    const onExit = () => {
      if (exitObserved) return;
      exitObserved = true;
      if (this.worker === child) this.worker = null;
      for (const [id, request] of this.requests) {
        if (request.child !== child) continue;
        this.requests.delete(id);
        request.reject(Error('文件桥工作进程已退出，操作结果未确认'));
      }
      finish();
    };
    child.once('exit', onExit);
    child.once('error', () => { if (child.pid == null) onExit(); });
    child.on('message', message => {
      if (!message || !Number.isSafeInteger(message.id)) return;
      const request = this.requests.get(message.id);
      if (!request || request.child !== child) return;
      this.requests.delete(message.id);
      if (this.paused || this.closed || request.generation !== this.generation) {
        request.reject(Error('文件桥请求已取消'));
      } else if (!bounded(message)) {
        request.reject(Error('文件桥响应过大'));
      } else if (message.error) {
        request.reject(Object.assign(Error(message.error.message || '文件桥操作失败'), { code: message.error.code }));
      } else {
        request.resolve(message.result);
      }
    });
    return child;
  }

  #request(op, data) {
    const child = this.#ensureWorker();
    const id = ++this.nextId;
    const message = { id, op, ...data };
    if (!bounded(message)) throw Error('文件桥请求过大');
    return new Promise((resolve, reject) => {
      this.requests.set(id, { child, generation: this.generation, resolve, reject });
      try {
        child.send(message, error => {
          if (!error) return;
          const request = this.requests.get(id);
          if (!request) return;
          this.requests.delete(id);
          reject(error);
        });
      } catch (error) {
        this.requests.delete(id);
        reject(error);
      }
    });
  }

  reporting(projectId) {
    const project = this.store.getProject(projectId);
    const directory = project.directory || null;
    let state = this.reportingStates.get(projectId);
    if (!state || state.directory !== directory) {
      if (state) for (const key of this.errors.keys()) {
        if (typeof key === 'string' && (key.startsWith(state.directory + sep) || key.startsWith(directory + sep))) this.errors.delete(key);
      }
      state = { directory, prepared: false, exportsComplete: false, lastReport: null,
        lastAccepted: directory ? this.store.lastFileReport(projectId,directory) : null, problem: null,
        instructions: { status: 'preparing', currentText: null, recommendedText: reportingInstructions },
        rule: { codex: { path: 'AGENTS.md', block: reportingRuleBlock, installed: false },
          claude: { path: 'CLAUDE.md', block: reportingRuleBlock, installed: false } } };
      this.reportingStates.set(projectId, state);
    }
    const phase = !directory ? 'unbound' : state.problem || state.lastReport?.status === 'rejected' ? 'attention' : !state.prepared ? 'preparing' : state.lastAccepted ? 'connected' : 'waiting';
    return { enabled: true, directory, phase, instructionPath: '.taskboard/REPORTING.md', prompt: directory ? `项目目录：${directory}。如果当前 AI 在其他目录，请先切换到此项目目录。${reportingPrompt}` : reportingPrompt, lastReport: state.lastReport,
      lastAccepted: state.lastAccepted, instructions: state.instructions, rule: state.rule,
      ...(state.problem || state.lastReport?.status === 'rejected' ? { problem: state.problem || state.lastReport.error } : {}) };
  }

  async installReportingRule(projectId, provider, expectedDirectory) {
    const project = this.store.getProject(projectId);
    if (!project.directory || project.directory !== expectedDirectory) throw Object.assign(Error('项目目录已变更，请刷新后重试'), { code: 'FILE_REPORTING_REBOUND' });
    if (!['codex', 'claude'].includes(provider)) throw Object.assign(Error('未知的 AI 工具'), { code: 'FILE_REPORTING_PROVIDER' });
    const result = await this.#request('installRule', { directory: project.directory, provider, value: reportingRuleBlock });
    this.reporting(projectId);
    this.reportingStates.get(projectId).rule[provider] = { ...result, block: reportingRuleBlock };
    return result;
  }

  async tick() {
    if (this.busy || this.paused || this.closed || this.unsafeStop) return;
    this.busy = true;
    const exportPending = this.pending;
    this.pending = false;
    try {
      for (const project of this.store.projects()) {
        if (this.paused) return;
        this.reporting(project.id);
        const state = this.reportingStates.get(project.id);
        if (!project.directory) continue;
        try {
          const entries = await this.#request('list', { directory: project.directory });
          if (this.paused) return;
          for (const path of entries) {
            if (this.paused) return;
            const item = await this.#request('read', { directory: project.directory, path });
            if (this.paused) return;
            if (!item || this.errors.get(path) === item.key) continue;
            let receipt;
            let event;
            try {
              event = JSON.parse(item.content);
              if (event.projectId && event.projectId !== project.id) throw Error('事件属于其他项目');
              if (event.taskId && this.store.getTask(event.taskId).projectId !== project.id) throw Error('任务属于其他项目');
              receipt = this.store.applyEvent({ ...event, projectId: project.id }, 'file', project.directory);
            } catch (error) { receipt = { status: 'rejected', error: error.message }; }
            if (this.paused) return;
            const persisted = await this.#request('writeReceipt', { directory: project.directory, receiptName: item.receiptName, value: JSON.stringify(receipt, null, 2) });
            if (this.paused) return;
            this.errors.set(path, item.key);
            state.lastReport = { file: relative(project.directory, path), status: receipt.status, ...(receipt.error ? { error: receipt.error } : {}), ...(receipt.eventId || event?.eventId ? { eventId: receipt.eventId || event.eventId } : {}), ...(receipt.taskId ? { taskId: receipt.taskId } : {}),
              receivedAt: receipt.status === 'accepted' ? receipt.fileReceivedAt ?? null : persisted.receivedAt };
            if (receipt.status === 'accepted') state.lastAccepted = this.store.lastFileReport(project.id,project.directory);
          }
          if (this.paused) return;
          if (exportPending || this.pending || !state.exportsComplete) {
            await this.#request('writeTasks', { directory: project.directory, value: JSON.stringify({ schemaVersion: 1, projectId: project.id, tasks: this.store.tasks(project.id) }, null, 2) });
            if (this.paused) return;
            await this.#request('writeContext', { directory: project.directory, value: this.store.context(project.id) });
            if (this.paused) return;
            state.exportsComplete = true;
          }
          if (this.paused) return;
          const instructions = await this.#request('writeReporting', { directory: project.directory, value: reportingInstructions,
            legacy: legacyReportingInstructions, version: reportingVersion });
          if (this.paused) return;
          state.instructions = { ...instructions, recommendedText: reportingInstructions };
          state.problem = instructions.status === 'customized' ? '已有自定义 .taskboard/REPORTING.md，请比较当前内容和建议内容' : null;
          state.prepared = !state.problem;
          for (const provider of ['codex', 'claude']) {
            try {
              const rule = await this.#request('readRule', { directory: project.directory, provider, value: reportingRuleBlock });
              state.rule[provider] = { ...rule, block: reportingRuleBlock };
            } catch (error) {
              state.rule[provider] = { ...state.rule[provider], installed: false, problem: error.message };
            }
          }
          this.errors.delete(project.id);
        } catch (error) {
          state.problem = error.message;
          this.errors.set(project.id, error.message);
          this.pending = true;
        }
      }
    } finally { this.busy = false; }
  }

  async pause({ timeoutMs = 5000 } = {}) {
    this.paused = true;
    this.generation++;
    if (this.unsafeStop) throw Error('文件桥工作进程停止结果未确认');
    if (!this.stopPromise) {
      this.pauseComplete = false;
      const child = this.worker;
      this.stopPromise = (async () => {
        const deadline = Date.now() + timeoutMs;
        if (child) {
          const exited = this.workerExit;
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
          const remaining = deadline - Date.now();
          if (remaining <= 0 || !(await exitedWithin(exited, remaining))) {
            this.unsafeStop = true;
            throw Error('文件桥工作进程未能在期限内停止，请检查项目目录连接');
          }
        }
        while (this.busy) {
          if (Date.now() >= deadline) {
            this.unsafeStop = true;
            throw Error('文件桥未能在期限内停止，请检查项目目录连接');
          }
          await wait(10);
        }
        this.pauseComplete = true;
      })();
    }
    return this.stopPromise;
  }

  resume() {
    if (this.closed || this.unsafeStop || this.worker || !this.pauseComplete || this.busy) return;
    this.stopPromise = null;
    this.pauseComplete = false;
    this.paused = false;
    this.pending = true;
  }

  close() {
    this.closed = true;
    this.paused = true;
    clearInterval(this.timer);
    this.store.off('change', this.changed);
    // Core awaits pause after its other shutdown stages; close must not
    // produce an unhandled rejection before then.
    void this.pause().catch(() => {});
  }
}
