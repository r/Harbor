# Harbor public site design

This revision builds on the Harbor site Raffi Krikorian shipped in May 2026. It keeps the four-page structure, code examples, architecture diagram, and invitation to debate. The homepage now opens with the reader’s choice of agent and uses a newspaper archive to explore what permission should mean. The [May design notes](https://github.com/r/Harbor/blob/532a688/whitepaper/DESIGN_NOTES.md) explain the choices behind the earlier edition.

The four pages share the editorial hierarchy of [The State of Open Source AI](https://stateofopensource.ai/) and draw on the high-contrast public-facing design of [Mozilla](https://www.mozilla.org/en-US/). Harbor’s wordmark and coastal artwork identify the project. The proposal, technical examples and status language follow [the positioning document](../docs/POSITIONING.md).

## Type and color

Large, closely spaced sans-serif headings introduce each chapter. System fonts keep the publication readable offline. Monospaced text distinguishes API examples, chapter labels and the status line. Bright green marks the main action and the lighthouse print. Darker green carries links and syntax highlighting on light backgrounds. The theme control preserves the reader’s choice across pages.

## Layout

The homepage pairs its headline with a coastal print made of CSS shapes. The text comes first in the single-column layout. On narrow screens the navigation wraps beneath the wordmark. The three companion articles use a narrower reading measure with a chapter index alongside on desktop. Keep article anchors clear of the sticky masthead.

## Editing

Edit shared styles in `styles.css` and article content directly in the four HTML files. Check both themes, the narrow navigation and code overflow in Firefox when changing these components.
