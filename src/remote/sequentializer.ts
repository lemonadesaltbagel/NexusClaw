// ---------------------------------------------------------------------------
// Sequentializer — single-lane FIFO. Jobs submitted run strictly one at a
// time in submission order. Used by platform adapters to guarantee that
// inbound updates are processed serially before fanning out to the gateway
// (which does its own per-identity queuing downstream).
// ---------------------------------------------------------------------------

type Job = () => Promise<void>;

export class Sequentializer {
  private pending: Job[] = [];
  private running = false;

  /** Enqueue a job. The returned promise settles when the job finishes. */
  submit(job: Job): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pending.push(async () => {
        try {
          await job();
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      if (!this.running) void this.drain();
    });
  }

  /** True while a job is currently executing. */
  get isBusy(): boolean {
    return this.running;
  }

  /** Number of jobs queued or in-flight. */
  get depth(): number {
    return this.pending.length + (this.running ? 1 : 0);
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (this.pending.length > 0) {
      const next = this.pending.shift()!;
      try {
        await next();
      } catch {
        // job-local errors already surfaced via the submit() promise
      }
    }
    this.running = false;
  }
}
