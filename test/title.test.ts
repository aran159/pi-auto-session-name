import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  buildConversationExcerpt,
  buildTitlePrompt,
  excerptFingerprint,
  findTicketId,
  normalizeTitle,
  prefixTitleWithTicket,
  type SessionEntryReader,
} from "../src/title.ts";

function messageEntry(
  id: string,
  parentId: string | null,
  role: "user" | "assistant" | "toolResult",
  content: string,
): SessionEntry {
  const base = {
    type: "message" as const,
    id,
    parentId,
    timestamp: "2026-07-12T00:00:00.000Z",
  };

  if (role === "user") {
    return {
      ...base,
      message: { role, content, timestamp: 1 },
    };
  }

  if (role === "assistant") {
    return {
      ...base,
      message: {
        role,
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: content },
        ],
        api: "openai-completions",
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

  return {
    ...base,
    message: {
      role,
      toolCallId: "tool-1",
      toolName: "bash",
      content: [{ type: "text", text: content }],
      isError: false,
      timestamp: 3,
    },
  };
}

function reader(entries: SessionEntry[]): SessionEntryReader {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    getLeafEntry: () => entries.at(-1),
    getEntry: (id) => byId.get(id),
  };
}

function linearEntries(messages: ReadonlyArray<readonly ["user" | "assistant" | "toolResult", string]>): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const [role, content] of messages) {
    const id = String(entries.length + 1);
    entries.push(messageEntry(id, entries.at(-1)?.id ?? null, role, content));
  }
  return entries;
}

function conversationExcerpt(session: SessionEntryReader) {
  return buildConversationExcerpt(session, DEFAULT_CONFIG);
}

test("buildConversationExcerpt keeps user and assistant text only", () => {
  const excerpt = conversationExcerpt(
    reader(
      linearEntries([
        ["user", "Build an extension"],
        ["assistant", "I will implement it"],
        ["toolResult", "secret tool output"],
      ]),
    ),
  );

  assert.equal(excerpt.hasUserMessage, true);
  assert.equal(excerpt.hasAssistantMessage, true);
  assert.match(excerpt.text, /User: Build an extension/);
  assert.match(excerpt.text, /Assistant: I will implement it/);
  assert.doesNotMatch(excerpt.text, /private reasoning|secret tool output/);
});

test("buildConversationExcerpt keeps the earliest six useful messages", () => {
  const excerpt = conversationExcerpt(
    reader(
      linearEntries([
        ["user", "first request DEMO-123"],
        ["assistant", "first answer"],
        ["user", "second request"],
        ["assistant", "second answer"],
        ["user", "third request"],
        ["assistant", "third answer"],
        ["user", "late unrelated request"],
        ["assistant", "late unrelated answer"],
      ]),
    ),
  );

  assert.match(excerpt.text, /^User: first request DEMO-123/);
  assert.match(excerpt.text, /Assistant: third answer$/);
  assert.doesNotMatch(excerpt.text, /late unrelated/);
});

test("buildConversationExcerpt bounds long text without joining full content", () => {
  const huge = "word ".repeat(200_000);
  const excerpt = conversationExcerpt(
    reader(
      linearEntries([
        ["user", huge],
        ["assistant", huge],
      ]),
    ),
  );

  assert.ok(excerpt.text.length <= 12_000);
  assert.equal(excerpt.hasUserMessage, true);
  assert.equal(excerpt.hasAssistantMessage, true);
});

test("buildConversationExcerpt honors configured limits", () => {
  const excerpt = buildConversationExcerpt(
    reader(
      linearEntries([
        ["user", "one two three four five"],
        ["assistant", "six seven eight nine ten"],
        ["user", "excluded third message"],
      ]),
    ),
    { maxMessages: 2, maxMessageChars: 12, maxConversationChars: 24 },
  );

  assert.ok(excerpt.text.length <= 24);
  assert.doesNotMatch(excerpt.text, /excluded/);
});

test("buildConversationExcerpt follows only the active branch", () => {
  const first = messageEntry("1", null, "user", "active task");
  const abandoned = messageEntry("2", "1", "assistant", "abandoned answer");
  const active = messageEntry("3", "1", "assistant", "active answer");
  const byId = new Map([first, abandoned, active].map((entry) => [entry.id, entry]));
  const excerpt = conversationExcerpt({
    getLeafEntry: () => active,
    getEntry: (id) => byId.get(id),
  });

  assert.match(excerpt.text, /active task/);
  assert.equal(excerpt.hasAssistantMessage, true);
  assert.doesNotMatch(excerpt.text, /abandoned/);
});

