# Harbor Brand Guide

**System:** Port Authority

**Status:** Initial approved guide

**Approved:** July 25, 2026

**Product truth:** [`../POSITIONING.md`](../POSITIONING.md)

**Discovery record:** [`harbor-brand-system.md`](harbor-brand-system.md)

**Asset package:** [`../../brand/README.md`](../../brand/README.md)

**Extension specimen:** [`../specimens/harbor-extension-port-authority.html`](../specimens/harbor-extension-port-authority.html)

## Brand thesis

Harbor is calm infrastructure for user-controlled AI on the open web.

It treats AI as a browser capability. The browser mediates the user's models,
credentials, tools, context, and permissions so any website can request an AI
capability without owning those resources.

Harbor should feel like a precise navigation instrument:

- Quiet until attention is required
- Explicit about identity, authority, target, and duration
- Technical without becoming a terminal
- Adaptable to changing browser conditions
- Open and durable rather than vendor-specific
- Nautical through structure and vocabulary, never illustration

## Principles

### Name the boundary

Every authority surface names the principal, Harbor boundary, target, scope,
and expiry. Never reduce a consequential decision to a generic status card.

### Keep the route visible

Connection metadata stays attached to the resource it describes. The Harbor
line connects principals and targets only when that route helps the user
understand or act.

### Signal with restraint

Fog and slate build structure. Beacon clay identifies Harbor and focus. Green,
amber, and red communicate state. Color never carries state by itself.

### Prefer ledgers to dashboards

Harbor is an operational console. Use continuous canvases, docked sections, and
ledger rows instead of grids of floating metric cards.

### Adapt without disappearing

Host appearance is an input to the palette reconciler, not a source of
component colors. Harbor can complement Firefox or Chrome while retaining its
own signal, type, and semantic system.

### State limitations plainly

Harbor is a proposal with a working implementation. Interface and public copy
state readiness, risk, and limitations directly. Do not imply safety through
style or overstate product maturity.

## Signature

The Harbor line is a thin route connecting principals, capabilities, and exact
targets. A port light marks each meaningful stop.

Use it for:

- Agent to Harbor to exact-tab authority
- Provider to endpoint connectivity
- Model to capability to site relationships
- Permission and session timelines
- Architecture diagrams

Do not use it:

- Between unrelated cards
- As a page border
- As decorative circuitry
- Without labels
- When a simple row communicates the relationship better

Each stop needs a text label. State is expressed through a light shape, color,
and adjacent status text.

## Mark

The primary mark is a harbor gate:

- Two piers create the vertical structure
- A bridge span creates the horizontal crossing
- The lower negative space remains open as a channel
- A beacon light sits at the controlled crossing
- The geometry forms an `H` only as a secondary reading

### Asset roles

| Asset | Role |
|---|---|
| `brand/harbor-mark.svg` | Primary two-color mark |
| `brand/harbor-mark-inverse.svg` | Two-color mark for dark surfaces |
| `brand/harbor-mark-monochrome.svg` | One-color and forced-color use |
| `brand/harbor-extension-icon.svg` | Browser toolbar and store icon |
| `brand/harbor-wordmark.svg` | Primary horizontal lockup |
| `brand/harbor-wordmark-inverse.svg` | Horizontal lockup for dark surfaces |

### Clear space

Keep clear space around the mark equal to the beacon diameter. No text, border,
or competing signal may enter this area.

### Minimum sizes

| Context | Minimum |
|---|---:|
| Standalone digital mark | 20 px |
| Extension icon | 16 px |
| Wordmark lockup | 120 px wide |
| Print mark | 6 mm |

At 16 px, use the extension icon. The standalone mark and wordmark are not
intended for that size.

### Color use

On fog or white, use slate piers and a beacon-clay light. On slate, use fog
piers and the brighter beacon. Use monochrome for forced colors, engraving,
single-ink print, or environments where the beacon cannot remain controlled.

The beacon is a brand signal. It does not turn green, amber, or red to indicate
runtime status.

### Misuse

Do not:

- Put the mark inside a generic rounded blue square
- Add an anchor, wave, rope, ship wheel, lighthouse, or compass
- Stretch, rotate, bevel, outline, or add a shadow
- Fill the negative-space channel
- Move or multiply the beacon
- Use the mark as a status indicator
- Recreate the wordmark with another serif

## Color

The palette comes from fog, slate water, weathered steel, dock light, channel
beacons, navigation lights, and buoy red.

### Core palette

