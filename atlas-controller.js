// Philips Atlas scene controller for Shelly 2PM Gen4 (local only).
// Controls switch:0 (O1) only; switch:1 (O2) is never read or changed.

let SWITCH_ID = 0;
let KVS_KEY = "atlas_mode";
let KVS_SCHEMA = 5;
let ON_STATE_PULSE_OFF_MS = 150;
let ON_STATE_PULSE_ON_SETTLE_MS = 250;
let OFF_STATE_PULSE_OFF_MS = 500;
let OFF_STATE_PULSE_ON_SETTLE_MS = 500;
let FINAL_ON_SETTLE_MS = 2500;
let SAFE_NORMAL_OFF_MS = 12000;
let SCENE_SWITCH_MAX_OFF_MS = 8000;
let OPERATION_TIMEOUT_MS = 120000;
let RELAY_RPC_TIMEOUT_MS = 5000;
let KVS_RETRY_MS = 500;
let KVS_MAX_ATTEMPTS = 3;
let STORAGE_HISTORY_KEY = "requests";
let STORAGE_DIRTY_KEY = "dirty";

let currentMode = 0;
let initialized = false;
let modeKnown = false;
let durableModeKnown = false;
let persistenceDirty = false;
let activeOperation = null;
let lastOperation = null;
let lastError = null;
let lastHistoryError = null;
let operationCounter = 0;

// Relay timing and ownership are runtime-only. Uptime is monotonic, so a wall
// clock correction cannot shorten the safe restoration interval.
let relayState = null;
let knownOffSinceMs = null;
let externalOffSinceMs = null;
let relayGeneration = 0;
let expectedRelayState = null;
let expectedRelayOperationId = null;
let startupRelayAmbiguous = false;

// The current request is part of the compact atomic KVS record. Older request
// outcomes live in bounded script storage so they cannot overflow KVS state.
let lastRequestId = null;
let lastRequestCommand = null;
let lastRequestOperationId = null;
let lastRequestPhase = null;
let requestHistory = [];
let REQUEST_HISTORY_LIMIT = 8;
let kvsWriteQueue = [];
let kvsWriteInFlight = false;
let lastKvsWriteOk = true;
let kvsCallTimer = null;
let kvsCallToken = 0;
let stateEtag = null;
let stateEtagKnown = false;
let requestHistoryPersistent = true;
let requestHistoryDegraded = false;
let safetyDegraded = false;
let lastPersistenceError = null;
let retryablePendingRequestIds = [];

function log(message) { print("[atlas] " + message); }
function uptimeMs() { return Shelly.getUptimeMs(); }
function validMode(mode) { return typeof mode === "number" && mode >= 0 && mode <= 2 && Math.floor(mode) === mode; }
function validDiagnosticPulseMs(ms) { return typeof ms === "number" && ms >= 100 && ms <= 4500 && Math.floor(ms) === ms; }
function validRequestId(id) {
  if (id === undefined) return true;
  if (typeof id !== "string" || id.length < 1 || id.length > 64) return false;
  let allowed = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-";
  for (let i = 0; i < id.length; i++) {
    if (allowed.indexOf(id.charAt(i)) < 0) return false;
  }
  return true;
}
function modeLabel(mode) {
  if (mode === 0) return "4000K / 100%";
  if (mode === 1) return "6500K / 50%";
  if (mode === 2) return "2700K / 50%";
  return "unknown";
}
function validStoredCommand(command) {
  if (command === "next" || command === "on" || command === "off") return true;
  if (command === "set:0" || command === "set:1" || command === "set:2") return true;
  if (command === "sync:0" || command === "sync:1" || command === "sync:2") return true;
  if (typeof command !== "string" || command.indexOf("diagnostic_pulse:") !== 0) return false;
  let value = Number(command.slice(17));
  return validDiagnosticPulseMs(value) && command === "diagnostic_pulse:" + value;
}
function isStoredArray(value) {
  if (!value || typeof value !== "object" || typeof value.length !== "number") return false;
  // Shelly's JS runtime does not consistently expose Array.isArray. Values
  // originate from JSON, whose canonical leading character distinguishes an
  // array from an object carrying a forged numeric length property.
  return JSON.stringify(value).charAt(0) === "[";
}
function serializedRequestHistory(history) {
  let saved = [];
  for (let i = 0; i < history.length; i++) {
    saved.push([history[i].id, history[i].command, history[i].outcome]);
  }
  return JSON.stringify(saved);
}
function persistRequestHistory(history) {
  let value = serializedRequestHistory(history);
  if (value.length > 1024) {
    requestHistoryPersistent = false;
    setHistoryError("Script.storage request history exceeds 1024 bytes");
    return false;
  }
  try {
    Script.storage.setItem(STORAGE_HISTORY_KEY, value);
    requestHistoryPersistent = true;
    if (!requestHistoryDegraded && lastHistoryError !== null) {
      let recoveredError = lastHistoryError;
      lastHistoryError = null;
      if (lastError === recoveredError) lastError = null;
    }
    return true;
  } catch (error) {
    requestHistoryPersistent = false;
    setHistoryError("Script.storage request history failed: " + error.message);
    return false;
  }
}
function rememberRequest(requestId, command, operationId) {
  if (requestId === null) return true;
  let next = [];
  for (let i = 0; i < requestHistory.length; i++) next.push(requestHistory[i]);
  next.push({ id: requestId, command: command, operation_id: operationId, outcome: "pending", message: null });
  if (next.length > REQUEST_HISTORY_LIMIT) {
    for (let i = 1; i < next.length; i++) next[i - 1] = next[i];
    next.pop();
  }
  if (!persistRequestHistory(next)) return false;
  requestHistory = next;
  return true;
}
function completeRememberedRequest(op, ok, message) {
  if (!op || op.requestId === null) return;
  for (let i = requestHistory.length - 1; i >= 0; i--) {
    if (requestHistory[i].id === op.requestId) {
      requestHistory[i].outcome = ok ? "ok" : "failed";
      requestHistory[i].message = message;
      break;
    }
  }
  persistRequestHistory(requestHistory);
}
function setDirtyMarker(reason) {
  try {
    Script.storage.setItem(STORAGE_DIRTY_KEY, reason || "1");
    safetyDegraded = false;
    return true;
  } catch (error) {
    safetyDegraded = true;
    persistenceDirty = true;
    setError("Script.storage dirty marker failed: " + error.message);
    return false;
  }
}
function clearDirtyMarker() {
  try {
    Script.storage.removeItem(STORAGE_DIRTY_KEY);
    return true;
  } catch (error) {
    safetyDegraded = true;
    persistenceDirty = true;
    setError("could not clear Script.storage dirty marker: " + error.message);
    return false;
  }
}
function hasDirtyMarker() {
  try {
    return Script.storage.getItem(STORAGE_DIRTY_KEY) !== null;
  } catch (error) {
    safetyDegraded = true;
    persistenceDirty = true;
    setError("could not read Script.storage dirty marker: " + error.message);
    return true;
  }
}
function preMutationMarker(op) {
  return op && op.requestId !== null ? "pre:" + op.requestId : "pre:anonymous";
}
function clearProvenSafePreMutationMarker() {
  try {
    let marker = Script.storage.getItem(STORAGE_DIRTY_KEY);
    if (typeof marker !== "string" || marker.indexOf("pre:") !== 0) return;
    let requestId = marker.slice(4);
    for (let i = 0; i < retryablePendingRequestIds.length; i++) {
      if (retryablePendingRequestIds[i] === requestId) {
        Script.storage.removeItem(STORAGE_DIRTY_KEY);
        log("cleared pre-mutation marker for request proven not to have started: " + requestId);
        return;
      }
    }
  } catch (error) {
    safetyDegraded = true;
    persistenceDirty = true;
    setError("could not reconcile pre-mutation dirty marker: " + error.message);
  }
}
function setError(message) { lastError = message; log("ERROR: " + message); }
function setHistoryError(message) {
  lastHistoryError = message;
  setError(message);
}
function persistenceFailure(phase, code, message) {
  lastKvsWriteOk = false;
  lastPersistenceError = { phase: phase, code: code, message: message, uptime_ms: uptimeMs() };
}
function readyError() {
  if (!initialized) return "controller is still loading KVS state";
  if (safetyDegraded) return "dirty-marker storage is unavailable; repair storage and use sync";
  if (persistenceDirty) return "controller persistence is dirty; sync is required";
  if (!modeKnown || !durableModeKnown) return "Atlas mode is uncertain; physically inspect it and use sync";
  return null;
}

