export const DEFAULT_BUDGET_MINUTES = 360;

export function planIntentForTask(task) {
  const goal = task?.goal ?? '';
  const nextStep = task?.nextStep ?? '';
  if (typeof goal !== 'string' || typeof nextStep !== 'string')
    throw new TypeError('Task plan fields must be strings');
  return { version: 1, goal, nextStep };
}

export function validPlanIntent(value) {
  return value?.version === 1 && typeof value.goal === 'string' &&
    typeof value.nextStep === 'string';
}

export function samePlanIntent(intent, task) {
  if (!validPlanIntent(intent)) return false;
  try {
    const current = planIntentForTask(task);
    return intent.goal === current.goal && intent.nextStep === current.nextStep;
  } catch { return false; }
}

export function validateBudgetMinutes(value) {
  if (!Number.isInteger(value) || value < 1 || value > 10080)
    throw new RangeError('budgetMinutes must be 1..10080');
  return value;
}

export function deadlineFor(startedAt, budgetMinutes) {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) throw new Error('Invalid automatic policy start time');
  return new Date(start + validateBudgetMinutes(budgetMinutes) * 60_000).toISOString();
}

export function budgetRemainingSeconds(policy, nowMs) {
  const deadline = Date.parse(policy?.deadlineAt);
  if (!Number.isFinite(deadline) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.ceil((deadline - nowMs) / 1000));
}

export function automaticStop(policy, nowMs) {
  let valid = false;
  try { valid = Boolean(policy?.startedAt && policy?.deadlineAt &&
    deadlineFor(policy.startedAt, policy.budgetMinutes) === policy.deadlineAt); }
  catch { /* Legacy or damaged plans cannot acquire a new deadline. */ }
  if (!valid)
    return { status: 'retry_stopped', stopReason: 'legacy_plan_missing_deadline' };
  if (budgetRemainingSeconds(policy, nowMs) === 0)
    return { status: 'budget_exhausted', stopReason: 'budget_expired' };
  if (!Number.isInteger(policy.attempts) || policy.attempts < 0 ||
      !Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 10 ||
      policy.attempts >= policy.maxAttempts)
    return { status: 'attempts_exhausted', stopReason: 'attempt_limit' };
  return null;
}
