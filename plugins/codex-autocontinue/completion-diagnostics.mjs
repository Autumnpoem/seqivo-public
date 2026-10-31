const CATEGORIES = {
  busy: '服务当前繁忙，请稍后由用户决定是否重试',
  quota: '模型使用额度或速率限制已触发',
  auth: '模型服务认证失败，请检查当前登录状态',
  unknown: '模型本轮失败，具体原因待核实',
};
const THREAD_STATUSES = new Set(['idle', 'active', 'unknown']);
const TURN_STATUSES = new Set(['completed', 'failed', 'interrupted', 'inProgress', 'unknown']);
const boundedStatus = (value, allowed) => typeof value === 'string' && allowed.has(value) ? value : 'unknown';

/** Only fixed, non-sensitive labels cross the persistent/public boundary. */
export function providerFailure(error) {
  // Match the previous quota detection across the provider's JSON error,
  // including nested codes, without carrying any of that text into state.
  let clue = '';
  try { clue = (typeof error === 'string' ? error : JSON.stringify(error) || '').toLowerCase(); }
  catch { /* A malformed local test value remains an unknown failure. */ }
  const category = /quota|rate.?limit|usage.?limit|额度|限额/.test(clue)
    ? 'quota' : /server_overloaded|overloaded|at capacity|capacity_exceeded|temporarily unavailable|service busy/.test(clue)
      ? 'busy' : /unauthorized|unauthenticated|invalid.api.key|authentication|forbidden|login required/.test(clue)
        ? 'auth' : 'unknown';
  return { category, summary: CATEGORIES[category] };
}

/** A predicate trace, not an exit or authorization proof. */
export function finalThreadCheck(thread, expectedTurnId) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : null;
  const lastTurn = turns?.at(-1);
  const flags = thread?.status?.activeFlags;
  return {
    threadStatus: boundedStatus(thread?.status?.type, THREAD_STATUSES),
    finalTurnPresent: Boolean(lastTurn),
    finalTurnMatches: Boolean(lastTurn && lastTurn.id === expectedTurnId),
    finalTurnStatus: boundedStatus(lastTurn?.status, TURN_STATUSES),
    activeFlagsCount: Array.isArray(flags) ? Math.min(flags.length, 1000) : null,
  };
}

export function publicCompletionDiagnostic(entry) {
  const result = {};
  const category = entry?.providerFailure?.category;
  if (Object.hasOwn(CATEGORIES, category)) result.providerFailure = { category, summary: CATEGORIES[category] };
  const check = entry?.stopProof?.finalThreadCheck;
  if (check && typeof check === 'object') result.finalThreadCheck = {
    threadStatus: boundedStatus(check.threadStatus, THREAD_STATUSES),
    finalTurnPresent: check.finalTurnPresent === true,
    finalTurnMatches: check.finalTurnMatches === true,
    finalTurnStatus: boundedStatus(check.finalTurnStatus, TURN_STATUSES),
    activeFlagsCount: Number.isSafeInteger(check.activeFlagsCount) && check.activeFlagsCount >= 0
      ? Math.min(check.activeFlagsCount, 1000) : null,
  };
  return Object.keys(result).length ? result : undefined;
}
