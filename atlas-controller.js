// Memory-bounded Philips Atlas controller for switch:0. switch:1 is untouched.
let SWITCH_ID = 0;
let KVS_KEY = "atlas_mode";
let KVS_SCHEMA = 5;
let DIRTY_KEY = "dirty";
let ON_PULSE_OFF_MS = 150;
let ON_PULSE_WAIT_MS = 250;
let OFF_PULSE_OFF_MS = 500;
let OFF_PULSE_WAIT_MS = 500;
let FINAL_SETTLE_MS = 2500;
let SAFE_OFF_MS = 12000;
let SCENE_OFF_MAX_MS = 8000;
let RPC_TIMEOUT_MS = 5000;
let OPERATION_TIMEOUT_MS = 120000;

let mode = 0;
let known = false;
let durableKnown = false;
let initialized = false;
let relayOn = null;
let offSince = null;
let expectedRelay = null;
let operation = null;
let operationCounter = 0;
let relayCallCounter = 0;
let lastOperation = null;
let lastError = null;
let saveBusy = false;
let saveToken = 0;
let saveTimer = null;
let saveCallback = null;
let saveKnown = false;
let pendingUnknown = false;

function requireVirtual(key) {
  let handle = Virtual.getHandle(key);
  if (!handle) throw new Error("required virtual component is missing: " + key);
  return handle;
}
let cloudScene = requireVirtual("enum:200");
let cloudApply = requireVirtual("button:200");
let cloudConfirm = requireVirtual("button:201");
let cloudOff = requireVirtual("button:202");
let cloudOn = requireVirtual("button:203");
let selectedMode = 0;

function log(message) { print("[atlas] " + message); }
function now() { return Shelly.getUptimeMs(); }
function validMode(value) { return typeof value === "number" && value >= 0 && value <= 2 && Math.floor(value) === value; }
function modeName(value) {
  if (value === 0) return "Bright";
  if (value === 1) return "Cool";
  if (value === 2) return "Warm";
  return "Unknown";
}
function modeLabel(value) {
  if (value === 0) return "4000K / 100%";
  if (value === 1) return "6500K / 50%";
  if (value === 2) return "2700K / 50%";
  return "unknown";
}
function setError(message) { lastError = message; log("ERROR: " + message); }
function readRelay() {
  try {
    let status = Shelly.getComponentStatus("switch", SWITCH_ID);
    if (status && typeof status.output === "boolean") return { on: status.output, error: null };
  } catch (error) { return { on: null, error: error.message }; }
  return { on: null, error: "switch:0 status is unavailable" };
}
function recordRelay(value) {
  if (relayOn === value) return;
  relayOn = value;
  if (value) offSince = null;
  else offSince = now();
}
function remainingSafeOff() {
  if (offSince === null) return SAFE_OFF_MS;
  let elapsed = now() - offSince;
  if (elapsed < 0) return SAFE_OFF_MS;
  return elapsed >= SAFE_OFF_MS ? 0 : SAFE_OFF_MS - elapsed;
}
function setDirty(reason) {
  try { Script.storage.setItem(DIRTY_KEY, reason || "unknown"); return true; }
  catch (error) { setError("could not persist uncertainty marker: " + error.message); return false; }
}
function clearDirty() {
  try { Script.storage.removeItem(DIRTY_KEY); return true; }
  catch (error) { setError("could not clear uncertainty marker: " + error.message); return false; }
}
function hasDirty() {
  try { return Script.storage.getItem(DIRTY_KEY) !== null; }
  catch (error) { setError("could not read uncertainty marker: " + error.message); return true; }
}

