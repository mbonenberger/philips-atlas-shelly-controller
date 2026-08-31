# Philips Atlas controller for Shelly 2PM Gen4

This repository contains a local Shelly Script for controlling the light in a
Philips Atlas ceiling fan. It adds reliable scene selection, normal power
control, persistent scene tracking, and a small RPC interface suitable for
later integration with systems such as Apple Home.

The controller runs entirely on the Shelly. It does not require a cloud service
or a separate home-automation server.

## What the controller does

The Atlas light has no digital scene API. It changes lighting scenes when its
power is switched OFF and ON quickly. A normal long OFF period restores the
previous scene instead.

The script operates the Shelly relay with calibrated pulse sequences and keeps
track of the resulting scene. It provides commands to:

- select an exact scene;
- advance to the next scene;
- turn the light on and off without intentionally changing its scene;
- synchronize the controller after a manually changed or uncertain scene;
- inspect relay, scene, operation, and persistence status.

The deployable source is [atlas-controller.js](atlas-controller.js). O1 is the
only controlled output. O2 is never read or changed.

## Repository layout

| Path | Purpose |
|---|---|
| `atlas-controller.js` | Shelly Script deployed to the device. |
| `tests/controller.test.js` | Node.js simulator and regression tests. |
| `docs/deployment-runbook.md` | Safe, repeatable RPC deployment and recovery procedure. |
| `README.md` | Operating, deployment, recovery, and maintenance guide. |

## Hardware and configuration assumptions

- Philips Atlas ceiling fan/light, EAN 8721103096081.
- Shelly 2PM Gen4.
- Atlas light connected to O1 / `switch:0`.
- O2 / `switch:1` reserved for other use and outside this project.
- Shelly configured in switch profile, not cover profile.
- Physical wall input configured as `flip`, so visitors receive immediate
  conventional wall-switch behavior even if the script is unavailable.

## Calibrated scene order

Production testing established this cycle order for the installed Atlas:

| Controller scene | Observed output |
|---:|---|
| 0 | 4000 K / 100% |
| 1 | 6500 K / 50% |
| 2 | 2700 K / 50% |

The cycle is:

    0 -> 1 -> 2 -> 0

The product manual shows the same three outputs but presents the two
half-brightness scenes in the opposite order. Repeated visual production tests
confirmed that the table above is correct for this installation.

Power measurement cannot identify the scene. All three measured approximately
33.5-33.7 W at O1 despite their visibly different output.

## How scene switching works

The Atlas advances its scene after a sufficiently short OFF/ON power cycle. A
long OFF period restores the existing scene. Although the manual specifies an
eight-second scene-switch window, the script uses a more conservative
12-second guard for ordinary restoration.

Physical testing also found a primer behavior when the light is already on:
the first short cycle in a new scripted sequence does not advance the scene.
The script therefore sends one primer before the required scene-advance pulses.

When a command begins with O1 already on:

- OFF pulse: 150 ms;
- ON interval between pulses: 250 ms;
- one primer pulse is included.

When a command begins with O1 off:

- the script first waits for the remaining part of the 12-second safe-OFF
  interval;
- OFF pulse: 500 ms;
- ON interval between pulses: 500 ms;
- no primer is needed after restoration.

Every scene command waits 2500 ms after the final ON edge before committing the
new scene.

## Physical wall-switch behavior

Normal wall-switch use does not usually require manual synchronization.

| Physical action | Controller behavior |
|---|---|
| Turn O1 off | Relay changes immediately; tracked scene remains known. |
| Turn O1 on after a long observed OFF period | Relay changes immediately; previous scene remains known. |
| Quick OFF/ON cycle | Atlas may change scene; controller conservatively marks the scene unknown. |
| Turn O1 on after the script restarted while O1 was off | Relay changes immediately; controller marks the scene unknown because the OFF duration was not observed. |

The last two cases require visual inspection followed by `sync`. This is
intentional: the Atlas exposes no scene feedback, and reporting uncertainty is
safer than silently publishing the wrong scene.

