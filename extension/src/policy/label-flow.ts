import { LabelSet } from './labels';
import { classifyDomain } from './sensitivity';

/** Owned by one live run or session. Only Harbor can attach it to a call. */
export class LabelFlow {
  private carried = LabelSet.empty();

  get labels(): LabelSet {
    return this.carried;
  }

  add(labels: LabelSet): void {
    this.carried = this.carried.union(labels);
  }

  /** The origin comes from the tab that owns the tool. */
  addPageOutput(origin: string): void {
    if (origin === 'null') return;
    const hostname = new URL(origin).hostname.replace(/\.$/, '');
    this.add(classifyDomain(hostname).labels);
  }
}
