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
  locally before making a remote scene selection.

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

## 2. Validate the source

Run these checks before touching the device:

```sh
node --check atlas-controller.js
node --check tests/controller.test.js
node tests/controller.test.js
git diff --check
```

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
2. Split `atlas-controller.js` into chunks no larger than 1024 bytes.
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
```

The first response must report `running: true`. The Atlas status response must
be valid and identify its initialization and scene-state fields. With the
current controller, a restart may return `mode_known: false` and
`durable_mode_known: false`; this is intentional uncertainty protection, not a
deployment failure.

On firmware that supports managed virtual components, verify these controls in
the Shelly web interface or Shelly Smart Control:

- `Atlas select Bright`
- `Atlas select Cool`
- `Atlas select Warm`
- `Atlas scene status`

## 6. Restore the scene safely

When the status says the mode is unknown, physically inspect the light and call
the local `sync` command with the observed scene. For example, after confirming
the warm 2700 K / 50% scene:

```sh
curl -fsS -X POST "http://${SHELLY_IP}/rpc/Script.AtlasCommand" \
  -d "{\"id\":${SCRIPT_ID},\"command\":\"sync\",\"mode\":2,\"request_id\":\"deployment-sync-warm\"}"
```

Do not use a remote scene-select button as a substitute for this physical
confirmation. Once `mode_known` and `durable_mode_known` are true, the virtual
controls can safely select scenes again.

## Recovery checklist

If deployment did not finish successfully:

1. Do not operate O1 until the script state is understood.
2. Restore the preserved backup in 1024-byte `Script.PutCode` chunks.
3. Enable startup if needed and start the restored slot.
4. Confirm `Script.GetStatus` reports `running: true`.
5. Check `Script.AtlasStatus`; visually synchronize if the scene is unknown.
6. If the slot cannot start, use the Shelly web interface to paste the backup,
   then inspect its script log and device firmware before retrying.

## Reference

- [Shelly Script RPC documentation](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Script/)
- [Shelly managed virtual components](https://shelly-api-docs.shelly.cloud/gen2/Scripts/APIs/Virtual/)
