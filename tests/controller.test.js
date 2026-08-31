"use strict";

const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const SCRIPT = fs.readFileSync(require("path").join(__dirname, "..", "atlas-controller.js"), "utf8");

class Device {
  constructor(options) {
    options = options || {};
    this.now = 1000;
    this.relay = options.relay === undefined ? true : options.relay;
    this.kvs = options.kvs || new Map();
    this.storage = options.storage || new Map();
    this.kvsEtag = options.kvsEtag || "etag-1";
    this.kvsRevision = 1;
    this.tasks = [];
    this.nextTask = 1;
    this.handlers = {};
    this.events = [];
    this.switchSets = 0;
    this.shellyCallCount = 0;
    this.inFlightRpcCalls = 0;
    this.activeTimers = new Set();
    this.failNextKvsSet = false;
    this.failKvsSets = 0;
    this.failKvsGets = 0;
    this.dropNextKvsCallback = false;
    this.commitAndDropNextKvsCallback = false;
    this.delayNextKvsCallbackMs = 0;
    this.dropNextSwitchCallback = false;
    this.failNextGetStatus = options.failNextGetStatus || false;
    this.failGetStatusAtCall = options.failGetStatusAtCall || null;
    this.componentStatusCalls = 0;
    this.failNextStorageSet = false;
    this.failDirtyMarkerSets = 0;
    this.logs = [];
    this.script = SCRIPT;
    if (options.operationTimeoutMs !== undefined) {
      this.script = SCRIPT.replace("let OPERATION_TIMEOUT_MS = 120000;", "let OPERATION_TIMEOUT_MS = " + options.operationTimeoutMs + ";");
    }
    this.start();
  }

  schedule(delay, fn) {
    const task = { id: this.nextTask++, at: this.now + delay, fn, cancelled: false };
    this.tasks.push(task);
    return task.id;
  }

  cancel(id) {
    const task = this.tasks.find((item) => item.id === id);
    if (task) task.cancelled = true;
  }

  runUntil(target) {
    while (true) {
      this.tasks.sort((a, b) => a.at - b.at || a.id - b.id);
      const task = this.tasks.find((item) => !item.cancelled && item.at <= target);
      if (!task) break;
      this.tasks.splice(this.tasks.indexOf(task), 1);
      this.now = task.at;
      task.fn();
    }
    this.now = target;
  }

  drain(limit) {
    const end = this.now + (limit || 60000);
    while (this.tasks.some((item) => !item.cancelled)) {
      this.tasks.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.tasks.find((item) => !item.cancelled);
      if (!next || next.at > end) throw new Error("simulator did not drain");
      this.runUntil(next.at);
    }
  }

  emitRelay(state) {
    for (const handler of this.events) {
      handler({ component: "switch:0", info: { state } });
    }
  }

  physicalSet(state) {
    if (this.relay === state) return;
    this.relay = state;
    this.emitRelay(state);
  }