| Token | Value | Role |
|---|---|---|
| Fog 50 | `#fbfaf7` | Light canvas |
| Fog 100 | `#f6f3ec` | Light inset and dark text |
| Fog 200 | `#e9e4da` | Quiet separation |
| Slate 950 | `#101a1e` | Dark canvas |
| Slate 900 | `#17262b` | Primary ink and dark surface |
| Slate 800 | `#22363d` | Raised dark surface |
| Slate 600 | `#49636a` | Secondary light text |
| Steel 300 | `#abb8b8` | Secondary dark text |
| Beacon 600 | `#a74a2a` | Light brand signal |
| Beacon 400 | `#d4764f` | Dark brand signal |

### Semantic colors

| Meaning | Light | Dark |
|---|---|---|
| Connected or active | `#2f765f` | `#68b99a` |
| Pending or expiring | `#9a6519` | `#e4b35e` |
| Failed or destructive | `#aa4138` | `#e6796e` |

Connected means the complete path is ready, not merely detected. Paired,
enabled, pending, paused, or expiring uses amber. Disabled uses neutral text.
Failed, disconnected, or revoked uses red with an explicit label.

### Distribution

Most product surfaces should be fog, slate, and steel:

- 80 percent structure and text
- 15 percent state and interaction surfaces
- 5 percent brand signal

This ratio is guidance, not a pixel-counting requirement.

## Typography

Harbor uses three roles.

### Brand and editorial

**Instrument Serif Regular**

Use for:

- The outlined Harbor wordmark
- Major brand statements
- Rare section titles at 24 px or larger
- Editorial callouts in public material

Do not use in controls, status labels, forms, table rows, or dense panel
headings.

### Interface

**Inter Regular, Medium, and Semibold**

Use for:

- Body copy
- Navigation
- Buttons and form controls
- Resource names
- Status labels
- Operational headings

The extension packages required font files locally. The system stack remains a
fallback, not the intended rendering.

### Technical

**JetBrains Mono Regular and Medium**

Use for:

- Endpoints and origins
- Client, window, tab, provider, and session identifiers
- Scopes and capability names
- Durations and timestamps where alignment matters
- Compact technical metadata

Disable discretionary ligatures for identifiers. Use tabular figures for
durations and numeric data.

### Product type scale

| Role | Size | Weight | Tracking |
|---|---:|---:|---:|
| Compact brand title | 20 px | Instrument 400 | `-0.015em` |
| Page or mode title | 18 px | Inter 600 | `-0.015em` |
| Section title | 13 px | Inter 600 | `0` |
| Body | 13 px | Inter 400 | `0` |
| Control | 12 px | Inter 500 | `0` |
| Metadata | 11 px | JetBrains Mono 400 | `0` |
| Eyebrow | 10 px | JetBrains Mono 500 | `0.08em` |

Uppercase is reserved for short eyebrows and registration-style metadata. Do
not uppercase ordinary panel titles.

## Layout

### Grid

Use a 4 px base unit. Product spacing uses 4, 8, 12, 16, 20, 24, and 32 px.
Choose the smallest value that preserves grouping and target size.

### Shape

| Element | Radius |
|---|---:|
| Input, button, ledger row | 4 px |
| Panel | 6 px |
| Popover or toast | 8 px |
| Port light | Circular |

Avoid large pill shapes. A pill is permitted only for a compact bounded value,
not for navigation, ordinary actions, or section labels.

### Depth

Borders and surface shifts establish depth:

1. Canvas
2. Primary surface
3. Inset surface
4. Raised transient surface

Inputs are inset relative to their parent. Shadows are limited to transient
overlays and should remain visually secondary to the border.

### Composition

Use:

- One continuous operational canvas
- Docked section headers
- Ledger rows with aligned identities and actions
- Inline forms below the resource being changed
- Inset surfaces for secrets, errors, and active edits

Avoid:

- Repeated card-within-card structures
- Symmetrical dashboard grids
- Large empty hero areas inside the extension
- Centered empty states with decorative icons
- Detached status summaries

## Components

### Port light

A port light is a 7 px state marker attached to a named resource or route stop.
Its label carries the state. Pending lights may fade between 55 and 100 percent
opacity. Do not scale, bounce, or glow them.

### Ledger row

A resource row contains:

1. Human-readable name
2. Explicit state label
3. Muted monospace endpoint or identifier
4. Actions aligned to the resource

Use a quiet surface shift on hover. Do not lift rows with shadows.

### Trust rail

The trust rail shows:

1. Agent name and client ID
2. Harbor bridge and gateway state
3. Exact tab title, origin, window ID, and tab ID

Each stop has its own port light and state label. The line never implies that a
later stop is ready when an earlier boundary has failed.

### Inline configuration

Configuration expands beneath its trigger or edited resource. Ask for a human
name before an endpoint. Keep constraints next to the field. Saving validates,
persists, probes the exact saved instance, and refreshes discovery.

### Actions

Primary actions use slate on light and fog on dark. Beacon clay is reserved for
brand signal, route emphasis, focus, and carefully bounded highlights.

