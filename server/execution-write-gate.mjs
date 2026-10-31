import { isAbsolute, relative, sep } from 'node:path';

export const EXECUTION_WRITE_REASONS = Object.freeze([
  'ACTIVE_EXECUTION', 'HUMAN_CONTROL', 'WORKSPACE_BUSY',
  'SOURCE_CHANGED', 'BINDING_UNAVAILABLE', 'CORE_UNAVAILABLE',
]);

const held = new Set(['sending', 'running', 'pausing', 'unknown']);
const within = (a, b) => {
  const path = relative(a, b);
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
const overlaps = (a, b) => !isAbsolute(a || '') || !isAbsolute(b || '') || within(a, b) || within(b, a);
const result = (state, reasonCode = null) => ({ state, reasonCode });
const unavailable = () => result('unknown', 'CORE_UNAVAILABLE');

// This is a read-only observation for UI and Hub queue admission. It never
// reserves a lease, changes control, or replaces the Core send-time checks.
export function createExecutionWriteGate({ leases, control, terminal, worktrees,
  workflow, previewBuilds, isClosing, bootId, now = Date.now }) {
  if (typeof bootId !== 'string' || !bootId) throw new TypeError('Core boot identity required');

  const common = project => {
    if (isClosing()) return result('unknown', 'CORE_UNAVAILABLE');
    if (!previewBuilds()) return unavailable();
    if (!isAbsolute(project.directory || '')) return result('unknown', 'SOURCE_CHANGED');
    try { control.assertMayStart(project.id); }
    catch (error) { return error?.code === 'CONTROL_BUSY' ? result('blocked', 'HUMAN_CONTROL') : result('unknown', 'SOURCE_CHANGED'); }
    try { terminal.assertManagedReady(project.id); }
    catch { return result('unknown', 'HUMAN_CONTROL'); }
    try { if (terminal.blocksProject(project.id)) return result('blocked', 'HUMAN_CONTROL'); }
    catch { return result('unknown', 'HUMAN_CONTROL'); }
    try { previewBuilds().assertNoUnfencedIntents(project.id); }
    catch (error) { return error?.code === 'BUILD_BUSY' ? result('blocked', 'WORKSPACE_BUSY') : result('unknown', 'WORKSPACE_BUSY'); }
    try { worktrees.assertMayExecute(project.id); }
    catch { return result('unknown', 'WORKSPACE_BUSY'); }
    return null;
  };

  const workflowConflict = (project, {taskId = null, workspace = project.directory, worktreeId = null} = {}) => {
    const plans = workflow.state().plans;
    if (!Array.isArray(plans)) return unavailable();
    for (const plan of plans) {
      if (!Array.isArray(plan.members)) return unavailable();
      for (const member of plan.members) {
        if (!held.has(member.status)) continue;
        if (member.taskId !== taskId && !overlaps(member.workspace, workspace) &&
            !(plan.projectId === project.id && (!worktreeId || !member.worktreeId))) continue;
        return result(member.status === 'unknown' || !isAbsolute(member.workspace || '') ? 'unknown' : 'blocked', 'ACTIVE_EXECUTION');
      }
    }
    return null;
  };

  const providerStatus = provider => {
    if (!provider) return null;
    if (provider.enabled !== true) return result('blocked', 'BINDING_UNAVAILABLE');
    if (provider.available !== true) return unavailable();
    return null;
  };

  const projectStatus = (project, provider) => {
    try {
      const blocked = common(project) || workflowConflict(project);
      if (blocked) return blocked;
      const active = leases.activeOverlaps(project.id);
      if (active.length) return result(active.some(item => item.status === 'unknown') ? 'unknown' : 'blocked', 'ACTIVE_EXECUTION');
      const unavailableProvider=providerStatus(provider);
      if (unavailableProvider) return unavailableProvider;
      return result('ready');
    } catch { return unavailable(); }
  };

  const taskStatus = (task, action, project, provider) => {
    try {
      const commonBlock = common(project);
      if (commonBlock) return commonBlock;
      const own = leases.state().active.filter(item => item.taskId === task.id);
      const worktreeId = own.length === 1 && own[0].status === 'startup' && own[0].ready === true
        ? own[0].worktreeId || null : null;
      const workspace = worktreeId ? worktrees.binding({id:worktreeId,taskId:task.id})?.path : project.directory;
      if (!isAbsolute(workspace || '')) return result('unknown', 'SOURCE_CHANGED');
      const blocked = workflowConflict(project, {taskId:task.id,workspace,worktreeId});
      if (blocked) return blocked;
      if (action === 'start') {
        if (task.status !== 'planned' || task.conversationId ||
            (task.executionProvider || 'codex-autocontinue') !== 'codex-autocontinue')
          return result('blocked', 'BINDING_UNAVAILABLE');
        const active = leases.activeOverlaps(project.id);
        if (active.length) return result(active.some(item=>item.status==='unknown')?'unknown':'blocked','ACTIVE_EXECUTION');
        return providerStatus(provider) || result('ready');
      }
      if (!task.conversationId || action === 'message' &&
          (task.executionProvider || 'codex-autocontinue') !== 'codex-autocontinue')
        return result('blocked', 'BINDING_UNAVAILABLE');
      if (leases.workflowMayContinue({ taskId: task.id,
        provider: task.executionProvider || 'codex-autocontinue', worktreeId })) {
        if (action === 'message' || (task.executionProvider || 'codex-autocontinue') === 'codex-autocontinue') {
          const unavailableProvider=providerStatus(provider);
          if (unavailableProvider) return unavailableProvider;
        }
        return result('ready');
      }
      if (own.some(item => item.status === 'unknown')) return result('unknown', 'ACTIVE_EXECUTION');
      const active=leases.activeOverlaps(project.id);
      if (active.length) return result(active.some(item=>item.status==='unknown')?'unknown':'blocked','ACTIVE_EXECUTION');
      return result('unknown', 'BINDING_UNAVAILABLE');
    } catch { return unavailable(); }
  };

  function project(project, observedAt = new Date(now()).toISOString(), provider = null) {
    return { v: 1, bootId, observedAt, ...projectStatus(project,provider) };
  }

  function task(task, project, observedAt = new Date(now()).toISOString(), provider = null) {
    return { v: 1, bootId, observedAt, taskRevision: task.revision,
      contentVersion: task.contentVersion, message: taskStatus(task, 'message', project,provider),
      continue: taskStatus(task, 'continue', project,provider),
      start: taskStatus(task, 'start', project,provider) };
  }

  return { project, task };
}