function operationSnapshot(op) {
  if (!op) return null;
  return {
    id: op.id, request_id: op.requestId, command: op.command, name: op.name,
    target_mode: op.targetMode, starting_mode: op.startingMode,
    working_mode: op.workingMode, branch: op.branch, phase: op.phase,
    pulse_index: op.pulseIndex, pulse_count: op.pulseCount,
    expected_relay_on: op.expectedRelayState,
    started_uptime_ms: op.startedMs, deadline_uptime_ms: op.deadlineMs,
    completed_uptime_ms: op.completedMs, ok: op.ok, message: op.message,
    primary_error: op.primaryError, recovery_error: op.recoveryError,
    relay_recovery_error: op.relayRecoveryError,
    uncertainty_persistence_error: op.uncertaintyPersistenceError
  };
}

function beginOperation(name, command, targetMode, requestId) {
  if (!initialized) return { error: "controller is still loading KVS state" };
  if (activeOperation) return { error: "controller is busy with " + activeOperation.name };
  if (requestHistoryDegraded) {
    return { error: "request history integrity is degraded; explicitly reset request history before another operation" };
  }
  if (!requestHistoryPersistent && !persistRequestHistory(requestHistory)) {
    return { error: "request history is not durable; refusing operation" };
  }
  operationCounter += 1;
  let op = {
    id: "op-" + uptimeMs() + "-" + operationCounter,
    requestId: requestId === undefined ? null : requestId,
    command: command, name: name, targetMode: targetMode,
    startingMode: currentMode, workingMode: currentMode,
    branch: null, phase: "starting", pulseIndex: 0, pulseCount: 0,
    expectedRelayState: null, startedMs: uptimeMs(), deadlineMs: null,
    completedMs: null, ok: null, message: null, primaryError: null,
    recoveryError: null, relayRecoveryError: null, uncertaintyPersistenceError: null,
    relayGeneration: relayGeneration, timer: null, watchdog: null,
    sceneMutation: false, interrupted: false
  };
  if (op.requestId !== null) {
    if (!rememberRequest(op.requestId, command, op.id)) {
      return { error: "request history could not be stored; refusing command" };
    }
    lastRequestId = op.requestId;
    lastRequestCommand = command;
    lastRequestOperationId = op.id;
  }
  activeOperation = op;
  lastError = null;
  op.watchdog = Timer.set(OPERATION_TIMEOUT_MS, false, function () { timeoutOperation(op); });
  log("starting " + name + " as " + op.id);
  return { operation: op };
}

function operationIsActive(op) {
  return activeOperation === op && !op.interrupted && op.relayGeneration === relayGeneration;
}
function clearOperationTimer(op) {
  if (op && op.timer !== null) {
    Timer.clear(op.timer);
    op.timer = null;
    op.deadlineMs = null;
  }
}
function clearOperationWatchdog(op) {
  if (op && op.watchdog !== null) {
    Timer.clear(op.watchdog);
    op.watchdog = null;
  }
}
function finishOperation(op, ok, message) {
  if (!op || activeOperation !== op) return;
  clearOperationTimer(op);
  clearOperationWatchdog(op);
  expectedRelayState = null;
  expectedRelayOperationId = null;
  op.expectedRelayState = null;
  op.phase = "completed";
  op.completedMs = uptimeMs();
  op.ok = ok;
  op.message = message;
  completeRememberedRequest(op, ok, message);
  if (!ok && op.primaryError === null) op.primaryError = message;
  activeOperation = null;
  lastOperation = operationSnapshot(op);
  if (ok) log("completed " + op.name + ": " + message);
  else setError(op.name + " failed: " + message);
}
function recoverTimedOutRelayOn(op, callback) {
  let done = false;
  function finish(error) {
    if (done) return;
    done = true;
    clearOperationTimer(op);
    expectedRelayState = null;
    expectedRelayOperationId = null;
    op.expectedRelayState = null;
    if (error) op.relayRecoveryError = error;
    callback();
  }
  function callTimed(method, params, phase, response) {
    op.phase = phase;
    clearOperationTimer(op);
    let handle = Timer.set(5000, false, function () {
      if (op.timer !== handle) return;
      op.timer = null;
      response(null, -1, method + " callback timeout");
    });
    op.timer = handle;
    Shelly.call(method, params, function (result, code, message) {
      if (done || op.timer !== handle) return;
      Timer.clear(op.timer);
      op.timer = null;
      response(result, code, message);
    });
  }
  function verifyOn() {
    callTimed("Switch.GetStatus", { id: SWITCH_ID }, "watchdog_verifying_relay_on", function (result, code, message) {
      if (code !== 0 || !result || result.output !== true) {
        return finish("watchdog could not verify O1 ON" + (message ? ": " + message : ""));
      }
      recordRelayTransition(true, true);
      finish(null);
    });
  }
  callTimed("Switch.GetStatus", { id: SWITCH_ID }, "watchdog_reading_relay", function (result, code, message) {
    if (code !== 0 || !result || typeof result.output !== "boolean") {
      return finish("watchdog could not read O1" + (message ? ": " + message : ""));
    }
    if (result.output) {
      recordRelayTransition(true, true);
      return finish(null);
    }
    expectedRelayState = true;
    expectedRelayOperationId = op.id;
    op.expectedRelayState = true;
    callTimed("Switch.Set", { id: SWITCH_ID, on: true }, "watchdog_restoring_relay_on", function () {
      // A lost Set response is ambiguous, so always verify the physical output.
      verifyOn();
    });
  });
}
function timeoutOperation(op) {
  if (!op || activeOperation !== op) return;
  op.watchdog = null;
  op.interrupted = true;
  op.primaryError = "operation watchdog expired during " + op.phase;
  clearOperationTimer(op);
  expectedRelayState = null;
  expectedRelayOperationId = null;
  op.expectedRelayState = null;
  if (!op.sceneMutation) return finishOperation(op, false, op.primaryError);
  modeKnown = false;
  durableModeKnown = false;
  setDirtyMarker(op.primaryError);
  let remaining = 2;
  function completedRecoveryPart() {
    remaining -= 1;
    if (remaining !== 0) return;
    let message = op.primaryError;
    message += op.relayRecoveryError ? "; relay recovery failed: " + op.relayRecoveryError : "; O1 recovery verified";
    if (op.uncertaintyPersistenceError) message += "; uncertainty persistence failed: " + op.uncertaintyPersistenceError;
    finishOperation(op, false, message);
  }
  persistState(false, currentMode, op, function (saved, error) {
    if (!saved) op.uncertaintyPersistenceError = error;
    completedRecoveryPart();
  });
  recoverTimedOutRelayOn(op, completedRecoveryPart);
}
function scheduleOperation(op, delayMs, phase, callback) {
  if (!operationIsActive(op)) return;
  clearOperationTimer(op);
  op.phase = phase;
  op.deadlineMs = uptimeMs() + delayMs;
  op.timer = Timer.set(delayMs, false, function () {
    op.timer = null;
    op.deadlineMs = null;
    if (operationIsActive(op)) callback();
  });
}

