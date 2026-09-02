"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SCRIPT_PATH = process.env.ATLAS_SCRIPT || path.join(__dirname, "..", "atlas-controller.js");
const SCRIPT = fs.readFileSync(SCRIPT_PATH, "utf8");

function maskedSource(source) {
  let output = "";
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (current === "\n") { lineComment = false; output += "\n"; }
      else output += " ";
    } else if (blockComment) {
      if (current === "*" && next === "/") { output += "  "; blockComment = false; index += 1; }
      else output += current === "\n" ? "\n" : " ";
    } else if (quote !== null) {
      output += current === "\n" ? "\n" : " ";
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = null;
    } else if (current === "\"" || current === "'") { quote = current; output += " "; }
    else if (current === "/" && next === "/") { lineComment = true; output += "  "; index += 1; }
    else if (current === "/" && next === "*") { blockComment = true; output += "  "; index += 1; }
    else output += current;
  }
  return output;
}

function anonymousNesting(source) {
  const masked = maskedSource(source);
  const functions = [];
  const matcher = /\bfunction\s*([A-Za-z_$][A-Za-z0-9_$]*)?\s*\(/g;
  let match;
  while ((match = matcher.exec(masked)) !== null) {
    if (match[1]) continue;
    const start = masked.indexOf("{", matcher.lastIndex);
    assert(start >= 0, "anonymous function body must be present");
    let depth = 1;
    let end = start + 1;
    while (end < masked.length && depth > 0) {
      if (masked[end] === "{") depth += 1;
      else if (masked[end] === "}") depth -= 1;
      end += 1;
    }
    assert.strictEqual(depth, 0, "anonymous function body must be balanced");
    functions.push({ start: match.index, end });
  }
  let maximum = 0;
  for (const candidate of functions) {
    const depth = functions.filter((outer) => outer.start <= candidate.start && outer.end >= candidate.end).length;
    if (depth > maximum) maximum = depth;
  }
  return maximum;
}

class Device {
  constructor(options) {
    options = options || {};
    this.now = 1000;
    this.relay = options.relay === undefined ? true : options.relay;
    this.kvs = options.kvs || new Map();
    this.storage = options.storage || new Map();
    const storedState = this.kvs.get("atlas_mode");
    this.lampMode = options.lampMode === undefined ? (storedState ? storedState.m : 0) : options.lampMode;
    this.lampPrimerRequired = this.relay;
    this.lampColdRestoreAt = null;
    this.lampOffAt = this.relay ? null : this.now - 12000;
    this.lampPulseFromColdRestore = null;
    this.virtual = new Map();
    this.handlers = {};
    this.statusHandlers = [];
    this.tasks = [];
    this.nextTask = 1;
    this.timers = new Set();
    this.switchSets = 0;
    this.switchTransitions = [];
    this.kvsWrites = [];
    this.rpcCalls = 0;
    this.failNextKvsSet = false;
    this.dropNextKvsSet = false;
    this.dropNextSwitchSet = false;
    this.ignoreNextSwitchSet = false;
    this.dropNextOperationTimer = false;
    this.failNextStatusRead = false;
    this.failDirtyWrite = false;
    this.logs = [];
    this.start();
  }

  schedule(delay, callback) {
    const task = { id: this.nextTask++, at: this.now + delay, callback, cancelled: false };
    this.tasks.push(task);
    return task.id;
  }

  runUntil(target) {
    while (true) {
      this.tasks.sort((left, right) => left.at - right.at || left.id - right.id);
      const task = this.tasks.find((item) => !item.cancelled && item.at <= target);
      if (!task) break;
      this.tasks.splice(this.tasks.indexOf(task), 1);
      this.now = task.at;
      task.callback();
    }
    this.now = target;
  }

  drain(limit) {
    const end = this.now + (limit || 60000);
    while (this.tasks.some((item) => !item.cancelled)) {
      this.tasks.sort((left, right) => left.at - right.at || left.id - right.id);
      const next = this.tasks.find((item) => !item.cancelled);
      if (!next || next.at > end) throw new Error("simulator did not drain");
      this.runUntil(next.at);
    }
  }

  emitRelay(value) {
    for (const handler of this.statusHandlers) handler({ component: "switch:0", delta: { output: value } });
  }

  recordLampRelay(value) {
    if (this.relay === value) return;
    if (!value) {
      this.lampPulseFromColdRestore = this.lampColdRestoreAt === null ? null : this.now - this.lampColdRestoreAt;
      this.lampOffAt = this.now;
      return;
    }
    const offDuration = this.lampOffAt === null ? null : this.now - this.lampOffAt;
    if (offDuration !== null && offDuration >= 8000) {
      this.lampPrimerRequired = false;
      this.lampColdRestoreAt = this.now;
    } else if (this.lampPrimerRequired) {
      this.lampPrimerRequired = false;
      this.lampColdRestoreAt = null;
    } else if (this.lampPulseFromColdRestore === null || this.lampPulseFromColdRestore >= 500) {
      this.lampMode = (this.lampMode + 1) % 3;
      this.lampColdRestoreAt = null;
    } else {
      this.lampColdRestoreAt = this.now;
    }
    this.lampOffAt = null;
    this.lampPulseFromColdRestore = null;
  }

  physicalSet(value) {
    if (this.relay === value) return;
    this.recordLampRelay(value);
    this.relay = value;
    this.emitRelay(value);
  }

  component(role) {
    if (!this.virtual.has(role)) this.virtual.set(role, { value: null, listeners: [] });
    const component = this.virtual.get(role);
    return {
      setValue(value) { component.value = value; },
      getValue() { return component.value; },
      on(event, handler) { component.listeners.push({ event, handler }); return component.listeners.length; },
      off() {}
    };
  }

  trigger(role, event, value) {
    const component = this.virtual.get(role);
    assert(component, "virtual component must exist: " + role);
    if (event === "change") component.value = value;
    for (const listener of component.listeners) {
      if (listener.event === event) listener.handler({ source: "cloud", value });
    }
  }

  start() {
    this.handlers = {};
    this.statusHandlers = [];
    this.tasks = [];
    this.timers = new Set();
    for (const value of this.virtual.values()) value.listeners = [];
    const device = this;
    const context = {
      print(message) { device.logs.push(message); },
      Timer: {
        set(delay, repeat, callback) {
          if (device.timers.size >= 5) throw new Error("timer limit exceeded");
          let handle = null;
          if (device.dropNextOperationTimer && callback.name === "operationTimerDone") {
            device.dropNextOperationTimer = false;
            handle = device.schedule(1000000000, () => { device.timers.delete(handle); callback(); });
          } else handle = device.schedule(delay, () => { device.timers.delete(handle); callback(); });
          device.timers.add(handle);
          return handle;
        },
        clear(handle) {
          device.timers.delete(handle);
          const task = device.tasks.find((item) => item.id === handle);
          if (task) task.cancelled = true;
        }
      },
      Shelly: {
        getUptimeMs() { return device.now; },
        getComponentStatus(type, id) {
          if (type !== "switch" || id !== 0) return null;
          if (device.failNextStatusRead) { device.failNextStatusRead = false; return null; }
          return { output: device.relay };
        },
        addStatusHandler(handler) { device.statusHandlers.push(handler); return device.statusHandlers.length; },
        call(method, params, callback, userdata) {
          device.rpcCalls += 1;
          device.schedule(0, () => {
            if (method === "KVS.Get") {
              if (device.kvs.has(params.key)) callback({ value: device.kvs.get(params.key) }, 0, null, userdata);
              else callback(null, -105, "not found", userdata);
              return;
            }
            if (method === "KVS.Set") {
              if (device.dropNextKvsSet) { device.dropNextKvsSet = false; return; }
              if (device.failNextKvsSet) {
                device.failNextKvsSet = false;
                callback(null, -1, "injected KVS failure", userdata);
                return;
              }
              const saved = JSON.parse(JSON.stringify(params.value));
              device.kvs.set(params.key, saved);
              device.kvsWrites.push(saved);
              callback({}, 0, null, userdata);
              return;
            }
            if (method === "Switch.Set") {
              device.switchSets += 1;
              if (device.ignoreNextSwitchSet) { device.ignoreNextSwitchSet = false; return; }
              if (device.relay !== params.on) {
                device.recordLampRelay(params.on);
                device.relay = params.on;
                device.switchTransitions.push({ at: device.now, on: params.on, known: device.kvs.get("atlas_mode").k });
                device.emitRelay(params.on);
              }
              if (device.dropNextSwitchSet) { device.dropNextSwitchSet = false; return; }
              callback({}, 0, null, userdata);
              return;
            }
            throw new Error("unexpected RPC: " + method);
          });
        }
      },
      Virtual: {
        getHandle(key) {
          const roles = {
            "enum:200": "scene",
            "button:200": "apply_scene",
            "button:201": "confirm_scene",
            "button:202": "power_off",
            "button:203": "power_on"
          };
          return roles[key] ? device.component(roles[key]) : null;
        }
      },
      Script: {
        addRpcHandler(name, handler) { device.handlers[name] = handler; },
        storage: {
          setItem(key, value) {
            if (key === "dirty" && device.failDirtyWrite) throw new Error("injected dirty-marker failure");
            device.storage.set(key, value);
          },
          getItem(key) { return device.storage.has(key) ? device.storage.get(key) : null; },
          removeItem(key) { device.storage.delete(key); }
        }
      }
    };
    vm.createContext(context);
    vm.runInContext(SCRIPT, context, { filename: SCRIPT_PATH });
    this.runUntil(this.now);
  }

  command(params) {
    let response = null;
    const request = {
      result(value) { response = { result: JSON.parse(JSON.stringify(value)) }; },
      error(code, message) { response = { error: { code, message } }; }
    };
    this.handlers.AtlasCommand(request, params);
    assert(response, "command must reply synchronously");
    return response;
  }

  status() {
    let response = null;
    this.handlers.AtlasStatus({ result(value) { response = JSON.parse(JSON.stringify(value)); } }, {});
    assert(response, "status must reply synchronously");
    return response;
  }
}

function state(mode, known) { return new Map([["atlas_mode", { s: 5, k: known === false ? 0 : 1, m: mode }]]); }
function test(name, callback) {
  try { callback(); process.stdout.write("ok - " + name + "\n"); }
  catch (error) { process.stderr.write("not ok - " + name + "\n" + error.stack + "\n"); process.exitCode = 1; }
}

test("controller avoids managed metadata and binds the five provisioned Cloud controls", () => {
  assert(!/@meta\b/.test(SCRIPT));
  const keys = Array.from(SCRIPT.matchAll(/requireVirtual\("([^"]+)"\)/g), (match) => match[1]).sort();
  assert.deepStrictEqual(keys, ["button:200", "button:201", "button:202", "button:203", "enum:200"]);
});

test("controller stays within Shelly anonymous callback nesting guidance", () => {
  assert(anonymousNesting(SCRIPT) <= 2);
});

test("known durable scene is restored and published", () => {
  const device = new Device({ kvs: state(2), relay: true });
  assert.strictEqual(device.status().scene, "2700K / 50%");
  assert.strictEqual(device.virtual.get("scene").value, "Warm");
});

test("scene mutation is durably invalidated before the first relay edge", () => {
  const device = new Device({ kvs: state(0), relay: true });
  device.command({ command: "next" });
  device.drain();
  assert.strictEqual(device.switchTransitions[0].known, 0);
  assert.deepStrictEqual(device.kvsWrites.map((write) => write.k), [0, 1]);
  assert.strictEqual(device.status().mode, 1);
  assert.strictEqual(device.status().mode_known, true);
});

test("an already-on scene change includes one primer pulse", () => {
  const device = new Device({ kvs: state(0), relay: true });
  device.command({ command: "set", mode: 1 });
  device.drain();
  assert.strictEqual(device.switchSets, 4);
  assert.strictEqual(device.status().last_operation.pulse_count, 2);
  assert.strictEqual(device.lampMode, 1);
});

test("an off-state scene change lets the lamp initialize before its first counted pulse", () => {
  const device = new Device({ kvs: state(0), relay: false });
  device.command({ command: "set", mode: 1 });
  device.runUntil(12999);
  assert.strictEqual(device.switchSets, 0);
  device.runUntil(13000);
  assert.deepStrictEqual(device.switchTransitions.map((transition) => [transition.at, transition.on]), [[13000, true]]);
  assert.strictEqual(device.status().operation.phase, "restore_settle");
  assert.strictEqual(device.status().timing_ms.restored_from_off_on_settle, 500);
  device.runUntil(13499);
  assert.strictEqual(device.switchSets, 1);
  assert.strictEqual(device.lampMode, 0);
  device.drain();
  assert.strictEqual(device.switchSets, 3);
  assert.deepStrictEqual(device.switchTransitions.map((transition) => [transition.at, transition.on]), [
    [13000, true], [13500, false], [14000, true]
  ]);
  assert.strictEqual(device.status().last_operation.pulse_count, 1);
  assert.strictEqual(device.status().mode, 1);
  assert.strictEqual(device.lampMode, 1);
});

test("an off-state two-step scene change preserves 500 ms ON intervals", () => {
  const device = new Device({ kvs: state(0), relay: false });
  device.command({ command: "set", mode: 2 });
  device.drain();
  assert.deepStrictEqual(device.switchTransitions.map((transition) => [transition.at, transition.on]), [
    [13000, true], [13500, false], [14000, true], [14500, false], [15000, true]
  ]);
  assert.strictEqual(device.status().last_operation.pulse_count, 2);
  assert.strictEqual(device.status().mode, 2);
  assert.strictEqual(device.lampMode, 2);
});

test("an external O1 change during restore settling fails closed", () => {
  const device = new Device({ kvs: state(0), relay: false });
  device.command({ command: "set", mode: 1 });
  device.runUntil(13000);
  assert.strictEqual(device.status().operation.phase, "restore_settle");
  device.physicalSet(false);
  device.drain();
  assert.strictEqual(device.status().busy, false);
  assert.strictEqual(device.status().mode_known, false);
  assert.strictEqual(device.status().last_operation.ok, false);
});

test("normal Off and On preserve the tracked scene", () => {
  const device = new Device({ kvs: state(2), relay: true });
  device.command({ command: "off" });
  device.drain();
  assert.strictEqual(device.relay, false);
  assert.strictEqual(device.status().mode_known, true);
  device.command({ command: "on" });
  device.drain();
  assert.strictEqual(device.relay, true);
  assert.strictEqual(device.status().mode, 2);
  assert.strictEqual(device.status().mode_known, true);
});

test("native Off alone preserves state and a long observed cycle remains known", () => {
  const device = new Device({ kvs: state(1), relay: true });
  device.physicalSet(false);
  assert.strictEqual(device.status().mode_known, true);
  device.runUntil(device.now + 9000);
  device.physicalSet(true);
  assert.strictEqual(device.status().mode_known, true);
});

test("native short OFF ON cycle becomes durably uncertain", () => {
  const device = new Device({ kvs: state(1), relay: true });
  device.physicalSet(false);
  device.runUntil(device.now + 2000);
  device.physicalSet(true);
  device.drain();
  assert.strictEqual(device.status().mode_known, false);
  assert.strictEqual(device.kvs.get("atlas_mode").k, 0);
  assert.strictEqual(device.storage.has("dirty"), true);
});

test("unobserved ON after restart becomes uncertain", () => {
  const device = new Device({ kvs: state(2), relay: false });
  device.physicalSet(true);
  device.drain();
  assert.strictEqual(device.status().mode_known, false);
});

test("Cloud confirmation synchronizes without operating O1", () => {
  const device = new Device({ kvs: state(0, false), relay: true });
  device.trigger("scene", "change", "Warm");
  device.trigger("confirm_scene", "single_push");
  device.drain();
  assert.strictEqual(device.switchSets, 0);
  assert.strictEqual(device.status().mode, 2);
  assert.strictEqual(device.status().mode_known, true);
});

test("Cloud On and Off use the normal power path", () => {
  const device = new Device({ kvs: state(2), relay: true });
  device.trigger("power_off", "single_push");
  device.drain();
  device.trigger("power_on", "single_push");
  device.drain();
  assert.strictEqual(device.relay, true);
  assert.strictEqual(device.status().mode, 2);
  assert.strictEqual(device.status().mode_known, true);
});

test("dirty marker forces uncertainty after restart", () => {
  const device = new Device({ kvs: state(2), relay: true, storage: new Map([["dirty", "crash"]]) });
  device.drain();
  assert.strictEqual(device.status().mode_known, false);
  assert.strictEqual(device.kvs.get("atlas_mode").k, 0);
});

test("dirty-marker failure blocks pulses", () => {
  const device = new Device({ kvs: state(0), relay: true });
  device.failDirtyWrite = true;
  const response = device.command({ command: "next" });
  device.drain();
  assert(response.error);
  assert.strictEqual(device.switchSets, 0);
});

test("KVS invalidation failure blocks pulses", () => {
  const device = new Device({ kvs: state(0), relay: true });
  device.failNextKvsSet = true;
  device.command({ command: "next" });
  device.drain();
  assert.strictEqual(device.switchSets, 0);
  assert.strictEqual(device.status().mode_known, false);
});

test("lost relay callback recovers when observed output is unambiguous", () => {
  const device = new Device({ kvs: state(0), relay: true });
  device.dropNextSwitchSet = true;
  device.command({ command: "next" });
  device.drain();
  assert.strictEqual(device.status().busy, false);
  assert.strictEqual(device.status().mode_known, true);
  assert.strictEqual(device.status().mode, 1);
  assert.strictEqual(device.status().last_operation.ok, true);
});

test("lost relay callback fails closed when observed output mismatches", () => {
  const device = new Device({ kvs: state(0), relay: true });
  device.ignoreNextSwitchSet = true;
  device.command({ command: "next" });
  device.drain();
  assert.strictEqual(device.status().busy, false);
  assert.strictEqual(device.status().mode_known, false);
  assert.strictEqual(device.status().last_operation.ok, false);
});

test("overall watchdog fails a stalled scene operation closed", () => {
  const device = new Device({ kvs: state(0), relay: false });
  device.dropNextOperationTimer = true;
  device.command({ command: "next" });
  device.drain(130000);
  assert.strictEqual(device.status().busy, false);
  assert.strictEqual(device.status().mode_known, false);
  assert.strictEqual(device.status().last_operation.ok, false);
  assert(device.status().last_operation.message.includes("watchdog expired"));
});

test("external relay change interrupts an active scene operation", () => {
  const device = new Device({ kvs: state(0), relay: true });
  device.command({ command: "next" });
  device.runUntil(device.now);
  device.physicalSet(true);
  device.drain();
  assert.strictEqual(device.status().busy, false);
  assert.strictEqual(device.status().mode_known, false);
});

test("status is synchronous and consumes no RPC or timer slot", () => {
  const device = new Device({ kvs: state(0), relay: true });
  const calls = device.rpcCalls;
  const timers = device.timers.size;
  device.status();
  assert.strictEqual(device.rpcCalls, calls);
  assert.strictEqual(device.timers.size, timers);
});