Relay activity occurring entirely while the script or device is unavailable
cannot be reconstructed and may also require synchronization.

## RPC interface

The script registers two local Shelly RPC methods:

    POST /rpc/Script.AtlasStatus
    POST /rpc/Script.AtlasCommand

Shelly uses the `id` field to route a custom RPC method to the correct script
slot. Set the device address and deployed script ID before using the examples:

    SHELLY_IP=192.0.2.10
    SCRIPT_ID=1

### Read status

    curl -s -X POST "http://$SHELLY_IP/rpc/Script.AtlasStatus" \
      -d "{\"id\":$SCRIPT_ID}"

Important status fields include:

| Field | Meaning |
|---|---|
| `relay_on` | Actual O1 relay state. |
| `mode` | Tracked scene number, even when confidence is lost. |
| `scene` | Human-readable label for `mode`. |
| `mode_known` | Whether the tracked scene is currently trusted. |
| `durable_mode_known` | Whether known scene state is stored durably. |
| `persistent` | Scene state and safety marker are currently consistent. |
| `busy` | A command is still running. |
| `operation` | Detailed active operation, or `null`. |
| `last_operation` | Most recently completed operation. |
| `last_error` | Latest controller error, or `null`. |

### Select or advance a scene

    # Advance one scene.
    curl -s -X POST "http://$SHELLY_IP/rpc/Script.AtlasCommand" \
      -d "{\"id\":$SCRIPT_ID,\"command\":\"next\"}"

    # Select warm 2700 K / 50% directly.
    curl -s -X POST "http://$SHELLY_IP/rpc/Script.AtlasCommand" \
      -d "{\"id\":$SCRIPT_ID,\"command\":\"set\",\"mode\":2}"

### Normal power control

    curl -s -X POST "http://$SHELLY_IP/rpc/Script.AtlasCommand" \
      -d "{\"id\":$SCRIPT_ID,\"command\":\"off\"}"

    curl -s -X POST "http://$SHELLY_IP/rpc/Script.AtlasCommand" \
      -d "{\"id\":$SCRIPT_ID,\"command\":\"on\"}"

Mutating commands return quickly with `accepted: true` and an `operation_id`.
Poll `AtlasStatus` until `busy` becomes false, then inspect `last_operation`.

## Command retries

The memory-bounded controller deliberately does not retain request history.
An optional `request_id` is echoed for caller correlation but is not used for
deduplication. Poll `AtlasStatus` after a lost response and inspect `busy` and
`last_operation` before deciding whether to retry. Never retry `next` blindly,
because a repeated relative command can advance the scene twice.

## Synchronizing an uncertain scene

When `mode_known` is false:

1. Inspect the visible light output.
2. Match it to the calibrated table.
3. Send `sync` with the corresponding mode, or use the matching Cloud
   confirmation control after the same visual check.
4. Confirm `mode_known`, `durable_mode_known`, and `persistent` are true.

`sync` changes only stored controller state. It does not operate O1 or O2.

| Visible output | Sync mode |
|---|---:|
| 4000 K / 100% | 0 |
| 6500 K / 50% | 1 |
| 2700 K / 50% | 2 |

    # Example: visually confirmed warm scene.
    curl -s -X POST "http://$SHELLY_IP/rpc/Script.AtlasCommand" \
      -d "{\"id\":$SCRIPT_ID,\"command\":\"sync\",\"mode\":2}"

## Shelly Smart Control controls

The deployment provisions five ordinary virtual components for Shelly Smart
Control before the controller starts. The script intentionally has no managed
`@meta` declaration: on the tested Shelly 2PM Gen4 firmware 2.0.0, starting even
a one-component managed declaration reboots the device. The controller instead
opens the fixed component keys created by `scripts/provision-shelly-components.js`.

