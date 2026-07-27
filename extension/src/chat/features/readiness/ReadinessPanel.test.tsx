// @vitest-environment jsdom

import {
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReadinessPanel } from './ReadinessPanel';
import { readinessFixtures } from './readiness.fixtures';

describe('ReadinessPanel', () => {
  it('renders model identity and nonblocking tool availability', () => {
    render(
      <ReadinessPanel
        readiness={readinessFixtures.ready}
        onRecoveryAction={() => undefined}
      />,
    );

    expect(screen.getByRole('heading', {
      name: 'Ready for departure',
    })).toBeTruthy();
    expect(screen.getByText('Local assistant · Ollama · local')).toBeTruthy();
    expect(screen.getByText('4 available')).toBeTruthy();
    expect(screen.queryByLabelText('Recovery actions')).toBeNull();
  });

  it('reports recovery actions through its boundary', () => {
    const onRecoveryAction = vi.fn();
    render(
      <ReadinessPanel
        readiness={readinessFixtures.offline}
        onRecoveryAction={onRecoveryAction}
      />,
    );

    expect(screen.getByRole('heading', {
      name: 'Harbor needs attention',
    })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {
      name: 'Open Connections',
    }));

    expect(onRecoveryAction).toHaveBeenCalledWith({
      kind: 'open-connections',
      label: 'Open Connections',
    });
  });
});
