# Harbor Brand and Interface System Direction

**Status:** Direction approved, retained as discovery record
**Date:** July 25, 2026
**Decision owner:** Harbor maintainers
**Source of product truth:** [`../POSITIONING.md`](../POSITIONING.md)
**Normative guide:** [`harbor-brand-guide.md`](harbor-brand-guide.md)

## Purpose

Harbor needs a recognizable brand package and a small design system that can
support its browser extensions, documentation, demos, specifications, and future
agent surfaces.

The current interface is operationally competent, but its visual language is
not yet distinct enough to express Harbor's position:

> AI as a browser capability, with the user's model, credentials, context, and
> permissions remaining under user control.

This document captures the discovery work, three visual directions, the
selected direction, and the host-aware theme architecture. Port Authority was
approved on July 25, 2026. The normative rules and initial assets now live in
the Harbor brand guide and `brand/`.

## Current-State Audit

Harbor currently has two partially independent visual systems.

### Product interface

The extension uses:

- A system sans and monospace type stack
- A strict 4 px spacing scale
- Neutral white and charcoal surfaces
- Generic developer-tool blue
- Green, amber, and red semantic states
- Compact bordered panels and accordions
- A blue square containing a white `H`

The strengths are density, legibility, clear status, and straightforward form
controls. The weaknesses are generic brand expression, repetitive bordered
containers, weak information hierarchy, and limited distinction from other
developer tools.

The token file describes itself as Stripe-inspired. That is a useful reference
point, but not an ownable identity.

### Public whitepaper

The whitepaper has a more distinctive editorial voice:

- Instrument Serif for display type
- Inter for body copy
- JetBrains Mono for code and technical metadata
- Rust-clay as a restrained accent
- Hairline rules instead of card decoration
- A technical-paper rhythm
- A recurring trust-line concept
- Direct, factual language about draft status and limitations

This system is more memorable, but it is optimized for long-form reading rather
than a compact operational browser interface.

### Existing mark

The current icon is a white block `H` inside a rounded nautical-blue square. It
is legible at extension sizes, but it behaves like a placeholder app tile rather
than a proprietary mark.

## What Should Survive

The overhaul should retain:

- Compact operational density
- Firefox-first behavior
- The 4 px spacing foundation
- Monospace technical identities and endpoints
- Explicit status and error semantics
- Borders as the primary depth strategy
- Minimal decorative color
- Factual, non-hyped product voice
- The External agent → Harbor → shared-tab trust-boundary rail
- Clear separation between native authority, extension policy, and page state

The visual overhaul must not weaken security comprehension for novelty.

## Brand Thesis

Harbor is calm infrastructure for user-controlled AI on the open web.

It should feel like a precise navigation instrument:

- Quiet until attention is required
- Explicit about identity and authority
- Designed for changing conditions
- Technical without becoming a terminal
- Nautical without anchors, waves, ropes, or maritime cosplay
- Modern without becoming a generic black-and-white software brand

## Product Domain

The relevant territory is:

- Harbor
- Bridge
- Channel
- Mooring
- Beacon
- Port authority
- Navigation signal
- Manifest
- Vessel identity
- Boundary
- Passage
- User control

These concepts should influence naming, structure, interaction, and motion. They
should not become literal illustrations.

## Color World

The physical color world is:

- Deep harbor slate
- Open-water blue
- Fog white
- Weathered steel
- Navigation green
- Beacon amber
- Buoy clay-red
- Warm dock light

Color should communicate structure or state. Harbor should have one proprietary
brand signal color, while green, amber, and red retain semantic meaning.

## Signature

The recommended signature is the **Harbor line**.

It is a thin visual route connecting principals, capabilities, and targets. At
important boundaries it passes through a small port light that communicates
state.

The Harbor line can appear in:

- The External agent → Harbor → shared-tab trust rail
- Provider → endpoint connection metadata
- Model → capability → site relationships
- Permission and session timelines
- Architecture diagrams
- Progress transitions
- The logo or icon construction

The line must remain functional. It is not decorative plumbing between cards.

## Defaults to Reject

### Generic blue app tile

