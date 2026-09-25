#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const manifestPath = process.argv[2];
const baseUrl = process.env.REPLAY_TARGET_BASE_URL;

function fail(message, code = 1) {
  console.error(`ReplayOps: ${message}`);
  process.exit(code);
}

if (!manifestPath) fail("Provide a downloaded replay manifest: npm run replay:http -- path/to/replay.json", 2);
if (!baseUrl) fail("Set REPLAY_TARGET_BASE_URL to the isolated application started by this CI job.", 2);

let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch (error) {
  fail(`Could not read the manifest: ${error instanceof Error ? error.message : String(error)}`, 2);
}

if (manifest.schemaVersion !== "replayops.http-replay/v1") fail("Unsupported replay manifest schema.", 2);
if (!manifest.request?.path?.startsWith("/")) fail("Request path must be origin-relative.", 2);
if (!manifest.assertions || !Number.isInteger(manifest.assertions.status)) fail("A numeric expected status is required.", 2);

const targetBase = new URL(baseUrl);
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(targetBase.hostname)) {
  fail("The replay target must be loopback. Start the candidate build inside the same isolated CI job.", 2);
}
const target = new URL(manifest.request.path, targetBase);
if (target.origin !== targetBase.origin) fail("The request attempted to escape the configured replay origin.", 2);

const forbiddenHeader = /authorization|cookie|api[-_]?key|token|secret/i;
const headers = Object.fromEntries(
  Object.entries(manifest.request.headers ?? {}).filter(([name]) => !forbiddenHeader.test(name))
);
headers["x-replayops-version"] = manifest.applicationVersion;

async function invoke() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  const startedAt = Date.now();
  try {
    const response = await fetch(target, {
      method: manifest.request.method,
      headers,
      body: ["GET", "DELETE"].includes(manifest.request.method) ? undefined : manifest.request.body,
      redirect: "error",
      signal: controller.signal
    });
    const body = (await response.text()).slice(0, 64_000);
    return {
      status: response.status,
      body,
      durationMs: Date.now() - startedAt,
      digest: createHash("sha256").update(`${response.status}:${body}`).digest("hex")
    };
  } finally {
    clearTimeout(timer);
  }
}

try {
  const first = await invoke();
  const second = await invoke();
  if (first.digest !== second.digest) fail("Nondeterministic output: identical requests returned different responses.");

  const failures = [];
  if (first.status !== manifest.assertions.status) failures.push(`expected status ${manifest.assertions.status}, observed ${first.status}`);
  if (manifest.assertions.bodyIncludes && !first.body.includes(manifest.assertions.bodyIncludes)) {
    failures.push(`response did not contain ${JSON.stringify(manifest.assertions.bodyIncludes)}`);
  }
  if (failures.length) fail(`regression failed (${failures.join("; ")}).`);
  console.log(`ReplayOps: regression passed in ${first.durationMs} ms against ${manifest.applicationVersion}.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
