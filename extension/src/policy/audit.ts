/**
 * Audit Log
 *
 * Every PolicyEngine decision is recorded here. The audit log is the data
 * backbone for:
 *
 *   - The sidebar's activity feed.
 *   - The watchdog's rolling-stats analyzer.
 *   - The decision simulator's "Why?" trace surface.
 *   - Local-first telemetry (the data summarized in `docs/PERMISSIONS.md`'s
 *     "Telemetry goals" section).
 *
 * The log is in-memory by default with an optional persistence backing.
 * Records are kept in a ring buffer; the oldest entries roll off when the
 * buffer fills. The default capacity is 5,000 entries — enough for a
 * meaningful activity feed without bloating extension memory.
 */

import type { TypedAction } from './actions';
import { LabelSet } from './labels';
import type { PolicyDecision, PolicyRequest, TraceStep } from './engine';

// =============================================================================
// Record shape
// =============================================================================

export interface AuditRecord {
  /** Stable id for the record (used by the simulator). */
  id: string;
  /** When the decision was made. */
  timestamp: number;
  /** Calling origin. */
  origin: string;
  /** Was this principal a subagent? */
  isSubagent?: boolean;
  /** The action requested. */
  action: TypedAction;
  /** Resource fields, for filtering. */
  resource?: {
    server?: string;
    tool?: string;
    host?: string;
    path?: string;
  };
  /** Final effect. */
  effect: PolicyDecision['effect'];
  /** Tier that produced the verdict. */
  tier: PolicyDecision['tier'];
  /** Source family. */
  source: PolicyDecision['source'];
  /** Matched rule, if any, with the rule's own effect. */
  rule?: PolicyDecision['rule'];
  /** Reason text. */
  reason: string;
  /** Error code, if denied. */
  errorCode?: PolicyDecision['errorCode'];
  /** Labels carried at decision time. */
  labelsIn: string[];
  /** Labels attached to the output. */
  labelsOut: string[];
  /** Tier-by-tier trace. */
  trace: TraceStep[];
  /** Optional correlation id from the request. */
  correlationId?: string;
  /**
   * Set when an `ask`/`preview` verdict proceeded on consent already
   * obtained upstream, rather than on a Harbor prompt. Today this is a page
   * call: the page API checks the origin's grant in Harbor's own store
   * (`permissions.check`) before this typed-action check runs.
   */
  consent?: 'origin-grant';
}

export interface AuditExtra {
  consent?: AuditRecord['consent'];
}

// =============================================================================
// AuditLog
// =============================================================================

class AuditLog {
  private buffer: AuditRecord[] = [];
  private capacity = 5_000;
  private listeners = new Set<(record: AuditRecord) => void>();

  setCapacity(capacity: number): void {
    if (capacity <= 0) throw new Error('Audit log capacity must be positive');
    this.capacity = capacity;
    if (this.buffer.length > capacity) {
      this.buffer.splice(0, this.buffer.length - capacity);
    }
  }

  /**
   * Record a decision. Called from the engine wrapper.
   */
  record(req: PolicyRequest, decision: PolicyDecision, extra: AuditExtra = {}): AuditRecord {
    const record: AuditRecord = {
      id: `aud_${crypto.randomUUID()}`,
      timestamp: Date.now(),
      origin: req.origin,
      isSubagent: req.isSubagent,
      action: req.action,
      resource: req.resource
        ? {
            server: req.resource.server,
            tool: req.resource.tool,
            host: req.resource.host,
            path: req.resource.path,
          }
        : undefined,
      effect: decision.effect,
      tier: decision.tier,
      source: decision.source,
      rule: decision.rule,
      reason: decision.reason,
      errorCode: decision.errorCode,
      labelsIn: (req.inputLabels ?? LabelSet.empty()).toArray(),
      labelsOut: decision.outputLabels.toArray(),
      trace: decision.trace,
      correlationId: req.correlationId,
      ...(extra.consent ? { consent: extra.consent } : {}),
    };