Replace the rounded blue `H` square with a proprietary mark built around a
channel, bridge, boundary, or negative-space harbor entrance.

### Accordion card stack

Replace the repeated card-within-card pattern with a continuous operational
canvas, docked sections, ledger rows, and strategic inset surfaces.

### Generic developer-tool blue

Replace borrowed Linear or Stripe blue with a Harbor-authored brand signal that
works with fog, slate, and adaptive host colors.

### Status dots without context

Use port lights as part of a named connection or authority path. Never rely on
color alone.

### One neutral sans everywhere

Give Harbor a recognizable typographic voice. Controls remain compact and
highly legible, while brand and major navigation receive a more distinctive
register.

## Direction A: Port Authority

**Recommendation**

Port Authority unifies the whitepaper's editorial intelligence with the
extension's operational precision.

### Character

- Calm
- Assured
- Editorial
- Technical
- Open
- Durable

### Visual language

- Fog and slate foundation
- Restrained clay or beacon signal color
- Hairline Harbor lines
- Port-light state markers
- Editorial titles paired with compact sans controls
- Monospace registration-style metadata
- Mostly square or lightly rounded geometry
- Continuous surfaces with ledger divisions

### Brand mark territory

A negative-space channel creates an `H` or bridge form without drawing a
literal letter. The outer silhouette must remain recognizable at 16 px.

### Product expression

The popup feels like a compact port authority console. It names what is
connected, where it is going, who approved it, and when the authority expires.

### Host-aware behavior

Host colors influence the surrounding fog, slate temperature, and control
contrast. The Harbor signal color and semantic colors remain controlled.

### Risk

If the editorial typography is used too heavily in dense controls, the product
will feel ornamental. Display type must be reserved for brand and navigation.

## Direction B: Open Water

Open Water emphasizes portability, adaptability, and the idea that Harbor moves
the user's AI across the web.

### Character

- Fluid
- Luminous
- Lightweight
- Welcoming
- Browser-native

### Visual language

- Cool translucent surfaces
- Blue-green signal family
- More generous negative space
- Soft surface transitions
- Thin flowing connection paths
- Humanist sans typography
- Reduced use of visible containers

### Brand mark territory

An open channel or paired currents form a simple passage symbol.

### Product expression

The popup feels integrated with the browser rather than installed on top of it.
Host-aware theming is the most visible feature of this direction.

### Host-aware behavior

The interface derives surface temperature and contrast from the browser
environment, then applies a controlled Harbor overlay.

### Risk

This direction can drift toward generic browser-assistant aesthetics. Excessive
translucency would also weaken contrast and Firefox consistency.

## Direction C: Signal Room

Signal Room emphasizes infrastructure, authority, and explicit machine state.

### Character

- Dense
- Instrumental
- Exact
- Technical
- High-confidence

### Visual language

- Deep slate and near-black surfaces
- Amber primary signal
- Mono-forward metadata
- Hard alignment
- Compact ledgers
- Channel markers and routing diagrams
- Minimal radius

### Brand mark territory

A geometric beacon, channel marker, or signal gate creates a highly compact
symbol.

### Product expression

The popup feels like a modern network operations instrument. It is strongest
for debugging providers, tools, sessions, and permissions.

### Host-aware behavior

Host theming changes contrast and surface temperature, but Signal Room retains
a stronger independent identity than the other directions.

### Risk

It can become intimidating, overly terminal-like, and too narrowly targeted at
infrastructure engineers.

## Recommendation

Choose **Port Authority** as the core system.

Borrow:

- Open Water's host-aware adaptability
- Signal Room's explicit machine-state discipline

Do not combine the three visual languages evenly. Port Authority should control
the composition, typography, mark, and brand palette. The other directions
contribute specific behaviors only.

The result should be identifiable as Harbor without relying on the product name:

- Editorial intelligence from the whitepaper
- Operational precision from the extension
- A proprietary trust-line signature
- A controlled nautical color world
- Browser-aware surfaces
- Visible user authority

## Host-Aware Appearance

Harbor should complement the browser environment without copying it literally.

### Principle

Host colors are inputs. They are never component tokens.

The system maps browser signals through contrast, saturation, and brand
constraints before exposing semantic tokens to components.