  start() {
    this.tasks = [];
    this.handlers = {};
    this.events = [];
    this.inFlightRpcCalls = 0;
    this.activeTimers = new Set();
    const device = this;
    const context = {
      print(message) { device.logs.push(message); },
      Timer: {
        set(delay, repeat, callback) {
          if (device.activeTimers.size >= 5) throw new Error("Shelly timer limit exceeded");
          let handle = null;
          handle = device.schedule(delay, () => {
            device.activeTimers.delete(handle);
            callback();
          });
          device.activeTimers.add(handle);
          return handle;
        },
        clear(handle) {
          device.activeTimers.delete(handle);
          device.cancel(handle);
        }
      },
      Shelly: {
        getUptimeMs() { return device.now; },
        getComponentStatus(type, id) {
          if (type !== "switch" || id !== 0) return null;
          device.componentStatusCalls += 1;
          if (device.failNextGetStatus || device.componentStatusCalls === device.failGetStatusAtCall) {
            device.failNextGetStatus = false;
            return null;
          }
          return { output: device.relay };
        },
        addEventHandler(handler) { device.events.push(handler); },
        call(method, params, callback) {
          if (device.inFlightRpcCalls >= 5) throw new Error("Shelly RPC call limit exceeded");
          device.inFlightRpcCalls += 1;
          device.shellyCallCount += 1;
          device.schedule(0, () => {
            device.inFlightRpcCalls -= 1;
            if (method === "KVS.Get") {
              if (device.failKvsGets > 0) {
                device.failKvsGets -= 1;
                callback(null, -1, "injected KVS.Get failure");
              } else if (device.kvs.has(params.key)) callback({ value: device.kvs.get(params.key), etag: device.kvsEtag }, 0, null);
              else callback(null, -105, "not found");
              return;
            }
            if (method === "KVS.Set") {
              if (device.dropNextKvsCallback) {
                device.dropNextKvsCallback = false;
                return;
              }
              if (device.failNextKvsSet || device.failKvsSets > 0) {
                device.failNextKvsSet = false;
                if (device.failKvsSets > 0) device.failKvsSets -= 1;
                callback(null, -1, "injected KVS failure");
              } else if (JSON.stringify(params.value).length > 253) {
                callback(null, -2, "value too long");
              } else if (params.etag !== undefined && params.etag !== device.kvsEtag) {
                callback(null, -3, "etag mismatch");
              } else {
                device.kvs.set(params.key, JSON.parse(JSON.stringify(params.value)));
                device.kvsRevision += 1;
                device.kvsEtag = "etag-" + device.kvsRevision;
                const response = { etag: device.kvsEtag, rev: device.kvsRevision };
                if (device.commitAndDropNextKvsCallback) {
                  device.commitAndDropNextKvsCallback = false;
                  return;
                }
                if (device.delayNextKvsCallbackMs > 0) {
                  const delay = device.delayNextKvsCallbackMs;
                  device.delayNextKvsCallbackMs = 0;
                  device.schedule(delay, () => callback(response, 0, null));
                  return;
                }
                callback(response, 0, null);
              }
              return;
            }
            if (method === "Switch.GetStatus") {
              if (device.failNextGetStatus) {
                device.failNextGetStatus = false;
                callback(null, -1, "injected status failure");
              } else callback({ output: device.relay }, 0, null);
              return;
            }
            if (method === "Switch.Set") {
              device.switchSets += 1;
              if (device.relay !== params.on) {
                device.relay = params.on;
                device.emitRelay(params.on);
              }
              if (device.dropNextSwitchCallback) {
                device.dropNextSwitchCallback = false;
                return;
              }
              callback({}, 0, null);
              return;
            }
            throw new Error("unexpected RPC " + method);
          });
        }
      },
      Script: {
        addRpcHandler(name, handler) { device.handlers[name] = handler; },
        storage: {
          setItem(key, value) {
            if (device.failNextStorageSet || (key === "dirty" && device.failDirtyMarkerSets > 0)) {
              device.failNextStorageSet = false;
              if (key === "dirty" && device.failDirtyMarkerSets > 0) device.failDirtyMarkerSets -= 1;
              throw new Error("injected storage failure");
            }
            if (value.length > 1024) throw new Error("storage value too long");
            device.storage.set(key, value);
          },
          getItem(key) { return device.storage.has(key) ? device.storage.get(key) : null; },
          removeItem(key) { device.storage.delete(key); }
        }
      }
    };
    vm.createContext(context);
    vm.runInContext(this.script, context, { filename: "atlas-controller.js" });
    this.runUntil(this.now);
  }

  command(params) {
    let response = null;
    const request = {
      result(value) { response = { result: JSON.parse(JSON.stringify(value)) }; },
      error(code, message) { response = { error: { code, message } }; }
    };
    this.handlers.AtlasCommand(request, params);
    assert(response, "command did not reply synchronously");
    return response;
  }

  status() {
    let response = null;
    const request = { result(value) { response = JSON.parse(JSON.stringify(value)); } };
    this.handlers.AtlasStatus(request, {});
    this.runUntil(this.now);
    assert(response, "status did not reply");
    return response;
  }
}

function knownState(mode) {
  return new Map([["atlas_mode", { s: 5, k: 1, m: mode, r: "", c: "", o: "" }]]);
}

function test(name, fn) {
  try {
    fn();
    process.stdout.write("ok - " + name + "\n");
  } catch (error) {
    process.stderr.write("not ok - " + name + "\n" + error.stack + "\n");
    process.exitCode = 1;
  }
}

test("scene state is invalidated before the first pulse and committed once at the end", () => {
  const device = new Device({ kvs: knownState(0), relay: true });
  const reply = device.command({ command: "next", request_id: "next-1" });
  assert.strictEqual(reply.result.accepted, true);
  device.runUntil(device.now);
  assert.deepStrictEqual(device.kvs.get("atlas_mode").k, 0);
  assert.strictEqual(device.switchSets, 1, "first pulse should have started only after invalidation");
  device.drain();
  assert.deepStrictEqual(device.kvs.get("atlas_mode").k, 1);
  assert.deepStrictEqual(device.kvs.get("atlas_mode").m, 1);
  assert.strictEqual(device.status().mode, 1);
});

test("production scene labels follow the calibrated Atlas cycle order", () => {
  const expected = ["4000K / 100%", "6500K / 50%", "2700K / 50%"];
  for (let mode = 0; mode < expected.length; mode++) {
    const device = new Device({ kvs: knownState(mode), relay: true });
    assert.strictEqual(device.status().scene, expected[mode]);
  }
});

