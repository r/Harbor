/**
 * The content-script half of a page chat's `harbor-page-chat:<chatId>`
 * port (page-chat-handlers.ts holds the background half). Pulled out of
 * page-chat.ts into its own module, imported from there, rather than
 * exported from it: page-chat.ts is bundled (esbuild, `bundle: true`) as
 * a plain script for Chrome and Safari, which load it via
 * `executeScript({ files: ['page-chat.js'] })` — a classic script, not a
 * module. A top-level `export` from page-chat.ts itself survives into
 * that bundle as a real `export { ... };` statement (an empty one, as in
 * directory.ts/injected.ts/sidebar.ts/worker-loader.ts, gets tree-shaken
 * away and leaves nothing), which a classic script can't contain —
 * `SyntaxError: Unexpected token 'export'`, and the chat never opens.
 * Exporting from *this* module instead, and only importing (never
 * re-exporting) it from page-chat.ts, keeps page-chat.ts's own bundle
 * export-free while still letting a test import `connectPageChatPort`
 * directly. build.mjs's own `checkNoEsmInScriptInjectedFiles` guards
 * against this recurring, for this file and the other script-injected
 * ones, across every browser target.
 */
import { browserAPI } from './browser-compat';

/**
 * Opens this chat's `harbor-page-chat:<chatId>` port, kept open for as
 * long as this document is — see page-chat.ts's own call site for why
 * (page-chat-handlers.ts's matching `runtime.onConnect` listener is what
 * actually ends the chat on the port's disconnect). Pulled out as its own
 * function, with no DOM in it, specifically so it's testable without one
 * (there's no jsdom in this project).
 */
export function connectPageChatPort(chatId: string): ReturnType<typeof browserAPI.runtime.connect> {
  return browserAPI.runtime.connect({ name: `harbor-page-chat:${chatId}` });
}