function persistedValue(known, mode, op, requestPhase) {
  let requestId = "";
  let requestCommand = "";
  let requestOperationId = "";
  let phase = "";
  if (op && op.requestId !== null) {
    requestId = op.requestId;
    requestCommand = op.command;
    requestOperationId = op.id;
    phase = requestPhase || (known ? "d" : "i");
  } else if (!op) {
    requestId = lastRequestId || "";
    requestCommand = lastRequestCommand || "";
    requestOperationId = lastRequestOperationId || "";
    phase = lastRequestPhase || "";
  }
  return {
    s: KVS_SCHEMA,
    k: known ? 1 : 0,
    m: mode,
    r: requestId,
    c: requestCommand,
    o: requestOperationId,
    p: phase
  };
}
function removeFirstKvsWrite() {
  for (let i = 1; i < kvsWriteQueue.length; i++) {
    kvsWriteQueue[i - 1] = kvsWriteQueue[i];
  }
  kvsWriteQueue.pop();
}
function finishKvsWrite(write, ok, error) {
  removeFirstKvsWrite();
  kvsWriteInFlight = false;
  lastKvsWriteOk = ok;
  if (!ok) durableModeKnown = false;
  write.callback(ok, error);
  persistenceDirty = safetyDegraded || kvsWriteQueue.length > 0 || !lastKvsWriteOk;
  processKvsWriteQueue();
}
function finishSuccessfulKvsWrite(write, result) {
  if (result && typeof result.etag === "string") {
    stateEtag = result.etag;
    stateEtagKnown = true;
  } else {
    stateEtagKnown = false;
  }
  lastRequestId = write.value.r || null;
  lastRequestCommand = write.value.c || null;
  lastRequestOperationId = write.value.o || null;
  lastRequestPhase = write.value.p || null;
  durableModeKnown = write.known;
  lastPersistenceError = null;
  // A newer queued write may represent an interruption that supersedes this
  // result. Keep the marker until the final queued state is durable.
  if (kvsWriteQueue.length === 1) clearDirtyMarker();
  log(write.known ? "persisted known scene " + write.mode + " (" + modeLabel(write.mode) + ")" : "persisted uncertain scene state");
  finishKvsWrite(write, true, null);
}
function sameKvsValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function finishKvsReconciliationFailure(write, conflictMessage, code, message) {
  stateEtagKnown = false;
  modeKnown = false;
  durableModeKnown = false;
  setDirtyMarker("authoritative KVS could not be reconciled after an etag conflict");
  let detail = "KVS.Get reconciliation failed" + (message ? ": " + message : "");
  persistenceFailure("KVS etag reconciliation", code, detail);
  finishKvsWrite(write, false, "etag conflict; KVS reconciliation failed after " + write.reconcileAttempts + " attempts; retry sync with a new request_id");
}
function reconcileKvsConflict(write, conflictMessage) {
  write.reconcileAttempts += 1;
  kvsCallToken += 1;
  let token = kvsCallToken;
  kvsCallTimer = Timer.set(5000, false, function () {
    kvsCallTimer = null;
    if (token !== kvsCallToken || kvsWriteQueue.length === 0 || kvsWriteQueue[0] !== write) return;
    if (write.reconcileAttempts < KVS_MAX_ATTEMPTS) {
      kvsCallTimer = Timer.set(KVS_RETRY_MS, false, function () {
        kvsCallTimer = null;
        reconcileKvsConflict(write, conflictMessage);
      });
      return;
    }
    finishKvsReconciliationFailure(write, conflictMessage, -1, "callback timeout");
  });
  Shelly.call("KVS.Get", { key: KVS_KEY }, function (result, code, message) {
    if (token !== kvsCallToken || kvsWriteQueue.length === 0 || kvsWriteQueue[0] !== write) return;
    if (kvsCallTimer !== null) {
      Timer.clear(kvsCallTimer);
      kvsCallTimer = null;
    }
    if (code === 0 && result && typeof result.etag === "string") {
      stateEtag = result.etag;
      stateEtagKnown = true;
    }
    if (code === 0 && result && sameKvsValue(result.value, write.value)) {
      log("reconciled a committed KVS write whose response was lost");
      finishSuccessfulKvsWrite(write, result);
      return;
    }
    if (code !== 0 || !result || typeof result.etag !== "string") {
      if (write.reconcileAttempts < KVS_MAX_ATTEMPTS) {
        kvsCallTimer = Timer.set(KVS_RETRY_MS, false, function () {
          kvsCallTimer = null;
          reconcileKvsConflict(write, conflictMessage);
        });
        return;
      }
      finishKvsReconciliationFailure(write, conflictMessage, code, message);
      return;
    }
    modeKnown = false;
    durableModeKnown = false;
    setDirtyMarker("authoritative KVS changed outside this controller");
    persistenceFailure("KVS etag reconciliation", code, conflictMessage);
    finishKvsWrite(write, false, "etag conflict; refreshed authoritative state, inspect the scene and retry sync with a new request_id");
  });
}
function isEtagConflict(code, message) {
  return code === -3 || (typeof message === "string" && message.toLowerCase().indexOf("etag") >= 0);
}
function handleKvsAttempt(write, result, code, message, token) {
  if (token !== kvsCallToken || kvsWriteQueue.length === 0 || kvsWriteQueue[0] !== write) return;
  if (kvsCallTimer !== null) {
    Timer.clear(kvsCallTimer);
    kvsCallTimer = null;
  }
  if (code === 0) {
    finishSuccessfulKvsWrite(write, result);
    return;
  }
  if (isEtagConflict(code, message)) {
    reconcileKvsConflict(write, message || "etag conflict");
    return;
  }
  if (write.attempts < KVS_MAX_ATTEMPTS) {
    log("KVS.Set attempt " + write.attempts + " failed; retrying");
    kvsCallTimer = Timer.set(KVS_RETRY_MS, false, function () {
      kvsCallTimer = null;
      performKvsAttempt(write);
    });
    return;
  }
  let detail = "KVS.Set failed after " + write.attempts + " attempts" + (message ? ": " + message : "");
  persistenceFailure("KVS.Set", code, detail);
  finishKvsWrite(write, false, detail);
}
function performKvsEtagRefresh(write) {
  write.refreshAttempts += 1;
  kvsCallToken += 1;
  let token = kvsCallToken;
  function failed(code, message) {
    if (write.refreshAttempts < KVS_MAX_ATTEMPTS) {
      kvsCallTimer = Timer.set(KVS_RETRY_MS, false, function () {
        kvsCallTimer = null;
        performKvsEtagRefresh(write);
      });
      return;
    }
    let detail = "KVS etag refresh failed after " + write.refreshAttempts + " attempts" + (message ? ": " + message : "");
    persistenceFailure("KVS etag refresh", code, detail);
    finishKvsWrite(write, false, detail);
  }
  kvsCallTimer = Timer.set(5000, false, function () {
    kvsCallTimer = null;
    if (token !== kvsCallToken || kvsWriteQueue.length === 0 || kvsWriteQueue[0] !== write) return;
    failed(-1, "callback timeout");
  });
  Shelly.call("KVS.Get", { key: KVS_KEY }, function (result, code, message) {
    if (token !== kvsCallToken || kvsWriteQueue.length === 0 || kvsWriteQueue[0] !== write) return;
    if (kvsCallTimer !== null) {
      Timer.clear(kvsCallTimer);
      kvsCallTimer = null;
    }
    if (code === -105) {
      stateEtag = null;
      stateEtagKnown = true;
      performKvsAttempt(write);
      return;
    }
    if (code !== 0 || !result || typeof result.etag !== "string") return failed(code, message);
    stateEtag = result.etag;
    stateEtagKnown = true;
    performKvsAttempt(write);
  });
}
function performKvsAttempt(write) {
  if (!stateEtagKnown) return performKvsEtagRefresh(write);
  write.attempts += 1;
  kvsCallToken += 1;
  let token = kvsCallToken;
  let params = { key: KVS_KEY, value: write.value };
  if (stateEtag !== null) params.etag = stateEtag;
  kvsCallTimer = Timer.set(5000, false, function () {
    kvsCallTimer = null;
    handleKvsAttempt(write, null, -1, "callback timeout", token);
  });
  Shelly.call("KVS.Set", params, function (result, code, message) {
    handleKvsAttempt(write, result, code, message, token);
  });
}
function processKvsWriteQueue() {
  if (kvsWriteInFlight || kvsWriteQueue.length === 0) return;
  let write = kvsWriteQueue[0];
  kvsWriteInFlight = true;
  performKvsAttempt(write);
}
function persistState(known, mode, op, callback, requestPhase) {
  persistenceDirty = true;
  let value = persistedValue(known, mode, op, requestPhase);
  if (JSON.stringify(value).length > 253) {
    durableModeKnown = false;
    persistenceFailure("KVS preflight", -2, "authoritative KVS value exceeds 253 bytes");
    Timer.set(0, false, function () { callback(false, "authoritative KVS value exceeds 253 bytes"); });
    return;
  }
  kvsWriteQueue.push({
    known: known,
    mode: mode,
    value: value,
    attempts: 0,
    refreshAttempts: 0,
    reconcileAttempts: 0,
    callback: callback
  });
  processKvsWriteQueue();
}
function persistUnknown(reason, op, callback) {
  modeKnown = false;
  durableModeKnown = false;
  setDirtyMarker(reason);
  setError("Atlas mode is uncertain: " + reason + ". Physically inspect it and call sync.");
  persistState(false, currentMode, op, function (ok, error) {
    if (!ok) setError("could not durably invalidate Atlas mode: " + error);
    callback(ok, error);
  });
}

