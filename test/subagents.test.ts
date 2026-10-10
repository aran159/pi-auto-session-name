import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CANCEL_EVENT, NAMING_AGENT, REGISTER_EVENT, REQUEST_EVENT, RESPONSE_EVENT, SubagentNamer } from "../src/subagents.ts";

function harness() {
  const bus = new EventEmitter();
  const events: ExtensionAPI["events"] = {
    on: (event, handler) => {
      bus.on(event, handler);
      return () => { bus.off(event, handler); };
    },
    emit: (event, data) => { bus.emit(event, data); },
  };
  const registrations: Record<string, unknown>[] = [];
  const requests: Record<string, unknown>[] = [];
  const cancels: unknown[] = [];
  let disposed = 0;
  bus.on(REGISTER_EVENT, (request) => {
    registrations.push(request);
    request.result = { ok: true, registration: { dispose: () => { disposed++; } } };
  });
  bus.on(REQUEST_EVENT, (request) => requests.push(request));
  bus.on(CANCEL_EVENT, (request) => cancels.push(request));
  const namer = new SubagentNamer(events);
  return {
    namer, bus, registrations, requests, cancels,
    disposed: () => disposed,
    respond: (response: Record<string, unknown> = {}, identity: Record<string, unknown> = requests.at(-1)!) => {
      bus.emit(RESPONSE_EVENT, {
        requestId: identity.requestId, ownerRunId: identity.ownerRunId, nodeId: identity.nodeId,
        status: "completed", result: { kind: "text", text: "Fix login flow" }, ...response,
      });
    },
  };
}

test("registration owns a tool-free fresh-context agent without a pinned model", () => {
  const h = harness();
  h.namer.ensureRegistered();
  h.namer.ensureRegistered();
  assert.equal(h.registrations.length, 1);
  assert.equal(h.registrations[0]!.name, NAMING_AGENT);
  const definition = h.registrations[0]!.definition as Record<string, unknown>;
  for (const field of ["tools", "extensions", "subagentOnlyExtensions", "skills", "defaultReads"]) assert.deepEqual(definition[field], []);
  for (const field of ["inheritProjectContext", "inheritGlobalContext", "inheritSkills", "allowNestedSubagents", "defaultProgress"]) assert.equal(definition[field], false);
  assert.equal(definition.model, undefined);
  assert.equal(definition.thinking, undefined);
  assert.equal(definition.defaultContext, "fresh");
  assert.equal(definition.systemPromptMode, "replace");
  h.namer.dispose();
  h.namer.dispose();
  assert.equal(h.disposed(), 1);
  h.namer.ensureRegistered();
  assert.equal(h.registrations.length, 2);
});

test("delegation disables tools, skills, artifacts, intercom, and fork context", async () => {
  const h = harness();
  const pending = h.namer.generate("Bounded excerpt", "/tmp", 1000, new AbortController().signal);
  const request = h.requests[0]!;
  assert.equal(request.task, "Bounded excerpt");
  assert.equal(request.context, "fresh");
  assert.equal(request.cwd, "/tmp");
  assert.equal(request.model, undefined);
  assert.equal(request.thinking, undefined);
  assert.deepEqual(request.toolBudget, { hard: 0, block: "*" });
  assert.deepEqual(request.intercomBridge, { mode: "off" });
  assert.deepEqual(request.result, { kind: "text" });
  assert.equal(request.artifacts, false);
  assert.equal(request.skill, false);
  h.respond();
  assert.equal(await pending, "Fix login flow");
  assert.equal(h.bus.listenerCount(RESPONSE_EVENT), 0);
});

test("responses require the complete request identity", async () => {
  const h = harness();
  const pending = h.namer.generate("Task", "/tmp", 1000, new AbortController().signal);
  for (const field of ["requestId", "ownerRunId", "nodeId"]) h.respond({ [field]: "other" });
  assert.equal(h.bus.listenerCount(RESPONSE_EVENT), 1);
  h.respond();
  await pending;
  assert.equal(h.bus.listenerCount(RESPONSE_EVENT), 0);
});

test("synchronous replies do not leak response listeners", async () => {
  const h = harness();
  h.bus.on(REQUEST_EVENT, (request) => h.respond({}, request));
  assert.equal(await h.namer.generate("Task", "/tmp", 1000, new AbortController().signal), "Fix login flow");
  assert.equal(h.bus.listenerCount(RESPONSE_EVENT), 0);
});

test("timeout cancels the exact attempt and removes response listeners", async () => {
  const h = harness();
  await assert.rejects(h.namer.generate("Task", "/tmp", 5, new AbortController().signal), /timed out/);
  assert.equal(h.cancels.length, 1);
  const request = h.requests[0]!;
  assert.deepEqual(h.cancels[0], { requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId });
  assert.equal(h.bus.listenerCount(RESPONSE_EVENT), 0);
});

test("abort cancels a request and rejects late responses", async () => {
  const h = harness();
  const controller = new AbortController();
  const pending = h.namer.generate("Task", "/tmp", 1000, controller.signal);
  controller.abort();
  h.respond();
  await assert.rejects(pending, /cancelled/);
  assert.equal(h.cancels.length, 1);
  assert.equal(h.bus.listenerCount(RESPONSE_EVENT), 0);
});

test("already aborted requests never register or launch an agent", async () => {
  const h = harness();
  await assert.rejects(h.namer.generate("Task", "/tmp", 1000, AbortSignal.abort()), /cancelled/);
  assert.equal(h.registrations.length, 0);
  assert.equal(h.requests.length, 0);
});

test("registration errors do not disclose owner error details", async () => {
  const h = harness();
  h.bus.removeAllListeners(REGISTER_EVENT);
  h.bus.on(REGISTER_EVENT, (request) => { request.result = { ok: false, error: new Error("PRIVATE_SECRET") }; });
  await assert.rejects(h.namer.generate("Task", "/tmp", 1000, new AbortController().signal), (error: Error) => {
    assert.match(error.message, /Could not register/);
    assert.doesNotMatch(error.message, /PRIVATE_SECRET/);
    return true;
  });
});

for (const response of [
  { status: "failed", error: "PRIVATE_SECRET" },
  { result: { kind: "structured", value: "PRIVATE_SECRET" } },
  { result: undefined },
]) {
  test(`invalid result is rejected without sensitive error details: ${JSON.stringify(response)}`, async () => {
    const h = harness();
    const pending = h.namer.generate("Task", "/tmp", 1000, new AbortController().signal);
    h.respond(response);
    await assert.rejects(pending, (error: Error) => {
      assert.doesNotMatch(error.message, /PRIVATE_SECRET/);
      return true;
    });
    assert.equal(h.bus.listenerCount(RESPONSE_EVENT), 0);
  });
}