function saveTimeout() {
  if (!saveBusy) return;
  let callback = saveCallback;
  saveBusy = false;
  saveCallback = null;
  saveTimer = null;
  saveToken += 1;
  durableKnown = false;
  setError("KVS.Set callback timeout");
  if (callback) callback(false, "KVS.Set callback timeout");
  flushPendingUnknown();
}
function saveDone(result, code, message, token) {
  if (!saveBusy || token !== saveToken) return;
  Timer.clear(saveTimer);
  saveTimer = null;
  saveBusy = false;
  let callback = saveCallback;
  saveCallback = null;
  if (code === 0) durableKnown = saveKnown;
  else {
    durableKnown = false;
    setError("KVS.Set failed" + (message ? ": " + message : ""));
  }
  if (callback) callback(code === 0, code === 0 ? null : "KVS.Set failed" + (message ? ": " + message : ""));
  flushPendingUnknown();
}
function saveState(valueKnown, valueMode, callback) {
  if (saveBusy) return false;
  saveBusy = true;
  saveKnown = valueKnown;
  saveCallback = callback;
  saveToken += 1;
  let token = saveToken;
  saveTimer = Timer.set(RPC_TIMEOUT_MS, false, saveTimeout);
  Shelly.call("KVS.Set", { key: KVS_KEY, value: { s: KVS_SCHEMA, k: valueKnown ? 1 : 0, m: valueMode } }, saveDone, token);
  return true;
}
function unknownSaved(ok, error) { if (!ok) setError("could not persist uncertain scene: " + error); }
function flushPendingUnknown() {
  if (!pendingUnknown || saveBusy) return;
  pendingUnknown = false;
  if (!saveState(false, mode, unknownSaved)) pendingUnknown = true;
}
function markUnknown(reason) {
  known = false;
  durableKnown = false;
  setDirty(reason);
  pendingUnknown = true;
  setError("scene is uncertain: " + reason + "; inspect it and use Confirm observed");
  flushPendingUnknown();
}

function operationSnapshot(value) {
  if (!value) return null;
  return {
    id: value.id, command: value.command, phase: value.phase,
    target_mode: value.target, pulse_index: value.pulseIndex,
    pulse_count: value.pulseCount, ok: value.ok, message: value.message
  };
}
function beginOperation(command, target, sceneMutation) {
  if (!initialized) return { error: "controller is still loading scene state" };
  if (operation) return { error: "controller is busy with " + operation.command };
  if (saveBusy) return { error: "controller persistence is busy" };
  operationCounter += 1;
  operation = {
    id: "op-" + now() + "-" + operationCounter,
    command: command, target: target, sceneMutation: sceneMutation,
    phase: "starting", timer: null, watchdog: null, desired: null, relayToken: 0,
    working: mode, remaining: 0, primer: false,
    pulseOffMs: 0, pulseWaitMs: 0, pulseIndex: 0, pulseCount: 0,
    ok: null, message: null
  };
  operation.watchdog = Timer.set(OPERATION_TIMEOUT_MS, false, operationWatchdog);
  lastError = null;
  return { operation: operation };
}
function clearOperationTimer() {
  if (operation && operation.timer !== null) {
    Timer.clear(operation.timer);
    operation.timer = null;
  }
}
function clearOperationWatchdog() {
  if (operation && operation.watchdog !== null) {
    Timer.clear(operation.watchdog);
    operation.watchdog = null;
  }
}
function operationWatchdog() {
  if (!operation) return;
  operation.watchdog = null;
  let reason = "operation watchdog expired during " + operation.phase;
  if (operation.sceneMutation) markUnknown(reason);
  finishOperation(false, reason);
}
function finishOperation(ok, message) {
  if (!operation) return;
  clearOperationTimer();
  clearOperationWatchdog();
  expectedRelay = null;
  operation.phase = "completed";
  operation.ok = ok;
  operation.message = message;
  lastOperation = operationSnapshot(operation);
  if (!ok) setError(message);
  else log(message);
  operation = null;
}
function scheduleOperation(delay, phase) {
  if (!operation) return;
  clearOperationTimer();
  operation.phase = phase;
  operation.timer = Timer.set(delay, false, operationTimerDone);
}
function operationTimerDone() {
  if (!operation) return;
  operation.timer = null;
  if (operation.phase === "safe_on_wait") return restorePowerNow();
  if (operation.phase === "pulse_off_wait") return callRelay(true, "pulse_on");
  if (operation.phase === "between_pulses") return startPulse();
  if (operation.phase === "final_settle") return persistFinalScene();
}
function relayTimeout() {
  if (!operation) return;
  operation.timer = null;
  expectedRelay = null;
  let phase = operation.phase;
  let desired = operation.desired;
  operation.relayToken = 0;
  let relay = readRelay();
  if (!relay.error && relay.on === desired) {
    log("recovered lost Switch.Set callback during " + phase);
    return relayPhaseSucceeded(desired, phase);
  }
  if (operation.sceneMutation) markUnknown("relay callback timeout during " + phase);
  finishOperation(false, "relay callback timeout during " + phase);
}
function callRelay(value, phase) {
  if (!operation) return;
  clearOperationTimer();
  operation.phase = phase;
  operation.desired = value;
  expectedRelay = value;
  relayCallCounter += 1;
  operation.relayToken = relayCallCounter;
  operation.timer = Timer.set(RPC_TIMEOUT_MS, false, relayTimeout);
  Shelly.call("Switch.Set", { id: SWITCH_ID, on: value }, relaySetDone, operation.relayToken);
}
function relayPhaseSucceeded(desired, phase) {
  if (!operation) return;
  recordRelay(desired);
  if (phase === "normal_off") return finishOperation(true, "O1 is off; tracked scene is unchanged");
  if (phase === "restore_on") return powerRestored();
  if (phase === "pulse_off") return scheduleOperation(operation.pulseOffMs, "pulse_off_wait");
  if (phase === "pulse_on") return pulseCompleted();
}
function relaySetDone(result, code, message, relayToken) {
  if (!operation || operation.relayToken !== relayToken) return;
  clearOperationTimer();
  let desired = operation.desired;
  let phase = operation.phase;
  operation.relayToken = 0;
  expectedRelay = null;
  if (code !== 0) {
    if (operation.sceneMutation) markUnknown("Switch.Set failed during " + phase);
    return finishOperation(false, "Switch.Set failed" + (message ? ": " + message : ""));
  }
  let relay = readRelay();
  if (relay.error || relay.on !== desired) {
    if (operation.sceneMutation) markUnknown("relay verification failed during " + phase);
    return finishOperation(false, relay.error || "relay verification failed");
  }
  relayPhaseSucceeded(desired, phase);
}

