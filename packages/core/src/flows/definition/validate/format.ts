import type { FlowValidationIssue } from './types.js';

export function formatFlowValidationIssues(issues: FlowValidationIssue[]): string {
  return issues.map((issue) => `- [${issue.code}] ${issue.path}: ${issue.message}`).join('\n');
}
