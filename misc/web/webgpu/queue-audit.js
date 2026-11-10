// Opt-in observation only. Promise completion includes worker scheduling delay;
// these are upper bounds, not GPU timestamps or exact frames-in-flight counts.
export class QueueAudit {
  constructor(now = () => performance.now()) {
    this.now = now;
    this.stats = {submitted: 0, completed: 0, maxObservedBacklog: 0,
      samples: 0, totalCompletionMs: 0, maxCompletionMs: 0, errors: 0};
    this.pending = false;
  }
  submit(queue) {
    const s = this.stats;
    ++s.submitted;
    s.maxObservedBacklog = Math.max(s.maxObservedBacklog, s.submitted - s.completed);
    if (this.pending) return; // At most one outstanding completion promise.
    this.pending = true;
    const serial = s.submitted, start = this.now();
    queue.onSubmittedWorkDone().then(() => {
      const ms = this.now() - start;
      s.completed = serial;
      ++s.samples;
      s.totalCompletionMs += ms;
      s.maxCompletionMs = Math.max(s.maxCompletionMs, ms);
      this.pending = false;
    }, () => { ++s.errors; this.pending = false; });
  }
}