function elapsedSince(startMs) {
  if (startMs === null) return null;
  let elapsed = uptimeMs() - startMs;
  return elapsed < 0 ? null : elapsed;
}
function remainingSafeOffMs() {
  let elapsed = elapsedSince(knownOffSinceMs);
  if (elapsed === null) return SAFE_NORMAL_OFF_MS;
  return elapsed >= SAFE_NORMAL_OFF_MS ? 0 : SAFE_NORMAL_OFF_MS - elapsed;
}

function recordRelayTransition(isOn, internal) {
  let previous = relayState;
  if (relayState === isOn) return;
  relayState = isOn;
  if (isOn) knownOffSinceMs = null;
  else knownOffSinceMs = uptimeMs();
  if (internal) return;

  relayGeneration += 1;
  log("observed external O1 transition to " + (isOn ? "ON" : "OFF") + "; generation " + relayGeneration);
  if (!isOn) {
    externalOffSinceMs = knownOffSinceMs;
    return;
  }
  let externalOffMs = elapsedSince(externalOffSinceMs);
  externalOffSinceMs = null;
  let unobservedOn = externalOffMs === null && (previous === false || previous === null);
  if (unobservedOn && !initialized) {
    startupRelayAmbiguous = true;
    log("observed O1 ON before the startup relay baseline was established");
    return;
  }
  if ((externalOffMs !== null && externalOffMs < SCENE_SWITCH_MAX_OFF_MS) || unobservedOn) {
    // A scene-changing operation will durably invalidate itself when the
    // generation change interrupts it. Normal power operations do not own
    // scene state, so their external short cycle must invalidate separately.
    if (!activeOperation || !activeOperation.sceneMutation) {
      let detail = externalOffMs === null ? "external OFF/ON duration was not observed" : "external short OFF/ON cycle of " + externalOffMs + " ms";
      persistUnknown(detail + " may have changed the scene", activeOperation, function () {});
    }
  }
}

function interruptActiveOperation(reason) {
  let op = activeOperation;
  if (!op || op.interrupted) return;
  op.interrupted = true;
  op.primaryError = reason;
  clearOperationTimer(op);
  expectedRelayState = null;
  expectedRelayOperationId = null;
  op.expectedRelayState = null;
  if (op.sceneMutation) {
    persistUnknown(reason, op, function () { finishOperation(op, false, reason); });
  } else {
    finishOperation(op, false, reason);
  }
}
function observeRelayEvent(isOn) {
  if (expectedRelayState === isOn && activeOperation && expectedRelayOperationId === activeOperation.id) {
    expectedRelayState = null;
    expectedRelayOperationId = null;
    activeOperation.expectedRelayState = null;
    recordRelayTransition(isOn, true);
    return;
  }
  expectedRelayState = null;
  expectedRelayOperationId = null;
  if (activeOperation) activeOperation.expectedRelayState = null;
  recordRelayTransition(isOn, false);
  if (activeOperation && activeOperation.relayGeneration !== relayGeneration) {
    interruptActiveOperation("unexpected external O1 transition during " + activeOperation.phase);
  }
}

