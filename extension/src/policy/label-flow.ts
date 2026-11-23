import { LabelSet } from './labels';
import { classifyDomain } from './sensitivity';

/** Owned by one live run or session. Only Harbor can attach it to a call. */
export class LabelFlow {
  labels = LabelSet.empty();

  add(labels: LabelSet): void {
    this.labels = this.labels.union(labels);
  }

  /** The origin comes from the tab that owns the tool. */
  addPageOutput(origin: string): void {
    this.add(classifyDomain(new URL(origin).hostname).labels);
  }
}