### Capability ladder

#### Level 1: universal

All browsers should support:

- `color-scheme`
- `prefers-color-scheme`
- `prefers-contrast` where available
- `forced-colors`
- Reduced-motion preferences
- Explicit Harbor Light, Dark, High Contrast, and Auto modes

#### Level 2: Firefox enhanced

When the Firefox theme API returns useful colors for the focused window, Harbor
may derive:

- Host frame temperature
- Host toolbar lightness
- Host accent suggestion
- Appropriate light or dark surface family

The adapter must tolerate empty or partial theme objects.

#### Level 3: Chrome complementary

Chrome should use the universal signals and a Harbor-authored complementary
palette. Harbor should not add broad management permissions merely to learn
that a theme extension is installed.

#### Level 4: user override

The user can always choose:

- Auto
- Light
- Dark
- High Contrast

The explicit choice wins over host-derived appearance.

### Token flow

```text
Browser and operating-system signals
                  ↓
        Host capability adapter
                  ↓
          Palette reconciler
                  ↓
         Harbor semantic tokens
                  ↓
   Popup, sidebar, approvals, and status
```

### Proposed token layers

#### Primitive

Raw color, type, spacing, radius, motion, and opacity values.

#### Brand

Harbor fog, slate, signal, steel, beacon, and buoy families.

#### Host

Normalized inputs such as:

- `--host-scheme`
- `--host-surface-temperature`
- `--host-frame-lightness`
- `--host-accent-suggestion`
- `--host-contrast`

#### Semantic

Product meaning such as:

- Canvas
- Surface
- Inset
- Text hierarchy
- Border hierarchy
- Focus
- Active authority
- Pending authority
- Disconnected authority
- Destructive action

#### Component

Local aliases for controls, ledgers, trust rails, port lights, inline forms,
toasts, and technical metadata.

Components must not consume raw host colors.

## Typography Questions

The system needs three roles:

1. A distinctive brand or editorial face
2. A compact, highly legible interface sans
3. A technical monospace face

The whitepaper's Instrument Serif and JetBrains Mono are strong candidates for
continuity. The production interface should test a modern humanist or grotesk
sans rather than automatically retaining the system stack or adopting another
default software font.

Font licensing, extension package size, Firefox rendering, and offline behavior
must be evaluated before selection.

## Brand Package Deliverables

After direction approval:

- Brand thesis and principles
- Primary mark
- Small extension icon
- Monochrome mark
- Wordmark
- Clear-space and minimum-size rules
- Light and dark usage
- Core and semantic color palettes
- Typography specification
- Iconography rules
- Motion principles
- Voice and interface-copy guide
- Accessibility requirements
- Host-aware appearance specification
- Design tokens
- Popup and sidebar component inventory
- High-fidelity Firefox-first prototype
- Chrome and Safari adaptation guidance
- Migration plan

## First Prototype Scope

The first prototype should redesign one coherent operational journey:

1. Bridge and gateway health
2. Provider discovery and configuration
3. External-agent pairing
4. Shared-tab access
5. Active-session trust rail
6. Error and recovery state

It should demonstrate:

- Auto, Light, Dark, and High Contrast
- Firefox enhanced adaptation
- Chrome complementary behavior
- Compact and expanded sidebar widths
- Keyboard focus and live status
- Loading, empty, success, warning, and failure states

## Evaluation Criteria

The chosen direction must pass:

- Recognition at 16 px without the word Harbor
- Clear hierarchy when viewed at popup width
- WCAG contrast requirements
- Light and dark coherence
- High-contrast and forced-colors resilience
- Firefox theme adaptation without contrast loss
- Chrome fallback without visual degradation
- Distinguishable active, pending, disabled, and disconnected states
- No authority communicated by color alone
- No secret or sensitive metadata used as decoration
- No dependence on network-loaded assets

## Decision

The approved direction is:

- **Direction:** Port Authority
- **Signal color:** Evolve rust-clay into a broader beacon family
- **Display type:** Retain Instrument Serif for brand and editorial moments
- **Mark territory:** Negative-space channel and bridge
- **Default appearance:** Auto