    this.buffer.push(record);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }

    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch (err) {
        console.error('[Harbor Audit] Listener error:', err);
      }
    }

    return record;
  }

  /** All records, oldest first. */
  list(): readonly AuditRecord[] {
    return this.buffer;
  }

  /**
   * Filter records. Multiple filters AND together.
   */
  query(filters: {
    origin?: string;
    action?: TypedAction;
    source?: PolicyDecision['source'];
    effect?: PolicyDecision['effect'];
    sinceMs?: number;
    until?: number;
    label?: string;
    minTier?: number;
    limit?: number;
  } = {}): AuditRecord[] {
    const now = Date.now();
    let out = this.buffer;
    if (filters.origin) out = out.filter((r) => r.origin === filters.origin);
    if (filters.action) out = out.filter((r) => r.action === filters.action);
    if (filters.source) out = out.filter((r) => r.source === filters.source);
    if (filters.effect) out = out.filter((r) => r.effect === filters.effect);
    if (filters.sinceMs !== undefined) {
      const since = filters.sinceMs;
      out = out.filter((r) => now - r.timestamp <= since);
    }
    if (filters.until !== undefined) {
      const until = filters.until;
      out = out.filter((r) => r.timestamp <= until);
    }
    if (filters.label) {
      const label = filters.label;
      out = out.filter((r) => r.labelsIn.includes(label) || r.labelsOut.includes(label));
    }
    if (filters.minTier !== undefined) {
      const minTier = filters.minTier;
      out = out.filter((r) => r.tier >= minTier);
    }
    if (filters.limit !== undefined) {
      out = out.slice(-filters.limit);
    }
    return out;
  }

  /** Look up a record by id (for the simulator's replay). */
  get(id: string): AuditRecord | undefined {
    return this.buffer.find((r) => r.id === id);
  }

  /** Subscribe to new records. Returns an unsubscribe function. */
  subscribe(listener: (record: AuditRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Aggregate counts grouped by origin and effect — used by the watchdog
   * to build its rolling stats and by the activity feed for "summary"
   * tabs.
   */
  summarize(filters: { sinceMs?: number } = {}): {
    totalDecisions: number;
    byEffect: Record<string, number>;
    bySource: Record<string, number>;
    byOrigin: Record<string, number>;
    byAction: Record<string, number>;
    labelEgressDenials: number;
    quarantines: number;
  } {
    const records = this.query({ sinceMs: filters.sinceMs });
    const byEffect: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    const byOrigin: Record<string, number> = {};
    const byAction: Record<string, number> = {};
    let labelEgressDenials = 0;
    let quarantines = 0;
    for (const r of records) {
      byEffect[r.effect] = (byEffect[r.effect] ?? 0) + 1;
      bySource[r.source] = (bySource[r.source] ?? 0) + 1;
      byOrigin[r.origin] = (byOrigin[r.origin] ?? 0) + 1;
      byAction[r.action] = (byAction[r.action] ?? 0) + 1;
      if (r.errorCode === 'ERR_LABEL_FLOW_BLOCKED') labelEgressDenials++;
      if (r.errorCode === 'ERR_QUARANTINED') quarantines++;
    }
    return {
      totalDecisions: records.length,
      byEffect,
      bySource,
      byOrigin,
      byAction,
      labelEgressDenials,
      quarantines,
    };
  }

  /** Drop everything. Used on user-initiated audit-log reset. */
  clear(): void {
    this.buffer = [];
  }

  /** Test escape hatch. */
  __reset(): void {
    this.buffer = [];
    this.listeners.clear();
    this.capacity = 5_000;
  }
}

export const Audit = new AuditLog();

// =============================================================================
// Engine integration
// =============================================================================

/**
 * Wraps the existing `evaluate` function so every decision lands in the
 * audit log. The engine remains testable without auditing — tests can
 * call `evaluate` directly; production code routes through this wrapper
 * so nothing escapes the log.
 *
 * `setupAuditLogging()` is called once at startup and patches the engine
 * by re-exporting the wrapped evaluator. We don't monkey-patch the
 * imported function; instead, callers of `evaluateAndAudit` get auditing
 * for free, and other modules switch to it. The migration happens
 * incrementally; for this commit we just provide the wrapper.
 */
export async function evaluateAndAudit(
  req: PolicyRequest,
  evaluate: (req: PolicyRequest) => Promise<PolicyDecision>,
): Promise<PolicyDecision> {
  const decision = await evaluate(req);
  Audit.record(req, decision);
  return decision;
}
