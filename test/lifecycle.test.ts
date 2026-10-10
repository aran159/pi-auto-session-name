import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import autoSessionName from "../src/index.ts";
import { REGISTER_EVENT, REQUEST_EVENT, RESPONSE_EVENT, CANCEL_EVENT } from "../src/subagents.ts";

function harness(confirmReplacement?: boolean, available = true) {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const bus = new EventEmitter();
  const requests: Record<string, unknown>[] = [];
  const cancellations: unknown[] = [];
  const warnings: string[] = [];
  let disposed = 0;
  let command: (args: string, ctx: ExtensionContext) => Promise<void>;
  let name: string | undefined;
  if (available) bus.on(REGISTER_EVENT, (request) => {
    request.result = { ok: true, registration: { dispose: () => { disposed++; } } };
  });
  bus.on(REQUEST_EVENT, (request) => requests.push(request));
  bus.on(CANCEL_EVENT, (request) => cancellations.push(request));
  const pi = {
    events: {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        bus.on(event, handler);
        return () => bus.off(event, handler);
      },
      emit: (event: string, data: unknown) => { bus.emit(event, data); },
    },
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
    getSessionName: () => name,
    setSessionName: (value: string) => { name = value; },
  } as unknown as ExtensionAPI;
  const entries = new Map([
    ["1", { type: "message", id: "1", parentId: null, message: { role: "user", content: "Fix login" } }],
    ["2", { type: "message", id: "2", parentId: "1", message: { role: "assistant", content: [{ type: "text", text: "Assistant explanation" }] } }],
  ]);
  const ctx = {
    cwd: "/tmp",
    isProjectTrusted: () => false,
    hasUI: confirmReplacement !== undefined,
    ui: { confirm: async () => confirmReplacement, notify: (text: string, level: string) => { if (level === "warning") warnings.push(text); } },
    sessionManager: { getLeafEntry: () => entries.get("2"), getEntry: (id: string) => entries.get(id) },
  } as unknown as ExtensionContext;
  autoSessionName(pi);
  return {
    emit: async (event: string, data: unknown = {}) => handlers.get(event)?.(data, ctx),
    manual: () => command!("", ctx),
    rename: (value: string) => { name = value; },
    name: () => name,
    requests,
    cancellations,
    warnings,
    disposed: () => disposed,
    respond: () => {
      const request = requests.at(-1)!;
      bus.emit(RESPONSE_EVENT, {
        requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId,
        status: "completed", result: { kind: "text", text: "Repair login flow" },
      });
    },
  };
}

test("automatic and manual naming preserve explicit names and send conversation text", async () => {
  const session = harness();
  await session.emit("session_start");
  session.rename("Manual name");
  await session.emit("agent_settled");
  assert.equal(session.name(), "Manual name");
  assert.equal(session.requests.length, 0);
  const pending = session.manual();
  session.respond();
  await pending;
  assert.equal(session.name(), "Repair login flow");
  assert.match(JSON.stringify(session.requests), /Fix login/);
  assert.match(JSON.stringify(session.requests), /Assistant explanation/);
  assert.equal(session.requests[0]?.model, undefined);
  assert.equal(session.requests[0]?.thinking, undefined);
});

test("automatic naming names an unnamed settled session", async () => {
  const session = harness();
  await session.emit("session_start");
  const pending = session.emit("agent_settled");
  session.respond();
  await pending;
  assert.equal(session.name(), "Repair login flow");
});

test("manual naming respects declined replacement confirmation", async () => {
  const session = harness(false);
  await session.emit("session_start");
  session.rename("Manual name");
  await session.manual();
  assert.equal(session.name(), "Manual name");
  assert.equal(session.requests.length, 0);
});

test("missing pi-subagents skips automatic naming and reports every manual attempt", async () => {
  const session = harness(true, false);
  await session.emit("session_start");
  await session.emit("agent_settled");
  await session.manual();
  await session.manual();
  assert.equal(session.name(), undefined);
  assert.equal(session.requests.length, 0);
  assert.equal(session.warnings.length, 3);
  assert.match(session.warnings[0]!, /requires an active pi-subagents/);
});

test("shutdown during configuration loading cannot register an agent afterward", async () => {
  const session = harness(true);
  const startup = session.emit("session_start");
  await session.emit("session_shutdown");
  await startup;
  await session.manual();
  assert.equal(session.requests.length, 0);
  assert.equal(session.disposed(), 0);
  assert.match(session.warnings[0]!, /not initialized/);
});

test("a manual request waiting for another request cannot launch after a session switch", async () => {
  const session = harness();
  await session.emit("session_start");
  const first = session.manual();
  const waiting = session.manual();
  await session.emit("session_start");
  await Promise.all([first, waiting]);
  assert.equal(session.requests.length, 1);
  assert.equal(session.cancellations.length, 1);
});

for (const event of ["session_shutdown", "session_info_changed", "session_start"]) {
  test(`late responses cannot rename after ${event}`, async () => {
    const session = harness();
    await session.emit("session_start");
    const pending = session.manual();
    session.rename("Keep this name");
    await session.emit(event, { name: "Keep this name" });
    session.respond();
    await pending;
    assert.equal(session.name(), "Keep this name");
    assert.equal(session.cancellations.length, 1);
    assert.equal(session.disposed(), event === "session_info_changed" ? 0 : 1);
  });
}
