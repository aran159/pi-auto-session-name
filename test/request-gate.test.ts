import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { RequestGate } from "../src/index.ts";

test("RequestGate deduplicates concurrent requests", () => {
  const gate = new RequestGate();
  const first = gate.begin(1, false, 100, DEFAULT_CONFIG.cooldownMs);
  assert.ok(first);
  assert.equal(gate.begin(2, false, 101, DEFAULT_CONFIG.cooldownMs), undefined);
  gate.finish(first);
  assert.ok(gate.begin(2, false, 102, DEFAULT_CONFIG.cooldownMs));
});

test("RequestGate cools down repeated automatic excerpts", () => {
  const gate = new RequestGate();
  const first = gate.begin(7, false, 1_000, DEFAULT_CONFIG.cooldownMs);
  assert.ok(first);
  gate.finish(first);

  assert.equal(gate.begin(7, false, 1_001, DEFAULT_CONFIG.cooldownMs), undefined);
  const changed = gate.begin(8, false, 1_002, DEFAULT_CONFIG.cooldownMs);
  assert.ok(changed);
  gate.finish(changed);

  const afterCooldown = gate.begin(7, false, 1_000 + DEFAULT_CONFIG.cooldownMs, DEFAULT_CONFIG.cooldownMs);
  assert.ok(afterCooldown);
});

test("RequestGate permits manual retries during automatic cooldown", () => {
  const gate = new RequestGate();
  const automatic = gate.begin(3, false, 1_000, DEFAULT_CONFIG.cooldownMs);
  assert.ok(automatic);
  gate.finish(automatic);

  const manual = gate.begin(3, true, 1_001, DEFAULT_CONFIG.cooldownMs);
  assert.ok(manual);
});

test("RequestGate aborts and releases active state on shutdown", () => {
  const gate = new RequestGate();
  const active = gate.begin(3, false, 1_000, DEFAULT_CONFIG.cooldownMs);
  assert.ok(active);
  gate.shutdown();

  assert.equal(active.signal.aborted, true);
  assert.ok(gate.begin(3, false, 1_001, DEFAULT_CONFIG.cooldownMs));
});