test("restart after durable invalidation cannot resurrect the old scene", () => {
  const kvs = knownState(0);
  const device = new Device({ kvs, relay: true });
  device.command({ command: "next", request_id: "crash-1" });
  device.runUntil(device.now);
  assert.strictEqual(kvs.get("atlas_mode").k, 0);
  device.start();
  assert.strictEqual(device.status().mode_known, false);
});

test("diagnostic uncertainty remains durable across restart", () => {
  const kvs = knownState(0);
  const device = new Device({ kvs, relay: true });
  device.command({ command: "diagnostic_pulse", off_ms: 200, request_id: "diag-1" });
  device.drain();
  assert.strictEqual(kvs.get("atlas_mode").k, 0);
  device.start();
  assert.strictEqual(device.status().mode_known, false);
});

test("a duplicate next request cannot advance twice", () => {
  const device = new Device({ kvs: knownState(0), relay: true });
  device.command({ command: "next", request_id: "retry-safe" });
  device.drain();
  const sets = device.switchSets;
  const duplicate = device.command({ command: "next", request_id: "retry-safe" });
  assert.strictEqual(duplicate.result.duplicate, true);
  device.drain();
  assert.strictEqual(device.switchSets, sets);
  assert.strictEqual(device.status().mode, 1);
});

test("next request id remains idempotent across restart", () => {
  const kvs = knownState(0);
  const device = new Device({ kvs, relay: true });
  device.command({ command: "next", request_id: "restart-retry" });
  device.drain();
  device.start();
  const sets = device.switchSets;
  const duplicate = device.command({ command: "next", request_id: "restart-retry" });
  assert.strictEqual(duplicate.result.duplicate, true);
  assert.strictEqual(device.switchSets, sets);
  assert.strictEqual(device.status().mode, 1);
});

test("a crash before KVS admission leaves the same request id retryable", () => {
  const kvs = knownState(0);
  const storage = new Map();
  const device = new Device({ kvs, storage, relay: true });
  const first = device.command({ command: "next", request_id: "pre-kvs-crash" });
  assert.strictEqual(first.result.accepted, true);
  device.start();
  const retry = device.command({ command: "next", request_id: "pre-kvs-crash" });
  assert.strictEqual(retry.result.duplicate, false);
  device.drain();
  assert.strictEqual(device.status().mode, 1);
});

test("an anonymous sync never borrows an older request identity", () => {
  const kvs = new Map([["atlas_mode", { s: 5, k: 0, m: 0, r: "ambiguous-a", c: "next", o: "op-a" }]]);
  const storage = new Map([["requests", JSON.stringify([["ambiguous-a", "next", "pending"]])]]);
  const device = new Device({ kvs, storage, relay: true });
  device.command({ command: "sync", mode: 0 });
  device.drain();
  assert.strictEqual(kvs.get("atlas_mode").r, "");
  assert.strictEqual(kvs.get("atlas_mode").c, "");
  assert.strictEqual(kvs.get("atlas_mode").o, "");
  device.start();
  const retry = device.command({ command: "next", request_id: "ambiguous-a" });
  assert.strictEqual(retry.result.duplicate, true);
  assert.strictEqual(retry.result.command, "next");
  assert.strictEqual(retry.result.outcome, "unknown");
});

test("a request is rejected before mutation when history persistence fails", () => {
  const device = new Device({ kvs: knownState(0), relay: true });
  device.failNextStorageSet = true;
  const response = device.command({ command: "next", request_id: "history-write-failure" });
  assert.strictEqual(response.error.code, 409);
  assert.strictEqual(device.switchSets, 0);
  assert.strictEqual(device.status().persistence.request_history_persistent, false);
});

test("a terminal history-write failure is repaired from authoritative KVS after restart", () => {
  const kvs = knownState(0);
  const storage = new Map();
  const device = new Device({ kvs, storage, relay: true });
  device.command({ command: "sync", mode: 2, request_id: "terminal-history" });
  device.failNextStorageSet = true;
  device.drain();
  assert.strictEqual(device.status().persistence.request_history_persistent, false);
  device.start();
  const duplicate = device.command({ command: "sync", mode: 2, request_id: "terminal-history" });
  assert.strictEqual(duplicate.result.duplicate, true);
  assert.strictEqual(duplicate.result.outcome, "ok");
  assert.strictEqual(device.status().persistence.request_history_persistent, true);
});

test("a completed normal off request survives a terminal history-write failure and restart", () => {
  const kvs = knownState(0);
  const storage = new Map();
  const device = new Device({ kvs, storage, relay: true });
  device.command({ command: "off", request_id: "off-terminal-loss" });
  device.failNextStorageSet = true;
  device.drain();
  assert.strictEqual(device.relay, false);
  assert.strictEqual(JSON.parse(storage.get("requests"))[0][2], "pending");
  assert.strictEqual(kvs.get("atlas_mode").p, "d");
  device.start();
  const duplicate = device.command({ command: "off", request_id: "off-terminal-loss" });
  assert.strictEqual(duplicate.result.duplicate, true);
  assert.strictEqual(duplicate.result.outcome, "ok");
  assert.strictEqual(device.relay, false);
});

