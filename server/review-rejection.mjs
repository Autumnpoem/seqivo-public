export const REVIEW_REJECTION_CODES = Object.freeze([
  'REVIEW_NOT_SUBMITTED',
  'REVIEW_CRITERIA_REQUIRED',
  'REVIEW_CURRENT_EVIDENCE_REQUIRED',
  'REVIEW_OPEN_ISSUES',
]);
const codes = new Set(REVIEW_REJECTION_CODES);
export const isReviewRejectionCode = value => typeof value === 'string' && codes.has(value);

export function reviewRejectionResult(value, taskId) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 3 && value.taskId === taskId &&
    value.status === 'rejected' && isReviewRejectionCode(value.failureCode);
}