| Virtual control | Effect |
|---|---|
| `Atlas scene` | Chooses Bright, Cool, or Warm without operating O1. |
| `Atlas Apply scene` | Applies the selected scene only while tracked state is known. |
| `Atlas Confirm observed` | Persists the selected scene only while tracked state is uncertain. |
| `Atlas On` | Turns O1 on using the safe normal-power path. |
| `Atlas Off` | Turns O1 off while preserving the tracked scene. |

Choosing a value in `Atlas scene` never operates O1. Use `Atlas Apply scene`
for normal scene changes. It fails closed while tracked state is uncertain.
After physically inspecting an uncertain lamp, choose the matching value and
press `Atlas Confirm observed`; confirmation only persists the selected scene
and never operates O1. It is rejected while state is already known. This keeps
selection, actuation, and confirmation as distinct user actions.
After a successful scene change or synchronization, the controller publishes
the committed scene back to `Atlas scene`; it also restores that value from a
known durable scene when the script starts.

Use `Atlas On` and `Atlas Off` for ordinary remote power control. Both are
idempotent and use the controller's normal-power path. `Atlas On` waits for the
safe OFF interval when necessary, so a quick app interaction cannot be mistaken
for an Atlas scene-change pulse. Avoid using the native `Output (0)` control for
a rapid OFF/ON cycle: it bypasses the controller, and the Atlas may genuinely
advance its scene.

The Cloud surface intentionally has no live status component. One enum and four
buttons keep the component and event-listener count to five, leaving more of
the Shelly's shared script-memory pool available to the controller. The
provisioning tool creates one `Atlas Controller` group containing those five
controls. Relay tracking uses one separate status subscription. Use
`Script.AtlasStatus` for diagnostics.

To make the controls available remotely:

1. Run `node scripts/provision-shelly-components.js` once. It is idempotent and
   refuses to overwrite an occupied fixed key with a different component.
2. Run `node scripts/check-shelly.js preflight`. Do not deploy while it reports
   unexpected or orphaned Atlas components.
3. Deploy this script, enable **Run on startup**, and start it. Do not add an
   `@meta` virtual-component declaration on firmware 2.0.0.
4. Run `node scripts/check-shelly.js verify` and retain the previous source
   until the check succeeds.
5. In Shelly Smart Control, open the 2PM Gen4 device and enable **Cloud** if it
   is not already enabled.
6. When on the same LAN, open the device's local IP from the app and inspect
   **Virtual Components**.

These controls are specific to Shelly Smart Control. They do not add custom
scene controls to the existing native Apple Home switch; use a HomeKit bridge
for that integration.

## Installation and deployment

The simplest installation method is the Shelly web interface:

1. Run `node scripts/build-shelly.js` and use the generated
   `dist/atlas-controller.js` artifact.
2. Run `node scripts/provision-shelly-components.js`.
3. Create or select a script slot.
4. Stop the script if it is running.
5. Upload the generated artifact.
6. Enable **Run on startup**.
7. Start the script.
8. Call `Script.GetStatus` and confirm that it is running without errors.
9. Call `Script.AtlasStatus` and confirm `initialized: true`.
10. Run `node scripts/check-shelly.js verify`.
11. Visually inspect the current scene and run `sync` if `mode_known` is false.

The generated artifact retains physical line breaks and keeps asynchronous
continuations in top-level named functions. The builder rejects managed
`@meta` declarations and artifacts above 24 KB. The simulator also rejects
builds with more than two nested anonymous callbacks, avoiding a documented
Shelly JS runtime limit while preserving memory-saving compaction.

For RPC-based deployment, `Script.PutCode` cannot overwrite a running script.
The source is also larger than a typical single Shelly HTTP request, so upload
it in 1024-byte chunks: the first request uses `append: false`, and every later
request uses `append: true`. Read the code back and compare its checksum before
starting the slot.

For the complete repeatable procedure, including a chunked backup of the
currently deployed script and rollback steps, see the
[deployment runbook](docs/deployment-runbook.md).

Stopping or starting the script does not intentionally change O1. Avoid using
the physical wall switch while code is being replaced, because relay events
cannot be observed while the script is stopped.

