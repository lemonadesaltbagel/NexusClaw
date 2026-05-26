import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPairing,
  savePairing,
  addPending,
  findByCode,
  removePending,
  watchPairing,
} from "@/remote/pairing";

let tmpDir: string;
let pairingPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "nexusclaw-pairing-"));
  pairingPath = join(tmpDir, "pairing.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadPairing", () => {
  test("returns an empty state when the file is missing", () => {
    expect(loadPairing(pairingPath)).toEqual({ telegram: { pending: {} } });
  });

  test("parses a stored state", () => {
    savePairing({
      telegram: {
        pending: {
          "1": { code: "AAAA1111", username: "u", firstName: "U", requestedAt: "2026-01-01" },
        },
      },
    }, pairingPath);
    expect(loadPairing(pairingPath).telegram.pending["1"]?.code).toBe("AAAA1111");
  });
});

describe("addPending / findByCode / removePending", () => {
  test("addPending persists a request keyed by userId", () => {
    addPending("telegram", "42", {
      code: "ABCD1234", username: "alice", requestedAt: "2026-01-01",
    }, pairingPath);
    const s = loadPairing(pairingPath);
    expect(s.telegram.pending["42"]).toMatchObject({ code: "ABCD1234", username: "alice" });
  });

  test("re-adding the same userId overwrites the previous entry", () => {
    addPending("telegram", "42", { code: "FIRST", requestedAt: "2026-01-01" }, pairingPath);
    addPending("telegram", "42", { code: "SECND", requestedAt: "2026-01-02" }, pairingPath);
    expect(loadPairing(pairingPath).telegram.pending["42"]?.code).toBe("SECND");
  });

  test("findByCode locates the userId for a given code", () => {
    addPending("telegram", "42", { code: "XYZ12345", requestedAt: "2026-01-01" }, pairingPath);
    const hit = findByCode("XYZ12345", pairingPath);
    expect(hit).toMatchObject({ platform: "telegram", userId: "42" });
  });

  test("findByCode returns null on miss", () => {
    expect(findByCode("NOSUCH", pairingPath)).toBeNull();
  });

  test("removePending clears the entry", () => {
    addPending("telegram", "42", { code: "C1", requestedAt: "x" }, pairingPath);
    removePending("telegram", "42", pairingPath);
    expect(loadPairing(pairingPath).telegram.pending["42"]).toBeUndefined();
  });
});

describe("atomic writes", () => {
  test("savePairing writes via a temp file (no torn writes)", () => {
    savePairing({ telegram: { pending: {} } }, pairingPath);
    expect(existsSync(pairingPath)).toBe(true);
    // The temp file should be gone after the rename.
    const left = require("node:fs").readdirSync(tmpDir);
    expect(left.filter((f: string) => f.startsWith("pairing.json.tmp."))).toEqual([]);
  });

  test("the resulting file parses cleanly as JSON", () => {
    addPending("telegram", "42", { code: "CCC", requestedAt: "t" }, pairingPath);
    expect(() => JSON.parse(readFileSync(pairingPath, "utf-8"))).not.toThrow();
  });
});

describe("watchPairing", () => {
  test("fires onChange after a debounced delay when the file is rewritten", async () => {
    savePairing({ telegram: { pending: {} } }, pairingPath);

    let count = 0;
    const w = watchPairing(() => { count++; }, pairingPath);

    addPending("telegram", "42", { code: "CCC", requestedAt: "t" }, pairingPath);
    // Debounce window is 100ms; wait a bit longer.
    await new Promise((r) => setTimeout(r, 200));

    expect(count).toBeGreaterThanOrEqual(1);
    w.close();
  });
});
