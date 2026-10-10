import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";
import { buildConversationExcerpt, normalizeTitle } from "../src/title.ts";

test("non-conversation context does not cross the naming boundary", () => {
  const entries = [
    { id: "1", parentId: null, type: "message", message: { role: "system", content: "private instructions" } },
    { id: "2", parentId: "1", type: "message", message: { role: "user", content: [
      { type: "text", text: "Fix login" },
      { type: "image", data: "private image", mimeType: "image/png" },
      { type: "thinking", thinking: "private reasoning" },
    ] } },
    { id: "3", parentId: "2", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "private file" }] } },
    { id: "4", parentId: "3", type: "custom", data: "private metadata" },
  ] as unknown as SessionEntry[];
  const excerpt = buildConversationExcerpt({
    getLeafEntry: () => entries.at(-1),
    getEntry: (id) => entries.find((entry) => entry.id === id),
  }, DEFAULT_CONFIG);
  assert.equal(excerpt.text, "User: Fix login");
});

test("defaults limit conversation excerpts to six messages and 12000 characters", () => {
  assert.equal(DEFAULT_CONFIG.maxMessages, 6);
  assert.equal(DEFAULT_CONFIG.maxMessageChars, 3000);
  assert.equal(DEFAULT_CONFIG.maxConversationChars, 12000);
});

test("JSON parse warnings do not disclose configuration contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-name-privacy-"));
  const path = join(directory, "config.json");
  try {
    await writeFile(path, "PRIVATE_SECRET is not JSON");
    const loaded = await loadConfig({ cwd: directory, projectTrusted: false, env: { PI_AUTO_SESSION_NAME_CONFIG: path } });
    assert.match(loaded.warnings.join(" "), /Invalid JSON/);
    assert.doesNotMatch(loaded.warnings.join(" "), /PRIVATE_SECRET/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("titles exclude terminal and bidirectional controls", () => {
  const title = normalizeTitle("Fix\u009b31m login\u202e flow\u2066", 80);
  assert.ok(title);
  assert.doesNotMatch(title, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
});
