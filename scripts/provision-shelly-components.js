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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

loadEnv();
const host = process.env.SHELLY_IP;
if (!host) throw new Error("SHELLY_IP is required in .env or the environment");

const controls = [
  { key: "enum:200", type: "enum", id: 200, config: { name: "Atlas scene", options: ["Bright", "Cool", "Warm"], default_value: "Bright", persisted: false } },
  { key: "button:200", type: "button", id: 200, config: { name: "Atlas Apply scene" } },
  { key: "button:201", type: "button", id: 201, config: { name: "Atlas Confirm observed" } },
  { key: "button:202", type: "button", id: 202, config: { name: "Atlas Off" } },
  { key: "button:203", type: "button", id: 203, config: { name: "Atlas On" } }
];
const group = { key: "group:200", type: "group", id: 200, config: { name: "Atlas Controller" } };

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ id: 1, method, params });
    const request = http.request({
      host, port: 80, path: "/rpc", method: "POST", timeout: 10000,
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
        } catch (error) { reject(new Error(method + " returned invalid JSON: " + error.message)); }
      });
    });
    request.on("timeout", () => request.destroy(new Error(method + " timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

function byKey(components) { return new Map(components.map((component) => [component.key, component])); }
function sameArray(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

(async () => {
  let dynamic = await rpc("Shelly.GetComponents", { dynamic_only: true, include: ["config", "status"] });
  let existing = byKey(dynamic.components || []);
  const created = [];

  for (const spec of controls) {
    const current = existing.get(spec.key);
    if (current) {
      if (!current.config || current.config.name !== spec.config.name) {
        throw new Error(spec.key + " is occupied by an unexpected component; refusing to overwrite it");
      }
      if (spec.type === "enum" && !sameArray(current.config.options, spec.config.options)) {
        throw new Error(spec.key + " has unexpected scene options; refusing to overwrite it");
      }
      continue;
    }
    await rpc("Virtual.Add", { type: spec.type, id: spec.id, config: spec.config });
    created.push(spec.key);
  }

  dynamic = await rpc("Shelly.GetComponents", { dynamic_only: true, include: ["config", "status"] });
  existing = byKey(dynamic.components || []);
  const currentGroup = existing.get(group.key);
  if (currentGroup && (!currentGroup.config || currentGroup.config.name !== group.config.name)) {
    throw new Error(group.key + " is occupied by an unexpected component; refusing to overwrite it");
  }
  if (!currentGroup) {
    await rpc("Virtual.Add", { type: group.type, id: group.id, config: group.config });
    created.push(group.key);
  }
  await rpc("Group.Set", { id: group.id, value: controls.map((control) => control.key) });

  process.stdout.write(JSON.stringify({ result: "ok", created, controls: controls.map((control) => control.key), group: group.key }, null, 2) + "\n");
})().catch((error) => {
  process.stderr.write("provision failed: " + error.message + "\n");
  process.exitCode = 1;
});
