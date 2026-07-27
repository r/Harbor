# Harbor Brand Package

**Direction:** Port Authority

**Status:** Initial approved system

**Normative guide:** [`../docs/specs/harbor-brand-guide.md`](../docs/specs/harbor-brand-guide.md)

This package contains the first production-ready Harbor identity assets and the
semantic token foundation for extension prototypes.

## Assets

| Asset | Use |
|---|---|
| `harbor-mark.svg` | Primary standalone mark on light surfaces |
| `harbor-mark-inverse.svg` | Primary standalone mark on dark surfaces |
| `harbor-mark-monochrome.svg` | Single-color mark for constrained contexts |
| `harbor-extension-icon.svg` | Full-bleed browser extension icon |
| `harbor-wordmark.svg` | Primary mark and outlined wordmark lockup |
| `harbor-wordmark-inverse.svg` | Inverse outlined lockup for dark surfaces |
| `port-authority.tokens.css` | Primitive, semantic, and component tokens |

## Source rules

- Treat these SVG files as masters. Generate PNG sizes from the extension icon.
- Do not recolor the beacon to communicate semantic status.
- Do not add nautical illustration, gradients, shadows, or container effects.
- Keep the mark clear space equal to the beacon diameter.
- Use the monochrome mark when only one ink color is available.
- Components consume semantic tokens, never primitive or host-input tokens.

## Prototype

Open
[`../docs/specimens/harbor-extension-port-authority.html`](../docs/specimens/harbor-extension-port-authority.html)
to review the light, dark, and high-contrast extension specimen.
