/**
 * Decision Simulator
 *
 * Replays a past decision (from the audit log) against modified context
 * — modified rules, modified labels, modified watchdog state — without
 * actually performing the action. Used by the sidebar's "What if?" tool
 * and the unit-test harness for policy authors.
 *
 * The simulator is *pure*: it never writes to storage, never updates the
 * watchdog, never appends to the audit log. It builds a sandbox copy of
 * the engine's inputs, runs `evaluate`, and returns the result.
 */

import { evaluate, type PolicyDecision, type PolicyRequest, type PolicyResource, setOriginGrantResolver, setWatchdogResolver, type OriginGrantResolver, type WatchdogResolver } from './engine';
import { Policy } from './store';
import type { CompiledRule, Rule } from './rules';
import { compileRule } from './rules';
import { LabelSet, type DataLabel } from './labels';
import type { TypedAction } from './actions';
import { Audit, type AuditRecord } from './audit';

// =============================================================================
// Types
// =============================================================================

export interface SimulationInput {
  /** Base origin/action/resource. Falls back to the audit record's values. */
  origin?: string;
  action?: TypedAction;
  resource?: PolicyResource;
  inputLabels?: readonly DataLabel[];
  isSubagent?: boolean;
  /** Replace the loaded rule set with these rules during simulation. */
  rulesOverride?: Rule[];
  /** Override the origin-grant resolver during simulation. */
  originGrantOverride?: OriginGrantResolver;
  /** Override the watchdog resolver during simulation. */
  watchdogOverride?: WatchdogResolver;
}

export interface SimulationResult {
  decision: PolicyDecision;
  request: PolicyRequest;
  /** Diff between the original audit record and the simulated decision. */
  diff?: SimulationDiff;
}

export interface SimulationDiff {
  /** Effect changed from → to. */
  effectChanged?: { from: PolicyDecision['effect']; to: PolicyDecision['effect'] };
  /** Tier changed from → to. */
  tierChanged?: { from: PolicyDecision['tier']; to: PolicyDecision['tier'] };
  /** Source changed from → to. */
  sourceChanged?: { from: PolicyDecision['source']; to: PolicyDecision['source'] };
  /** Rule changed from → to. */
  ruleChanged?: { from?: string; to?: string };
  /** Labels added in the simulation. */
  labelsAdded: DataLabel[];
  /** Labels removed in the simulation. */
  labelsRemoved: DataLabel[];
}

// =============================================================================
// Simulate against a fresh request
// =============================================================================

/**
 * Run a hypothetical request through the engine without side effects.
 * The engine's globally-installed resolvers are temporarily swapped if
 * `input.originGrantOverride` or `input.watchdogOverride` is provided.
 */
export async function simulate(input: SimulationInput): Promise<SimulationResult> {
  if (!input.origin) throw new Error('simulate(): origin is required');
  if (!input.action) throw new Error('simulate(): action is required');

  const request: PolicyRequest = {
    origin: input.origin,
    action: input.action,
    resource: input.resource,
    inputLabels: input.inputLabels ? new LabelSet(input.inputLabels) : undefined,
    isSubagent: input.isSubagent,
    correlationId: 'simulator',
  };

  const decision = await runWithOverrides(request, input);
  return { decision, request };
}

// =============================================================================
// Replay an audit record under modified context
// =============================================================================

/**
 * Re-run a past decision under modified context, and report the diff.
 */
export async function replay(
  recordId: string,
  modifications: Omit<SimulationInput, 'origin' | 'action'> = {},
): Promise<SimulationResult> {
  const record = Audit.get(recordId);
  if (!record) throw new Error(`replay(): no audit record ${recordId}`);

  const request: PolicyRequest = {
    origin: record.origin,
    action: record.action,
    resource: {
      server: record.resource?.server,
      tool: record.resource?.tool,
      host: record.resource?.host,
      path: record.resource?.path,
      ...modifications.resource,
    },
    inputLabels: modifications.inputLabels
      ? new LabelSet(modifications.inputLabels)
      : new LabelSet(record.labelsIn as DataLabel[]),
    isSubagent: modifications.isSubagent ?? record.isSubagent,
    correlationId: 'simulator-replay',
  };

  const decision = await runWithOverrides(request, modifications);
  return {
    decision,
    request,
    diff: diffAgainstAudit(record, decision),
  };
}

// =============================================================================
// Helpers
// =============================================================================

async function runWithOverrides(
  request: PolicyRequest,
  input: SimulationInput,
): Promise<PolicyDecision> {
  // Swap rules if override given.
  let savedRules: readonly CompiledRule[] | null = null;
  if (input.rulesOverride) {
    savedRules = Policy.rules();
    Policy.__setForTesting(input.rulesOverride.map(compileRule));
  }

  // Save and swap resolvers if overrides given. This is intentionally
  // simple — the simulator runs *synchronously after* the engine setup,
  // so concurrent simulations are not supported. (The "what if?" UI
  // simulates one decision at a time.)
  const savedOriginGrant = takeOriginGrantResolver();
  const savedWatchdog = takeWatchdogResolver();
  if (input.originGrantOverride) setOriginGrantResolver(input.originGrantOverride);
  if (input.watchdogOverride) setWatchdogResolver(input.watchdogOverride);

  try {
    return await evaluate(request);
  } finally {
    if (savedRules) Policy.__setForTesting([...savedRules]);
    if (savedOriginGrant) setOriginGrantResolver(savedOriginGrant);
    if (savedWatchdog) setWatchdogResolver(savedWatchdog);
  }
}

/**
 * Capture the current origin-grant resolver so we can restore it after a
 * simulation. The engine doesn't expose a getter; we save by setting and
 * stashing what we set.
 */
let lastOriginGrant: OriginGrantResolver | null = null;
let lastWatchdog: WatchdogResolver | null = null;

/**
 * Wrappers that record what's currently installed. Call once at startup
 * via `recordCurrentResolvers()` so the simulator can restore later.
 */
export function recordCurrentResolvers(
  originGrant: OriginGrantResolver,
  watchdog: WatchdogResolver,
): void {
  lastOriginGrant = originGrant;
  lastWatchdog = watchdog;
}

function takeOriginGrantResolver(): OriginGrantResolver | null {
  return lastOriginGrant;
}

function takeWatchdogResolver(): WatchdogResolver | null {
  return lastWatchdog;
}

function diffAgainstAudit(
  record: AuditRecord,
  decision: PolicyDecision,
): SimulationDiff {
  const out: SimulationDiff = {
    labelsAdded: [],
    labelsRemoved: [],
  };
  if (record.effect !== decision.effect) {
    out.effectChanged = { from: record.effect, to: decision.effect };
  }
  if (record.tier !== decision.tier) {
    out.tierChanged = { from: record.tier, to: decision.tier };
  }
  if (record.source !== decision.source) {
    out.sourceChanged = { from: record.source, to: decision.source };
  }
  if ((record.rule?.id ?? null) !== (decision.rule?.id ?? null)) {
    out.ruleChanged = { from: record.rule?.id, to: decision.rule?.id };
  }
  const recordOut = new Set(record.labelsOut as DataLabel[]);
  for (const tag of decision.outputLabels) {
    if (!recordOut.has(tag)) out.labelsAdded.push(tag);
  }
  const decisionOut = new Set(decision.outputLabels.toArray());
  for (const tag of record.labelsOut as DataLabel[]) {
    if (!decisionOut.has(tag)) out.labelsRemoved.push(tag);
  }
  return out;
}
