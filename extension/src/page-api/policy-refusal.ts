/**
 * The codes Harbor's policy gate refuses a page's call with, as
 * docs/PERMISSIONS.md lists them. A page handler reports one of these as is;
 * any other failure keeps the handler's own code (ERR_MODEL_FAILED,
 * ERR_TOOL_FAILED, ...), whatever code or text it carried.
 */
export const POLICY_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'ERR_PERMISSION_DENIED',
  'ERR_BLOCKED_BY_POLICY',
  'ERR_QUARANTINED',
  'ERR_LABEL_FLOW_BLOCKED',
]);

/**
 * The policy engine's code when `error` (a thrown error, or a stream's
 * error) is Harbor's policy gate refusing the call; otherwise undefined.
 */
export function policyRefusalCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && POLICY_REFUSAL_CODES.has(code) ? code : undefined;
}
