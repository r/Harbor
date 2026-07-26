# Harbor Interface System

## Direction

Harbor is a dense, precise developer tool for managing browser capabilities,
native bridges, model providers, endpoints, and connection health. Interfaces
should feel calm and operational, with enough technical detail to diagnose a
problem without becoming a debugging console.

The primary user is a developer configuring infrastructure from a persistent
browser side panel beside the page they are working in. They need to identify a
resource, understand where Harbor will connect, verify its state, and recover
from an error without losing page context.

The approved brand direction is Port Authority. It combines the whitepaper's
editorial intelligence with the extension's operational precision. Use Open
Water only for host-aware adaptation and Signal Room only for explicit
machine-state discipline.

## Brand Identity

- The master package lives in `brand/`.
- The normative guide is `docs/specs/harbor-brand-guide.md`.
- The mark is a harbor gate with two piers, a bridge span, an open lower
  channel, and one controlled beacon light.
- Use `brand/harbor-extension-icon.svg` at browser icon sizes.
- Use the beacon as a brand signal, never as a runtime status light.
- Do not use generic blue app tiles, nautical illustration, gradients,
  shadows, or decorative circuitry.

## Visual Language

- Domain concepts: harbor, bridge, provider, endpoint, runtime, capability,
  connection, model discovery, and trusted boundary.
- Color world: charcoal runtime surfaces, white and graphite structure, Harbor
  blue actions, green connected states, amber pending states, and red failures.
- Signature: connection metadata stays visible beside resource health. Provider
  names describe the human meaning, while endpoints use monospace typography.
- Agent authority uses a visible trust-boundary rail: Agent → Harbor → exact
  tab. Each stop names the principal or target and shows its current state.
- Avoid generic account cards, modal setup wizards, decorative icons, gradients,
  and disconnected settings pages.
- Prefer one continuous operational canvas, docked sections, and ledger rows
  over repeated card-within-card structures.

## Depth and Surfaces

- Use borders as the primary depth strategy.
- Use `--color-surface-primary` for panels and `--color-surface-secondary` for
  inset forms and resource rows.
- Use `--color-border-subtle` for internal separation and
  `--color-border-default` for interactive boundaries.
- Keep shadows limited to transient overlays such as toasts.
- Use `--radius-sm` for controls and resource rows, and `--radius-md` for panels.

## Typography

- Use Inter for labels, controls, resource names, and operational headings.
- Use JetBrains Mono for endpoints, identifiers, scopes, and connection
  metadata.
- Use Instrument Serif only for the outlined wordmark, brand statements, and
  rare section moments at 24 px or larger.
- Use uppercase `--text-xs` section labels with `--tracking-wide`.
- Keep resource names visually primary, health secondary, and endpoints muted.
- Package all production extension fonts locally. Network font requests are not
  permitted.

## Spacing

- Use the existing 4 px base unit.
- Use `--space-1` for tightly related metadata.
- Use `--space-2` within controls and resource rows.
- Use `--space-3` inside forms and between distinct sections.
- Keep padding symmetrical unless content requires otherwise.

## Panel-First Navigation Pattern

Harbor's canonical operational surface is `extension/src/sidebar.html`. Keep one
shared panel document and controller across browsers:

- Chrome 114 and later uses the native `side_panel` manifest surface. Clicking
  the toolbar action opens the Harbor panel.
- Firefox uses the native `sidebar_action` manifest surface. Clicking the
  toolbar action toggles the Harbor sidebar.
- Safari retains the toolbar popup as a compatibility fallback.

The panel remains available beside the current page and must not behave like a
transient menu:

- Keep bridge health and Harbor identity visible in the panel header.
- Preserve operational state when the developer interacts with the page.
- Refresh tab-sensitive state when visibility or active-tab context changes.
- Bind approvals to the exact tab shown in the trust-boundary rail. Never imply
  that authority followed the developer to another tab.
- Open broad browsing surfaces such as the MCP directory in a full browser tab.
- Keep the operational panel usable without horizontal scrolling from 320 to
  480 px.
- At narrow widths, stack the Agent, Harbor, and exact-tab boundaries while
  preserving their directional order.
- Do not maintain separate full popup and side-panel implementations.

## Port Authority Tokens

- The source token package is `brand/port-authority.tokens.css`.
- Components consume semantic tokens, never raw primitives or host inputs.
- Fog and slate build structure.
- Beacon clay identifies Harbor, route emphasis, and focus.
- Navigation green means the complete required path is connected.
- Navigation amber means pending, paired, paused, enabled, or expiring.
- Buoy red means failed, disconnected, revoked, or destructive.
- Disabled is neutral.
- Explicit Light, Dark, or High Contrast selection wins over Auto.

