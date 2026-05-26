import { test, expect, describe } from "bun:test";
import { Sequentializer } from "@/remote/sequentializer";

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("Sequentializer", () => {
  test("jobs run in submission order", async () => {
    const s = new Sequentializer();
    const order: number[] = [];
    const p1 = s.submit(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
    });
    const p2 = s.submit(async () => { order.push(2); });
    const p3 = s.submit(async () => { order.push(3); });
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  test("only one job runs at a time", async () => {
    const s = new Sequentializer();
    const gate1 = deferred();
    let running = 0;
    let maxConcurrent = 0;

    const p1 = s.submit(async () => {
      running++; maxConcurrent = Math.max(maxConcurrent, running);
      await gate1.promise;
      running--;
    });
    const p2 = s.submit(async () => {
      running++; maxConcurrent = Math.max(maxConcurrent, running);
      running--;
    });

    await new Promise((r) => setTimeout(r, 5));
    expect(running).toBe(1);
    gate1.resolve();
    await Promise.all([p1, p2]);
    expect(maxConcurrent).toBe(1);
  });

  test("submit() rejects when the job throws", async () => {
    const s = new Sequentializer();
    await expect(s.submit(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });

  test("a thrown job does not block subsequent jobs", async () => {
    const s = new Sequentializer();
    const order: string[] = [];
    const p1 = s.submit(async () => { throw new Error("first fails"); });
    const p2 = s.submit(async () => { order.push("ran"); });
    await expect(p1).rejects.toThrow("first fails");
    await p2;
    expect(order).toEqual(["ran"]);
  });

  test("isBusy and depth reflect current state", async () => {
    const s = new Sequentializer();
    const gate = deferred();
    expect(s.isBusy).toBe(false);
    expect(s.depth).toBe(0);
    const p = s.submit(async () => { await gate.promise; });
    await new Promise((r) => setTimeout(r, 5));
    expect(s.isBusy).toBe(true);
    expect(s.depth).toBe(1);
    gate.resolve();
    await p;
    await new Promise((r) => setTimeout(r, 0));
    expect(s.isBusy).toBe(false);
    expect(s.depth).toBe(0);
  });
});
