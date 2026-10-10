import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";

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
    JSON.stringify({ timeoutMs: 40_000, maxMessages: 10 }),
  );
  await writeFile(
    paths.projectPath,
    JSON.stringify({ timeoutMs: 50_000, ticketPrefix: false, maxMessages: 8 }),
  );

  try {
    const loaded = await loadConfig({
      cwd: paths.directory,
      projectTrusted: true,
      env: {
        PI_AUTO_SESSION_NAME_CONFIG: paths.globalPath,
        PI_AUTO_SESSION_NAME_TIMEOUT_MS: "45000",
        PI_AUTO_SESSION_NAME_ACTIVE_NAMING_DELAY_MS: "90000",
      },
    });

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
  await writeFile(paths.globalPath, JSON.stringify({ timeoutMs: 40_000 }));
  await writeFile(paths.projectPath, JSON.stringify({ timeoutMs: 50_000 }));

  try {
    const loaded = await loadConfig({
      cwd: paths.directory,
      projectTrusted: false,
      env: { PI_AUTO_SESSION_NAME_CONFIG: paths.globalPath },
    });
    assert.equal(loaded.config.timeoutMs, 40_000);
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
    assert.equal(loaded.config.timeoutMs, DEFAULT_CONFIG.timeoutMs);
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

test("legacy provider settings are ignored with migration warnings", async () => {
  const paths = await temporaryProject();
  try {
    await writeFile(paths.globalPath, JSON.stringify({ provider: "old-provider", model: "old-model", maxTokens: 96 }));
    const loaded = await loadConfig({
      cwd: paths.directory,
      projectTrusted: false,
      env: { PI_AUTO_SESSION_NAME_CONFIG: paths.globalPath, PI_AUTO_SESSION_NAME_MODEL: "old-env-model" },
    });
    assert.deepEqual(loaded.config, DEFAULT_CONFIG);
    assert.equal(loaded.warnings.length, 4);
    assert.ok(loaded.warnings.every((warning) => warning.includes("is ignored")));
    assert.doesNotMatch(JSON.stringify(loaded.config), /old-provider|old-model|old-env-model/);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
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
  assert.equal(manifest.repository?.url, "git+https://github.com/aran159/pi-auto-session-name.git");
  assert.equal(manifest.homepage, "https://github.com/aran159/pi-auto-session-name#readme");
  assert.equal(manifest.bugs?.url, "https://github.com/aran159/pi-auto-session-name/issues");
});
