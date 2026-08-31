#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const sourcePath = path.join(root, "atlas-controller.js");
const outputPath = path.join(root, "dist", "atlas-controller.js");
const maximumBytes = 24000;

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

function compactLine(line) {
  let output = "";
  let quote = null;
  let escaped = false;
  const punctuation = "{}()[],;:";
  for (let index = 0; index < line.length; index += 1) {
    const current = line[index];
    if (quote !== null) {
      output += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === '"' || current === "'") { quote = current; output += current; continue; }
    if (current === " " && (punctuation.includes(output.slice(-1)) || punctuation.includes(line[index + 1]))) continue;
    output += current;
  }
  return output;
}

function manglePrivateIdentifiers(source) {
  const names = {
    requestHistory: "_a", activeOperation: "_b", operationIsActive: "_c", requestId: "_d",
    expectedRelayState: "_e", requestHistoryDegraded: "_f", finishOperation: "_g",
    durableModeKnown: "_h", requestHistoryPersistent: "_i", lastRequestCommand: "_j",
    expectedRelayOperationId: "_k", currentMode: "_l", kvsWriteQueue: "_m", kvsCallTimer: "_n",
    persistenceDirty: "_o", lastRequestId: "_p", persistRequestHistory: "_q", modeKnown: "_r",
    callback: "_s", lastRequestOperationId: "_t", retryablePendingRequestIds: "_u",
    safetyDegraded: "_v", setHistoryError: "_w", setError: "_x", relayGeneration: "_y",
    lastRequestPhase: "_z", kvsCallToken: "_A", stateEtagKnown: "_B", cloudSelectedMode: "_C",
    setDirtyMarker: "_D", clearOperationTimer: "_E", recordRelayTransition: "_F",
    unresolvedPowerIntent: "_G", lastHistoryError: "_H", completePowerOperation: "_I",
    relayState: "_J", persistenceFailure: "_K", failSceneOperation: "_L", persistState: "_M",
    knownOffSinceMs: "_N", startupRelayAmbiguous: "_O", scheduleOperation: "_P",
    performKvsAttempt: "_Q", initialized: "_R", bindOperationCallback: "_S",
    finishRestorePower: "_T", finishRestoreRelaySet: "_U", verifyRestorePower: "_V",
    restorePowerNow: "_W", readRestorePower: "_X", finishSinglePulse: "_Y",
    finishPulseOn: "_Z", continuePulseOn: "_0", finishPulseOff: "_1",
    finishNormalOffRelaySet: "_2", continueNormalOffAfterRead: "_3",
    continueNormalOffAfterIntent: "_4", finishDiagnosticPulse: "_5",
    continueDiagnosticAfterRestore: "_6", continueDiagnosticAfterInvalidation: "_7"
  };
  let output = "";
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length;) {
    const current = source[index];
    if (quote !== null) {
      output += current;
      index += 1;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === '"' || current === "'") { quote = current; output += current; index += 1; continue; }
    if (/[A-Za-z_$]/.test(current)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) end += 1;
      const token = source.slice(index, end);
      let previous = output.length - 1;
      while (previous >= 0 && /\s/.test(output[previous])) previous -= 1;
      let next = end;
      while (next < source.length && /\s/.test(source[next])) next += 1;
      const objectKey = source[next] === ":" && (output[previous] === "{" || output[previous] === ",");
      output += names[token] && output[previous] !== "." && !objectKey ? names[token] : token;
      index = end;
      continue;
    }
    output += current;
    index += 1;
  }
  return output;
}

const source = fs.readFileSync(sourcePath, "utf8");
if (/^\s*\/[*]\s*@meta\b/.test(source) || /^\s*\/\/\s*@meta\b/.test(source)) {
  throw new Error("managed @meta virtual components are disabled because firmware 2.0.0 reboots during reconciliation");
}
const body = manglePrivateIdentifiers(stripComments(source))
  .split(/\r?\n/)
  .map((line) => compactLine(line.trim()))
  .filter(Boolean)
  .join("\n");
const artifact = body + "\n";
const bytes = Buffer.byteLength(artifact);
if (bytes > maximumBytes) throw new Error("deploy artifact is " + bytes + " bytes; maximum is " + maximumBytes);
new vm.Script(artifact, { filename: "dist/atlas-controller.js" });

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, artifact);
process.stdout.write(JSON.stringify({ output: path.relative(root, outputPath), bytes, maximum_bytes: maximumBytes }) + "\n");
