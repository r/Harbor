/**
 * `agent.capabilities().surfaces` must match what the background allows.
 *
 * Each surface is checked against a message that surface sends: the surface
 * reports true exactly when `featureRefusal` lets that message through under
 * the same toggles. Sessions, MCP and chat aren't gated by any toggle (their
 * permission prompts gate them), so they must report true even with every
 * toggle off.
 */
import { describe, expect, it } from 'vitest';
import { featureRefusal, type FeatureFlags } from '../policy/feature-flag-set';
import { loadInjectedApi, ALL_FLAGS_TRUE, ALL_FLAGS_FALSE, resolveFromModule } from './support/api-shape';

const INJECTED_PATH = resolveFromModule(import.meta.url, '../injected.ts');
const FLAGS_ELEMENT_ID = 'harbor-page-api-flags';

/** The toggles, as a plain record (`loadInjectedApi` takes one). */
type Flags = Record<keyof FeatureFlags, boolean>;
type Surfaces = Record<string, boolean | Record<string, boolean>>;

/** A surface's path in `capabilities().surfaces`, and a message it sends. */
const SURFACE_MESSAGES: Array<[path: string, message: string]> = [
  ['ai', 'ai.languageModel.create'],
  ['tools', 'agent.tools.call'],
  ['run', 'agent.run'],
  ['browser.activeTab', 'agent.browser.activeTab.click'],
  ['browser.tabs', 'agent.browser.tabs.create'],
  ['browser.navigate', 'agent.browser.navigate'],
  ['browser.fetch', 'agent.browser.fetch'],
  ['mcp', 'agent.mcp.register'],
  ['chat', 'agent.chat.open'],
  ['sessions', 'agent.sessions.create'],
  ['agents', 'agent.agents.invoke'],
];

const FLAG_NAMES = Object.keys(ALL_FLAGS_TRUE) as Array<keyof FeatureFlags>;
const SETTINGS: Array<[label: string, flags: Flags]> = [
  ['every toggle on', ALL_FLAGS_TRUE],
  ['every toggle off', ALL_FLAGS_FALSE],
  ...FLAG_NAMES.map((name): [string, Flags] => [
    `only ${name} off`,
    { ...ALL_FLAGS_TRUE, [name]: false },
  ]),
];

function surfacesUnder(flags: Flags): Surfaces {
  const { agent } = loadInjectedApi(INJECTED_PATH, flags, FLAGS_ELEMENT_ID);
  return (agent as { capabilities(): { surfaces: Surfaces } }).capabilities().surfaces;
}

function read(surfaces: Surfaces, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], surfaces);
}

describe('agent.capabilities() surfaces match what the background allows', () => {
  it.each(SETTINGS)('with %s', (_label: string, flags: Flags) => {
    const surfaces = surfacesUnder(flags);
    for (const [path, message] of SURFACE_MESSAGES) {
      expect({ path, reported: read(surfaces, path) })
        .toEqual({ path, reported: featureRefusal(message, flags) === null });
    }
  });
});
