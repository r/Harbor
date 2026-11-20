/**
 * A `model:prompt`/`model:tools` grant records the backend it was given
 * for, and counts only while that backend is still selected
 * (policy/backend-grant.ts). Switching to a different ACP agent, or back
 * to Harbor's built-in model, doesn't erase the grant — it just stops (or
 * resumes) counting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';
import { writeAgentBackendSetting } from '../../page-api/agent-backend-setting';

type PermissionsModule = typeof import('../permissions');
let grantPermissions: PermissionsModule['grantPermissions'];
let denyPermissions: PermissionsModule['denyPermissions'];
let checkPermissions: PermissionsModule['checkPermissions'];
let getPermissionStatus: PermissionsModule['getPermissionStatus'];
let requestPermissions: PermissionsModule['requestPermissions'];
let showPermissionPrompt: PermissionsModule['showPermissionPrompt'];
let handlePermissionPromptResponse: PermissionsModule['handlePermissionPromptResponse'];

const ORIGIN = 'https://example.test';

beforeEach(async () => {
  resetMockBrowser();
  vi.resetModules();
  ({
    grantPermissions, denyPermissions, checkPermissions, getPermissionStatus,
    requestPermissions, showPermissionPrompt, handlePermissionPromptResponse,
  } = await import('../permissions'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a grant made under one backend does not count under another', () => {
  it('counts while the backend that granted it is still selected (builtin)', async () => {
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-always');
    const check = await checkPermissions(ORIGIN, ['model:prompt']);
    expect(check.granted).toBe(true);
  });

  it('stops counting once a different ACP agent is selected', async () => {
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-always'); // granted under builtin
    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    const check = await checkPermissions(ORIGIN, ['model:prompt']);
    expect(check.granted).toBe(false);
    expect(check.missingScopes).toContain('model:prompt');
    // Not a denial — the site should be asked again, not told no.
    expect(check.deniedScopes).not.toContain('model:prompt');
  });

  it('a grant made for one ACP agent does not count for a different one', async () => {
    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    await grantPermissions(ORIGIN, ['model:tools'], 'granted-always');
    await writeAgentBackendSetting({ type: 'acp', agentId: 'codex' });
    const check = await checkPermissions(ORIGIN, ['model:tools']);
    expect(check.granted).toBe(false);
  });

  it('counts again once the original backend is reselected', async () => {
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-always');
    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    expect((await checkPermissions(ORIGIN, ['model:prompt'])).granted).toBe(false);

    await writeAgentBackendSetting(null); // back to builtin
    expect((await checkPermissions(ORIGIN, ['model:prompt'])).granted).toBe(true);
  });

  it('a legacy grant with no recorded backend counts as builtin', async () => {
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-always');
    // Strip the backend field to simulate a grant made before this existed.
    const stored = await chrome.storage.local.get('harbor_origin_permissions');
    const all = stored.harbor_origin_permissions as Record<string, { scopes: Record<string, { backend?: string }> }>;
    delete all[ORIGIN].scopes['model:prompt'].backend;
    await chrome.storage.local.set({ harbor_origin_permissions: all });

    expect((await checkPermissions(ORIGIN, ['model:prompt'])).granted).toBe(true);

    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    expect((await checkPermissions(ORIGIN, ['model:prompt'])).granted).toBe(false);
  });

  it('other scopes are unaffected by a backend switch', async () => {
    await grantPermissions(ORIGIN, ['mcp:tools.list'], 'granted-always');
    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    expect((await checkPermissions(ORIGIN, ['mcp:tools.list'])).granted).toBe(true);
  });

  it('a mismatch is reported as not-granted, not denied, in getPermissionStatus', async () => {
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-always');
    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    const status = await getPermissionStatus(ORIGIN);
    expect(status.scopes['model:prompt']).toBe('not-granted');
  });

  // Maintainer decision, 2026-11-19: a deny is universal (applies under
  // every backend); only allows are per-backend.
  it('a deny applies under every backend, not just the one selected when it was made', async () => {
    await denyPermissions(ORIGIN, ['model:prompt']);
    expect((await checkPermissions(ORIGIN, ['model:prompt'])).deniedScopes).toContain('model:prompt');

    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    const check = await checkPermissions(ORIGIN, ['model:prompt']);
    expect(check.deniedScopes).toContain('model:prompt');
  });

  it('allow under builtin, then allow under goose, then switch back: both still count', async () => {
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-always');
    expect((await checkPermissions(ORIGIN, ['model:prompt'])).granted).toBe(true);

    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-always');
    expect((await checkPermissions(ORIGIN, ['model:prompt'])).granted).toBe(true);

    await writeAgentBackendSetting(null); // back to builtin
    expect((await checkPermissions(ORIGIN, ['model:prompt'])).granted).toBe(true); // still counts — never overwritten

    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    expect((await checkPermissions(ORIGIN, ['model:prompt'])).granted).toBe(true); // goose's own allow, untouched
  });

  it('a deny after per-backend allows means denied everywhere, including backends that had an allow', async () => {
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-always');
    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-always');

    await denyPermissions(ORIGIN, ['model:prompt']);

    expect((await checkPermissions(ORIGIN, ['model:prompt'])).deniedScopes).toContain('model:prompt'); // goose, currently selected
    await writeAgentBackendSetting(null);
    expect((await checkPermissions(ORIGIN, ['model:prompt'])).deniedScopes).toContain('model:prompt'); // builtin, which had its own allow
    await writeAgentBackendSetting({ type: 'acp', agentId: 'codex' });
    expect((await checkPermissions(ORIGIN, ['model:prompt'])).deniedScopes).toContain('model:prompt'); // codex, which never had one
  });

  // A deny must actually clear the stored per-backend allows, not just
  // read as 'denied' while they're still sitting there underneath
  // (checkPermissions's own flat-grant short-circuit would hide that
  // either way) — a later grant under some *other* backend must not
  // resurrect them.
  it('a deny clears the stored per-backend allows, so a later grant elsewhere does not resurrect them', async () => {
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-always'); // builtin
    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-always'); // goose

    await denyPermissions(ORIGIN, ['model:prompt']);

    // A grant under a third backend that never held an allow before.
    await writeAgentBackendSetting({ type: 'acp', agentId: 'codex' });
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-always');

    expect((await checkPermissions(ORIGIN, ['model:prompt'])).granted).toBe(true); // codex, just granted

    await writeAgentBackendSetting(null);
    expect((await checkPermissions(ORIGIN, ['model:prompt'])).granted).toBe(false); // builtin: the deny must have actually cleared this

    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    expect((await checkPermissions(ORIGIN, ['model:prompt'])).granted).toBe(false); // goose: likewise
  });
});

describe('requestPermissions re-asks when the backend has changed', () => {
  it('shows the native prompt again for a scope that was already granted under a different backend', async () => {
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-always');
    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });

    const create = vi.spyOn(chrome.windows, 'create');
    const resultPromise = requestPermissions(ORIGIN, { scopes: ['model:prompt'] });
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    handlePermissionPromptResponse({ granted: true, grantType: 'granted-always' });
    const result = await resultPromise;
    expect(result.granted).toBe(true);
  });

  it('does not re-prompt when the backend has not changed', async () => {
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-always');
    const create = vi.spyOn(chrome.windows, 'create');
    const result = await requestPermissions(ORIGIN, { scopes: ['model:prompt'] });
    expect(result.granted).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('the grant is stamped for the backend the prompt named, not whatever is selected when the person answers', () => {
  it('a backend switch while the prompt is open does not change which backend the resulting allow is for', async () => {
    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });

    const create = vi.spyOn(chrome.windows, 'create');
    const resultPromise = requestPermissions(ORIGIN, { scopes: ['model:prompt'] });
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    // The prompt's own URL named goose — the backend selected right now,
    // when it was shown.
    const url = new URL((create.mock.calls[0][0] as { url: string }).url);
    expect(url.searchParams.get('backendTag')).toBe('acp:goose');

    // The person switches backends *while the popup is still open* — the
    // permission-prompt.html page itself doesn't re-read this; it already
    // has its own URL.
    await writeAgentBackendSetting({ type: 'acp', agentId: 'codex' });

    // The response echoes back the backend the prompt itself named
    // (what permission-prompt.ts reads from its own URL, not a live
    // read) — simulated here exactly as that page would send it.
    handlePermissionPromptResponse({ granted: true, grantType: 'granted-always', backendTag: 'acp:goose' });
    await resultPromise;

    // Granted for goose — what the prompt actually named...
    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    expect((await checkPermissions(ORIGIN, ['model:prompt'])).granted).toBe(true);
    // ...but not for codex, the backend that was live when the person
    // actually answered. Harbor asks again for it — correctly: the grant
    // is for goose, not codex.
    await writeAgentBackendSetting({ type: 'acp', agentId: 'codex' });
    expect((await checkPermissions(ORIGIN, ['model:prompt'])).granted).toBe(false);
  });

  it('with no backendTag in the response (an older prompt page), falls back to a live read', async () => {
    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    const create = vi.spyOn(chrome.windows, 'create');
    const resultPromise = requestPermissions(ORIGIN, { scopes: ['model:prompt'] });
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    handlePermissionPromptResponse({ granted: true, grantType: 'granted-always' }); // no backendTag
    await resultPromise;

    expect((await checkPermissions(ORIGIN, ['model:prompt'])).granted).toBe(true); // goose, read live at grant time
  });
});

// Exercise the exported showPermissionPrompt/handlePermissionPromptResponse
// pair so the import above isn't flagged unused across build targets that
// tree-shake differently; also documents that these are still the same pair
// permission-prompt-url.test.ts covers for the base (non-backend) behaviour.
describe('showPermissionPrompt/handlePermissionPromptResponse are still wired', () => {
  it('round-trips a grant', async () => {
    const create = vi.spyOn(chrome.windows, 'create');
    const resultPromise = showPermissionPrompt(ORIGIN, ['model:prompt']);
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    handlePermissionPromptResponse({ granted: true, grantType: 'granted-once' });
    // backendTag is always stamped now (item 5, round 4) — the
    // background's own record of the backend this prompt was shown for,
    // 'builtin' here since no agent is selected.
    await expect(resultPromise).resolves.toEqual({ granted: true, grantType: 'granted-once', backendTag: 'builtin' });
  });
});
