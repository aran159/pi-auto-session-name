import type { CacheRetention, ThinkingLevel } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const CACHE_RETENTIONS = ["none", "short", "long"] as const;

export interface AutoSessionNameConfig {
  provider: string;
  model: string;
  reasoning: ThinkingLevel;
  temperature: number | undefined;
  maxTokens: number;
  timeoutMs: number;
  maxRetries: number;
  maxRetryDelayMs: number;
  cacheRetention: CacheRetention;
  automatic: boolean;
  cooldownMs: number;
  maxMessages: number;
  maxMessageChars: number;
  maxConversationChars: number;
  maxTitleChars: number;
  ticketPrefix: boolean;
}

export const DEFAULT_CONFIG: Readonly<AutoSessionNameConfig> = {
  provider: "openai-codex",
  model: "gpt-5.4-mini",
  reasoning: "low",
  temperature: undefined,
  maxTokens: 96,
  timeoutMs: 30_000,
  maxRetries: 0,
  maxRetryDelayMs: 60_000,
  cacheRetention: "none",
  automatic: true,
  cooldownMs: 5 * 60_000,
  maxMessages: 6,
  maxMessageChars: 3_000,
  maxConversationChars: 12_000,
  maxTitleChars: 80,
  ticketPrefix: true,
};

export interface LoadedConfig {
  config: AutoSessionNameConfig;
  paths: string[];
  warnings: string[];
}

export interface LoadConfigOptions {
  cwd: string;
  projectTrusted: boolean;
  env?: ConfigEnvironment;
}

interface ConfigEnvironment {
  PI_AUTO_SESSION_NAME_CONFIG?: string;
  PI_AUTO_SESSION_NAME_PROVIDER?: string;
  PI_AUTO_SESSION_NAME_MODEL?: string;
  PI_AUTO_SESSION_NAME_REASONING?: string;
  PI_AUTO_SESSION_NAME_TEMPERATURE?: string;
  PI_AUTO_SESSION_NAME_MAX_TOKENS?: string;
  PI_AUTO_SESSION_NAME_TIMEOUT_MS?: string;
  PI_AUTO_SESSION_NAME_MAX_RETRIES?: string;
  PI_AUTO_SESSION_NAME_MAX_RETRY_DELAY_MS?: string;
  PI_AUTO_SESSION_NAME_CACHE_RETENTION?: string;
  PI_AUTO_SESSION_NAME_AUTOMATIC?: string;
  PI_AUTO_SESSION_NAME_COOLDOWN_MS?: string;
  PI_AUTO_SESSION_NAME_MAX_MESSAGES?: string;
  PI_AUTO_SESSION_NAME_MAX_MESSAGE_CHARS?: string;
  PI_AUTO_SESSION_NAME_MAX_CONVERSATION_CHARS?: string;
  PI_AUTO_SESSION_NAME_MAX_TITLE_CHARS?: string;
  PI_AUTO_SESSION_NAME_TICKET_PREFIX?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.some((level) => level === value);
}

