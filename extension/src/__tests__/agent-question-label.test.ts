import { describe, expect, it } from 'vitest';
import { optionLabel } from '../agent-question-label';

describe('optionLabel', () => {
  it('turns a name that is just the kind code into readable text', () => {
    expect(optionLabel({ optionId: 'allow_always', name: 'allow_always', kind: 'allow_always' })).toBe('Allow always');
    expect(optionLabel({ optionId: 'x', name: 'reject_once', kind: 'reject_once' })).toBe('Reject once');
  });

  it('also reads a name that is just the option id code', () => {
    expect(optionLabel({ optionId: 'deny_all', name: 'deny_all', kind: 'reject_always' })).toBe('Deny all');
  });

  it('shows any other name exactly as the agent wrote it', () => {
    expect(optionLabel({ optionId: 'allow', name: 'Allow for this session', kind: 'allow_once' })).toBe('Allow for this session');
    expect(optionLabel({ optionId: 'y', name: 'allow_once please', kind: 'allow_once' })).toBe('allow_once please');
  });
});
