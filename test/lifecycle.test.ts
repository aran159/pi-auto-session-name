import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

let resolveResponse: ((value: unknown) => void) | undefined;
let request: unknown;
mock.module("@earendil-works/pi-ai/compat", {
  namedExports: {
    completeSimple: async (_model: unknown, context: unknown) => {
      request = context;
      return new Promise((resolve) => { resolveResponse = resolve; });
    },
  },
});
const { default: autoSessionName } = await import("../src/index.ts");

function harness(confirmReplacement?: boolean) {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let command: (args: string, ctx: ExtensionContext) => Promise<void>;
  let name: string | undefined;
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
    getSessionName: () => name,
    setSessionName: (value: string) => { name = value; },
  } as unknown as ExtensionAPI;
  const entries = new Map([
    ["1", { type: "message", id: "1", parentId: null, message: { role: "user", content: "Fix login" } }],
    ["2", { type: "message", id: "2", parentId: "1", message: { role: "assistant", content: [{ type: "text", text: "private file contents" }] } }],
  ]);
  const ctx = {
    cwd: "/tmp",
    isProjectTrusted: () => false,
    hasUI: confirmReplacement !== undefined,
    ui: { confirm: async () => confirmReplacement, notify: () => {} },
    sessionManager: { getLeafEntry: () => entries.get("2"), getEntry: (id: string) => entries.get(id) },
    modelRegistry: { find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }) },
  } as unknown as ExtensionContext;
  autoSessionName(pi);
  return {
    emit: async (event: string, data: unknown = {}) => handlers.get(event)?.(data, ctx),
    manual: () => command!("", ctx),
    rename: (value: string) => { name = value; },
    name: () => name,
  };
}

async function finishResponse() {
  for (let i = 0; i < 100 && !resolveResponse; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(resolveResponse);
  resolveResponse({ content: [{ type: "text", text: "Repair login flow" }], stopReason: "stop" });
  resolveResponse = undefined;
}

test("automatic and manual naming preserve explicit names and send conversation text", async () => {
  const session = harness();
  await session.emit("session_start");
  session.rename("Manual name");
  await session.emit("agent_settled");
  assert.equal(session.name(), "Manual name");
  const pending = session.manual();
  await finishResponse();
  await pending;
  assert.equal(session.name(), "Repair login flow");
  assert.match(JSON.stringify(request), /Fix login/);
  assert.match(JSON.stringify(request), /private file contents/);
  assert.doesNotMatch(JSON.stringify(request), /test-key/);
});

test("automatic naming names an unnamed settled session", async () => {
  const session = harness();
  await session.emit("session_start");
  const pending = session.emit("agent_settled");
  await finishResponse();
  await pending;
  assert.equal(session.name(), "Repair login flow");
});

test("manual naming respects declined replacement confirmation", async () => {
  const session = harness(false);
  await session.emit("session_start");
  session.rename("Manual name");
  await session.manual();
  assert.equal(session.name(), "Manual name");
  assert.equal(resolveResponse, undefined);
});

for (const event of ["session_shutdown", "session_info_changed", "session_start"]) {
  test(`late provider responses cannot rename after ${event}`, async () => {
    const session = harness();
    await session.emit("session_start");
    const pending = session.manual();
    for (let i = 0; i < 100 && !resolveResponse; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(resolveResponse);
    session.rename("Keep this name");
    await session.emit(event, { name: "Keep this name" });
    await finishResponse();
    await pending;
    assert.equal(session.name(), "Keep this name");
  });
}