test("startup resolves an interrupted power intent that reached its relay state", () => {
  const kvs = new Map([["atlas_mode", {
    s: 5, k: 1, m: 0, r: "off-intent-complete", c: "off", o: "op-off", p: "i"
  }]]);
  const storage = new Map([["requests", JSON.stringify([["off-intent-complete", "off", "pending"]])]]);
  const device = new Device({ kvs, storage, relay: false });
  const duplicate = device.command({ command: "off", request_id: "off-intent-complete" });
  assert.strictEqual(duplicate.result.duplicate, true);
  assert.strictEqual(duplicate.result.outcome, "ok");
  assert.strictEqual(device.switchSets, 0);
});

test("startup makes an interrupted power intent retryable when its relay state was not reached", () => {
  const kvs = new Map([["atlas_mode", {
    s: 5, k: 1, m: 0, r: "off-intent-retry", c: "off", o: "op-off", p: "i"
  }]]);
  const storage = new Map([["requests", JSON.stringify([["off-intent-retry", "off", "pending"]])]]);
  const device = new Device({ kvs, storage, relay: true });
  const retry = device.command({ command: "off", request_id: "off-intent-retry" });
  assert.strictEqual(retry.result.duplicate, false);
  device.drain();
  assert.strictEqual(device.relay, false);
});

test("startup suppresses a power-intent retry when relay state cannot be read", () => {
  const kvs = new Map([["atlas_mode", {
    s: 5, k: 1, m: 0, r: "off-intent-unknown", c: "off", o: "op-off", p: "i"
  }]]);
  const storage = new Map([["requests", JSON.stringify([["off-intent-unknown", "off", "pending"]])]]);
  const device = new Device({ kvs, storage, relay: false, failGetStatusAtCall: 2 });
  const duplicate = device.command({ command: "off", request_id: "off-intent-unknown" });
  assert.strictEqual(duplicate.result.duplicate, true);
  assert.strictEqual(duplicate.result.outcome, "unknown");
  assert.strictEqual(duplicate.result.accepted, false);
});

test("startup does not trust relay ON for an interrupted normal-on intent", () => {
  const kvs = new Map([["atlas_mode", {
    s: 5, k: 1, m: 2, r: "on-intent-ambiguous", c: "on", o: "op-on", p: "i"
  }]]);
  const storage = new Map([["requests", JSON.stringify([["on-intent-ambiguous", "on", "pending"]])]]);
  const device = new Device({ kvs, storage, relay: true });
  device.drain();
  const duplicate = device.command({ command: "on", request_id: "on-intent-ambiguous" });
  assert.strictEqual(duplicate.result.duplicate, true);
  assert.strictEqual(duplicate.result.outcome, "unknown");
  assert.strictEqual(duplicate.result.accepted, false);
  assert.strictEqual(device.status().mode_known, false);
  assert.strictEqual(kvs.get("atlas_mode").k, 0);
  device.start();
  assert.strictEqual(device.status().mode_known, false);
});

test("startup does not trust relay ON for an interrupted same-scene set intent", () => {
  const kvs = new Map([["atlas_mode", {
    s: 5, k: 1, m: 1, r: "set-intent-ambiguous", c: "set:1", o: "op-set", p: "i"
  }]]);
  const storage = new Map([["requests", JSON.stringify([["set-intent-ambiguous", "set:1", "pending"]])]]);
  const device = new Device({ kvs, storage, relay: true });
  device.drain();
  const duplicate = device.command({ command: "set", mode: 1, request_id: "set-intent-ambiguous" });
  assert.strictEqual(duplicate.result.duplicate, true);
  assert.strictEqual(duplicate.result.outcome, "unknown");
  assert.strictEqual(duplicate.result.accepted, false);
  assert.strictEqual(device.status().mode_known, false);
  assert.strictEqual(kvs.get("atlas_mode").k, 0);
  device.start();
  assert.strictEqual(device.status().mode_known, false);
});

test("an anonymous operation repairs terminal history before clearing the KVS tuple", () => {
  const kvs = knownState(0);
  const storage = new Map();
  const device = new Device({ kvs, storage, relay: true });
  device.command({ command: "next", request_id: "terminal-before-anonymous" });
  device.failNextStorageSet = true;
  device.drain();
  assert.strictEqual(JSON.parse(storage.get("requests"))[0][2], "pending");
  const anonymous = device.command({ command: "sync", mode: 1 });
  assert.strictEqual(anonymous.result.accepted, true);
  device.drain();
  assert.strictEqual(JSON.parse(storage.get("requests"))[0][2], "ok");
  assert.strictEqual(kvs.get("atlas_mode").r, "");
  device.start();
  const retry = device.command({ command: "next", request_id: "terminal-before-anonymous" });
  assert.strictEqual(retry.result.duplicate, true);
  assert.strictEqual(retry.result.outcome, "ok");
});