function isCacheRetention(value: unknown): value is CacheRetention {
  return typeof value === "string" && CACHE_RETENTIONS.some((retention) => retention === value);
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function assignString(
  target: AutoSessionNameConfig,
  key: "provider" | "model",
  value: unknown,
  source: string,
  warnings: string[],
): void {
  if (value === undefined) return;
  if (typeof value === "string" && value.trim()) {
    target[key] = value.trim();
    return;
  }
  warnings.push(`${source}.${key} must be a non-empty string`);
}

function assignBoolean(
  target: AutoSessionNameConfig,
  key: "automatic" | "ticketPrefix",
  value: unknown,
  source: string,
  warnings: string[],
): void {
  if (value === undefined) return;
  const parsed = parseBoolean(value);
  if (parsed !== undefined) {
    target[key] = parsed;
    return;
  }
  warnings.push(`${source}.${key} must be true or false`);
}

function assignNumber(
  target: AutoSessionNameConfig,
  key:
    | "temperature"
    | "maxTokens"
    | "timeoutMs"
    | "maxRetries"
    | "maxRetryDelayMs"
    | "cooldownMs"
    | "maxMessages"
    | "maxMessageChars"
    | "maxConversationChars"
    | "maxTitleChars",
  value: unknown,
  source: string,
  warnings: string[],
  minimum: number,
  maximum: number,
  integer: boolean,
): void {
  if (value === undefined) return;
  const parsed = parseNumber(value);
  if (parsed !== undefined && parsed >= minimum && parsed <= maximum && (!integer || Number.isInteger(parsed))) {
    target[key] = parsed;
    return;
  }
  const kind = integer ? "integer" : "number";
  warnings.push(`${source}.${key} must be a ${kind} from ${minimum} to ${maximum}`);
}

function applyValues(
  target: AutoSessionNameConfig,
  values: Record<string, unknown>,
  source: string,
  warnings: string[],
): void {
  assignString(target, "provider", values.provider, source, warnings);
  assignString(target, "model", values.model, source, warnings);

  if (values.reasoning !== undefined) {
    if (isThinkingLevel(values.reasoning)) target.reasoning = values.reasoning;
    else warnings.push(`${source}.reasoning must be one of: ${THINKING_LEVELS.join(", ")}`);
  }
  if (values.cacheRetention !== undefined) {
    if (isCacheRetention(values.cacheRetention)) target.cacheRetention = values.cacheRetention;
    else warnings.push(`${source}.cacheRetention must be one of: ${CACHE_RETENTIONS.join(", ")}`);
  }

  assignNumber(target, "temperature", values.temperature, source, warnings, 0, 2, false);
  assignNumber(target, "maxTokens", values.maxTokens, source, warnings, 16, 4_096, true);
  assignNumber(target, "timeoutMs", values.timeoutMs, source, warnings, 1_000, 600_000, true);
  assignNumber(target, "maxRetries", values.maxRetries, source, warnings, 0, 10, true);
  assignNumber(target, "maxRetryDelayMs", values.maxRetryDelayMs, source, warnings, 0, 600_000, true);
  assignNumber(target, "cooldownMs", values.cooldownMs, source, warnings, 0, 86_400_000, true);
  assignNumber(target, "maxMessages", values.maxMessages, source, warnings, 2, 20, true);
  assignNumber(target, "maxMessageChars", values.maxMessageChars, source, warnings, 100, 20_000, true);
  assignNumber(
    target,
    "maxConversationChars",
    values.maxConversationChars,
    source,
    warnings,
    500,
    100_000,
    true,
  );
  assignNumber(target, "maxTitleChars", values.maxTitleChars, source, warnings, 20, 200, true);
  assignBoolean(target, "automatic", values.automatic, source, warnings);
  assignBoolean(target, "ticketPrefix", values.ticketPrefix, source, warnings);
}

function environmentValues(env: ConfigEnvironment): Record<string, unknown> {
  return {
    provider: env.PI_AUTO_SESSION_NAME_PROVIDER,
    model: env.PI_AUTO_SESSION_NAME_MODEL,
    reasoning: env.PI_AUTO_SESSION_NAME_REASONING,
    temperature: env.PI_AUTO_SESSION_NAME_TEMPERATURE,
    maxTokens: env.PI_AUTO_SESSION_NAME_MAX_TOKENS,
    timeoutMs: env.PI_AUTO_SESSION_NAME_TIMEOUT_MS,
    maxRetries: env.PI_AUTO_SESSION_NAME_MAX_RETRIES,
    maxRetryDelayMs: env.PI_AUTO_SESSION_NAME_MAX_RETRY_DELAY_MS,
    cacheRetention: env.PI_AUTO_SESSION_NAME_CACHE_RETENTION,
    automatic: env.PI_AUTO_SESSION_NAME_AUTOMATIC,
    cooldownMs: env.PI_AUTO_SESSION_NAME_COOLDOWN_MS,
    maxMessages: env.PI_AUTO_SESSION_NAME_MAX_MESSAGES,
    maxMessageChars: env.PI_AUTO_SESSION_NAME_MAX_MESSAGE_CHARS,
    maxConversationChars: env.PI_AUTO_SESSION_NAME_MAX_CONVERSATION_CHARS,
    maxTitleChars: env.PI_AUTO_SESSION_NAME_MAX_TITLE_CHARS,
    ticketPrefix: env.PI_AUTO_SESSION_NAME_TICKET_PREFIX,
  };
}

async function applyFile(
  config: AutoSessionNameConfig,
  path: string,
  warnings: string[],
): Promise<void> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isRecord(parsed)) applyValues(config, parsed, path, warnings);
    else warnings.push(`${path} must contain a JSON object`);
  } catch (error: unknown) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (!missing) {
      const message = error instanceof Error ? error.message : "unknown error";
      warnings.push(`Could not read ${path}: ${message}`);
    }
  }
}

export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  const env = options.env ?? process.env;
  const globalPath = env.PI_AUTO_SESSION_NAME_CONFIG ?? join(getAgentDir(), "extensions", "auto-session-name.json");
  const projectPath = join(options.cwd, CONFIG_DIR_NAME, "auto-session-name.json");
  const paths = options.projectTrusted ? [globalPath, projectPath] : [globalPath];
  const warnings: string[] = [];
  const config: AutoSessionNameConfig = { ...DEFAULT_CONFIG };

  for (const path of paths) await applyFile(config, path, warnings);
  applyValues(config, environmentValues(env), "environment", warnings);

  if (config.maxConversationChars < config.maxMessageChars) {
    warnings.push("maxConversationChars is smaller than maxMessageChars; individual messages will use the lower total limit");
  }

  return { config, paths, warnings };
}

export function modelLabel(config: Pick<AutoSessionNameConfig, "provider" | "model">): string {
  return `${config.provider}/${config.model}`;
}
