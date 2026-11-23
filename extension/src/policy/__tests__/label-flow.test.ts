import { describe, expect, it } from 'vitest';
import { LabelFlow } from '../label-flow';

describe('source labels on page-owned tool results', () => {
  it('classifies a fully qualified hostname and keeps earlier labels', () => {
    const flow = new LabelFlow();
    flow.addPageOutput('https://accounts.google.com.:443');
    flow.addPageOutput('https://stripe.com');
    expect(flow.labels.toArray()).toEqual(['credentials', 'identity', 'payments']);
  });

  it('accepts the serialized opaque origin, which has no hostname', () => {
    const flow = new LabelFlow();
    flow.addPageOutput('null');
    expect(flow.labels.isEmpty()).toBe(true);
  });
});