Destructive actions begin quiet. Confirmation names the exact resource, keeps
Cancel available, and does not rely on red alone.

### Navigation

Use a compact mode switch for major extension areas. Keep the active mode
visible through position, weight, border, and label. Do not use a generic icon
rail unless icon comprehension has been tested at extension width.

## Iconography

Use a single 1.5 px line system with square geometry softened only at joins.
Icons clarify a named action and do not decorate headings or empty states.

Preferred icon qualities:

- 16 px default grid
- Round line caps only for directional paths
- Mitered or slightly rounded structural corners
- No filled circular icon containers
- No mixed emoji and vector icons

Reload, appearance, copy, edit, delete, pause, resume, and revoke require text
labels when space permits. Icon-only controls require an accessible name and a
tooltip.

## Motion

Motion communicates state change and route continuity:

- Hover and press: 80 to 140 ms
- Inline expansion: 180 to 220 ms
- Toast entry and exit: 180 to 220 ms
- Easing: decelerating `cubic-bezier(.2, .8, .2, 1)`

Use opacity and short translations under 4 px. The Harbor line may reveal in
the direction of a successful connection. Never use bounce, elastic movement,
ambient floating, or continuous glow.

Reduced motion removes all nonessential duration and route drawing.

## Voice

Harbor speaks like an operator standing beside the user.

### Character

- Direct
- Calm
- Specific
- Factual
- Non-promotional

### Write

- `Connected to Ollama workstation`
- `Saved, but the endpoint did not respond`
- `Codex CLI can observe this exact tab for 15 minutes`
- `Gateway access is off`
- `Copy this secret now. Harbor will not show it again.`

### Avoid

- `Everything looks great!`
- `Something went wrong`
- `Secure connection`
- `AI-powered magic`
- `Grant full access`
- `Don't worry`

Use `connected` only when the full required path is ready. Distinguish saved
configuration from verified connectivity. Avoid `safe` or `secure` as broad
claims. Name the concrete control or reduced surface instead.

## Host-aware appearance

Auto is the default. Explicit Light, Dark, or High Contrast selection wins.

### Capability order

1. User override
2. Forced colors and contrast preferences
3. Firefox focused-window theme signals
4. Operating-system color scheme
5. Harbor-authored browser fallback

Firefox may contribute frame temperature, toolbar lightness, and a constrained
accent suggestion. Chrome and Safari use universal media signals and
Harbor-authored complementary palettes.

The palette reconciler validates contrast and saturation, then writes Harbor
semantic tokens. Components never consume raw browser colors.

## Accessibility

- Meet WCAG 2.2 AA contrast for text and interactive boundaries
- Preserve a visible 2 px focus indicator with 2 px offset
- Keep pointer targets at least 28 px in dense extension contexts and 44 px
  where layout permits
- Pair every status color with a shape, label, or both
- Announce asynchronous status through polite live regions
- Use alerts for blocking failures
- Restore keyboard focus after forms and confirmation states close
- Preserve forced-color system values
- Remove nonessential motion when requested
- Never use secrets, page content, or sensitive metadata as decoration

## Token contract

`brand/port-authority.tokens.css` provides:

1. Primitive brand values
2. Light, dark, and high-contrast semantic values
3. Automatic system dark behavior
4. Forced-color aliases
5. Reduced-motion durations

Components consume only `--harbor-canvas`, `--harbor-surface-*`,
`--harbor-text-*`, `--harbor-border-*`, `--harbor-control-*`,
`--harbor-brand-signal`, and semantic state tokens.

## Production migration sequence

1. Add local font assets and licenses.
2. Introduce Port Authority tokens beside the current tokens.
3. Replace the extension icon and header lockup.
4. Migrate canvas, text, borders, controls, and focus states.
5. Convert top-level panels into docked sections and ledger rows.
6. Apply the Harbor line to provider and trust-boundary routes.
7. Add Auto, Light, Dark, and High Contrast appearance controls.
8. Add the Firefox theme adapter and palette reconciler.
9. Adapt the Web Agents API companion extension.
10. Remove legacy tokens after visual and accessibility parity.

Each step must preserve functionality, keyboard behavior, live regions, state
semantics, and Firefox-first testing.

## Acceptance criteria

- The extension icon remains identifiable at 16 px
- The mark remains clear in light, dark, monochrome, and forced colors
- Popup hierarchy survives a narrow 320 px viewport
- Active, pending, disabled, disconnected, and destructive states are distinct
  without relying on color alone
- Light and dark interfaces feel authored, not inverted
- Firefox host adaptation cannot lower text or control contrast
- Chrome and Safari degrade to coherent Harbor palettes
- No extension asset requires a network request
- The Harbor line appears only where it explains a real route
- Operational copy names the resource, boundary, and next action