test("an anonymous operation is blocked while terminal history remains unwritable", () => {
  const device = new Device({ kvs: knownState(0), relay: true });
  device.command({ command: "next", request_id: "terminal-still-broken" });
  device.failNextStorageSet = true;
  device.drain();
  device.failNextStorageSet = true;
  const blocked = device.command({ command: "sync", mode: 1 });
  assert.strictEqual(blocked.error.code, 409);
});

test("request ids reject characters that expand serialized storage", () => {
  const device = new Device({ kvs: knownState(0), relay: true });
  const response = device.command({ command: "next", request_id: "bad\\id" });
  assert.strictEqual(response.error.code, 400);
  assert.strictEqual(device.switchSets, 0);
});

test("malformed history remains degraded until explicitly reset", () => {
  const storage = new Map([["requests", "{not-json"]]);
  const device = new Device({ kvs: knownState(0), storage, relay: true });
  assert.strictEqual(device.status().persistence.request_history_degraded, true);
  const blocked = device.command({ command: "next", request_id: "blocked-by-history" });
  assert.strictEqual(blocked.error.code, 409);
  const unconfirmed = device.command({ command: "reset_request_history" });
  assert.strictEqual(unconfirmed.error.code, 400);
  const reset = device.command({ command: "reset_request_history", confirm: true });
  assert.strictEqual(reset.result.reset, true);
  const resetStatus = device.status();
  assert.strictEqual(resetStatus.persistence.request_history_degraded, false);
  assert.strictEqual(resetStatus.persistence.request_history_error, null);
  assert.strictEqual(resetStatus.last_error, null);
  const accepted = device.command({ command: "next", request_id: "after-history-reset" });
  assert.strictEqual(accepted.result.accepted, true);
});

test("array-like objects and object entries are rejected as history", () => {
  const containers = [
    "{\"length\":0}",
    "[{\"0\":\"object-id\",\"1\":\"next\",\"2\":\"ok\",\"length\":3}]",
    "[null]"
  ];
  for (const raw of containers) {
    const storage = new Map([["requests", raw]]);
    const device = new Device({ kvs: knownState(0), storage, relay: true });
    assert.strictEqual(device.status().persistence.request_history_degraded, true, raw);
  }
});

test("history reset does not misclassify an unresolved power intent as completed", () => {
  const kvs = new Map([["atlas_mode", {
    s: 5, k: 1, m: 0, r: "reset-power-intent", c: "off", o: "op-off", p: "i"
  }]]);
  const storage = new Map([["requests", "{not-json"]]);
  const device = new Device({ kvs, storage, relay: true });
  const reset = device.command({ command: "reset_request_history", confirm: true });
  assert.strictEqual(reset.result.reset, true);
  const duplicate = device.command({ command: "off", request_id: "reset-power-intent" });
  assert.strictEqual(duplicate.result.duplicate, true);
  assert.strictEqual(duplicate.result.outcome, "unknown");
  assert.strictEqual(duplicate.result.accepted, false);
  assert.strictEqual(device.relay, true);
});

test("a KVS and history command mismatch fails closed", () => {
  const kvs = new Map([["atlas_mode", { s: 5, k: 1, m: 0, r: "same-request", c: "sync:0", o: "op-sync" }]]);
  const storage = new Map([["requests", JSON.stringify([["same-request", "next", "pending"]])]]);
  const device = new Device({ kvs, storage, relay: true });
  const status = device.status();
  assert.strictEqual(status.persistence.request_history_degraded, true);
  const retry = device.command({ command: "next", request_id: "same-request" });
  assert.strictEqual(retry.result.duplicate, true);
  assert.strictEqual(retry.result.command, "next");
  assert.strictEqual(retry.result.outcome, "unknown");
  assert.strictEqual(retry.result.accepted, false);
});

test("terminal outcomes are quarantined after a KVS command mismatch", () => {
  for (const outcome of ["ok", "failed"]) {
    const kvs = new Map([["atlas_mode", { s: 5, k: 1, m: 0, r: "terminal-mismatch", c: "sync:0", o: "op-sync" }]]);
    const storage = new Map([["requests", JSON.stringify([["terminal-mismatch", "next", outcome]])]]);
    const device = new Device({ kvs, storage, relay: true });
    const retry = device.command({ command: "next", request_id: "terminal-mismatch" });
    assert.strictEqual(retry.result.duplicate, true);
    assert.strictEqual(retry.result.accepted, false);
    assert.strictEqual(retry.result.outcome, "unknown");
  }
});

