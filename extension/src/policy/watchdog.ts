/**
 * Watchdog
 *
 * Tier 4 of the policy ladder. Watches the rolling stream of decisions
 * for an origin and decides whether the session should be downgraded.
 * Producing a verdict is fast and cheap — the engine consults the
 * watchdog on every gated call, so this module operates entirely on
 * in-memory rolling counters.
 *
 * The four states form a one-way ratchet within a session:
 *
 *   normal → flagged → restricted → quarantined
 *
 * - **flagged**: nothing changes for the user, but the audit feed marks
 *   this session as suspicious. The next ambiguous decision tightens
 *   into `restricted`.
 * - **restricted**: every action that would have been `allow` is forced
 *   up to `ask`. Confirmation prompts return.
 * - **quarantined**: every action denies with `ERR_QUARANTINED`. The user
 *   has to re-grant from the sidebar to leave this state.
 *
 * State is cleared when an origin is unloaded or the user resets it
 * from the sidebar.
 */

import type { TypedAction } from './actions';
import type { AuditRecord } from './audit';
import { Audit } from './audit';
import type { WatchdogResolver, WatchdogOutcome } from './engine';

// =============================================================================
// Thresholds
// =============================================================================

export interface WatchdogThresholds {
  /** Window over which we compute rolling counts, in ms. */
  windowMs: number;
  /** Tool calls inside the window that escalate normal → flagged. */
  toolCallsToFlag: number;
  /** Tool calls inside the window that escalate flagged → restricted. */
  toolCallsToRestrict: number;
  /** Cross-origin egress events that escalate to restricted. */
  crossOriginEgressToRestrict: number;
  /** Distinct sensitive labels touched that escalate to restricted. */
  distinctSensitiveLabelsToRestrict: number;
  /** Number of label-flow blocks (Tier 3 denies) that escalate to quarantine. */
  labelFlowDeniesToQuarantine: number;
  /** Number of consecutive denies that escalate to quarantine. */
  consecutiveDeniesToQuarantine: number;
}

export const DEFAULT_THRESHOLDS: WatchdogThresholds = {
  windowMs: 60_000, // 1 minute
  toolCallsToFlag: 20,
  toolCallsToRestrict: 60,
  crossOriginEgressToRestrict: 5,
  distinctSensitiveLabelsToRestrict: 3,
  labelFlowDeniesToQuarantine: 3,
  consecutiveDeniesToQuarantine: 5,
};

// =============================================================================
// State
// =============================================================================

type WatchdogState = 'normal' | 'flagged' | 'restricted' | 'quarantined';

interface OriginState {
  status: WatchdogState;
  reason?: string;
  toolCallTimes: number[];
  crossOriginEgressTimes: number[];
  sensitiveLabels: Set<string>;
  labelFlowDeniesTimes: number[];
  consecutiveDenies: number;
  lastUpdated: number;
}

class Watchdog {
  private state = new Map<string, OriginState>();
  private thresholds: WatchdogThresholds = { ...DEFAULT_THRESHOLDS };

  setThresholds(t: Partial<WatchdogThresholds>): void {
    this.thresholds = { ...this.thresholds, ...t };
  }

  getThresholds(): WatchdogThresholds {
    return { ...this.thresholds };
  }

  /**
   * Manually quarantine an origin. Called from the sidebar.
   */
  quarantine(origin: string, reason: string): void {
    const s = this.getOrCreate(origin);
    s.status = 'quarantined';
    s.reason = reason;
    s.lastUpdated = Date.now();
  }

  /**
   * Manually clear all state for an origin (called from the sidebar's
   * "Reset" button).
   */
  reset(origin: string): void {
    this.state.delete(origin);
  }

  /**
   * Reset everything.
   */
  resetAll(): void {
    this.state.clear();
  }

  /**
   * Get the current state for diagnostics.
   */
  inspect(origin: string): { status: WatchdogState; reason?: string } {
    const s = this.state.get(origin);
    return s ? { status: s.status, reason: s.reason } : { status: 'normal' };
  }

  /**
   * Engine resolver. Called on every gated decision.
   */
  resolve: WatchdogResolver = (origin, action) => {
    return this.evaluateOrigin(origin, action);
  };

