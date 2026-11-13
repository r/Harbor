import { describe, expect, it } from 'vitest';
import { configuredModelActions, modelsAvailableToAdd } from '../sidebar-models';

const apple = { name: 'Apple Intelligence', model_id: 'apple:system', is_default: true, automatic: true };

describe('automatic Apple model controls', () => {
  it('offers a connection test without trying to remove or update an unsaved model', () => {
    const actions = configuredModelActions(apple);
    expect(actions).toContain('test-model-btn');
    expect(actions).not.toContain('remove-model-btn');
    expect(configuredModelActions({ ...apple, is_default: false })).not.toContain('set-default-model-btn');
  });

  it('keeps the automatic model available to save as an explicit selection', () => {
    const discovered = [{ id: 'apple:system' }, { id: 'ollama:test' }];
    expect(modelsAvailableToAdd(discovered, [apple])).toEqual(discovered);
    expect(modelsAvailableToAdd(discovered, [{ ...apple, automatic: false }])).toEqual([{ id: 'ollama:test' }]);
  });

  it('preserves saved model management controls', () => {
    const actions = configuredModelActions({ ...apple, automatic: false, is_default: false });
    expect(actions).toContain('set-default-model-btn');
    expect(actions).toContain('remove-model-btn');
  });
});