test("an older next request remains idempotent after newer commands and restart", () => {
  const kvs = knownState(0);
  const device = new Device({ kvs, relay: true });
  device.command({ command: "next", request_id: "history-1" });
  device.drain();
  device.command({ command: "next", request_id: "history-2" });
  device.drain();
  device.start();
  const sets = device.switchSets;
  const duplicate = device.command({ command: "next", request_id: "history-1" });
  assert.strictEqual(duplicate.result.duplicate, true);
  assert.strictEqual(device.switchSets, sets);
  assert.strictEqual(device.status().mode, 2);
});

test("reusing a request id for different parameters is rejected", () => {
  const device = new Device({ kvs: knownState(0), relay: true });
  device.command({ command: "set", mode: 1, request_id: "same-id" });
  device.drain();
  const conflict = device.command({ command: "set", mode: 2, request_id: "same-id" });
  assert.strictEqual(conflict.error.code, 409);
  assert.strictEqual(device.status().mode, 1);
});

test("next requires a request id", () => {
  const device = new Device({ kvs: knownState(0), relay: true });
  const response = device.command({ command: "next" });
  assert.strictEqual(response.error.code, 400);
  assert.strictEqual(device.switchSets, 0);
});

test("eight maximum-length request ids stay within persistence limits", () => {
  const device = new Device({ kvs: knownState(0), relay: true });
  for (let i = 0; i < 8; i++) {
    const id = ("request-" + i).padEnd(64, "x");
    device.command({ command: "sync", mode: i % 3, request_id: id });
    device.drain();
    assert(JSON.stringify(device.kvs.get("atlas_mode")).length <= 253);
  }
  assert(device.storage.get("requests").length <= 1024);
  device.start();
  const duplicate = device.command({ command: "sync", mode: 0, request_id: "request-6".padEnd(64, "x") });
  assert.strictEqual(duplicate.result.duplicate, true);
  assert.strictEqual(duplicate.result.outcome, "ok");
});

test("repeated off is a no-op and retains the original off timestamp", () => {
  const device = new Device({ kvs: knownState(0), relay: true });
  device.command({ command: "off", request_id: "off-1" });
  device.drain();
  device.runUntil(device.now + 5000);
  device.command({ command: "off", request_id: "off-2" });
  device.drain();
  const remaining = device.status().timing_ms.restore_wait_remaining;
  assert(remaining >= 6999 && remaining <= 7000, "remaining guard was " + remaining);
});

test("a physical short cycle durably invalidates the tracked scene", () => {
  const kvs = knownState(0);
  const device = new Device({ kvs, relay: true });
  device.status();
  device.physicalSet(false);
  device.runUntil(device.now + 500);
  device.physicalSet(true);
  device.runUntil(device.now);
  assert.strictEqual(device.status().mode_known, false);
  assert.strictEqual(kvs.get("atlas_mode").k, 0);
  device.start();
  assert.strictEqual(device.status().mode_known, false);
});

test("a physical long cycle preserves the tracked scene", () => {
  const kvs = knownState(2);
  const device = new Device({ kvs, relay: true });
  device.status();
  device.physicalSet(false);
  device.runUntil(device.now + 9000);
  device.physicalSet(true);
  device.drain();
  const status = device.status();
  assert.strictEqual(status.mode_known, true);
  assert.strictEqual(status.mode, 2);
  assert.strictEqual(kvs.get("atlas_mode").k, 1);
});

test("dirty marker prevents stale resurrection when external invalidation fails", () => {
  const kvs = knownState(0);
  const storage = new Map();
  const device = new Device({ kvs, storage, relay: true });
  device.status();
  device.failKvsSets = 3;
  device.physicalSet(false);
  device.runUntil(device.now + 200);
  device.physicalSet(true);
  device.drain();
  assert.strictEqual(device.status().persistence.dirty_marker, true);
  assert.strictEqual(kvs.get("atlas_mode").k, 1, "stale KVS value should still demonstrate the failure case");
  device.start();
  device.drain();
  assert.strictEqual(device.status().mode_known, false);
  assert.strictEqual(kvs.get("atlas_mode").k, 0);
  assert.strictEqual(device.status().persistence.dirty_marker, false);
});

test("dirty-marker failure blocks scripted scene mutation before a pulse", () => {
  const device = new Device({ kvs: knownState(0), relay: true });
  device.failDirtyMarkerSets = 1;
  const response = device.command({ command: "next", request_id: "dirty-failure" });
  assert.strictEqual(response.error.code, 409);
  const status = device.status();
  assert.strictEqual(device.switchSets, 0);
  assert.strictEqual(status.mode_known, true);
  assert.strictEqual(status.persistence.safety_degraded, true);
  assert.strictEqual(status.persistence_dirty, true);
});

