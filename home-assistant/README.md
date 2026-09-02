# Home Assistant adapter

This optional adapter represents the Philips Atlas controller as a semantic
Home Assistant light with Bright, Cool, and Warm effects. A separate preset
select allows automations to choose the next scene while the lamp is off.

The Shelly Script remains the only state machine. Home Assistant never calls
the native O1 switch and contains no relay timing, pulse, relative `next`, or
scene-progression logic.

## Exposed entities and scripts

After installation, the default entity IDs are:

| Entity | Purpose |
|---|---|
| `light.atlas_light` | Semantic power control and Bright/Cool/Warm effects. |
| `select.atlas_scene_preset` | Select a scene without turning on an off lamp. |
| `sensor.atlas_controller_status` | Controller state and operation attributes. |
| `sensor.atlas_selected_scene` | Current value of Shelly `enum:200`. |
| `binary_sensor.atlas_scene_uncertain` | Problem indicator when the scene is unknown. |
| `script.atlas_turn_on` | Stable automation target for safe power-on. |
| `script.atlas_turn_off` | Stable automation target for safe power-off. |

Home Assistant may assign a suffix when an entity ID is already occupied.
Resolve collisions before using the adapter in automations.

## Behavior

- Selecting an effect while Atlas is off changes only Shelly `enum:200`; O1
  remains off and no scene pulse is sent.
- Turning the light on applies the selected scene with one absolute
  `set(mode)` controller command.
- Selecting an effect while Atlas is on applies it with the same absolute
  controller path.
- Turning the light off uses the controller's `off` command.
- The adapter serializes operations, correlates the returned `operation_id`,
  and validates the final relay, scene, persistence, and error state.
- When the scene is unknown or persistence is degraded, scene application
  fails closed. Visually inspect the lamp and use the controller's safe-sync
  procedure before continuing.

`command: on` intentionally preserves the controller's applied scene and does
not consume `enum:200`. The adapter therefore uses absolute `set(mode)` when
turning on a preset scene.

## Prerequisites

1. Deploy and verify the Shelly controller first, including its five virtual
   components. See the main [deployment runbook](../docs/deployment-runbook.md).
2. Confirm Home Assistant can reach the Shelly over a trusted local network.
3. Know the Shelly IP address and the controller's script-slot ID.
4. Back up `/config` using the method appropriate for your Home Assistant
   installation.

The examples assume controller script slot `1` and fixed Atlas virtual enum
ID `200`. The enum ID is provisioned by this repository. If the script uses a
different slot, change both documented `"id": 1` occurrences in
`atlas-rest-command.yaml` and `atlas-rest.yaml`.

## 1. Copy the adapter files

Copy these files into a directory below `/config`, for example
`/config/atlas`:

```text
atlas-rest-command.yaml
atlas-rest.yaml
atlas-template.yaml
scripts.yaml
```

Do not copy `secrets.example.yaml` over an existing `secrets.yaml`.

## 2. Configure the Shelly URLs

Copy the four keys from `secrets.example.yaml` into `/config/secrets.yaml` and
replace the documentation address `192.0.2.10` with the Shelly's local IP.
Do not commit the resulting `secrets.yaml`.

These examples assume that Shelly authentication is disabled on the trusted
LAN. If authentication is enabled, configure supported Home Assistant REST
authentication without storing credentials in these tracked files.

## 3. Include the YAML

For a configuration that does not already define these top-level keys, add:

```yaml
rest: !include atlas/atlas-rest.yaml
rest_command: !include atlas/atlas-rest-command.yaml
template: !include atlas/atlas-template.yaml
script: !include atlas/scripts.yaml
```

Never add a duplicate top-level key. Most installations already have a
`script:` include, and many already define `template:`. In that case, merge
the Atlas dictionaries or lists into the existing included files, or use
Home Assistant's directory merge includes:

```yaml
rest: !include_dir_merge_list rest/
template: !include_dir_merge_list templates/
rest_command: !include_dir_merge_named rest_commands/
script: !include_dir_merge_named scripts/
```

Place `atlas-rest.yaml` and `atlas-template.yaml` in the corresponding list
directories. Place `atlas-rest-command.yaml` and `scripts.yaml` in the
corresponding named directories. Files used with `!include_dir_merge_list`
must retain their leading list markers (`-`).

See Home Assistant's
[configuration splitting documentation](https://www.home-assistant.io/docs/configuration/splitting_configuration/)
before changing an existing include layout.

## 4. Check configuration before restart

Run the configuration check appropriate for the installation. For Home
Assistant Container, a typical command is:

```sh
docker exec homeassistant python -m homeassistant --script check_config --config /config
```

Read the complete output and resolve every Atlas or YAML error; do not rely on
the exit code alone. Only then restart Home Assistant using the normal method
for the installation.

## 5. Verify without operating the lamp

Confirm that all entities and both REST commands exist. Inspect
`sensor.atlas_controller_status` and require:

```text
initialized: true
busy: false
persistence_busy: false
relay_error: null
mode_known: true
durable_mode_known: true
persistent: true
```

If any scene-confidence field is false, stop. Visually inspect the lamp and
perform exactly one safe sync through the documented controller procedure.

## 6. Supervised functional test

Run scene tests only while someone can see the lamp:

1. Start from a visually confirmed, synchronized scene.
2. Turn Atlas off through `script.atlas_turn_off`.
3. Choose Bright in `select.atlas_scene_preset`; verify that O1 remains off.
4. Run `script.atlas_turn_on`; verify Bright physically and in controller
   status.
5. Repeat separately for Cool and Warm.
6. Test an effect change while the light is already on.
7. At the first mismatch, stop. Never repeat `next` or another scene command
   blindly; visually inspect and safe-sync once.

For a wall-switch automation, call the preset select first and the stable
turn-on script second:

```yaml
actions:
  - action: select.select_option
    target:
      entity_id: select.atlas_scene_preset
    data:
      option: Bright
  - action: script.atlas_turn_on
```

## Security and HomeKit

- Keep Shelly RPC on a trusted local network; never expose it directly to the
  internet.
- Do not target the Shelly's native O1 entity from Home Assistant.
- Do not publish both the native Shelly switch and `light.atlas_light` through
  the same HomeKit bridge.
- Decide explicitly whether to export the semantic light; this repository does
  not configure a HomeKit bridge.

## Upstream Home Assistant references

- [Template integration](https://www.home-assistant.io/integrations/template/)
- [RESTful integration](https://www.home-assistant.io/integrations/rest/)
- [RESTful command](https://www.home-assistant.io/integrations/rest_command/)
- [Splitting configuration](https://www.home-assistant.io/docs/configuration/splitting_configuration/)