function restorePowerNow() {
  if (!operation) return;
  let relay = readRelay();
  if (relay.error) return finishOperation(false, relay.error);
  if (relay.on) { recordRelay(true); return powerRestored(); }
  callRelay(true, "restore_on");
}
function powerRestored() {
  if (!operation) return;
  if (operation.command === "on" || operation.command === "set_same") return finishOperation(true, "O1 is on; tracked scene is unchanged");
  startPulse();
}
function startPulse() {
  if (!operation) return;
  operation.pulseIndex += 1;
  callRelay(false, "pulse_off");
}
function pulseCompleted() {
  if (!operation) return;
  operation.remaining -= 1;
  if (operation.primer) operation.primer = false;
  else operation.working = (operation.working + 1) % 3;
  if (operation.remaining === 0) return scheduleOperation(FINAL_SETTLE_MS, "final_settle");
  scheduleOperation(operation.pulseWaitMs, "between_pulses");
}
function persistFinalScene() {
  if (!operation) return;
  operation.phase = "persisting_scene";
  if (!saveState(true, operation.target, sceneSaved)) finishOperation(false, "scene persistence is busy");
}
function sceneSaved(ok, error) {
  if (!operation || operation.phase !== "persisting_scene") return;
  if (!ok) { known = false; return finishOperation(false, "scene changed but could not be persisted: " + error); }
  mode = operation.target;
  known = true;
  if (!clearDirty()) {
    known = false;
    pendingUnknown = true;
    flushPendingUnknown();
    return finishOperation(false, "scene changed but uncertainty marker could not be cleared");
  }
  publishMode();
  finishOperation(true, "scene " + mode + " (" + modeLabel(mode) + ") selected");
}
function invalidationSaved(ok, error) {
  if (!operation || operation.phase !== "invalidating_scene") return;
  if (!ok) return finishOperation(false, "refusing to pulse because scene invalidation failed: " + error);
  prepareSceneChange();
}
function prepareSceneChange() {
  if (!operation) return;
  let relay = readRelay();
  if (relay.error) return finishOperation(false, relay.error);
  recordRelay(relay.on);
  let steps = (operation.target - operation.working + 3) % 3;
  if (relay.on) {
    operation.pulseOffMs = ON_PULSE_OFF_MS;
    operation.pulseWaitMs = ON_PULSE_WAIT_MS;
    operation.primer = true;
    operation.remaining = steps + 1;
    operation.pulseCount = operation.remaining;
    return startPulse();
  }
  operation.pulseOffMs = OFF_PULSE_OFF_MS;
  operation.pulseWaitMs = OFF_PULSE_WAIT_MS;
  operation.primer = false;
  operation.remaining = steps;
  operation.pulseCount = steps;
  let wait = remainingSafeOff();
  if (wait > 0) return scheduleOperation(wait, "safe_on_wait");
  restorePowerNow();
}
function startPowerOn(command) {
  let started = beginOperation(command || "on", mode, false);
  if (started.error) return started;
  let relay = readRelay();
  if (relay.error) { finishOperation(false, relay.error); return { error: lastError }; }
  recordRelay(relay.on);
  if (relay.on) { finishOperation(true, "O1 was already on; tracked scene is unchanged"); return started; }
  let wait = remainingSafeOff();
  if (wait > 0) scheduleOperation(wait, "safe_on_wait");
  else restorePowerNow();
  return started;
}
function startSet(target, command) {
  if (!validMode(target)) return { error: "mode must be 0, 1, or 2" };
  if (!known || !durableKnown || hasDirty()) return { error: "scene is uncertain; inspect it and use Confirm observed" };
  let steps = (target - mode + 3) % 3;
  if (steps === 0) return startPowerOn("set_same");
  let started = beginOperation(command || "set", target, true);
  if (started.error) return started;
  if (!setDirty("scene change in progress")) {
    finishOperation(false, "refusing to pulse because uncertainty marker could not be stored");
    return { error: lastError };
  }
  known = false;
  durableKnown = false;
  operation.phase = "invalidating_scene";
  if (!saveState(false, mode, invalidationSaved)) {
    finishOperation(false, "refusing to pulse because scene persistence is busy");
    return { error: lastError };
  }
  return started;
}
function startPowerOff() {
  let started = beginOperation("off", mode, false);
  if (started.error) return started;
  let relay = readRelay();
  if (relay.error) { finishOperation(false, relay.error); return { error: lastError }; }
  recordRelay(relay.on);
  if (!relay.on) { finishOperation(true, "O1 was already off; tracked scene is unchanged"); return started; }
  callRelay(false, "normal_off");
  return started;
}
function syncSaved(ok, error) {
  if (!operation || operation.phase !== "persisting_sync") return;
  if (!ok) return finishOperation(false, "scene synchronization failed: " + error);
  mode = operation.target;
  known = true;
  if (!clearDirty()) {
    known = false;
    pendingUnknown = true;
    flushPendingUnknown();
    return finishOperation(false, "scene synchronized but uncertainty marker could not be cleared");
  }
  publishMode();
  finishOperation(true, "scene synchronized to " + mode + " (" + modeLabel(mode) + ")");
}
function startSync(target) {
  if (!validMode(target)) return { error: "mode must be 0, 1, or 2" };
  let started = beginOperation("sync", target, false);
  if (started.error) return started;
  operation.phase = "persisting_sync";
  if (!saveState(true, target, syncSaved)) {
    finishOperation(false, "scene persistence is busy");
    return { error: lastError };
  }
  return started;
}