function relayRpcCall(method, params, callback) {
  let completed = false;
  let timer = Timer.set(RELAY_RPC_TIMEOUT_MS, false, function () {
    if (completed) return;
    completed = true;
    callback(null, -1, method + " callback timeout");
  });
  Shelly.call(method, params, function (result, code, message) {
    if (completed) return;
    completed = true;
    Timer.clear(timer);
    callback(result, code, message);
  });
}
function getRelayState(callback) {
  relayRpcCall("Switch.GetStatus", { id: SWITCH_ID }, function (result, code, message) {
    if (code !== 0 || !result || typeof result.output !== "boolean") {
      callback(null, "Switch.GetStatus failed" + (message ? ": " + message : ""));
      return;
    }
    if (relayState === null) relayState = result.output;
    else if (relayState !== result.output) observeRelayEvent(result.output);
    callback(result.output, null);
  });
}
function getRelayStateNow() {
  try {
    let result = Shelly.getComponentStatus("switch", SWITCH_ID);
    if (!result || typeof result.output !== "boolean") {
      return { on: null, error: "Switch.GetStatus failed: component status is unavailable" };
    }
    if (relayState === null) relayState = result.output;
    else if (relayState !== result.output) observeRelayEvent(result.output);
    return { on: result.output, error: null };
  } catch (error) {
    return { on: null, error: "Switch.GetStatus failed: " + error.message };
  }
}
function seedRelayStateAtStartup() {
  try {
    let result = Shelly.getComponentStatus("switch", SWITCH_ID);
    if (result && typeof result.output === "boolean") {
      relayState = result.output;
      log("seeded startup O1 state as " + (relayState ? "ON" : "OFF"));
    } else {
      log("startup O1 state is unavailable; the first unobserved ON edge will invalidate the scene");
    }
  } catch (error) {
    log("startup O1 state could not be read; the first unobserved ON edge will invalidate the scene: " + error.message);
  }
}
function setRelay(op, on, callback) {
  if (!operationIsActive(op)) return;
  expectedRelayState = on;
  expectedRelayOperationId = op.id;
  op.expectedRelayState = on;
  relayRpcCall("Switch.Set", { id: SWITCH_ID, on: on }, function (result, code, message) {
    if (!operationIsActive(op)) return;
    if (code !== 0) {
      expectedRelayState = null;
      expectedRelayOperationId = null;
      op.expectedRelayState = null;
      callback(false, "Switch.Set(" + (on ? "on" : "off") + ") failed" + (message ? ": " + message : ""));
      return;
    }
    getRelayState(function (actualOn, stateError) {
      if (!operationIsActive(op)) return;
      expectedRelayState = null;
      expectedRelayOperationId = null;
      op.expectedRelayState = null;
      if (stateError) return callback(false, stateError);
      if (actualOn !== on) return callback(false, "relay verification expected " + (on ? "on" : "off") + " but found " + (actualOn ? "on" : "off"));
      recordRelayTransition(actualOn, true);
      callback(true, null);
    });
  });
}

function restorePowerSafely(op, callback) {
  op.phase = "reading_relay";
  getRelayState(function (isOn, error) {
    if (!operationIsActive(op)) return;
    if (error) return callback(false, error, false);
    if (isOn) {
      op.branch = "already_on";
      return callback(true, null, false);
    }
    op.branch = "restored_from_off";
    let waitMs = remainingSafeOffMs();
    function restoreNow() {
      op.phase = "verifying_restore";
      getRelayState(function (isOnNow, verifyError) {
        if (!operationIsActive(op)) return;
        if (verifyError) return callback(false, verifyError, false);
        if (isOnNow) return callback(true, null, false);
        setRelay(op, true, function (ok, setError) { callback(ok, setError, ok); });
      });
    }
    if (waitMs === 0) return restoreNow();
    log("O1 is off; waiting remaining " + waitMs + " ms before normal restore");
    scheduleOperation(op, waitMs, "waiting_safe_restore", restoreNow);
  });
}

function recoverRelayOn(op, primaryError, callback) {
  if (!operationIsActive(op)) return;
  op.primaryError = primaryError;
  op.phase = "recovering_relay_on";
  setRelay(op, true, function (ok, error) {
    if (!ok) op.recoveryError = error;
    callback();
  });
}
function failSceneOperation(op, message, recover) {
  op.primaryError = message;
  function finishFailed() {
    persistUnknown(message, op, function () {
      finishOperation(op, false, message + (op.recoveryError ? "; recovery failed: " + op.recoveryError : ""));
    });
  }
  if (recover) recoverRelayOn(op, message, finishFailed);
  else finishFailed();
}

function runSinglePulse(op, offMs, done) {
  op.phase = "pulse_off";
  setRelay(op, false, function (ok, error) {
    if (!operationIsActive(op)) return;
    if (!ok) return failSceneOperation(op, "could not confirm O1 OFF during a mode pulse: " + error, true);
    scheduleOperation(op, offMs, "pulse_off_wait", function () {
      op.phase = "pulse_on";
      setRelay(op, true, function (onOk, onError) {
        if (!operationIsActive(op)) return;
        if (!onOk) return failSceneOperation(op, "could not confirm O1 ON during a mode pulse: " + onError, true);
        done(true, null);
      });
    });
  });
}
function runModePulses(op, remaining, isPrimer, offMs, onSettleMs, done) {
  if (!operationIsActive(op)) return;
  if (remaining === 0) return done(true, null);
  op.pulseIndex += 1;
  runSinglePulse(op, offMs, function (ok, error) {
    if (!operationIsActive(op)) return;
    if (!ok) return done(false, error);
    if (isPrimer) log("verified primer pulse; working scene remains " + op.workingMode);
    else {
      op.workingMode = (op.workingMode + 1) % 3;
      log("verified scene pulse; working scene is now " + op.workingMode);
    }
    if (remaining === 1) {
      return scheduleOperation(op, FINAL_ON_SETTLE_MS, "final_on_settle", function () { done(true, null); });
    }
    scheduleOperation(op, onSettleMs, "between_pulses", function () {
      runModePulses(op, remaining - 1, false, offMs, onSettleMs, done);
    });
  });
}

function commitSceneOperation(op) {
  op.phase = "committing_scene";
  if (op.workingMode !== op.targetMode) return failSceneOperation(op, "internal scene calculation ended at " + op.workingMode + " instead of " + op.targetMode, false);
  persistState(true, op.targetMode, op, function (saved, error) {
    if (!operationIsActive(op)) return;
    if (!saved) {
      modeKnown = false;
      return finishOperation(op, false, "physical pulses completed but final scene commit failed: " + error);
    }
    currentMode = op.targetMode;
    modeKnown = true;
    finishOperation(op, true, "target scene " + currentMode + " (" + modeLabel(currentMode) + ") reached, settled, and persisted");
  });
}
function persistPowerRequest(op, phase, callback) {
  persistState(modeKnown && durableModeKnown, currentMode, op, callback, phase);
}
function completePowerOperation(op, successMessage) {
  if (op.requestId === null) return finishOperation(op, true, successMessage);
  op.phase = "committing_power_request";
  persistPowerRequest(op, "d", function (saved, error) {
    if (!operationIsActive(op)) return;
    if (!saved) return finishOperation(op, false, "physical power action succeeded but request commit failed: " + error);
    finishOperation(op, true, successMessage);
  });
}
function startPowerIntent(op, callback) {
  if (op.requestId === null) return callback(true, null);
  op.phase = "persisting_power_intent";
  persistPowerRequest(op, "i", callback);
}

function startSetMode(target, name, command, requestId) {
  let readiness = readyError();
  if (readiness) return { error: readiness };
  let started = beginOperation(name, command, target, requestId);
  if (started.error) return started;
  let op = started.operation;
  let steps = (target - currentMode + 3) % 3;
  op.sceneMutation = steps > 0;

  function continueWithPower() {
    restorePowerSafely(op, function (powerOk, powerError, restoredFromOff) {
      if (!operationIsActive(op)) return;
      if (!powerOk) {
        if (op.sceneMutation) return failSceneOperation(op, "could not restore/read O1: " + powerError, false);
        return finishOperation(op, false, "could not restore/read O1: " + powerError);
      }
      if (steps === 0) return completePowerOperation(op, "O1 is on; target scene " + currentMode + " already selected");
      let offMs = restoredFromOff ? OFF_STATE_PULSE_OFF_MS : ON_STATE_PULSE_OFF_MS;
      let onMs = restoredFromOff ? OFF_STATE_PULSE_ON_SETTLE_MS : ON_STATE_PULSE_ON_SETTLE_MS;
      op.pulseCount = steps + (restoredFromOff ? 0 : 1);
      runModePulses(op, op.pulseCount, !restoredFromOff, offMs, onMs, function (ok, error) {
        if (!operationIsActive(op)) return;
        if (!ok) return failSceneOperation(op, error, false);
        commitSceneOperation(op);
      });
    });
  }

  if (!op.sceneMutation) {
    startPowerIntent(op, function (saved, error) {
      if (!operationIsActive(op)) return;
      if (!saved) return finishOperation(op, false, "refusing power restore because request intent failed: " + error);
      continueWithPower();
    });
    return started;
  }
  op.phase = "invalidating_persisted_scene";
  if (!setDirtyMarker(preMutationMarker(op))) {
    finishOperation(op, false, "refusing to pulse because the durable dirty marker could not be written");
    return { error: "durable dirty marker could not be written; no relay pulse was sent" };
  }
  modeKnown = false;
  durableModeKnown = false;
  persistState(false, currentMode, op, function (saved, error) {
    if (!operationIsActive(op)) return;
    if (!saved) return finishOperation(op, false, "refusing to pulse because durable invalidation failed: " + error);
    continueWithPower();
  });
  return started;
}

