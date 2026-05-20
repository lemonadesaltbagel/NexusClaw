import { test, expect, describe } from "bun:test";
import { IdentityQueue } from "@/remote/queue";

/** Promise that resolves when externally triggered. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("IdentityQueue", () => {
  test("jobs for one identity run in submission order", async () => {
    const q = new IdentityQueue();
    const order: number[] = [];

    const p1 = q.submit("u1", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
    });
    const p2 = q.submit("u1", async () => { order.push(2); });
    const p3 = q.submit("u1", async () => { order.push(3); });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  test("different identities run in parallel", async () => {
    const q = new IdentityQueue();
    const u1Gate = deferred();
    const u2Gate = deferred();
    const seen = { u1: false, u2: false };

    // u1 blocks on u1Gate.
    const p1 = q.submit("u1", async () => {
      seen.u1 = true;
      await u1Gate.promise;
    });
    // u2 should still get to run even though u1 is blocked.
    const p2 = q.submit("u2", async () => {
      seen.u2 = true;
      await u2Gate.promise;
    });

    // Yield once so both jobs start.
    await new Promise((r) => setTimeout(r, 5));
    expect(seen.u1).toBe(true);
    expect(seen.u2).toBe(true);

    u1Gate.resolve();
    u2Gate.resolve();
    await Promise.all([p1, p2]);
  });

  test("submit() rejects when the job throws", async () => {
    const q = new IdentityQueue();
    await expect(q.submit("u1", async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
  });

  test("a failing job does not block subsequent jobs on the same lane", async () => {
    const q = new IdentityQueue();
    const order: string[] = [];

    const p1 = q.submit("u1", async () => { throw new Error("first fails"); });
    const p2 = q.submit("u1", async () => { order.push("ran"); });

    await expect(p1).rejects.toThrow("first fails");
    await p2;
    expect(order).toEqual(["ran"]);
  });

  test("isBusy reflects current lane state", async () => {
    const q = new IdentityQueue();
    const gate = deferred();
    expect(q.isBusy("u1")).toBe(false);
    const p = q.submit("u1", async () => { await gate.promise; });
    await new Promise((r) => setTimeout(r, 5));
    expect(q.isBusy("u1")).toBe(true);
    gate.resolve();
    await p;
    // Lane bookkeeping settles on the next tick after the submit promise resolves.
    await new Promise((r) => setTimeout(r, 0));
    expect(q.isBusy("u1")).toBe(false);
  });
});
