#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadEnv();

const mode = process.argv[2];
const host = process.env.SHELLY_IP;
const scriptId = Number(process.env.SCRIPT_ID || 1);
const minimumFree = Number(process.env.SHELLY_MIN_SCRIPT_MEM_FREE || 8192);
const expectedControls = [
  ["enum", "Atlas scene"],
  ["button", "Atlas Apply scene"],
  ["button", "Atlas Confirm observed"],
  ["button", "Atlas On"],
  ["button", "Atlas Off"]
];

if (mode !== "preflight" && mode !== "verify") throw new Error("usage: node scripts/check-shelly.js preflight|verify");
if (!host) throw new Error("SHELLY_IP is required in .env or the environment");
if (!Number.isInteger(scriptId) || scriptId < 0) throw new Error("SCRIPT_ID must be a non-negative integer");
if (!Number.isFinite(minimumFree) || minimumFree < 1) throw new Error("SHELLY_MIN_SCRIPT_MEM_FREE must be a positive number");

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ id: 1, method, params });
    const request = http.request({
      host,
      port: 80,
      path: "/rpc",
      method: "POST",
      timeout: 10000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(method + " failed: " + JSON.stringify(parsed.error)));
          resolve(parsed.result === undefined ? parsed : parsed.result);
        } catch (error) {
          reject(new Error(method + " returned invalid JSON: " + error.message));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error(method + " timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

function atlasInventory(components) {
  const atlas = components.filter((component) => (
    component.config && typeof component.config.name === "string" && component.config.name.startsWith("Atlas")
  ));
  return {
    controls: atlas
      .filter((component) => component.key.split(":")[0] !== "group")
      .map((component) => ({ key: component.key, type: component.key.split(":")[0], name: component.config.name }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    groups: atlas
      .filter((component) => component.key.split(":")[0] === "group")
      .map((component) => ({
        key: component.key,
        name: component.config.name,
        members: Array.isArray(component.status && component.status.value) ? component.status.value.slice().sort() : []
      }))
      .sort((left, right) => left.key.localeCompare(right.key))
  };
}

function hasExpectedInventory(inventory) {
  const actualControls = inventory.controls
    .map((component) => [component.type, component.name])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const wantedControls = expectedControls.slice().sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (JSON.stringify(actualControls) !== JSON.stringify(wantedControls)) return false;
  if (inventory.groups.length !== 1 || inventory.groups[0].name !== "Atlas Controller") return false;
  const controlKeys = inventory.controls.map((component) => component.key).sort();
  return JSON.stringify(inventory.groups[0].members) === JSON.stringify(controlKeys);
}

(async () => {
  const [status, dynamic] = await Promise.all([
    rpc("Script.GetStatus", { id: scriptId }),
    rpc("Shelly.GetComponents", { dynamic_only: true, include: ["config", "status"] })
  ]);
  const inventory = atlasInventory(dynamic.components || []);
  const atlasCount = inventory.controls.length + inventory.groups.length;
  const errors = status.errors || [];

  if (!status.running) throw new Error("script " + scriptId + " is not running");
  if (errors.length) throw new Error("script reports errors: " + JSON.stringify(errors));
  if (typeof status.mem_free !== "number" || status.mem_free < minimumFree) {
    throw new Error("script memory headroom " + status.mem_free + " is below the configured floor " + minimumFree);
  }

  if (mode === "preflight" && atlasCount !== 0 && !hasExpectedInventory(inventory)) {
    throw new Error("unexpected Atlas virtual-component inventory blocks deployment: " + JSON.stringify(inventory));
  }
  if (mode === "verify" && !hasExpectedInventory(inventory)) {
    throw new Error("deployed Atlas virtual components do not match the expected five controls and controller group: " + JSON.stringify(inventory));
  }

  process.stdout.write(JSON.stringify({
    result: "ok",
    mode,
    script_id: scriptId,
    memory: { used: status.mem_used, peak: status.mem_peak, free: status.mem_free, minimum_free: minimumFree },
    atlas_components: inventory.controls,
    atlas_group: inventory.groups[0] || null
  }, null, 2) + "\n");
})().catch((error) => {
  process.stderr.write("check failed: " + error.message + "\n");
  process.exitCode = 1;
});