function startNormalOn(requestId) {
  let started = beginOperation("normal_on", "on", null, requestId);
  if (started.error) return started;
  let op = started.operation;
  startPowerIntent(op, function (saved, intentError) {
    if (!operationIsActive(op)) return;
    if (!saved) return finishOperation(op, false, "refusing O1 ON because request intent failed: " + intentError);
    restorePowerSafely(op, function (ok, error) {
      if (!operationIsActive(op)) return;
      if (!ok) return finishOperation(op, false, error);
      completePowerOperation(op, "O1 is on; tracked scene is unchanged");
    });
  });
  return started;
}
function startNormalOff(requestId) {
  let started = beginOperation("normal_off", "off", null, requestId);
  if (started.error) return started;
  let op = started.operation;
  startPowerIntent(op, function (saved, intentError) {
    if (!operationIsActive(op)) return;
    if (!saved) return finishOperation(op, false, "refusing O1 OFF because request intent failed: " + intentError);
    op.phase = "reading_relay";
    getRelayState(function (isOn, error) {
      if (!operationIsActive(op)) return;
      if (error) return finishOperation(op, false, error);
      if (!isOn) return completePowerOperation(op, "O1 was already off; original off timer retained");
      op.phase = "normal_off";
      setRelay(op, false, function (ok, setError) {
        if (!operationIsActive(op)) return;
        if (!ok) return finishOperation(op, false, setError);
        completePowerOperation(op, "O1 is off; tracked scene is unchanged");
      });
    });
  });
  return started;
}
function startDiagnosticPulse(offMs, requestId) {
  let readiness = readyError();
  if (readiness) return { error: readiness };
  let started = beginOperation("diagnostic_pulse_" + offMs + "ms", "diagnostic_pulse:" + offMs, null, requestId);
  if (started.error) return started;
  let op = started.operation;
  op.sceneMutation = true;
  op.phase = "invalidating_persisted_scene";
  if (!setDirtyMarker(preMutationMarker(op))) {
    finishOperation(op, false, "refusing diagnostic pulse because the durable dirty marker could not be written");
    return { error: "durable dirty marker could not be written; no diagnostic pulse was sent" };
  }
  modeKnown = false;
  durableModeKnown = false;
  persistState(false, currentMode, op, function (saved, error) {
    if (!operationIsActive(op)) return;
    if (!saved) return finishOperation(op, false, "refusing diagnostic pulse because durable invalidation failed: " + error);
    restorePowerSafely(op, function (powerOk, powerError) {
      if (!operationIsActive(op)) return;
      if (!powerOk) return finishOperation(op, false, "could not restore/read O1: " + powerError);
      op.pulseCount = 1;
      op.pulseIndex = 1;
      runSinglePulse(op, offMs, function () {
        if (operationIsActive(op)) finishOperation(op, true, "diagnostic pulse completed; sync the observed scene before another scene command");
      });
    });
  });
  return started;
}
function startSync(mode, requestId) {
  let started = beginOperation("sync_" + mode, "sync:" + mode, mode, requestId);
  if (started.error) return started;
  let op = started.operation;
  op.phase = "persisting_sync";
  if (!setDirtyMarker(preMutationMarker(op))) {
    finishOperation(op, false, "scene was not synchronized because the durable dirty marker could not be written");
    return { error: "durable dirty marker could not be written; scene was not synchronized" };
  }
  persistState(true, mode, op, function (saved, error) {
    if (!operationIsActive(op)) return;
    if (!saved) {
      modeKnown = false;
      return finishOperation(op, false, "scene was not synchronized because persistence failed: " + error);
    }
    currentMode = mode;
    modeKnown = true;
    finishOperation(op, true, "scene synchronized to " + mode + " (" + modeLabel(mode) + ")");
  });
  return started;
}

function statusObject(relayOn, relayError) {
  let dirtyMarker = hasDirtyMarker();
  return {
    switch_id: SWITCH_ID, relay_on: relayOn, relay_error: relayError,
    mode: currentMode, scene: modeLabel(currentMode), mode_known: modeKnown,
    durable_mode_known: durableModeKnown,
    persistent: modeKnown && durableModeKnown && !persistenceDirty && !safetyDegraded && !dirtyMarker,
    persistence_dirty: persistenceDirty, initialized: initialized,
    busy: activeOperation !== null,
    active_operation: activeOperation ? activeOperation.name : null,
    operation: operationSnapshot(activeOperation), last_operation: lastOperation,
    last_error: lastError, relay_generation: relayGeneration,
    persistence: {
      queue_depth: kvsWriteQueue.length,
      write_in_flight: kvsWriteInFlight,
      last_write_ok: lastKvsWriteOk,
      dirty_marker: dirtyMarker,
      safety_degraded: safetyDegraded,
      request_history_persistent: requestHistoryPersistent,
      request_history_degraded: requestHistoryDegraded,
      request_history_error: lastHistoryError,
      last_error: lastPersistenceError
    },
    timing_ms: {
      already_on: { pulse_off: ON_STATE_PULSE_OFF_MS, pulse_on_settle: ON_STATE_PULSE_ON_SETTLE_MS, primer: true },
      restored_from_off: { pulse_off: OFF_STATE_PULSE_OFF_MS, pulse_on_settle: OFF_STATE_PULSE_ON_SETTLE_MS, primer: false },
      final_on_settle: FINAL_ON_SETTLE_MS,
      scene_switch_max_off: SCENE_SWITCH_MAX_OFF_MS,
      safe_normal_off: SAFE_NORMAL_OFF_MS,
      operation_timeout: OPERATION_TIMEOUT_MS,
      relay_rpc_timeout: RELAY_RPC_TIMEOUT_MS,
      kvs_retry: KVS_RETRY_MS,
      kvs_max_attempts: KVS_MAX_ATTEMPTS,
      off_duration_known: knownOffSinceMs !== null,
      restore_wait_remaining: relayOn === false ? remainingSafeOffMs() : (relayOn === true ? 0 : null)
    }
  };
}
function replyStatus(request) {
  let relay = getRelayStateNow();
  request.result(statusObject(relay.on, relay.error));
}
function commandSignature(command, params) {
  if (command === "set" || command === "sync") return command + ":" + params.mode;
  if (command === "diagnostic_pulse") return command + ":" + params.off_ms;
  return command;
}
function duplicateRequestResult(requestId, signature) {
  if (requestId === undefined) return null;
  let remembered = null;
  for (let i = requestHistory.length - 1; i >= 0; i--) {
    if (requestHistory[i].id === requestId) {
      remembered = requestHistory[i];
      break;
    }
  }
  if (remembered === null) return null;
  if (signature !== remembered.command) {
    return { conflict: true, error: "request_id was already used for " + remembered.command };
  }
  if (requestHistoryDegraded) {
    return {
      accepted: false, duplicate: true, request_id: requestId,
      command: remembered.command, operation_id: remembered.operation_id,
      busy: false, outcome: "unknown",
      message: "request history integrity is degraded; the recorded outcome cannot be trusted",
      mode: currentMode, mode_known: modeKnown
    };
  }
  return {
    accepted: remembered.outcome !== "failed" && remembered.outcome !== "unknown",
    duplicate: true, request_id: requestId,
    command: remembered.command, operation_id: remembered.operation_id,
    busy: activeOperation !== null && activeOperation.id === remembered.operation_id,
    outcome: remembered.outcome,
    message: remembered.message,
    mode: currentMode, mode_known: modeKnown
  };
}

