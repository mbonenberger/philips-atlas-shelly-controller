# Shelly deployment runbook

Use this runbook to replace the Philips Atlas controller in an existing Shelly
script slot without losing the currently deployed code. It is intended for a
Shelly 2PM Gen4 using the `switch` profile and controls only O1 / `switch:0`.

## Safety rules

- Deploy from the same trusted LAN as the Shelly. Do not expose its RPC API to
  the internet.
- Do not use the physical wall switch while the script is stopped. Relay events
  during that interval cannot be observed by the controller.
- Back up the entire current script before calling `Script.Stop`. A failed or
  interrupted upload otherwise leaves no reliable rollback source.
- Do not upload to an arbitrary slot. Confirm the slot name, startup setting,
  and running state first.
- A script restart deliberately makes the Atlas scene state uncertain if the
  relay was off. This is safe: visually inspect the light and synchronize it
  locally or use `Atlas Confirm observed` before applying a remote scene.
- Do not delete the script slot as a routine cleanup shortcut. Script storage
  is cleared, and the scene must then be synchronized again.

## Prerequisites

- Node.js and `curl` on the deployment computer.
- Access to the Shelly local web interface and its local IP address.
- Current source checkout with `atlas-controller.js` and its tests.
- A target script slot already exists. The slot should be configured to run on
  startup.

Keep deployment settings in the ignored local `.env` file, never in tracked
files:

```sh
SHELLY_IP=192.168.1.42
SCRIPT_ID=1
SHELLY_MIN_SCRIPT_MEM_FREE=8192
```

The IP address is consumed by the deployment computer. It is not an input to
the Shelly-resident JavaScript and must not be added to `atlas-controller.js`.

If device authentication is enabled, use the Shelly web interface or an
authenticated HTTP client. Do not add passwords or tokens to the repository.

## 1. Discover and confirm the target slot

Load the local settings and list the script slots:

```sh
set -a; source .env; set +a
curl -fsS "http://${SHELLY_IP}/rpc/Script.List"
```

Choose the numeric `id` of the existing `Atlas Controller` entry and set it as
`SCRIPT_ID`. Then check the target before replacing it:

```sh
curl -fsS "http://${SHELLY_IP}/rpc/Script.GetConfig?id=${SCRIPT_ID}"
curl -fsS "http://${SHELLY_IP}/rpc/Script.GetStatus?id=${SCRIPT_ID}"
curl -fsS "http://${SHELLY_IP}/rpc/Shelly.GetDeviceInfo"
```

Verify all of the following:

- the device is a 2PM Gen4 in `switch` profile;
- the slot is named as expected;
- `enable` is `true`, so it runs after a reboot;
- it is the intended active controller, not another automation.

Provision or verify the fixed Cloud components, then run the read-only guard:

```sh
node scripts/provision-shelly-components.js
node scripts/check-shelly.js preflight
```

The provisioning command creates the exact five controls and their group when
they are missing. It is idempotent and refuses to overwrite a fixed key that is
occupied by an unexpected component. The preflight command records current script memory and inventories every dynamic component
whose name starts with `Atlas`. It fails when the script is stopped, reports an
error, has less free script memory than `SHELLY_MIN_SCRIPT_MEM_FREE`, or has an
unexpected Atlas component. The default 8192-byte floor is a local operational
guard based on this controller's deployment history, not a vendor-published
per-script allowance.

Do not continue when old select, confirm, status, or group components remain.
Direct `Virtual.Delete` may be denied for script-owned components. Resolve them
through a supported Shelly UI or firmware procedure, or escalate to Shelly
support. Do not factory-reset the device without a separate configuration
backup and explicit approval.

## 2. Validate the source

Run these checks before touching the device:

```sh
node --check atlas-controller.js
node --check tests/controller.test.js
node --check scripts/build-shelly.js
node --check scripts/check-shelly.js
node --check scripts/provision-shelly-components.js
node tests/controller.test.js
node scripts/build-shelly.js
node --check dist/atlas-controller.js
ATLAS_SCRIPT=dist/atlas-controller.js node tests/controller.test.js
git diff --check
```

Deploy `dist/atlas-controller.js`, not the readable source file. The build
removes comments and indentation, rejects managed `@meta` virtual-component
declarations, retains physical line breaks, and enforces a 24,000-byte artifact
ceiling. On the tested Shelly 2PM Gen4 firmware 2.0.0, starting even a minimal
managed virtual-component declaration reboots the device; the separately
provisioned fixed components avoid that firmware path. The simulator also
rejects more than two nested anonymous callbacks, and its second run verifies
the exact artifact that will be uploaded. `dist/` is ignored and must be rebuilt
for each deployment.

## 3. Back up the current script in chunks

`Script.GetCode` accepts `offset` and `len` and returns `data` plus `left`.
Always request 1024-byte chunks until `left` is zero. Do **not** request the
whole script in one HTTP response: a controller-sized source file can exceed
the Shelly HTTP response timeout.

The backup algorithm is:

1. Start with `offset=0` and `len=1024`.
2. Append the returned `data` verbatim to the backup source.
3. Increase `offset` by the byte length of `data`.
4. Repeat until `left` is `0`.
5. Calculate and record a SHA-256 checksum of the assembled backup.

Do not proceed if a chunk is empty while `left` is non-zero, an RPC request
fails, or the assembled backup cannot be checksummed. Keep the backup available
until post-deployment verification succeeds.

## 4. Replace the code safely

Only after the backup completes:

1. Call `Script.Stop` for `SCRIPT_ID` and record whether it was running.
2. Split `dist/atlas-controller.js` into chunks no larger than 1024 bytes.
3. Send the first chunk with `Script.PutCode` and `append: false`.
4. Send each remaining chunk with `append: true`.
5. Read the new code back using the same chunked `Script.GetCode` procedure.
6. Compare the read-back SHA-256 checksum with the local source checksum.
7. Call `Script.Start` only when the checksums match.

If any upload, read-back, checksum, or startup step fails, stop the deployment,
restore the backed-up source using the same `Script.PutCode` chunking, then
restart it if it was running before deployment. Do not try to repair the
controller by sending an unverified partial upload.

`Script.PutCode` only works on a stopped script. Its response contains `len`,
the total stored source length in bytes; use it as a progress check, not as a
substitute for the read-back checksum.

## 5. Verify the deployed controller

After startup, verify the script and its public status API:

```sh
curl -fsS "http://${SHELLY_IP}/rpc/Script.GetStatus?id=${SCRIPT_ID}"
curl -fsS -X POST "http://${SHELLY_IP}/rpc/Script.AtlasStatus" \
  -d "{\"id\":${SCRIPT_ID}}"
node scripts/check-shelly.js verify
```

The first response must report `running: true`, no `errors`, and usable
`mem_used`, `mem_peak`, and `mem_free` values. The automated verification also
requires the configured free-memory floor, the exact five expected virtual
controls, and their auto-generated `Atlas Controller` group. The Atlas status
response must be valid and identify its
initialization and scene-state fields. With the current controller, a restart
may return `mode_known: false` and `durable_mode_known: false`; this is
intentional uncertainty protection, not a deployment failure.

Keep the backup until verification has passed after startup and again after a
supervised exercise of Apply, Confirm, On, and Off. If the script stops, reports
`out_of_memory`, falls below the configured memory floor, or exposes additional
Atlas components, restore the backup immediately.

The controller has one 120-second overall operation watchdog in addition to
the five-second KVS and relay callback timeouts. A lost relay callback is
recoverable only when the device's synchronous output status exactly matches
the requested relay state. A mismatch remains a failure and makes an active
scene operation uncertain. Persistent request-ID deduplication is deliberately
not included; never retry the relative `next` command without first inspecting
`AtlasStatus`.

For a scene change that starts with O1 safely off, the expected relay sequence
is: restore O1, hold it on for 500 ms so the Atlas electronics can initialize,
then begin the 500 ms OFF/500 ms ON scene pulses. The active operation reports
`restore_settle` during that initial ON interval, and `AtlasStatus.timing_ms`
reports it as `restored_from_off_on_settle`. A successful `Switch.Set` response
proves only the relay state; it does not by itself prove the visible scene.

Verify these provisioned controls in the Shelly web interface or Shelly Smart
Control:

- `Atlas scene`
- `Atlas Apply scene`
- `Atlas Confirm observed`
- `Atlas On`
- `Atlas Off`

## 6. Restore the scene safely

When the status says the mode is unknown, physically inspect the light and call
the local `sync` command with the observed scene, or choose the matching value
in `Atlas scene` and press `Atlas Confirm observed`. Confirmation persists the
selection without operating O1. For example, after confirming the warm
2700 K / 50% scene:

```sh
curl -fsS -X POST "http://${SHELLY_IP}/rpc/Script.AtlasCommand" \
  -d "{\"id\":${SCRIPT_ID},\"command\":\"sync\",\"mode\":2}"
```

Do not use remote confirmation as a substitute for physically observing the
lamp. The Shelly cannot verify the visible output. `Atlas Apply scene` fails
closed while state is unknown; once `mode_known` and `durable_mode_known` are
true, it can safely apply the selected scene.

For ordinary remote power control, use `Atlas On` and `Atlas Off` instead of the
native `Output (0)` control. They are idempotent and operate O1 through the
managed normal-power path; an On action waits for the safe OFF interval and
preserves the tracked scene. A rapid native OFF/ON cycle bypasses that safeguard
and must be treated as a possible scene change.

There is deliberately no Cloud status component. The selector plus four action
buttons use five provisioned components and five listeners. Use
`Script.AtlasStatus` for diagnostics.

### Supervised OFF-state scene acceptance

Run this check after changing relay timing or the OFF-state scene path, with a
person present to observe the lamp:

1. Visually identify the current scene and synchronize it exactly once.
2. Turn the light off through `Atlas Off` and wait for the complete safe-OFF
   interval.
3. Select a different absolute scene and apply it once; do not use `next`.
4. Confirm the visible scene before accepting `mode_known`,
   `durable_mode_known`, and `persistent` as operationally valid.
5. Repeat separately for a two-step absolute change and for an already-on
   scene change.
6. At the first visual mismatch, stop. Do not repeat the command; inspect the
   lamp and perform one safe synchronization to the observed scene.

## Recovery checklist

If deployment did not finish successfully:

1. Do not operate O1 until the script state is understood.
2. Restore the preserved backup in 1024-byte `Script.PutCode` chunks.
3. Enable startup if needed and start the restored slot.
4. Confirm `Script.GetStatus` reports `running: true`.
5. Run `node scripts/check-shelly.js verify`.
6. Check `Script.AtlasStatus`; visually synchronize if the scene is unknown.
7. If the slot cannot start, use the Shelly web interface to paste the backup,
   then inspect its script log and device firmware before retrying.

## Reference

- [Shelly Script RPC documentation](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Script/)
- [Shelly virtual-component RPC documentation](https://shelly-api-docs.shelly.cloud/gen2/DynamicComponents/Virtual/)
- [Shelly managed virtual components](https://shelly-api-docs.shelly.cloud/gen2/Scripts/APIs/Virtual/)