  /**
   * Update state from an audit record. Called from the audit log
   * subscriber; can also be called explicitly by tests.
   */
  observe(record: AuditRecord): void {
    const s = this.getOrCreate(record.origin);
    const now = record.timestamp;

    // Always update consecutive-denies counter.
    if (record.effect === 'deny') {
      s.consecutiveDenies++;
    } else if (record.effect === 'allow') {
      s.consecutiveDenies = 0;
    }

    // Tool call counter.
    if (record.action === 'tool.call') {
      s.toolCallTimes.push(now);
    }

    // Cross-origin egress counter.
    if (
      record.action === 'network.egress.cross_origin' ||
      record.action === 'model.prompt.remote.thirdParty'
    ) {
      s.crossOriginEgressTimes.push(now);
    }

    // Distinct sensitive labels. We count credentials/payments/identity/
    // regulated/confidential.
    for (const label of record.labelsOut) {
      if (
        label === 'credentials' ||
        label === 'payments' ||
        label === 'identity' ||
        label === 'regulated' ||
        label === 'confidential'
      ) {
        s.sensitiveLabels.add(label);
      }
    }

    // Label-flow denies.
    if (record.errorCode === 'ERR_LABEL_FLOW_BLOCKED') {
      s.labelFlowDeniesTimes.push(now);
    }

    s.lastUpdated = now;
    this.maybeEscalate(s, now);
  }

  // =====================================================================
  // Internals
  // =====================================================================

  private getOrCreate(origin: string): OriginState {
    let s = this.state.get(origin);
    if (!s) {
      s = {
        status: 'normal',
        toolCallTimes: [],
        crossOriginEgressTimes: [],
        sensitiveLabels: new Set(),
        labelFlowDeniesTimes: [],
        consecutiveDenies: 0,
        lastUpdated: 0,
      };
      this.state.set(origin, s);
    }
    return s;
  }

  private maybeEscalate(s: OriginState, now: number): void {
    if (s.status === 'quarantined') return; // ratchet stops here

    const t = this.thresholds;
    const cutoff = now - t.windowMs;
    s.toolCallTimes = s.toolCallTimes.filter((x) => x >= cutoff);
    s.crossOriginEgressTimes = s.crossOriginEgressTimes.filter((x) => x >= cutoff);
    s.labelFlowDeniesTimes = s.labelFlowDeniesTimes.filter((x) => x >= cutoff);

    const labelFlowCount = s.labelFlowDeniesTimes.length;
    const toolCalls = s.toolCallTimes.length;
    const crossOrigin = s.crossOriginEgressTimes.length;
    const distinctLabels = s.sensitiveLabels.size;

    // Quarantine triggers.
    if (labelFlowCount >= t.labelFlowDeniesToQuarantine) {
      s.status = 'quarantined';
      s.reason = `${labelFlowCount} label-flow blocks in ${t.windowMs}ms (likely exfiltration attempt)`;
      return;
    }
    if (s.consecutiveDenies >= t.consecutiveDeniesToQuarantine) {
      s.status = 'quarantined';
      s.reason = `${s.consecutiveDenies} consecutive denies (likely scope-probing)`;
      return;
    }

    // Restrict triggers.
    if (toolCalls >= t.toolCallsToRestrict) {
      s.status = 'restricted';
      s.reason = `${toolCalls} tool calls in ${t.windowMs}ms (high velocity)`;
      return;
    }
    if (crossOrigin >= t.crossOriginEgressToRestrict) {
      s.status = 'restricted';
      s.reason = `${crossOrigin} cross-origin egresses in ${t.windowMs}ms`;
      return;
    }
    if (distinctLabels >= t.distinctSensitiveLabelsToRestrict) {
      s.status = 'restricted';
      s.reason = `Touched ${distinctLabels} distinct sensitive labels`;
      return;
    }

    // Flag trigger.
    if (s.status === 'normal' && toolCalls >= t.toolCallsToFlag) {
      s.status = 'flagged';
      s.reason = `${toolCalls} tool calls in ${t.windowMs}ms (above flag threshold)`;
    }
  }

  private evaluateOrigin(
    origin: string,
    _action: TypedAction,
  ): WatchdogOutcome {
    const s = this.state.get(origin);
    if (!s) return { status: 'normal' };
    return { status: s.status, reason: s.reason };
  }
}

export const Watchdog_ = new Watchdog();

// Re-export under the cleaner public name. Underlying class name is
// `Watchdog` (TypeScript class declaration); to avoid name collision with
// the module-level export we keep an `_` suffix on the singleton.
export { Watchdog_ as Watchdog };

// =============================================================================
// Wiring
// =============================================================================

/**
 * Subscribe the watchdog to the audit log so it observes every decision
 * automatically. Call once at startup.
 */
export function attachWatchdogToAudit(): () => void {
  const unsub = Audit.subscribe((record) => {
    Watchdog_.observe(record);
  });
  return unsub;
}
