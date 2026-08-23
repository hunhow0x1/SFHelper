#!/usr/bin/env node
/** Find out which public Soulframe endpoints actually exist.
 *
 *  Run this on your own machine - it does nothing but plain GETs to the
 *  candidate URLs in data/endpoints.json, one at a time, with an identifying
 *  User-Agent. No credentials, no auth headers, no retries: a 403 or 429
 *  aborts the run, because DE firewalls hosts that hammer these servers.
 *
 *    node scripts/probe-endpoints.mjs --displayName "YourName"
 *
 *  Results land in data/endpoints.discovered.json. Anything that answers
 *  with real data belongs in the "confirmed" list of data/endpoints.json.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(root, "data", "endpoints.json");
const OUTPUT = join(root, "data", "endpoints.discovered.json");
const BODY_PREVIEW_BYTES = 400;

function parseArgs(argv) {
  const vars = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!flag?.startsWith("--")) continue;
    const value = argv[i + 1];
    if (value !== undefined) vars[flag.slice(2)] = value;
  }
  return vars;
}

function fill(url, vars) {
  const missing = [];
  const filled = url.replace(/\{(\w+)\}/g, (match, key) => {
    if (vars[key] === undefined) {
      missing.push(key);
      return match;
    }
    return encodeURIComponent(vars[key]);
  });
  return { filled, missing };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function probe(endpoint, url, userAgent) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { "user-agent": userAgent, accept: "*/*" },
      redirect: "follow",
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      id: endpoint.id,
      url,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type"),
      cacheControl: response.headers.get("cache-control"),
      bytes: buffer.byteLength,
      elapsedMs: Date.now() - started,
      preview: buffer.subarray(0, BODY_PREVIEW_BYTES).toString("utf8").replace(/\s+/g, " ").trim(),
    };
  } catch (error) {
    return { id: endpoint.id, url, error: String(error?.message ?? error) };
  }
}

const vars = parseArgs(process.argv.slice(2));
const config = JSON.parse(await readFile(CONFIG, "utf8"));
const results = [];

for (const endpoint of config.candidates) {
  const { filled, missing } = fill(endpoint.url, vars);
  if (missing.length > 0) {
    console.log(`- ${endpoint.id}: skipped, needs --${missing.join(" --")}`);
    results.push({ id: endpoint.id, skipped: `missing ${missing.join(", ")}` });
    continue;
  }

  await sleep(config.minIntervalMs ?? 2000);
  const result = await probe(endpoint, filled, config.userAgent);
  results.push(result);

  if (result.error) {
    console.log(`- ${endpoint.id}: network error - ${result.error}`);
  } else {
    console.log(
      `- ${endpoint.id}: ${result.status} ${result.contentType ?? "?"} ${result.bytes}B ${filled}`,
    );
  }

  if (result.status === 403 || result.status === 429) {
    console.error(`\nStopping: ${filled} answered ${result.status}. Do not retry in a loop.`);
    break;
  }
}

await writeFile(OUTPUT, `${JSON.stringify({ probedAt: new Date().toISOString(), results }, null, 2)}\n`);
console.log(`\nWrote ${OUTPUT}`);
console.log("Move anything that returned real data into the \"confirmed\" list in data/endpoints.json.");
