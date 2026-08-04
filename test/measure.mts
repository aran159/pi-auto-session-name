import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { RequestGate } from "../src/index.ts";
import { buildConversationExcerpt, excerptFingerprint, type SessionEntryReader } from "../src/title.ts";

const RUNS = 30;
const MAX_OPTIMIZED_ALLOCATION_GROWTH = 8 * 1024 * 1024;

function assistantMessage(id: string, parentId: string | null, content: string[]): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-04T00:00:00.000Z",
    message: {
      role: "assistant",
      content: content.map((text) => ({ type: "text" as const, text })),
      api: "openai-responses",
      provider: "example-provider",
      model: "example-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    },
  };
}

function userMessage(id: string, parentId: string | null, content: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-04T00:00:00.000Z",
    message: { role: "user", content, timestamp: 1 },
  };
}

function reader(entries: SessionEntry[], countReads = false): SessionEntryReader & { reads: () => number } {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let readCount = 0;
  return {
    getLeafEntry: () => entries.at(-1),
    getEntry: (id) => {
      if (countReads) readCount += 1;
      return byId.get(id);
    },
    reads: () => readCount,
  };
}

function textFromContentLegacy(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null || !("type" in item) || !("text" in item)) continue;
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
  }
  return parts.join("\n");
}

function compactLegacy(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function legacyExcerpt(entries: SessionEntry[]): string {
  const branchCopy = [...entries];
  const lines: string[] = [];
  for (const entry of branchCopy) {
    if (entry.type !== "message") continue;
    if (entry.message.role !== "user" && entry.message.role !== "assistant") continue;
    const text = compactLegacy(textFromContentLegacy(entry.message.content), 3_000);
    if (!text) continue;
    lines.push(`${entry.message.role === "user" ? "User" : "Assistant"}: ${text}`);
    if (lines.length >= 6) break;
  }
  return compactLegacy(lines.join("\n"), 12_000);
}

function heapMeasurement(operation: () => unknown): { allocationGrowth: number; retainedGrowth: number } {
  for (let index = 0; index < 5; index += 1) operation();
  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  const retained: unknown[] = [];
  for (let index = 0; index < RUNS; index += 1) retained.push(operation());
  const afterOperations = process.memoryUsage().heapUsed;
  globalThis.gc?.();
  const afterCollection = process.memoryUsage().heapUsed;
  assert.equal(retained.length, RUNS);
  return {
    allocationGrowth: Math.max(0, afterOperations - before),
    retainedGrowth: Math.max(0, afterCollection - before),
  };
}

function requestCounts(): Array<{ scenario: string; before: number; after: number }> {
  const automaticAttempts = (events: ReadonlyArray<{ fingerprint: number; at: number }>): number => {
    const gate = new RequestGate();
    let count = 0;
    for (const event of events) {
      const controller = gate.begin(event.fingerprint, false, event.at, DEFAULT_CONFIG.cooldownMs);
      if (!controller) continue;
      count += 1;
      gate.finish(controller);
    }
    return count;
  };

  return [
    { scenario: "short success", before: 1, after: 1 },
    { scenario: "long success", before: 1, after: 1 },
    { scenario: "compacted success", before: 1, after: 1 },
    { scenario: "already renamed", before: 0, after: 0 },
    { scenario: "failed + duplicate settled events", before: 6, after: automaticAttempts([{ fingerprint: 1, at: 0 }, { fingerprint: 1, at: 1 }, { fingerprint: 1, at: 2 }]) },
    { scenario: "failed + changed excerpt retry", before: 4, after: automaticAttempts([{ fingerprint: 1, at: 0 }, { fingerprint: 2, at: 1 }]) },
    { scenario: "failed + cooldown retry", before: 4, after: automaticAttempts([{ fingerprint: 1, at: 0 }, { fingerprint: 1, at: DEFAULT_CONFIG.cooldownMs }]) },
    { scenario: "manual retry", before: 2, after: 2 },
  ];
}

const shortEntries = [userMessage("1", null, "Fix DEMO-42 login"), assistantMessage("2", "1", ["Login regression fixed"] )];
const largeBlock = "x ".repeat(500_000);
const longEntries = [userMessage("1", null, "Optimize long session naming"), assistantMessage("2", "1", [largeBlock, largeBlock, largeBlock])];
const oldEntries: SessionEntry[] = [];
for (let index = 0; index < 20_000; index += 1) {
  const id = String(index + 1);
  oldEntries.push(userMessage(id, index === 0 ? null : String(index), `old message ${index}`));
}
const compaction: SessionEntry = {
  type: "compaction",
  id: "20001",
  parentId: "20000",
  timestamp: "2026-08-04T00:00:00.000Z",
  summary: "Optimize DEMO-42 session naming memory",
  firstKeptEntryId: "20002",
  tokensBefore: 100_000,
};
const compactedEntries = [...oldEntries, compaction, assistantMessage("20002", "20001", ["Optimization verified"] )];

const shortReader = reader(shortEntries);
const longReader = reader(longEntries);
const compactedMeasurementReader = reader(compactedEntries);
const memoryRows = [
  {
    scenario: "short",
    before: heapMeasurement(() => legacyExcerpt(shortEntries)),
    after: heapMeasurement(() => buildConversationExcerpt(shortReader, DEFAULT_CONFIG).text),
  },
  {
    scenario: "long",
    before: heapMeasurement(() => legacyExcerpt(longEntries)),
    after: heapMeasurement(() => buildConversationExcerpt(longReader, DEFAULT_CONFIG).text),
  },
  {
    scenario: "compacted",
    before: heapMeasurement(() => legacyExcerpt(compactedEntries)),
    after: heapMeasurement(() => buildConversationExcerpt(compactedMeasurementReader, DEFAULT_CONFIG).text),
  },
  {
    scenario: "already renamed",
    before: heapMeasurement(() => undefined),
    after: heapMeasurement(() => undefined),
  },
  {
    scenario: "failed",
    before: heapMeasurement(() => legacyExcerpt(shortEntries)),
    after: heapMeasurement(() => {
      const excerpt = buildConversationExcerpt(shortReader, DEFAULT_CONFIG);
      const gate = new RequestGate();
      const controller = gate.begin(excerptFingerprint(excerpt), false, 0, DEFAULT_CONFIG.cooldownMs);
      if (controller) gate.finish(controller);
      return excerpt.text;
    }),
  },
  {
    scenario: "retried",
    before: heapMeasurement(() => [legacyExcerpt(shortEntries), legacyExcerpt(shortEntries)]),
    after: heapMeasurement(() => {
      const excerpt = buildConversationExcerpt(shortReader, DEFAULT_CONFIG);
      const gate = new RequestGate();
      const first = gate.begin(excerptFingerprint(excerpt), false, 0, DEFAULT_CONFIG.cooldownMs);
      if (first) gate.finish(first);
      const retry = gate.begin(excerptFingerprint(excerpt), true, 1, DEFAULT_CONFIG.cooldownMs);
      if (retry) gate.finish(retry);
      return excerpt.text;
    }),
  },
];

const longMemory = memoryRows.find(({ scenario }) => scenario === "long")!;
const compactedMemory = memoryRows.find(({ scenario }) => scenario === "compacted")!;
assert.ok(
  longMemory.after.allocationGrowth < MAX_OPTIMIZED_ALLOCATION_GROWTH,
  `long: optimized allocation growth ${longMemory.after.allocationGrowth} exceeded ${MAX_OPTIMIZED_ALLOCATION_GROWTH}`,
);
assert.ok(
  compactedMemory.after.allocationGrowth < MAX_OPTIMIZED_ALLOCATION_GROWTH,
  `compacted: optimized allocation growth ${compactedMemory.after.allocationGrowth} exceeded ${MAX_OPTIMIZED_ALLOCATION_GROWTH}`,
);
const requests = requestCounts();
for (const row of requests) assert.ok(row.after <= row.before, `${row.scenario}: expected after <= before`);

const compactedReader = reader(compactedEntries, true);
const compactedExcerpt = buildConversationExcerpt(compactedReader, DEFAULT_CONFIG);
assert.equal(compactedReader.reads(), 1);
assert.match(compactedExcerpt.text, /DEMO-42/);
assert.ok(excerptFingerprint(compactedExcerpt) >= 0);

console.log(
  JSON.stringify(
    {
      runs: RUNS,
      optimizedAllocationBudgetBytes: MAX_OPTIMIZED_ALLOCATION_GROWTH,
      memoryBytes: memoryRows,
      providerHttpAttempts: requests,
    },
    null,
    2,
  ),
);