Script.addRpcHandler("AtlasStatus", function (request, params) { replyStatus(request); });
Script.addRpcHandler("AtlasCommand", function (request, params) {
  let command = params.command;
  let requestId = params.request_id;
  if (!validRequestId(requestId)) return request.error(400, "request_id must contain 1-64 letters, digits, dots, underscores, colons, or hyphens");
  if (command === "status") return replyStatus(request);
  if (command === "reset_request_history") {
    if (params.confirm !== true) return request.error(400, "reset_request_history requires confirm:true");
    if (!initialized) return request.error(409, "controller is still loading KVS state");
    if (activeOperation || kvsWriteInFlight || kvsWriteQueue.length > 0) return request.error(409, "controller persistence is busy");
    let reset = resetRequestHistory();
    if (reset.error) return request.error(409, reset.error);
    return request.result(reset);
  }
  if (command === "next" && requestId === undefined) return request.error(400, "next requires request_id for retry safety");
  let signature = commandSignature(command, params);
  let duplicate = duplicateRequestResult(requestId, signature);
  if (duplicate !== null) {
    if (duplicate.conflict) return request.error(409, duplicate.error);
    return request.result(duplicate);
  }

  let started;
  if (command === "next") {
    let readiness = readyError();
    started = readiness ? { error: readiness } : startSetMode((currentMode + 1) % 3, "next", signature, requestId);
  } else if (command === "set") {
    started = validMode(params.mode) ? startSetMode(params.mode, "set_" + params.mode, signature, requestId) : { error: "set requires integer scene 0, 1, or 2" };
  } else if (command === "on") started = startNormalOn(requestId);
  else if (command === "off") started = startNormalOff(requestId);
  else if (command === "diagnostic_pulse") {
    started = validDiagnosticPulseMs(params.off_ms) ? startDiagnosticPulse(params.off_ms, requestId) : { error: "diagnostic_pulse requires integer off_ms from 100 through 4500" };
  } else if (command === "sync") {
    started = validMode(params.mode) ? startSync(params.mode, requestId) : { error: "sync requires integer scene 0, 1, or 2" };
  } else started = { error: "unknown command; use status, next, set, on, off, diagnostic_pulse, sync, or reset_request_history" };

  if (started.error) return request.error(409, started.error);
  request.result({
    accepted: true, duplicate: false,
    request_id: requestId === undefined ? null : requestId,
    command: command, operation_id: started.operation.id,
    mode: currentMode, mode_known: modeKnown
  });
});

Shelly.addEventHandler(function (event) {
  if (event.component === "switch:" + SWITCH_ID && event.info && typeof event.info.state === "boolean") {
    observeRelayEvent(event.info.state);
  }
});

