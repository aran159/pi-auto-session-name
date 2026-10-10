import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type AutoSessionNameConfig } from "./config.ts";
import { NAMING_AGENT, NamingIntegrationError, SubagentNamer } from "./subagents.ts";
import {
  buildConversationExcerpt,
  buildTitlePrompt,
  excerptFingerprint,
  findTicketId,
  normalizeTitle,
  prefixTitleWithTicket,
  type ConversationExcerpt,
} from "./title.ts";

export interface ScheduledTask {
  cancel(): void;
  unref?(): void;
}

export type TaskScheduler = (delayMs: number, callback: () => void) => ScheduledTask;

const defaultTaskScheduler: TaskScheduler = (delayMs, callback) => {
  const timer = setTimeout(callback, delayMs);
  return {
    cancel: () => clearTimeout(timer),
    unref: () => timer.unref?.(),
  };
};

export class ActiveNamingTimer {
  private task: ScheduledTask | undefined;

  constructor(private readonly scheduleTask: TaskScheduler = defaultTaskScheduler) {}

  schedule(delayMs: number, callback: () => void): boolean {
    if (this.task) return false;
    this.task = this.scheduleTask(delayMs, () => {
      this.task = undefined;
      callback();
    });
    this.task.unref?.();
    return true;
  }

  cancel(): void {
    this.task?.cancel();
    this.task = undefined;
  }

  get scheduled(): boolean {
    return this.task !== undefined;
  }
}

export class RequestGate {
  private active: AbortController | undefined;
  private lastAutomaticFingerprint: number | undefined;
  private lastAutomaticAttemptAt = 0;

  begin(fingerprint: number, force: boolean, now: number, cooldownMs: number): AbortController | undefined {
    if (this.active) return undefined;
    if (
      !force &&
      this.lastAutomaticFingerprint === fingerprint &&
      now - this.lastAutomaticAttemptAt < cooldownMs
    ) {
      return undefined;
    }

    if (!force) {
      this.lastAutomaticFingerprint = fingerprint;
      this.lastAutomaticAttemptAt = now;
    }
    this.active = new AbortController();
    return this.active;
  }

  finish(controller: AbortController): void {
    if (this.active === controller) this.active = undefined;
  }

  shutdown(): void {
    this.active?.abort();
    this.active = undefined;
    this.lastAutomaticFingerprint = undefined;
    this.lastAutomaticAttemptAt = 0;
  }
}

async function generateTitle(
  namer: SubagentNamer,
  ctx: ExtensionContext,
  config: AutoSessionNameConfig,
  excerpt: ConversationExcerpt,
  signal: AbortSignal,
): Promise<string> {
  const response = await namer.generate(buildTitlePrompt(excerpt.text), ctx.cwd, config.timeoutMs, signal);
  const title = normalizeTitle(response, config.maxTitleChars);
  if (!title) throw new Error("Naming model returned no usable title");
  if (!config.ticketPrefix) return title;
  return prefixTitleWithTicket(title, findTicketId(excerpt.text), config.maxTitleChars);
}

export default function autoSessionName(pi: ExtensionAPI) {
  const gate = new RequestGate();
  const namer = new SubagentNamer(pi.events);
  let config: AutoSessionNameConfig | undefined;
  let warned = false;
  const activeNamingTimer = new ActiveNamingTimer();
  let activeRun: Promise<void> | undefined;
  let sessionGeneration = 0;

  pi.on("session_start", async (_event, ctx) => {
    const generation = ++sessionGeneration;
    activeNamingTimer.cancel();
    gate.shutdown();
    activeRun = undefined;
    namer.dispose();
    config = undefined;
    const loaded = await loadConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
    if (generation !== sessionGeneration) return;
    config = loaded.config;
    warned = false;
    for (const warning of loaded.warnings) console.warn(`[auto-session-name] ${warning}`);
    try {
      namer.ensureRegistered();
    } catch (error: unknown) {
      if (error instanceof NamingIntegrationError && ctx.hasUI) {
        ctx.ui.notify(error.message, "warning");
        warned = true;
      }
    }
  });

  const run = async (ctx: ExtensionContext, force: boolean, requireAssistantMessage: boolean): Promise<void> => {
    const currentConfig = config;
    if (!currentConfig) return;
    if (!force && (!currentConfig.automatic || pi.getSessionName())) return;

    const excerpt = buildConversationExcerpt(ctx.sessionManager, currentConfig);
    if (!excerpt.hasUserMessage || (requireAssistantMessage && !excerpt.hasAssistantMessage) || !excerpt.text) return;

    const controller = gate.begin(excerptFingerprint(excerpt), force, Date.now(), currentConfig.cooldownMs);
    if (!controller) return;

    try {
      const title = await generateTitle(namer, ctx, currentConfig, excerpt, controller.signal);
      if (controller.signal.aborted || (!force && pi.getSessionName())) return;

      pi.setSessionName(title);
      warned = false;
      if (ctx.hasUI) ctx.ui.notify(`Session named: ${title}`, "info");
    } catch (error: unknown) {
      if (!controller.signal.aborted && (force || !warned) && ctx.hasUI) {
        ctx.ui.notify(error instanceof NamingIntegrationError ? error.message : "Session naming failed; check pi-subagents settings and authentication", "warning");
        warned = true;
      }
    } finally {
      gate.finish(controller);
    }
  };

  const startRun = (
    ctx: ExtensionContext,
    force: boolean,
    requireAssistantMessage: boolean,
  ): Promise<void> => {
    let tracked: Promise<void>;
    tracked = run(ctx, force, requireAssistantMessage).finally(() => {
      if (activeRun === tracked) activeRun = undefined;
    });
    activeRun = tracked;
    return tracked;
  };

  pi.on("before_agent_start", (_event, ctx) => {
    const currentConfig = config;
    if (!currentConfig?.automatic || pi.getSessionName()) return;

    activeNamingTimer.schedule(currentConfig.activeNamingDelayMs, () => {
      if (ctx.isIdle() || pi.getSessionName()) return;
      startRun(ctx, false, false).catch((error: unknown) => {
        console.error("[auto-session-name] Unexpected active naming failure", error);
      });
    });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const generation = sessionGeneration;
    activeNamingTimer.cancel();
    const pending = activeRun;
    if (pending) await pending;
    if (generation !== sessionGeneration) return;
    await startRun(ctx, false, true);
  });

  pi.on("session_info_changed", (event) => {
    if (!event.name) return;
    activeNamingTimer.cancel();
    gate.shutdown();
  });

  pi.on("session_shutdown", () => {
    sessionGeneration++;
    config = undefined;
    activeNamingTimer.cancel();
    gate.shutdown();
    namer.dispose();
  });

  pi.registerCommand("auto-name", {
    description: "Generate or replace the session name",
    handler: async (_args, ctx) => {
      const generation = sessionGeneration;
      const currentConfig = config;
      if (!currentConfig) {
        if (ctx.hasUI) ctx.ui.notify("Automatic session naming is not initialized", "warning");
        return;
      }
      if (pi.getSessionName() && ctx.hasUI) {
        const confirmed = await ctx.ui.confirm(
          "Replace session name?",
          `Generate a new name with the pi-subagents ${NAMING_AGENT} agent?`,
        );
        if (!confirmed) return;
      }
      if (generation !== sessionGeneration) return;
      activeNamingTimer.cancel();
      const pending = activeRun;
      if (pending) await pending;
      if (generation !== sessionGeneration) return;
      await startRun(ctx, true, true);
    },
  });
}
