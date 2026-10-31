// A verification checklist belongs to the version recorded with its test result.
// An older result may reference criteria that were replaced in a later task version.
export function pendingChecks(value, criterionIds, ErrorType = Error) {
  const fail = () => { throw new ErrorType('待验证清单格式不正确'); };
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) fail();
  const available = criterionIds == null ? null : new Set(criterionIds);
  const ids = new Set();
  const field = (input, max, required = true) => {
    if (typeof input !== 'string' || input.length > max || (required && !input.trim())) fail();
    return input.trim();
  };
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).some(key => !['id', 'kind', 'title', 'criterionIds', 'steps', 'expectedResult', 'blockedReason', 'shareWithRemote', 'completed'].includes(key))) fail();
    const id = field(item.id, 100);
    if (ids.has(id)) fail();
    ids.add(id);
    if (!['test', 'implementation', 'decision'].includes(item.kind)) fail();
    if (!Array.isArray(item.criterionIds) || item.criterionIds.length < 1 || item.criterionIds.length > 100 ||
        item.criterionIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 100 || (available && !available.has(id))) ||
        new Set(item.criterionIds).size !== item.criterionIds.length) fail();
    if (!Array.isArray(item.steps) || item.steps.length < 1 || item.steps.length > 10) fail();
    if (item.shareWithRemote !== undefined && typeof item.shareWithRemote !== 'boolean') fail();
    if (item.completed !== undefined && typeof item.completed !== 'boolean') fail();
    return {
      id, kind: item.kind, title: field(item.title, 240), criterionIds: [...item.criterionIds],
      steps: item.steps.map(step => field(step, 2000)),
      expectedResult: field(item.expectedResult, 4000),
      blockedReason: item.blockedReason === undefined ? '' : field(item.blockedReason, 4000, false),
      shareWithRemote: item.shareWithRemote ?? false,
      completed: item.completed ?? false,
    };
  });
}
