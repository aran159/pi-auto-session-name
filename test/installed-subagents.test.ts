import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { REQUEST_EVENT, SubagentNamer } from "../src/subagents.ts";

const packageDir = process.env.PI_SUBAGENTS_TEST_PACKAGE_DIR;

test("installed pi-subagents accepts the registration and structured delegation contract without model calls", { skip: !packageDir }, async () => {
  const load = (path: string) => import(pathToFileURL(join(packageDir!, "src", path)).href);
  const { registerRuntimeAgentEventListener } = await load("agents/runtime-agent-events.js");
  const { listRuntimeAgentConfigs } = await load("agents/runtime-agent-registry.js");
  const { parseSubagentDelegationRequest } = await load("slash/delegation-request.js");
  const { mergeRuntimeAgents } = await load("agents/runtime-agent-registry.js");
  const { registerPromptTemplateDelegationBridge } = await load("slash/prompt-template-bridge.js");
  const bus = new EventEmitter();
  const pi = {
    on: () => () => {},
    registerTool: () => {},
    events: {
      on: (name: string, handler: (...args: unknown[]) => void) => { bus.on(name, handler); return () => { bus.off(name, handler); }; },
      emit: (name: string, data: unknown) => { bus.emit(name, data); },
    },
  };
  const dispose = registerRuntimeAgentEventListener(pi);
  const namer = new SubagentNamer(pi.events);
  const directory = await mkdtemp(join(tmpdir(), "pi-namer-installed-"));
  const bridge = registerPromptTemplateDelegationBridge({
    events: pi.events,
    getContext: () => ({}),
    execute: async (_requestId: string, params: Record<string, unknown>) => {
      assert.equal(params.model, undefined);
      assert.equal(params.delegatedThinkingOverride, undefined);
      assert.equal(params.foregroundOnly, true);
      assert.equal(params.async, false);
      assert.equal(params.context, "fresh");
      assert.deepEqual(params.toolBudget, { hard: 0, block: "*" });
      return { details: { results: [{ agent: "session-namer", finalOutput: "Validated installed API", exitCode: 0 }] } };
    },
  });
  try {
    namer.ensureRegistered();
    const agent = listRuntimeAgentConfigs(pi)[0];
    assert.equal(agent.name, "session-namer");
    assert.deepEqual(agent.tools, []);
    assert.equal(agent.inheritProjectContext, false);
    assert.equal(agent.model, undefined);
    bus.on(REQUEST_EVENT, (request) => {
      const parsed = parseSubagentDelegationRequest(request);
      assert.equal(parsed.ok, true, parsed.error);

    });
    assert.equal(await namer.generate("Safe excerpt", "/tmp", 1000, new AbortController().signal), "Validated installed API");
    await mkdir(join(directory, ".pi"));
    await writeFile(join(directory, ".pi", "settings.json"), JSON.stringify({ subagents: {
      defaultModel: "test-provider/default-model",
      defaultThinking: "low",
      agentOverrides: { "session-namer": { model: "test-provider/naming-model", thinking: "off", tools: ["bash"], inheritProjectContext: true } },
    } }));
    const resolved = mergeRuntimeAgents(pi, { agents: [] }, [], { cwd: directory, scope: "both", projectTrusted: true }).agents[0];
    assert.equal(resolved.model, "test-provider/naming-model");
    assert.equal(resolved.thinking, "off");
    assert.deepEqual(resolved.tools, []);
    assert.equal(resolved.inheritProjectContext, false);
    await writeFile(join(directory, ".pi", "settings.json"), JSON.stringify({ subagents: { defaultModel: "test-provider/default-model", defaultThinking: "low" } }));
    const defaults = mergeRuntimeAgents(pi, { agents: [] }, [], { cwd: directory, scope: "both", projectTrusted: true }).agents[0];
    assert.equal(defaults.model, "test-provider/default-model");
    assert.equal(defaults.thinking, "low");
  } finally {
    namer.dispose();
    assert.equal(listRuntimeAgentConfigs(pi).length, 0);
    bridge.dispose();
    dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