## Provider Configuration Pattern

Provider configuration belongs inline under the Providers section:

1. A full-width secondary trigger names the provider being added.
2. The trigger expands into an inset form without navigating away.
3. The form begins with a semantic provider badge, provider type, and one-line
   explanation of the connection path.
4. Ask for a human-readable provider name before the endpoint.
5. Explain endpoint constraints immediately below the URL field.
6. Use secondary Cancel and primary Save actions.
7. Saving should validate, persist, probe the exact saved instance, and refresh
   model discovery.
8. Close the form after a successful probe. Keep it open after a failed probe
   so the endpoint can be corrected immediately.

Configured remote providers should show:

- Human-readable name
- Connected or unreachable state
- A muted monospace `Remote · host` line
- An Edit action that reuses the same inline form
- A destructive Delete action for persisted provider instances

## Agent Gateway Trust Boundary Pattern

Agent access belongs inline in the Harbor operational panel as an approval
surface, not in DevTools or a separate settings page.

The primary structure is the trust-boundary rail:

1. Agent identifies the paired client by human-readable name and monospace ID.
2. Harbor shows whether the native bridge and gateway authority are ready.
3. Tab identifies the exact browser target by title, origin, window ID, and tab
   ID.

An approval must always show:

- The exact paired client
- The exact controllable HTTP(S) tab
- Explicit scopes, never an implied bundle
- A concrete expiry or TTL
- Current lifecycle state

Use `tabs:list` and `page:observe` as separately selectable scopes. Do not
preselect authority that the developer did not explicitly choose. When choosing
a default target, use only the active tab in the focused window and still show
its window and tab IDs.

Pairing credentials are a protected transient state:

- Show the client ID and one-time secret prominently in monospace text.
- Provide a separate copy action for each value.
- Keep the secret out of persistent UI state, storage, logs, and status text.
- Require explicit acknowledgement before leaving the credential state.
- Keep only permitted client metadata after acknowledgement.

Session controls stay attached to the active trust rail. Provide concrete Pause,
Resume, End, Revoke, and Disable actions. Destructive actions identify the exact
target, use an explicit confirmation state, and always provide Cancel.

During asynchronous authority changes:

- Disable conflicting controls.
- Replace the action label with the concrete operation in progress.
- Mark the panel busy and announce progress through a polite live region.
- Restore deterministic keyboard focus after controls appear or disappear.
- Keep local authority fail closed when native synchronization fails.

Do not use auto-approval, hidden session creation, wildcard targets, or a generic
account-card presentation for browser authority.

## States

- Default: secondary trigger or quiet resource row.
- Focus: existing global focus ring and control border token.
- Saving: disable the primary action and replace its label with a concrete
  connection verb.
- Connected: green status and a concise confirmation toast.
- Active authority: green status only when the complete Agent → Harbor → tab
  path is ready and the session is active.
- Enabled, paired, paused, expiring, or awaiting approval: amber status.
- Disabled: muted neutral status, not an error.
- Disconnected or failed authority: red status with a boundary-specific error.
- Unreachable: muted resource treatment, explicit status, and an error toast
  that distinguishes saved configuration from failed connectivity.
- Invalid: keep the form open and report a boundary-specific validation error.
- Deleting: confirm the exact provider name, disable the destructive action,
  remove the persisted instance, and refresh provider and model discovery.
- Discovering: disable provider-add actions and show concise waiting text until
  model discovery succeeds or a persisted provider reports connected.

## Implementation Guidance

- Reuse the shared design tokens and existing button and form primitives.
- Keep provider input validation in a small pure module with focused tests.
- Normalize endpoint input before persistence.
- Escape provider names, identifiers, and endpoint metadata before inserting
  them into generated markup.
- Do not hard-code deployment-specific provider names or endpoints.
- Show only one provider configuration form at a time. Hide add actions while
  edit or credential configuration is active.
- Offer deletion only for persisted instances, never for auto-detected provider
  types.
- Extend this pattern for future remote provider types instead of creating a
  separate configuration surface for each one.
- Keep native pairing authority, extension policy, and volatile tab sessions as
  separate state owners. The interface may summarize them, but must not blur
  their boundaries.
- Minimize browser metadata. Show origins instead of full URLs when paths,
  queries, or fragments are not required for the decision.
- Treat page-derived names and text as untrusted content and preserve the
  gateway redaction boundary in every new view.
- Add direct controller or DOM tests for credential lifetime, focus restoration,
  live status, busy controls, and destructive confirmation when extending the
  gateway UI.
