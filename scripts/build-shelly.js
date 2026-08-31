#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const sourcePath = path.join(root, "atlas-controller.js");
const outputPath = path.join(root, "dist", "atlas-controller.js");
const maximumBytes = 56000;

function stripComments(source) {
  let output = "";
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (current === "\n") { lineComment = false; output += current; }
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") { blockComment = false; index += 1; }
      else if (current === "\n") output += current;
      continue;
    }
    if (quote !== null) {
      output += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === '"' || current === "'") { quote = current; output += current; continue; }
    if (current === "/" && next === "/") { lineComment = true; index += 1; continue; }
    if (current === "/" && next === "*") { blockComment = true; index += 1; continue; }
    output += current;
  }
  if (quote !== null || blockComment) throw new Error("unterminated source token while building Shelly artifact");
  return output;
}

const source = fs.readFileSync(sourcePath, "utf8");
const metadataEnd = source.indexOf("*/");
if (!source.startsWith("/* @meta ") || metadataEnd < 0) throw new Error("Shelly @meta header is missing or malformed");
const metadata = source.slice(0, metadataEnd + 2);
const body = stripComments(source.slice(metadataEnd + 2))
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .join("");
const artifact = metadata + "\n" + body + "\n";
const bytes = Buffer.byteLength(artifact);
if (bytes > maximumBytes) throw new Error("deploy artifact is " + bytes + " bytes; maximum is " + maximumBytes);
new vm.Script(artifact, { filename: "dist/atlas-controller.js" });

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, artifact);
process.stdout.write(JSON.stringify({ output: path.relative(root, outputPath), bytes, maximum_bytes: maximumBytes }) + "\n");