function loadRequestHistory() {
  requestHistory = [];
  try {
    let raw = Script.storage.getItem(STORAGE_HISTORY_KEY);
    if (raw === null) return;
    let saved = JSON.parse(raw);
    if (!isStoredArray(saved) || saved.length > REQUEST_HISTORY_LIMIT) {
      requestHistoryPersistent = false;
      requestHistoryDegraded = true;
      setHistoryError("stored request history has an invalid container");
      return;
    }
    for (let i = 0; i < saved.length; i++) {
      let item = saved[i];
      let validOutcome = item && (item[2] === "ok" || item[2] === "failed" || item[2] === "pending" || item[2] === "unknown");
      if (!isStoredArray(item) || item.length !== 3 || typeof item[0] !== "string" || !validRequestId(item[0]) || !validStoredCommand(item[1]) || !validOutcome) {
        requestHistory = [];
        requestHistoryPersistent = false;
        requestHistoryDegraded = true;
        setHistoryError("stored request history contains an invalid entry");
        return;
      }
      for (let previous = 0; previous < requestHistory.length; previous++) {
        if (requestHistory[previous].id === item[0]) {
          requestHistory = [];
          requestHistoryPersistent = false;
          requestHistoryDegraded = true;
          setHistoryError("stored request history contains a duplicate request_id");
          return;
        }
      }
      requestHistory.push({ id: item[0], command: item[1], operation_id: null, outcome: item[2], message: null });
    }
  } catch (error) {
    requestHistoryPersistent = false;
    requestHistoryDegraded = true;
    setHistoryError("could not load Script.storage request history: " + error.message);
  }
}
function resetRequestHistory() {
  let previousHistoryError = lastHistoryError;
  let reset = [];
  if (lastRequestId !== null && lastRequestCommand !== null) {
    let retainedOutcome = modeKnown && durableModeKnown && lastRequestPhase !== "i" ? "ok" : "unknown";
    if (unresolvedPowerIntent(modeKnown)) {
      let relay = getRelayStateNow();
      if (lastRequestCommand === "off" && !relay.error && relay.on === false) retainedOutcome = "ok";
    }
    reset.push({
      id: lastRequestId, command: lastRequestCommand,
      operation_id: lastRequestOperationId,
      outcome: retainedOutcome, message: null
    });
  }
  if (!persistRequestHistory(reset)) return { error: "request history could not be reset" };
  requestHistory = reset;
  retryablePendingRequestIds = [];
  requestHistoryDegraded = false;
  lastHistoryError = null;
  if (lastError === previousHistoryError) lastError = null;
  return {
    reset: true,
    retained_request_id: lastRequestId,
    retained_request_command: lastRequestCommand,
    warning: "previous retry history was discarded; do not retry older request IDs"
  };
}
function isPowerIntentCommand(command, kvsKnown) {
  if (command === "on" || command === "off") return true;
  if (!kvsKnown || typeof command !== "string" || command.indexOf("set:") !== 0) return false;
  return Number(command.slice(4)) === currentMode;
}
function unresolvedPowerIntent(kvsKnown) {
  return lastRequestPhase === "i" && lastRequestId !== null &&
    isPowerIntentCommand(lastRequestCommand, kvsKnown);
}
function reconcileRequestHistoryWithState(kvsKnown) {
  retryablePendingRequestIds = [];
  let reconciled = [];
  let changed = false;
  for (let i = 0; i < requestHistory.length; i++) {
    let item = requestHistory[i];
    if (item.outcome === "pending") {
      if (item.id !== lastRequestId) {
        // The authoritative KVS record proves this request never crossed the
        // pre-mutation durability boundary, so the same ID is retryable.
        retryablePendingRequestIds.push(item.id);
        changed = true;
        continue;
      }
      if (item.command !== lastRequestCommand) {
        item.outcome = "unknown";
        requestHistoryDegraded = true;
        requestHistoryPersistent = false;
        setHistoryError("KVS request command conflicts with stored request history for " + item.id);
      } else {
        if (!unresolvedPowerIntent(kvsKnown)) item.outcome = kvsKnown ? "ok" : "unknown";
      }
      if (item.outcome !== "pending") changed = true;
    }
    reconciled.push(item);
  }
  requestHistory = reconciled;
  if (lastRequestId === null || lastRequestCommand === null) {
    if (changed && !requestHistoryDegraded) persistRequestHistory(requestHistory);
    return;
  }
  for (let i = requestHistory.length - 1; i >= 0; i--) {
    if (requestHistory[i].id === lastRequestId) {
      if (requestHistory[i].command !== lastRequestCommand) {
        requestHistory[i].outcome = "unknown";
        requestHistory[i].message = "KVS request command conflicts with stored request history";
        requestHistoryDegraded = true;
        requestHistoryPersistent = false;
        setHistoryError("KVS request command conflicts with stored request history for " + lastRequestId);
        return;
      }
      requestHistory[i].operation_id = lastRequestOperationId;
      if (requestHistory[i].outcome === "unknown" && kvsKnown && !unresolvedPowerIntent(kvsKnown)) {
        requestHistory[i].outcome = "ok";
        changed = true;
      }
      if (changed && !requestHistoryDegraded) persistRequestHistory(requestHistory);
      return;
    }
  }
  requestHistory.push({
    id: lastRequestId, command: lastRequestCommand,
    operation_id: lastRequestOperationId,
    outcome: unresolvedPowerIntent(kvsKnown) ? "pending" : (kvsKnown ? "ok" : "unknown"),
    message: null
  });
  if (requestHistory.length > REQUEST_HISTORY_LIMIT) {
    for (let i = 1; i < requestHistory.length; i++) requestHistory[i - 1] = requestHistory[i];
    requestHistory.pop();
  }
  if (!requestHistoryDegraded) persistRequestHistory(requestHistory);
}
function resolveStartupPowerIntent(kvsKnown) {
  if (!unresolvedPowerIntent(kvsKnown) || requestHistoryDegraded) return;
  let index = -1;
  for (let i = requestHistory.length - 1; i >= 0; i--) {
    if (requestHistory[i].id === lastRequestId && requestHistory[i].command === lastRequestCommand) {
      index = i;
      break;
    }
  }
  if (index < 0 || requestHistory[index].outcome !== "pending") return;
  let relay = getRelayStateNow();
  if (relay.error) {
    requestHistory[index].outcome = "unknown";
    requestHistory[index].message = "startup could not resolve interrupted power request: " + relay.error;
    persistRequestHistory(requestHistory);
    return;
  }
  let expectedOn = lastRequestCommand !== "off";
  if (relay.on === expectedOn) {
    if (expectedOn) {
      requestHistory[index].outcome = "unknown";
      requestHistory[index].message = "interrupted power restoration found O1 ON but cannot prove that the scene-safe interval was preserved";
      persistRequestHistory(requestHistory);
      modeKnown = false;
      durableModeKnown = false;
      persistenceDirty = true;
      setDirtyMarker("interrupted power restoration may have changed the scene");
      log("interrupted power restoration " + lastRequestId + " is ambiguous; scene synchronization is required");
      return;
    }
    requestHistory[index].outcome = "ok";
    requestHistory[index].message = "interrupted power request resolved from relay state at startup";
    lastRequestPhase = "d";
    persistRequestHistory(requestHistory);
    log("resolved interrupted power request " + lastRequestId + " as completed");
    return;
  }
  for (let i = index + 1; i < requestHistory.length; i++) requestHistory[i - 1] = requestHistory[i];
  requestHistory.pop();
  retryablePendingRequestIds.push(lastRequestId);
  persistRequestHistory(requestHistory);
  log("interrupted power request " + lastRequestId + " did not reach its relay state and is retryable");
}
function applyStartupRelayAmbiguity() {
  if (!startupRelayAmbiguous) return;
  startupRelayAmbiguous = false;
  modeKnown = false;
  durableModeKnown = false;
  persistenceDirty = true;
  setDirtyMarker("O1 turned ON before the startup relay baseline was established");
  log("startup O1 transition was ambiguous; forcing uncertain scene state");
}
function loadRequestTuple(value) {
  let requestId = typeof value.r === "string" ? value.r : "";
  let requestCommand = typeof value.c === "string" ? value.c : "";
  let operationId = typeof value.o === "string" ? value.o : "";
  let phase = typeof value.p === "string" ? value.p : "";
  if (requestId.length === 0 && requestCommand.length === 0 && operationId.length === 0) {
    if (phase.length !== 0) {
      requestHistoryPersistent = false;
      requestHistoryDegraded = true;
      setHistoryError("authoritative KVS contains a request phase without a request metadata tuple");
    }
    lastRequestId = null;
    lastRequestCommand = null;
    lastRequestOperationId = null;
    lastRequestPhase = null;
    return;
  }
  // Schema-5 records written before request phases were introduced are still
  // valid: known state proves completion, while uncertain state is an intent.
  if (phase.length === 0) phase = value.k === 1 ? "d" : "i";
  if (!validRequestId(requestId) || !validStoredCommand(requestCommand) || !validRequestId(operationId) || (phase !== "i" && phase !== "d")) {
    lastRequestId = null;
    lastRequestCommand = null;
    lastRequestOperationId = null;
    lastRequestPhase = null;
    requestHistoryPersistent = false;
    requestHistoryDegraded = true;
    setHistoryError("authoritative KVS contains an invalid request metadata tuple");
    return;
  }
  lastRequestId = requestId;
  lastRequestCommand = requestCommand;
  lastRequestOperationId = operationId;
  lastRequestPhase = phase;
}
function loadMode() {
  Shelly.call("KVS.Get", { key: KVS_KEY }, function (result, code, message) {
    initialized = true;
    loadRequestHistory();
    if (code === 0 && result && typeof result.etag === "string") {
      stateEtag = result.etag;
      stateEtagKnown = true;
    } else if (code === -105) {
      stateEtag = null;
      stateEtagKnown = true;
    }
    if (code === 0 && result && result.value && result.value.s === KVS_SCHEMA && validMode(result.value.m)) {
      currentMode = result.value.m;
      modeKnown = result.value.k === 1;
      durableModeKnown = modeKnown;
      loadRequestTuple(result.value);
      reconcileRequestHistoryWithState(modeKnown);
      resolveStartupPowerIntent(modeKnown);
      applyStartupRelayAmbiguity();
      clearProvenSafePreMutationMarker();
      if (hasDirtyMarker()) {
        modeKnown = false;
        durableModeKnown = false;
        persistenceDirty = true;
        log("durable dirty marker found; forcing uncertain scene state");
        persistState(false, currentMode, null, function (saved, error) {
          if (!saved) setError("startup uncertainty repair failed: " + error);
        });
        return;
      }
      log(modeKnown ? "restored persistent known scene " + currentMode : "restored durable uncertain scene state; sync required");
      return;
    }
    currentMode = 0;
    modeKnown = false;
    durableModeKnown = false;
    persistenceDirty = hasDirtyMarker();
    reconcileRequestHistoryWithState(false);
    applyStartupRelayAmbiguity();
    clearProvenSafePreMutationMarker();
    persistenceDirty = hasDirtyMarker();
    log("no valid schema-5 state; visually identify the scene, then call sync");
  });
}

seedRelayStateAtStartup();
loadMode();
log("controller started for switch:0; O2 is untouched");
