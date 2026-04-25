import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Store, accountRows, formatDuration, formatStatusLine, isRateLimited, nextAccountName, normalizeRateLimitSnapshot, parseGlobal, splitCommandLine, validateAccount } from "../bin/cx.js";

test("account names reject path traversal", () => {
  assert.throws(() => validateAccount("../bad"));
});

test("store rotates accounts from active account", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cx-test-"));
  const store = new Store(root);
  store.ensureAccount("b");
  store.ensureAccount("a");
  store.setActive("a");

  assert.equal(nextAccountName(store), "b");
});

test("rate limit detection covers common Codex output", () => {
  assert.equal(isRateLimited("", "HTTP 429 rate limit reached"), true);
  assert.equal(isRateLimited("", "permission denied"), false);
});

test("global parser keeps native Codex options intact", () => {
  assert.deepEqual(parseGlobal(["-m", "gpt-5", "exec", "hi"]).rest, ["-m", "gpt-5", "exec", "hi"]);
});

test("global parser accepts cx account option", () => {
  assert.deepEqual(parseGlobal(["-a", "sub", "exec", "hi"]), {
    options: { account: "sub", autoNext: false, maxAttempts: null },
    rest: ["exec", "hi"],
  });
});

test("slash command parser preserves quoted args", () => {
  assert.deepEqual(splitCommandLine('account "work main"'), ["account", "work main"]);
  assert.deepEqual(splitCommandLine("login main --with-api-key"), ["login", "main", "--with-api-key"]);
});

test("store tracks 5h reset estimates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cx-test-"));
  const store = new Store(root);
  store.ensureAccount("main");
  store.markLimited("main", 1_000);

  const [row] = accountRows(store, 1_000);
  assert.equal(row.account, "main");
  assert.equal(row.limited, true);
  assert.equal(row.remaining, 5 * 60 * 60 * 1000);

  store.clearLimit("main");
  assert.equal(accountRows(store, 1_000)[0].limited, false);
});

test("duration formatter uses compact countdowns", () => {
  assert.equal(formatDuration(5 * 60 * 60 * 1000), "5h 00m");
  assert.equal(formatDuration(90 * 1000), "1m 30s");
  assert.equal(formatDuration(0), "now");
});

test("normalizeRateLimitSnapshot reads codex bucket", () => {
  const snapshot = normalizeRateLimitSnapshot({
    rateLimits: { primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: 123 } },
    rateLimitsByLimitId: {
      codex: { limitId: "codex", primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 456 } },
    },
  });
  assert.equal(snapshot.resetAt, 456);
  assert.equal(snapshot.usedPercent, 40);
  assert.equal(snapshot.windowDurationMins, 300);
});

test("statusline formats all accounts compactly", () => {
  const line = formatStatusLine([
    { account: "main", active: true, usedPercent: 0, windowDurationMins: 300, resetAt: 1_800 },
    { account: "sub", active: false, usedPercent: 100, windowDurationMins: 300, resetAt: 900 },
    { account: "bad", active: false, error: "not logged in" },
  ], 0);
  assert.match(line, /\*main:0%\/5h reset/);
  assert.match(line, /sub:100% limited reset/);
  assert.match(line, /bad:error/);
});