## Local development and tests

The test suite runs the Shelly source inside a deterministic Node.js simulator.
It covers scene transactions, relay timing, durable invalidation, persistence
failures, restart uncertainty, Cloud controls, physical switch events, callback
timeouts, and Shelly resource limits.

Requirements:

- Node.js;
- no npm packages or network access.

Run syntax checks and all tests:

    node --check atlas-controller.js
    node --check tests/controller.test.js
    node --check scripts/build-shelly.js
    node --check scripts/check-shelly.js
    node tests/controller.test.js
    node scripts/build-shelly.js
    node --check dist/atlas-controller.js
    ATLAS_SCRIPT=dist/atlas-controller.js node tests/controller.test.js

## Persistence and failure safety

The controller treats a scene as known only after its state is durably stored.
Its authoritative record is a compact schema-5 value in Shelly KVS under
`atlas_mode`.

Before the first scene-changing relay edge, the script:

1. writes a private dirty marker;
2. persists `known: false` to KVS;
3. performs and verifies the relay pulses;
4. waits for final settling;
5. persists the new known scene;
6. clears the dirty marker.

A restart therefore cannot interpret a partially completed scene operation as
successful. If completion cannot be proven, `mode_known` remains false.

Normal `on`, `off`, and already-selected `set` operations do not modify scene
state. KVS and relay calls have five-second callback timeouts, and every
operation has a single 120-second watchdog. After a lost relay callback, the
controller continues only when the synchronous output status exactly matches
the requested state; a per-call token ignores late callbacks. A mismatch or
unavailable status still fails closed and makes an active scene change unknown.

To stay within the device memory budget, the controller does not provide
persistent request deduplication, etag reconciliation, automatic KVS retries,
diagnostic pulses, or multi-stage recovery. A failed or ambiguous scene
operation remains unknown and requires visual synchronization.

## Production verification checklist

After changing relay logic, persistence, or scene mapping, verify at least:

1. `sync 0` from a visually confirmed 4000 K / 100% scene.
2. `next` reaches scene 1, then scene 2, then scene 0.
3. `set` reaches exact targets in both directions.
4. `off`, a delay longer than 12 seconds, and `on` preserve the scene.
5. Scene selection from an initially off relay uses the no-primer path.
6. A lost response is resolved through status inspection rather than a blind
   retry.
7. A quick physical OFF/ON cycle produces `mode_known: false`.
8. Restarting the script while O1 is off, then physically turning it on without
   a prior status request, produces `mode_known: false`.
9. Visual `sync` restores known, durable, persistent state.
10. O2 remains untouched throughout testing.

## Security

Do not expose the Shelly RPC interface to an untrusted network. Enable Shelly
device authentication when the LAN is not fully trusted. Device authentication
also protects custom script RPC methods and is compatible with later home
automation integrations when those integrations are configured with the same
credentials.

## References

- The Atlas manual supplied for this installation defines the three light
  outputs and the eight-second switching threshold. Production testing defines
  the installed cycle order used by this controller.
- [Philips Atlas product page](https://www.lighting.philips.ch/consumer/p/deckenventilator-mit-beleuchtung-atlas-deckenventilator-mit-beleuchtung/8721103096081)
- [Shelly Script component and deployment RPCs](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Script/)
- [Shelly Switch RPC reference](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/)
- [Shelly KVS reference](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/KVS/)
- [Shelly Script RPC handlers](https://shelly-api-docs.shelly.cloud/gen2/Scripts/APIs/RPCHandlers/)
- [Shelly Script language and resource limits](https://shelly-api-docs.shelly.cloud/gen2/Scripts/LanguageReference/)
- [Shelly Timer reference](https://shelly-api-docs.shelly.cloud/gen2/Scripts/APIs/Timer/)
- [Shelly Script core API](https://shelly-api-docs.shelly.cloud/gen2/Scripts/APIs/Shelly/)