function abortForExternal(reason) {
  if (!operation) return;
  let sceneMutation = operation.sceneMutation;
  finishOperation(false, reason);
  if (sceneMutation) markUnknown(reason);
}
function switchStatusChanged(status) {
  if (!status || status.component !== "switch:0" || !status.delta || typeof status.delta.output !== "boolean") return;
  let value = status.delta.output;
  if (relayOn === value) return;
  let previousOffSince = offSince;
  if (expectedRelay === value) { recordRelay(value); return; }
  recordRelay(value);
  if (operation) abortForExternal("external O1 change during " + operation.phase);
  if (!value) return;
  let duration = previousOffSince === null ? null : now() - previousOffSince;
  if (duration === null || duration < SCENE_OFF_MAX_MS) {
    markUnknown(duration === null ? "unobserved external O1 ON" : "external short OFF/ON cycle of " + duration + " ms");
  }
}

function publishMode() {
  selectedMode = mode;
  try { cloudScene.setValue(modeName(mode)); }
  catch (error) { setError("could not publish scene selector: " + error.message); }
}
function cloudSceneChanged(event) {
  if (!event) return;
  if (event.value === "Bright") selectedMode = 0;
  else if (event.value === "Cool") selectedMode = 1;
  else if (event.value === "Warm") selectedMode = 2;
}
function reportCloudResult(result) { if (result.error) setError("Cloud command rejected: " + result.error); }
function cloudApplyPressed() { reportCloudResult(startSet(selectedMode, "set")); }
function cloudConfirmPressed() {
  if (known && durableKnown && !hasDirty()) return setError("Cloud confirmation rejected: scene is already known");
  reportCloudResult(startSync(selectedMode));
}
function cloudOnPressed() { reportCloudResult(startPowerOn("on")); }
function cloudOffPressed() { reportCloudResult(startPowerOff()); }
function bindCloud() {
  cloudScene.on("change", cloudSceneChanged);
  cloudApply.on("single_push", cloudApplyPressed);
  cloudConfirm.on("single_push", cloudConfirmPressed);
  cloudOn.on("single_push", cloudOnPressed);
  cloudOff.on("single_push", cloudOffPressed);
}

