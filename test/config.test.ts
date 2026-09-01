import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, loadConfig, modelLabel } from "../src/config.ts";

interface PackageManifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  files?: string[];
  repository?: { type?: string; url?: string };
  homepage?: string;
  bugs?: { url?: string };
}

async function temporaryProject(): Promise<{ directory: string; globalPath: string; projectPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-auto-session-name-"));
  const projectConfigDir = join(directory, ".pi");
  await mkdir(projectConfigDir);
  return {
    directory,
    globalPath: join(directory, "global.json"),
    projectPath: join(projectConfigDir, "auto-session-name.json"),
  };
}

test("loadConfig returns defaults when config files are absent", async () => {
  const paths = await temporaryProject();
  try {
    const loaded = await loadConfig({
      cwd: paths.directory,
      projectTrusted: true,
      env: { PI_AUTO_SESSION_NAME_CONFIG: paths.globalPath },
    });
    assert.deepEqual(loaded.config, DEFAULT_CONFIG);
    assert.deepEqual(loaded.warnings, []);
    assert.deepEqual(loaded.paths, [paths.globalPath, paths.projectPath]);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("loadConfig merges defaults, global file, trusted project file, and environment", async () => {
  const paths = await temporaryProject();
  await writeFile(
    paths.globalPath,
    JSON.stringify({ provider: "openai", model: "global-model", reasoning: "low", maxTokens: 128 }),
  );
  await writeFile(
    paths.projectPath,
    JSON.stringify({ model: "project-model", reasoning: "medium", ticketPrefix: false, maxMessages: 8 }),
  );

  try {
    const loaded = await loadConfig({
      cwd: paths.directory,
      projectTrusted: true,
      env: {
        PI_AUTO_SESSION_NAME_CONFIG: paths.globalPath,
        PI_AUTO_SESSION_NAME_MODEL: "env-model",
        PI_AUTO_SESSION_NAME_REASONING: "high",
        PI_AUTO_SESSION_NAME_TIMEOUT_MS: "45000",
        PI_AUTO_SESSION_NAME_ACTIVE_NAMING_DELAY_MS: "90000",
      },
    });

    assert.equal(loaded.config.provider, "openai");
    assert.equal(loaded.config.model, "env-model");
    assert.equal(loaded.config.reasoning, "high");
    assert.equal(loaded.config.maxTokens, 128);
    assert.equal(loaded.config.timeoutMs, 45_000);
    assert.equal(loaded.config.activeNamingDelayMs, 90_000);
    assert.equal(loaded.config.ticketPrefix, false);
    assert.equal(loaded.config.maxMessages, 8);
    assert.deepEqual(loaded.warnings, []);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("loadConfig ignores project configuration when the project is not trusted", async () => {
  const paths = await temporaryProject();
  await writeFile(paths.globalPath, JSON.stringify({ model: "global-model" }));
  await writeFile(paths.projectPath, JSON.stringify({ model: "untrusted-project-model" }));

  try {
    const loaded = await loadConfig({
      cwd: paths.directory,
      projectTrusted: false,
      env: { PI_AUTO_SESSION_NAME_CONFIG: paths.globalPath },
    });
    assert.equal(loaded.config.model, "global-model");
    assert.deepEqual(loaded.paths, [paths.globalPath]);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("loadConfig keeps safe defaults and reports invalid values", async () => {
  const paths = await temporaryProject();
  await writeFile(
    paths.globalPath,
    JSON.stringify({
      provider: "",
      reasoning: "extreme",
      temperature: 4,
      maxTokens: 0,
      timeoutMs: 10,
      maxRetries: -1,
      activeNamingDelayMs: 999,
      cacheRetention: "forever",
      automatic: "sometimes",
    }),
  );

  try {
    const loaded = await loadConfig({
      cwd: paths.directory,
      projectTrusted: false,
      env: { PI_AUTO_SESSION_NAME_CONFIG: paths.globalPath },
    });
    assert.equal(loaded.config.provider, DEFAULT_CONFIG.provider);
    assert.equal(loaded.config.reasoning, DEFAULT_CONFIG.reasoning);
    assert.equal(loaded.config.maxTokens, DEFAULT_CONFIG.maxTokens);
    assert.equal(loaded.config.automatic, DEFAULT_CONFIG.automatic);
    assert.ok(loaded.warnings.length >= 8);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("loadConfig warns about malformed JSON without failing extension startup", async () => {
  const paths = await temporaryProject();
  await writeFile(paths.globalPath, "not json");

  try {
    const loaded = await loadConfig({
      cwd: paths.directory,
      projectTrusted: false,
      env: { PI_AUTO_SESSION_NAME_CONFIG: paths.globalPath },
    });
    assert.deepEqual(loaded.config, DEFAULT_CONFIG);
    assert.equal(loaded.warnings.length, 1);
    assert.match(loaded.warnings[0] ?? "", /Could not read/);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("modelLabel combines provider and model", () => {
  assert.equal(modelLabel({ provider: "commandcode", model: "anthropic/claude-sonnet" }), "commandcode/anthropic/claude-sonnet");
});

test("package manifest uses host core packages and ships configuration docs", async () => {
  const contents = await readFile(new URL("../package.json", import.meta.url), "utf8");
  const manifest: PackageManifest = JSON.parse(contents);

  for (const packageName of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"]) {
    assert.equal(manifest.dependencies?.[packageName], undefined);
    assert.equal(manifest.peerDependencies?.[packageName], "*");
    assert.equal(manifest.peerDependenciesMeta?.[packageName]?.optional, true);
  }
  assert.ok(manifest.files?.includes("config.example.json"));
  assert.ok(manifest.files?.includes("LICENSE"));
  assert.equal(manifest.repository?.type, "git");
  assert.equal(manifest.repository?.url, "git+https://github.com/patlux/pi-auto-session-name.git");
  assert.equal(manifest.homepage, "https://github.com/patlux/pi-auto-session-name#readme");
  assert.equal(manifest.bugs?.url, "https://github.com/patlux/pi-auto-session-name/issues");
});