test("a successful sync clears a transient dirty-marker degradation", () => {
  const device = new Device({ kvs: knownState(0), relay: true });
  device.failDirtyMarkerSets = 1;
  device.command({ command: "next", request_id: "dirty-first" });
  const sync = device.command({ command: "sync", mode: 0, request_id: "dirty-recovery" });
  assert.strictEqual(sync.result.accepted, true);
  device.drain();
  const status = device.status();
  assert.strictEqual(status.persistence.safety_degraded, false);
  assert.strictEqual(status.persistent, true);
});

test("turning on after an unobserved off duration is conservatively uncertain", () => {
  const kvs = knownState(2);
  const device = new Device({ kvs, relay: false });
  device.status();
  device.physicalSet(true);
  device.drain();
  assert.strictEqual(device.status().mode_known, false);
  assert.strictEqual(kvs.get("atlas_mode").k, 0);
});

test("a physical ON after restart is detected without requiring an initial status poll", () => {
  const kvs = knownState(2);
  const device = new Device({ kvs, relay: false });
  device.physicalSet(true);
  device.drain();
  const status = device.status();
  assert.strictEqual(status.mode_known, false);
  assert.strictEqual(kvs.get("atlas_mode").k, 0);
});

test("an ON edge fails closed when the startup relay baseline was unavailable", () => {
  const kvs = knownState(1);
  const device = new Device({ kvs, relay: false, failNextGetStatus: true });
  device.physicalSet(true);
  device.drain();
  assert.strictEqual(device.status().mode_known, false);
  assert.strictEqual(kvs.get("atlas_mode").k, 0);
});

test("overlapping external invalidations are serialized", () => {
  const kvs = knownState(0);
  const device = new Device({ kvs, relay: true });
  device.status();
  device.physicalSet(false);
  device.runUntil(device.now + 100);
  device.physicalSet(true);
  device.physicalSet(false);
  device.runUntil(device.now + 100);
  device.physicalSet(true);
  device.drain();
  const status = device.status();
  assert.strictEqual(status.persistence_dirty, false);
  assert.strictEqual(status.mode_known, false);
  assert.strictEqual(kvs.get("atlas_mode").k, 0);
});

test("external switching interrupts an active scene operation", () => {
  const kvs = knownState(0);
  const device = new Device({ kvs, relay: true });
  device.command({ command: "next", request_id: "interrupt-1" });
  device.runUntil(device.now);
  device.physicalSet(true);
  device.runUntil(device.now);
  const status = device.status();
  assert.strictEqual(status.busy, false);
  assert.strictEqual(status.mode_known, false);
  assert.strictEqual(status.last_operation.ok, false);
  assert.strictEqual(kvs.get("atlas_mode").k, 0);
});

test("a final persistence failure never publishes the target as known", () => {
  const kvs = knownState(0);
  const device = new Device({ kvs, relay: true });
  device.command({ command: "next", request_id: "kvs-final" });
  device.runUntil(device.now);
  device.failKvsSets = 3;
  device.drain();
  const status = device.status();
  assert.strictEqual(status.mode_known, false);
  assert.strictEqual(status.persistence_dirty, true);
  assert.strictEqual(kvs.get("atlas_mode").k, 0);
  const duplicate = device.command({ command: "next", request_id: "kvs-final" });
  assert.strictEqual(duplicate.result.duplicate, true);
  assert.strictEqual(duplicate.result.accepted, false);
  assert.strictEqual(duplicate.result.outcome, "failed");
});

test("transient KVS failure is retried", () => {
  const device = new Device({ kvs: knownState(0), relay: true });
  device.failKvsSets = 1;
  device.command({ command: "sync", mode: 1, request_id: "retry-kvs" });
  device.drain();
  const status = device.status();
  assert.strictEqual(status.mode_known, true);
  assert.strictEqual(status.mode, 1);
  assert.strictEqual(status.persistence.last_write_ok, true);
});

test("etag conflict prevents scene pulses", () => {
  const device = new Device({ kvs: knownState(0), relay: true });
  device.kvsEtag = "externally-changed";
  device.command({ command: "next", request_id: "etag-conflict" });
  device.drain();
  const status = device.status();
  assert.strictEqual(device.switchSets, 0);
  assert.strictEqual(status.mode_known, false);
  assert.strictEqual(status.persistence_dirty, true);
});

test("sync recovers after etag reconciliation with a new request id", () => {
  const device = new Device({ kvs: knownState(0), relay: true });
  device.kvsEtag = "externally-changed";
  device.command({ command: "next", request_id: "etag-first" });
  device.drain();
  const sync = device.command({ command: "sync", mode: 0, request_id: "etag-sync" });
  assert.strictEqual(sync.result.accepted, true);
  device.drain();
  const status = device.status();
  assert.strictEqual(status.mode_known, true);
  assert.strictEqual(status.persistent, true);
});

