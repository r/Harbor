import { describe, expect, it, vi } from 'vitest';
import type {
  CapturedPageContext,
  SourceTabLaunchEnvelope,
  SourceTabReference,
} from '../../contracts';
import type { SourceTabPort } from '../../services';
import {
  MAX_SOURCE_CONTEXT_CHARACTERS,
  approveSourceContext,
  captureApprovedSourceContext,
  resolveSourceContext,
  type SourceContextApproval,
} from './source-context-coordinator';

const source: SourceTabReference = {
  tabId: 41,
  windowId: 7,
  url: 'https://example.com/article',
  title: 'Example article',
  origin: 'https://example.com',
};

const envelope: SourceTabLaunchEnvelope = {
  version: 1,
  launchId: 'launch-123',
  source,
  createdAt: 1_000,
  expiresAt: 10_000,
};

const capturedContext: CapturedPageContext = {
  title: 'Example article',
  url: source.url,
  text: 'Page contents',
  capturedAt: 3_000,
};

function createSourceTabPort(): SourceTabPort & {
  resolveLaunch: ReturnType<typeof vi.fn<SourceTabPort['resolveLaunch']>>;
  inspect: ReturnType<typeof vi.fn<SourceTabPort['inspect']>>;
  capture: ReturnType<typeof vi.fn<SourceTabPort['capture']>>;
} {
  return {
    resolveLaunch: vi.fn<SourceTabPort['resolveLaunch']>()
      .mockResolvedValue(envelope),
    inspect: vi.fn<SourceTabPort['inspect']>()
      .mockResolvedValue(source),
    capture: vi.fn<SourceTabPort['capture']>()
      .mockResolvedValue(capturedContext),
  };
}

describe('source context coordinator', () => {
  it('previews exact source metadata without capturing content', async () => {
    const sourceTabPort = createSourceTabPort();

    await expect(
      resolveSourceContext('launch-123', sourceTabPort, () => 2_000),
    ).resolves.toEqual({
      kind: 'available',
      envelope,
      preview: {
        title: 'Example article',
        origin: 'https://example.com',
      },
    });
    expect(sourceTabPort.capture).not.toHaveBeenCalled();
  });

  it('rejects restricted and malformed source URLs', async () => {
    const sourceTabPort = createSourceTabPort();
    sourceTabPort.resolveLaunch.mockResolvedValue({
      ...envelope,
      source: {
        ...source,
        url: 'chrome://settings',
        origin: 'chrome://settings',
      },
    });

    await expect(
      resolveSourceContext('launch-123', sourceTabPort, () => 2_000),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'unsupported',
    });
    expect(sourceTabPort.inspect).not.toHaveBeenCalled();
  });

  it('rejects a launch envelope with an invalid lifetime', async () => {
    const sourceTabPort = createSourceTabPort();
    sourceTabPort.resolveLaunch.mockResolvedValue({
      ...envelope,
      createdAt: 12_000,
      expiresAt: 10_000,
    });

    await expect(
      resolveSourceContext('launch-123', sourceTabPort, () => 2_000),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'missing',
    });
    expect(sourceTabPort.inspect).not.toHaveBeenCalled();
  });

  it('invalidates an expired launch before inspecting the tab', async () => {
    const sourceTabPort = createSourceTabPort();

    await expect(
      resolveSourceContext('launch-123', sourceTabPort, () => 10_000),
    ).resolves.toEqual({
      kind: 'stale',
      reason: 'expired',
    });
    expect(sourceTabPort.inspect).not.toHaveBeenCalled();
  });

  it('invalidates a source that navigated before approval', async () => {
    const sourceTabPort = createSourceTabPort();
    sourceTabPort.inspect.mockResolvedValue({
      ...source,
      url: 'https://example.com/other',
    });

    await expect(
      resolveSourceContext('launch-123', sourceTabPort, () => 2_000),
    ).resolves.toEqual({
      kind: 'stale',
      reason: 'navigated',
    });
  });

  it('requires a runtime-issued approval carrying page-read access', async () => {
    const sourceTabPort = createSourceTabPort();
    const available = await resolveSourceContext(
      'launch-123',
      sourceTabPort,
      () => 2_000,
    );
    if (available.kind !== 'available') {
      throw new Error('Expected source context to be available');
    }

    expect(approveSourceContext(available, ['model:prompt'])).toBeNull();
    await expect(captureApprovedSourceContext(
      { envelope } as SourceContextApproval,
      sourceTabPort,
      () => 2_000,
    )).resolves.toEqual({ kind: 'denied' });
    expect(sourceTabPort.capture).not.toHaveBeenCalled();
  });

  it('captures the recorded tab ID and bounds retained text', async () => {
    const sourceTabPort = createSourceTabPort();
    sourceTabPort.capture.mockResolvedValue({
      ...capturedContext,
      text: `\u0000${'x'.repeat(MAX_SOURCE_CONTEXT_CHARACTERS + 50)}`,
    });
    const available = await resolveSourceContext(
      'launch-123',
      sourceTabPort,
      () => 2_000,
    );
    if (available.kind !== 'available') {
      throw new Error('Expected source context to be available');
    }
    const approval = approveSourceContext(
      available,
      ['model:prompt', 'browser:activeTab.read'],
    );
    if (!approval) {
      throw new Error('Expected source context approval');
    }

    const result = await captureApprovedSourceContext(
      approval,
      sourceTabPort,
      () => 2_000,
    );

    expect(sourceTabPort.capture).toHaveBeenCalledWith(source);
    expect(result.kind).toBe('captured');
    if (result.kind === 'captured') {
      expect(result.context.text).toHaveLength(
        MAX_SOURCE_CONTEXT_CHARACTERS,
      );
      expect(result.context.text).not.toContain('\u0000');
    }
  });

  it('discards content when navigation occurs during capture', async () => {
    const sourceTabPort = createSourceTabPort();
    sourceTabPort.inspect
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce({
        ...source,
        url: 'https://example.com/other',
      });
    const available = await resolveSourceContext(
      'launch-123',
      sourceTabPort,
      () => 2_000,
    );
    if (available.kind !== 'available') {
      throw new Error('Expected source context to be available');
    }
    const approval = approveSourceContext(
      available,
      ['browser:activeTab.read'],
    );
    if (!approval) {
      throw new Error('Expected source context approval');
    }

    await expect(captureApprovedSourceContext(
      approval,
      sourceTabPort,
      () => 2_000,
    )).resolves.toEqual({
      kind: 'stale',
      reason: 'navigated',
    });
  });

  it('discards a capture that reports a different URL', async () => {
    const sourceTabPort = createSourceTabPort();
    sourceTabPort.capture.mockResolvedValue({
      ...capturedContext,
      url: 'https://example.com/other',
    });
    const available = await resolveSourceContext(
      'launch-123',
      sourceTabPort,
      () => 2_000,
    );
    if (available.kind !== 'available') {
      throw new Error('Expected source context to be available');
    }
    const approval = approveSourceContext(
      available,
      ['browser:activeTab.read'],
    );
    if (!approval) {
      throw new Error('Expected source context approval');
    }

    await expect(captureApprovedSourceContext(
      approval,
      sourceTabPort,
      () => 2_000,
    )).resolves.toEqual({
      kind: 'stale',
      reason: 'navigated',
    });
  });
});
