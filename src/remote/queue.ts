// ---------------------------------------------------------------------------
// IdentityQueue — per-identity FIFO that preserves the REPL's strict
// serialization invariant for each user. Two distinct identities run in
// parallel; messages from one identity always execute in arrival order.
// ---------------------------------------------------------------------------

import type { RemoteIdentityKey } from "@/remote/types";

type Job = () => Promise<void>;

interface Lane {
  pending: Job[];
  running: boolean;
}

export class IdentityQueue {
  private lanes = new Map<RemoteIdentityKey, Lane>();

  /** Enqueue a job for the given identity. Returns when the job has run. */
  submit(key: RemoteIdentityKey, job: Job): Promise<void> {
    return new Promise((resolve, reject) => {
      const wrapped: Job = async () => {
        try {
          await job();
          resolve();
        } catch (err) {
          reject(err);
        }
      };
      const lane = this.lanes.get(key) ?? { pending: [], running: false };
      lane.pending.push(wrapped);
      this.lanes.set(key, lane);
      if (!lane.running) void this.drain(key);
    });
  }

  /** Whether any job is currently running for this identity. */
  isBusy(key: RemoteIdentityKey): boolean {
    return this.lanes.get(key)?.running ?? false;
  }

  private async drain(key: RemoteIdentityKey): Promise<void> {
    const lane = this.lanes.get(key);
    if (!lane) return;
    lane.running = true;
    while (lane.pending.length > 0) {
      const next = lane.pending.shift()!;
      try {
        await next();
      } catch {
        // job-local errors already surfaced via the submit() promise
      }
    }
    lane.running = false;
    if (lane.pending.length === 0) this.lanes.delete(key);
  }
}