test("sync refreshes an unresolved etag after reconciliation reads fail", () => {
  const device = new Device({ kvs: knownState(0), relay: true });
  device.kvsEtag = "externally-changed";
  device.failKvsGets = 3;
  device.command({ command: "next", request_id: "etag-read-failure" });
  device.drain();
  const failed = device.status();
  assert.strictEqual(failed.persistence.last_error.phase, "KVS etag reconciliation");
  assert(failed.persistence.last_error.message.indexOf("failed") >= 0);
  const sync = device.command({ command: "sync", mode: 0, request_id: "etag-refresh-sync" });
  assert.strictEqual(sync.result.accepted, true);
  device.drain();
  const recovered = device.status();
  assert.strictEqual(recovered.mode_known, true);
  assert.strictEqual(recovered.persistent, true);
});

test("missing KVS callback times out and retries", () => {
  const device = new Device({ kvs: knownState(0), relay: true });
  device.dropNextKvsCallback = true;
  device.command({ command: "sync", mode: 2, request_id: "timeout-kvs" });
  device.drain();
  assert.strictEqual(device.status().mode, 2);
  assert.strictEqual(device.status().persistent, true);
});

test("a committed KVS write with a lost response is reconciled as success", () => {
  const device = new Device({ kvs: knownState(0), relay: true });
  device.commitAndDropNextKvsCallback = true;
  device.command({ command: "sync", mode: 2, request_id: "lost-response" });
  device.drain();
  const status = device.status();
  assert.strictEqual(status.mode, 2);
  assert.strictEqual(status.persistent, true);
  assert.strictEqual(status.persistence.last_write_ok, true);
});

test("a late KVS success callback cannot corrupt reconciled state", () => {
  const device = new Device({ kvs: knownState(0), relay: true });
  device.delayNextKvsCallbackMs = 6000;
  device.command({ command: "sync", mode: 1, request_id: "late-response" });
  device.drain();
  const status = device.status();
  assert.strictEqual(status.mode, 1);
  assert.strictEqual(status.persistent, true);
  assert.strictEqual(status.persistence.queue_depth, 0);
});

test("relay RPC timeout recovers a dropped switch callback before the watchdog", () => {
  const device = new Device({ kvs: knownState(0), relay: true });
  device.dropNextSwitchCallback = true;
  device.command({ command: "next", request_id: "timeout-switch" });
  device.drain();
  const status = device.status();
  assert.strictEqual(status.busy, false);
  assert.strictEqual(status.mode_known, false);
  assert.strictEqual(status.relay_on, true);
  assert.strictEqual(status.last_operation.ok, false);
  assert.strictEqual(status.last_operation.recovery_error, null);
  assert(status.last_operation.primary_error.indexOf("callback timeout") >= 0);
  assert.strictEqual(status.timing_ms.relay_rpc_timeout, 5000);
  assert.strictEqual(status.timing_ms.operation_timeout, 120000);
});

test("watchdog reports relay and uncertainty-persistence failures separately", () => {
  const device = new Device({ kvs: knownState(0), relay: true, operationTimeoutMs: 1000 });
  device.dropNextSwitchCallback = true;
  device.command({ command: "next", request_id: "timeout-dual-errors" });
  device.runUntil(device.now);
  device.failKvsSets = 3;
  device.failNextGetStatus = true;
  device.drain(80000);
  const operation = device.status().last_operation;
  assert(operation.relay_recovery_error.indexOf("could not read O1") >= 0);
  assert(operation.uncertainty_persistence_error.indexOf("KVS.Set failed") >= 0);
});

test("sync does not update in-memory mode when persistence fails", () => {
  const device = new Device({ kvs: knownState(0), relay: true });
  device.failKvsSets = 3;
  device.command({ command: "sync", mode: 2, request_id: "sync-fail" });
  device.drain();
  const status = device.status();
  assert.strictEqual(status.mode_known, false);
  assert.strictEqual(status.mode, 0);
});

test("relay read failure reports unknown restore timing", () => {
  const device = new Device({ kvs: knownState(0), relay: false });
  device.failNextGetStatus = true;
  const status = device.status();
  assert.strictEqual(status.relay_on, null);
  assert.strictEqual(status.timing_ms.restore_wait_remaining, null);
});

test("status replies synchronously without consuming timer or RPC-call slots", () => {
  const device = new Device({ kvs: knownState(0), relay: true });
  device.command({ command: "next", request_id: "status-resource-budget" });
  device.runUntil(device.now);
  const timersBefore = device.activeTimers.size;
  const callsBefore = device.shellyCallCount;
  for (let i = 0; i < 5; i++) {
    let response = null;
    device.handlers.AtlasStatus({ result(value) { response = value; } }, {});
    assert(response, "status handler did not reply synchronously");
  }
  assert.strictEqual(device.activeTimers.size, timersBefore);
  assert.strictEqual(device.shellyCallCount, callsBefore);
  device.drain();
});