function statusValue() {
  let relay = readRelay();
  return {
    initialized: initialized, relay_on: relay.on, relay_error: relay.error,
    mode: mode, scene: modeLabel(mode), mode_known: known,
    durable_mode_known: durableKnown,
    persistent: known && durableKnown && !hasDirty() && !saveBusy && !pendingUnknown,
    busy: operation !== null, operation: operationSnapshot(operation),
    last_operation: lastOperation, last_error: lastError,
    persistence_busy: saveBusy,
    timing_ms: {
      safe_normal_off: SAFE_OFF_MS,
      scene_switch_max_off: SCENE_OFF_MAX_MS,
      restore_wait_remaining: relay.on === false ? remainingSafeOff() : 0
    }
  };
}
function replyStatus(request) { request.result(statusValue()); }
Script.addRpcHandler("AtlasStatus", function atlasStatus(request) { replyStatus(request); });
Script.addRpcHandler("AtlasCommand", function atlasCommand(request, params) {
  params = params || {};
  let command = params.command;
  if (command === "status") return replyStatus(request);
  let started;
  if (command === "next") started = known ? startSet((mode + 1) % 3, "next") : { error: "scene is uncertain; inspect it and use sync" };
  else if (command === "set") started = startSet(params.mode, "set");
  else if (command === "on") started = startPowerOn("on");
  else if (command === "off") started = startPowerOff();
  else if (command === "sync") started = startSync(params.mode);
  else return request.error(400, "unknown command; use status, next, set, on, off, or sync");
  if (started.error) return request.error(409, started.error);
  request.result({ accepted: true, operation_id: started.operation.id, request_id: params.request_id || null });
});

function loadDone(result, code, message) {
  initialized = true;
  if (code === 0 && result && result.value && result.value.s === KVS_SCHEMA && validMode(result.value.m)) {
    mode = result.value.m;
    known = result.value.k === 1;
    durableKnown = known;
  } else if (code !== -105) setError("KVS.Get failed" + (message ? ": " + message : ""));
  if (hasDirty()) {
    known = false;
    durableKnown = false;
    pendingUnknown = true;
    flushPendingUnknown();
  }
  selectedMode = mode;
  if (known) publishMode();
  log(known ? "restored scene " + mode : "scene is uncertain; confirmation is required");
}
function seedRelay() {
  let relay = readRelay();
  if (relay.error) return setError(relay.error);
  relayOn = relay.on;
  offSince = null;
}

bindCloud();
Shelly.addStatusHandler(switchStatusChanged);
seedRelay();
Shelly.call("KVS.Get", { key: KVS_KEY }, loadDone);
log("memory-bounded controller started; O2 is untouched");