test("buildConversationExcerpt excludes compaction summaries and older entries", () => {
  const old = messageEntry("1", null, "user", "old full conversation");
  const compacted: SessionEntry = {
    type: "compaction",
    id: "2",
    parentId: "1",
    timestamp: "2026-07-12T00:00:00.000Z",
    summary: "Implement DEMO-321 checkout recovery",
    firstKeptEntryId: "3",
    tokensBefore: 50_000,
  };
  const recent = messageEntry("3", "2", "assistant", "Recovery tests now pass");
  const byId = new Map([old, compacted, recent].map((entry) => [entry.id, entry]));
  let reads = 0;
  const excerpt = conversationExcerpt({
    getLeafEntry: () => recent,
    getEntry: (id) => {
      reads += 1;
      return byId.get(id);
    },
  });

  assert.equal(excerpt.text, "Assistant: Recovery tests now pass");
  assert.equal(excerpt.hasUserMessage, false);
  assert.equal(excerpt.hasAssistantMessage, true);
  assert.equal(reads, 1);
});

test("excerptFingerprint is stable and content-sensitive", () => {
  const first = { text: "User: task\nAssistant: done", hasUserMessage: true, hasAssistantMessage: true };
  const second = { ...first, text: `${first.text}!` };
  assert.equal(excerptFingerprint(first), excerptFingerprint(first));
  assert.notEqual(excerptFingerprint(first), excerptFingerprint(second));
});

test("buildTitlePrompt preserves naming quality rules without adding conversation context", () => {
  const prompt = buildTitlePrompt("User: DEMO-42 Anmeldung reparieren\nAssistant: Fehler behoben");
  assert.match(prompt, /Use the conversation's language/);
  assert.match(prompt, /3 to 8 words/);
  assert.match(prompt, /Preserve useful ticket IDs/);
  assert.match(prompt, /DEMO-42 Anmeldung reparieren/);
  assert.doesNotMatch(prompt, /tool output|system prompt|private reasoning/i);
});

test("normalizeTitle removes wrappers and punctuation", () => {
  assert.equal(normalizeTitle('## Titel: “Pi Sessions automatisch benennen.”', 80), "Pi Sessions automatisch benennen");
});

test("normalizeTitle uses the first non-empty line", () => {
  assert.equal(normalizeTitle("\nGrafana Dashboard erweitern\nExplanation", 80), "Grafana Dashboard erweitern");
});

test("normalizeTitle rejects empty output", () => {
  assert.equal(normalizeTitle(" \n ", 80), undefined);
});

test("normalizeTitle limits long titles", () => {
  const title = normalizeTitle("A very long session title ".repeat(10), 40);
  assert.ok(title);
  assert.ok(title.length <= 40);
});

test("findTicketId finds and normalizes a ticket ID", () => {
  assert.equal(findTicketId("Bitte demo-0000 prüfen und beheben"), "DEMO-0000");
});

test("findTicketId returns the first ticket ID", () => {
  assert.equal(findTicketId("Start with SAMPLE-42, then inspect DEMO-123"), "SAMPLE-42");
});

test("findTicketId ignores words without a numeric issue suffix", () => {
  assert.equal(findTicketId("Update the auto-name plugin"), undefined);
});

test("prefixTitleWithTicket adds the ticket ID as prefix", () => {
  assert.equal(prefixTitleWithTicket("Druckdialog korrigieren", "DEMO-0000", 80), "DEMO-0000: Druckdialog korrigieren");
});

test("prefixTitleWithTicket avoids duplicate ticket IDs", () => {
  assert.equal(prefixTitleWithTicket("DEMO-0000 Druckdialog korrigieren", "DEMO-0000", 80), "DEMO-0000: Druckdialog korrigieren");
  assert.equal(prefixTitleWithTicket("[DEMO-0000] Druckdialog korrigieren", "DEMO-0000", 80), "DEMO-0000: Druckdialog korrigieren");
});

test("prefixTitleWithTicket preserves titles without a ticket ID", () => {
  assert.equal(prefixTitleWithTicket("Grafana Alerts prüfen", undefined, 80), "Grafana Alerts prüfen");
});

test("prefixTitleWithTicket keeps the complete title within the limit", () => {
  const title = prefixTitleWithTicket("A very long session title ".repeat(10), "SAMPLE-1234", 80);
  assert.equal(title.startsWith("SAMPLE-1234: "), true);
  assert.ok(title.length <= 80);
});
