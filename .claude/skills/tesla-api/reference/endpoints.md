# Tesla Fleet API endpoint reference

This file has two halves:

1. **Full catalogue** — every endpoint Tesla documents, grouped by the seven
   categories its docs use. Use this to answer "does an endpoint for X exist?"
2. **Project detail** — the subset `backend/app/tesla/fleet.py` actually calls,
   with payloads, quirks and per-row sourcing. Use this to answer "what does
   this repo send, and why?"

Base URLs come from `backend/app/config.py`: `tesla_fleet_base` (default
`https://fleet-api.prd.eu.vn.cloud.tesla.com`) for plain Fleet API calls,
`tesla_proxy_url` (default `https://tesla-proxy:4443`) for signed vehicle
commands via the self-hosted `vehicle-command` HTTP proxy.

Sourcing: rows marked **Tesla docs** were confirmed against
developer.tesla.com/docs/fleet-api pages (fetched via the `r.jina.ai` reader
proxy — the site 403s a plain fetch) during this skill's research, August 2026.
Rows marked **community** were confirmed against `tesla-api.timdorr.com`,
GitHub (`teslamotors/vehicle-command` source, issues/discussions), or
TeslaMotorsClub threads because Tesla's own docs don't state that detail.
Rows marked **UNVERIFIED** are what `fleet.py` sends, unconfirmed against any
outside source — treat with more suspicion.

---

# Part 1 — Full endpoint catalogue (Tesla docs categories)

Doc URL pattern: `https://developer.tesla.com/docs/fleet-api/endpoints/<category>`
— e.g. https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-endpoints.
Category slugs are `charging-endpoints`, `energy`, `partner-endpoints`,
`user-endpoints`, `vehicle-commands`, `vehicle-endpoints`, `vehicle-management`.
Note the odd one out: Energy is `/endpoints/energy`, **not** `energy-endpoints`
(that URL 404s).

All paths below are relative to `tesla_fleet_base`. Tesla's docs write the
vehicle path parameter as `{vin}`; the plain Fleet API accepts either the VIN or
the numeric vehicle id, while the signing proxy requires the VIN (see Part 2).
✅ marks endpoints this project calls — full detail in Part 2.

## How to read the request/response columns

**Tesla's own endpoint pages publish no request-parameter tables and no
response bodies at all** — checked page by page, Aug 2026. Each endpoint gets a
one-line description and nothing else; the only field-level thing Tesla
publishes is the error table below. So the field columns are sourced, in this
order of authority:

- **proxy** — `teslamotors/vehicle-command`'s `pkg/proxy/command.go`, fetched
  raw (Aug 2026). Authoritative for signed commands: it is literally the code
  that parses the JSON body this project sends, so its field names and
  required/optional flags are the real contract.
- **docs-inline** — a field name Tesla's prose description happens to mention
  (e.g. `actuate_trunk`'s `which_trunk: "front"`).
- **community** — `Teslemetry/tesla_fleet_api` (a maintained Fleet API client)
  and `tesla-api.timdorr.com`. Used only where no primary source exists.
- **UNVERIFIED** — no source found. Left explicitly empty rather than guessed,
  per SKILL.md §1.4 ("a short accurate table beats a complete invented one").

Where the proxy and the community client disagree, **the proxy wins** for
anything this project sends — everything signed goes through it. Those
disagreements are recorded inline rather than silently resolved; two of them are
real traps (`remote_seat_heater_request`, `set_temps`).

### The response envelope

Not documented by Tesla anywhere, but it is what `fleet.py` parses and what
every community client expects. Commands return:

```json
{"response": {"result": true, "reason": ""}}
```

`result: false` with a human-readable `reason` arrives with **HTTP 200**, not an
error status — see SKILL.md §4.4. Read endpoints wrap their payload under the
same top-level `"response"` key. Beyond that, per-endpoint response fields are
undocumented; where a response shape is known it is given in the row, otherwise
the column says UNVERIFIED and that is the honest state of it.

### Error responses (the one documented field-level thing)

From https://developer.tesla.com/docs/fleet-api/getting-started/conventions
(Tesla docs, verified Aug 2026):

| Status | Name | Error codes / conditions |
|---|---|---|
| 400 | Bad Request | `invalid_command`, `invalid_field`, `invalid_request`, `invalid_auth_code`, `invalid_redirect_url`, `unsupported_grant_type`, `unauthorized_client` |
| 401 | Unauthorized | `mobile_access_disabled`, `login_required`; empty body means an expired OAuth token |
| 402 | Payment Required | Payment required for API use (non-free accounts) |
| 403 | Forbidden | Insufficient scopes, or Tesla Vehicle Command Protocol required |
| 404 | Not Found | Requested resource does not exist |
| 405 | Not Allowed | Operation not permitted |
| 406 | Not Acceptable | Missing `Content-Type: application/json` header |
| 408 | Device Not Available | Vehicle not online when the request was made |
| 412 | Precondition Failed | Unregistered account or unmet conditions |
| 418 | Client Too Old | Mobile app requires update (Tesla App only) |
| 421 | Incorrect Region | User not present in current region |
| 422 | Invalid Resource | Semantic/data problems; vehicle may lack protocol support |
| 423 | Locked | Account locked by Tesla |
| 429 | Rate Limited | "Check the 'RateLimit-Reset' or 'Retry-After' request headers to determine when to make the next request." |
| 451 | Resource Unavailable | Privacy setting violations |
| 499 | Client Closed Request | Client terminated before server response |

Two of these are already load-bearing in this repo: `408` is `VehicleAsleepError`
(SKILL.md §4.2), and `403` is the scope-bucket check (§3). `406` is worth
remembering — a command that omits the JSON content type fails as
"Not Acceptable", which does not read like a header problem.

## Charging Endpoints

https://developer.tesla.com/docs/fleet-api/endpoints/charging-endpoints

| Endpoint | Method | Path | Request fields | Response |
|---|---|---|---|---|
| ✅ `charging_history` | GET | `/api/1/dx/charging/history` | Query, all optional (community): `vin` str, `startTime` str, `endTime` str, `pageNo` int, `pageSize` int, `sortBy` str, `sortOrder` str. Note the camelCase — unlike every other endpoint here | Paginated. Field shape UNVERIFIED |
| `charging_invoice` | GET | `/api/1/dx/charging/invoice/{id}` | `{id}` in path, from a charging-history event | **PDF bytes, not JSON** (Tesla docs: "Returns a charging invoice pdf") |
| `charging_sessions` | GET | `/api/1/dx/charging/sessions` | Query, all optional (community): `vin` str, `date_from` str, `date_to` str, `limit` int, `offset` int | UNVERIFIED. Business fleet accounts only |

Account-scoped (`/dx/`), not vehicle-scoped — no vehicle id in the path.
Descriptions: Tesla docs. Parameters: `Teslemetry/tesla_fleet_api` (community) —
Tesla publishes none. `charging_invoice` is the only endpoint in this whole
reference that does not return JSON.

## Energy Endpoints

https://developer.tesla.com/docs/fleet-api/endpoints/energy

None used by this project — it is a vehicle-only app and requests neither
`energy_device_data` nor `energy_cmds` scope.

| Endpoint | Method | Path | Request fields | Response |
|---|---|---|---|---|
| Backup history | GET | `/api/1/energy_sites/{energy_site_id}/calendar_history` | Query: `kind=backup` (required), `start_date`, `end_date`, `period`, `time_zone` | "The backup (off-grid) event history of the site in duration of **seconds**." Field shape UNVERIFIED |
| Charging history | GET | `/api/1/energy_sites/{energy_site_id}/telemetry_history` | Query: `kind=charge` (required), `start_date` (required), `end_date` (required), `time_zone` | Wall-connector charging history, **watt hours**. Field shape UNVERIFIED |
| Energy history | GET | `/api/1/energy_sites/{energy_site_id}/calendar_history` | Query: `kind=energy` (required), `start_date`, `end_date`, `period`, `time_zone` | Site energy measurements aggregated to `period`, **watt hours**. Field shape UNVERIFIED |
| Live status | GET | `/api/1/energy_sites/{energy_site_id}/live_status` | none | "Power, state of energy, grid status, storm mode." **Watts** and watt hours. Field shape UNVERIFIED |
| Products | GET | `/api/1/products` | none | "Returns products mapped to user." Field shape UNVERIFIED |
| Site info | GET | `/api/1/energy_sites/{energy_site_id}/site_info` | none | "Assets (has solar, etc), settings (backup reserve, etc), and features" — docs name `storm_mode_capable` as one feature flag |
| Time of use settings | POST | `/api/1/energy_sites/{energy_site_id}/time_of_use_settings` | Body: `settings` object; community client wraps it as `tou_settings.tariff_content_v2` | Command envelope |

Units are the trap here: energy in watt hours, power in watts, backup history in
seconds. Query parameters above are community-sourced
(`Teslemetry/tesla_fleet_api`) except the `kind` values, which Tesla's own paths
show inline.

**Correction to an earlier draft of this file**, which claimed third-party
write-ups listing `/backup`, `/operation`, `/storm_mode`,
`/grid_import_export` and `/off_grid_vehicle_charging_reserve` were simply
wrong. They are not on Tesla's docs page — that part was verified by grepping
the fetched page — but a *currently maintained* client implements all five
against live endpoints:

| Endpoint | Method | Path | Request fields (community only) |
|---|---|---|---|
| Backup reserve | POST | `/api/1/energy_sites/{id}/backup` | `backup_reserve_percent` int (required) |
| Operation mode | POST | `/api/1/energy_sites/{id}/operation` | `default_real_mode` (required) — `autonomous` = time-based control, `self_consumption` = self-powered |
| Storm mode | POST | `/api/1/energy_sites/{id}/storm_mode` | `enabled` bool (required) |
| Grid import/export | POST | `/api/1/energy_sites/{id}/grid_import_export` | `disallow_charge_from_grid_with_solar_installed` bool, `customer_preferred_export_rule` |
| Off-grid EV charging reserve | POST | `/api/1/energy_sites/{id}/off_grid_vehicle_charging_reserve` | `off_grid_vehicle_charging_reserve_percent` int (required) |

So: undocumented-but-apparently-real, not obsolete. Treat as community-only.
There is also a whole gRPC-over-REST surface
(`POST /api/1/energy_sites/{id}/command` with `command_type: "grpc_command"`)
for firmware/networking/authorized-key operations — entirely undocumented by
Tesla, out of scope here, and irrelevant to a vehicle-only app.

## Partner Endpoints

https://developer.tesla.com/docs/fleet-api/endpoints/partner-endpoints

All require a **partner authentication token**, not a user token. None used by
this project at runtime, but `Register Partner Account` is the one-time step
that makes the app usable at all, and `Get Public Key` is the fastest way to
check virtual-key hosting (see Part 2's setup notes).

| Endpoint | Method | Path | Request fields | Response |
|---|---|---|---|---|
| Register Partner Account | POST | `/api/1/partner_accounts` | Body: `domain` str (required) — the domain hosting the public key (community) | UNVERIFIED. Registers the app; one-time step |
| Get Public Key | GET | `/api/1/partner_accounts/public_key` | Query: `domain` str | Returns the public key registered for that domain — use it to confirm registration succeeded |
| Get Fleet Telemetry Errors | GET | `/api/1/partner_accounts/fleet_telemetry_errors` | Query: `domain` str (required, per community client) | Recent telemetry errors reported by vehicles after receiving the config. Field shape UNVERIFIED |
| Get Fleet Telemetry Error VINs | GET | `/api/1/partner_accounts/fleet_telemetry_error_vins` | UNVERIFIED — not implemented by the community client either | A list of VINs with telemetry errors. Field shape UNVERIFIED |

Partner tokens come from a separate `client_credentials` grant, not the user
OAuth flow this app uses: `POST https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token`
with `grant_type=client_credentials`, `client_id`, `client_secret`, `audience`
(the regional Fleet API base URL), and optional `scope` (community).

`Get Public Key` is the cheapest check that virtual-key hosting is intact — it
asks Tesla what it has on file for the domain, which is exactly the question
worth answering before blaming the proxy for a "not been paired" error
(SKILL.md §4.3).

## User Endpoints

https://developer.tesla.com/docs/fleet-api/endpoints/user-endpoints

All require user context and are **incompatible with third-party business
tokens** (Tesla docs). None currently called by `fleet.py`; all four are covered
by the `user_data` scope this project already requests.

| Endpoint | Method | Path | Request fields | Response |
|---|---|---|---|---|
| Feature Config | GET | `/api/1/users/feature_config` | none | "Any custom feature flag applied to a user." Field shape UNVERIFIED |
| Me | GET | `/api/1/users/me` | none | "A summary of a user's account." Field shape UNVERIFIED — community clients return it untyped. Covered by `user_data` scope, whose docs list contact info, home address, profile picture and referral info |
| Orders | GET | `/api/1/users/orders` | none | "The active orders for a user." Field shape UNVERIFIED |
| Region | GET | `/api/1/users/region` | none | The user's region **and the correct fleet-api base URL for it** |

No endpoint here takes any parameter — all four are bare GETs on the user's own
token. The community client also exposes an undocumented
`GET /api/1/users/backup_key`, which is not on Tesla's page.

`GET /api/1/users/region` is the documented way to discover the correct regional
base URL rather than hardcoding it — this project hardcodes the EU base in
`tesla_fleet_base`, which is fine for one owner in one region but is the thing
to call if the account ever moves.

## Vehicle Commands

https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-commands

All are `POST /api/1/vehicles/{vin}/command/{name}`. Everything here needs the
signing proxy except the handful noted in Part 2 as `ErrCommandUseRESTAPI`.

All return the command envelope `{"response": {"result": bool, "reason": str}}`.
Source tags in the fields column: **(p)** proxy source, **(c)** community client,
**(d)** named inline in Tesla's own description. `—` means the command takes no
body. ⚠ marks a proxy/community disagreement that would actually break a call.

| Command | Used | Request body fields | Description (Tesla docs) |
|---|---|---|---|
| `actuate_trunk` | ✅ | `which_trunk` str, optional — `"front"`/`"rear"`, defaults to rear when absent (p, d) | Controls front or rear trunk. |
| `add_charge_schedule` | ✅ | `days_of_week` str req, `enabled` bool req, `lat` f64 req, `lon` f64 req, `start_enabled` bool req, `start_time` f64 opt, `end_enabled` bool req, `end_time` f64 opt, `one_time` bool opt, `id` f64 opt (p); community also sends `name` str opt | Add vehicle charging schedule. |
| `add_precondition_schedule` | ✅ | `days_of_week` str req, `enabled` bool req, `lat` f64 req, `lon` f64 req, `precondition_time` f64 req, `one_time` bool opt, `id` f64 opt (p); community also sends `name` str opt | Add or modify preconditioning schedule. |
| `adjust_volume` | ✅ | `volume` f64 req (p) | Adjusts media playback volume. Requires user presence. |
| `auto_conditioning_start` | ✅ | — | Starts climate preconditioning. |
| `auto_conditioning_stop` | ✅ | — | Stops climate preconditioning. |
| `cancel_software_update` | ✅ | — | Cancels software update countdown. |
| `charge_max_range` | | — | Charges in max range mode. |
| `charge_port_door_close` | ✅ | — | Closes charge port door. |
| `charge_port_door_open` | ✅ | — | Opens charge port door. |
| `charge_standard` | | — | Charges in Standard mode. |
| `charge_start` | ✅ | — | Starts vehicle charging. |
| `charge_stop` | ✅ | — | Stops vehicle charging. |
| `clear_pin_to_drive_admin` | | — (p); community sends `pin` str opt | Deactivates PIN to Drive (firmware 2023.44+). |
| `door_lock` | ✅ | — | Locks the vehicle. |
| `door_unlock` | ✅ | — | Unlocks the vehicle. |
| `erase_user_data` | | — | Erases user interface data in Guest Mode. |
| `flash_lights` | ✅ | — | Briefly flashes headlights. Vehicle must be in park. |
| `guest_mode` | | `enable` bool req (p) | Restricts UI functionality and enables guest access setup. |
| `honk_horn` | ✅ | — | Honks vehicle horn. Vehicle must be in park. |
| `media_next_fav` | ✅ | — | Advances to next favorite track. |
| `media_next_track` | ✅ | — | Advances to next track. |
| `media_prev_fav` | ✅ | — | Advances to previous favorite track. |
| `media_prev_track` | ✅ | — | Advances to previous track. |
| `media_toggle_playback` | ✅ | — | Toggles play/pause state. |
| `media_volume_down` | ✅ | — | Turns volume down by one. |
| `media_volume_up` | ✅ | — | Turns volume up by one. |
| `navigation_gps_request` | ✅ | `lat` f req, `lon` f req, `order` int opt (default 0) (c) | Start navigation to given coordinates. **Unsigned** — no case at all in the proxy. |
| `navigation_request` | | `value` str req, `type` str opt (default `"share_ext_content_raw"`), `locale` str opt, `timestamp_ms` int opt (c) | Sends location to in-vehicle navigation. **Unsigned** — proxy returns `ErrCommandUseRESTAPI`. Note this is the same payload `fleet.py` posts to `share`. |
| `navigation_sc_request` | | `id` int req, `order` int opt (c) | Start navigation to supercharger. |
| `navigation_waypoints_request` | | UNVERIFIED — no source found | Sends waypoint list to navigation system. |
| `parental_controls_activate` | | `pin` str req (p) | Activates Parental Controls with four-digit PIN. |
| `parental_controls_clear_pin_admin` | | — | Clears parental controls PIN. |
| `parental_controls_deactivate` | | `pin` str req (p) | Deactivates Parental Controls. |
| `parental_controls_enable_setting` | | `setting` str req, `enable` bool req (p) | Enables/disables a parental controls setting. |
| `parental_controls_set_speed_limit` | | `limit_mph` f64 req (p) | Sets parental controls speed limit (mph). |
| `remote_auto_seat_climate_request` | | `auto_seat_position` f64 req, `auto_climate_on` bool req (p) | Sets automatic seat heating/cooling. |
| `remote_auto_steering_wheel_heat_climate_request` | | `on` bool req (c) — absent from the proxy | Sets automatic steering wheel heating. |
| `remote_boombox` | | `sound` int req (c) — docs note IDs 0 and 2000 | Plays sound via external speaker. Proxy returns `ErrCommandNotImplemented`: unusable through the proxy at all. |
| `remote_seat_cooler_request` | | `seat_position` f64 req, `seat_cooler_level` f64 req (p) | Sets seat cooling. |
| `remote_seat_heater_request` | ✅ | `seat_position` f64 req, `level` f64 req (p). ⚠ the community client sends `seat_heater_level` instead — the proxy reads **`level`**, which is what `fleet.py` sends | Sets seat heating. Requires preconditioning or climate keeper on. |
| `remote_start_drive` | | — | Starts vehicle remotely. |
| `remote_steering_wheel_heat_level_request` | | `level` int req (c) — absent from the proxy | Sets steering wheel heat level. |
| `remote_steering_wheel_heater_request` | ✅ | `on` bool req (p) | Sets steering wheel heating on/off. |
| `remove_charge_schedule` | ✅ | `id` f64 req (p) | Remove charge schedule by ID. |
| `remove_precondition_schedule` | ✅ | `id` f64 req (p) | Remove precondition schedule by ID. |
| `reset_pin_to_drive_pin` | | — | Removes PIN to Drive. |
| `reset_valet_pin` | | — | Removes Valet Mode PIN. |
| `schedule_software_update` | ✅ | `offset_sec` f64 req (p) | Schedules OTA software update. |
| `set_bioweapon_mode` | | `on` bool req, `manual_override` bool req (p) | Turns Bioweapon Defense Mode on/off. |
| `set_cabin_overheat_protection` | ✅ | `on` bool req, `fan_only` bool opt (p; the community client marks it required) | Sets overheat protection. |
| `set_charge_limit` | ✅ | `percent` f64 req (p) | Sets vehicle charge limit. |
| `set_charging_amps` | ✅ | `charging_amps` f64 req (p) | Sets vehicle charging amps. |
| `set_climate_keeper_mode` | ✅ | `climate_keeper_mode` f64 req, 0-3, `manual_override` bool opt (p) | Enables climate keeper. 0 Off, 1 Keep, 2 Dog, 3 Camp. |
| `set_cop_temp` | ✅ | `cop_temp` f64 req, 0-2 (p) | Cabin Overheat Protection temperature. 0 Low, 1 Medium, 2 High. |
| `set_pin_to_drive` | | `on` bool req, `password` str opt (p) | Sets four-digit PIN to Drive passcode. |
| `set_preconditioning_max` | ✅ | `on` bool req, `manual_override` bool opt (p) | Sets preconditioning override. |
| `set_scheduled_charging` | | `enable` bool req, `time` f64 opt — minutes after midnight (p) | **Deprecated** — "not recommended beginning with firmware version 2024.26." |
| `set_scheduled_departure` | | `enable` bool req, `departure_time` f64 opt, `preconditioning_enabled` bool opt, `preconditioning_weekdays_only` bool opt, `off_peak_charging_enabled` bool opt, `off_peak_charging_weekdays_only` bool opt, `end_off_peak_time` f64 opt — all times minutes after midnight (p) | **Deprecated** — "not recommended beginning with firmware version 2024.26." |
| `set_sentry_mode` | ✅ | `on` bool req (p) | Enables/disables Sentry Mode. |
| `set_temps` | ✅ | `driver_temp` f64 opt, `passenger_temp` f64 opt (p). ⚠ the community client marks both required | Sets cabin temperature for driver/passenger zones. |
| `set_valet_mode` | | `on` bool req, `password` str opt (p) | Turns on Valet Mode with four-digit passcode. |
| `set_vehicle_name` | | `vehicle_name` str req (p) | Changes vehicle name. |
| `speed_limit_activate` | | `pin` str req (p) | Activates Speed Limit Mode with four-digit PIN. |
| `speed_limit_clear_pin` | | `pin` str req (p) | Deactivates Speed Limit Mode. |
| `speed_limit_clear_pin_admin` | | — | Deactivates Speed Limit Mode (firmware 2023.38+). |
| `speed_limit_deactivate` | | `pin` str req (p) | Deactivates Speed Limit Mode. |
| `speed_limit_set_limit` | | `limit_mph` f64 req (p) | Sets maximum speed for Speed Limit Mode (mph). |
| `sun_roof_control` | | `state` str req — `stop`/`close`/`vent` (c) — absent from the proxy | Controls sunroof. Not applicable to this Model 3. |
| `trigger_homelink` | ✅ | `lat` f64 req, `lon` f64 req (p); the community client also allows `token` str opt | Turns on HomeLink for garage door control. |
| `upcoming_calendar_entries` | | `calendar_data` str req (c) — absent from the proxy | Retrieves upcoming calendar entries. |
| `window_control` | ✅ | `command` str req — `"vent"`/`"close"` (p); the community client also allows `lat`/`lon` f opt | Controls windows. |

`share` — the command `fleet.py` uses for `set_navigation_destination` — is
**not** on this docs page; only `navigation_request` is. See Part 2 for why the
project uses `share` anyway and what backs that choice. New corroboration from
this pass: the community client sends `fleet.py`'s exact payload
(`value` + `type: "share_ext_content_raw"` + `locale` + `timestamp_ms`) to
`navigation_request`, so the payload shape is confirmed twice over even though
the endpoint name it belongs on is not.

Three more commands exist in the community client but not on Tesla's page:
`take_drivenote` (`note` str), `batch_remove_charge_schedules` and
`batch_remove_precondition_schedules` (both `home`/`work`/`other` bool). Not
Tesla-documented — treat as community-only if ever needed.

## Vehicle Endpoints

https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-endpoints

| Endpoint | Method | Path | Request fields | Response |
|---|---|---|---|---|
| ✅ List Vehicles | GET | `/api/1/vehicles` | Query: `page` int opt, `per_page` int opt (c) | Array of vehicle summaries under `response`; paginated, default page size 100 (Tesla docs). Per-item fields: see the top-level keys of Vehicle Data below |
| Get Vehicle Info | GET | `/api/1/vehicles/{vin}` | none | One vehicle summary. Field shape UNVERIFIED |
| ✅ Vehicle Data | GET | `/api/1/vehicles/{vin}/vehicle_data` | Query: `endpoints` — `;`-separated list, e.g. `drive_state;location_data`, `charge_schedule_data;preconditioning_schedule_data` | Large nested object — see the field breakdown below |
| ✅ Wake Vehicle | POST | `/api/1/vehicles/{vin}/wake_up` | none | Vehicle summary with `state` (`asleep`/`online`) |
| ✅ Nearby Charging Sites | GET | `/api/1/vehicles/{vin}/nearby_charging_sites` | Query: `count` int opt, `radius` int opt, `detail` bool opt (c) | Superchargers/destination chargers near the car. Field shape UNVERIFIED |
| ✅ Recent Alerts | GET | `/api/1/vehicles/{vin}/recent_alerts` | none | "List of recent alerts". Field shape UNVERIFIED |
| ✅ Release Notes | GET | `/api/1/vehicles/{vin}/release_notes` | Query: `staged` bool opt, `language` int opt (c) | Firmware release notes. Field shape UNVERIFIED |
| Mobile Access Status | GET | `/api/1/vehicles/{vin}/mobile_enabled` | none | Whether mobile access is enabled |
| Service Data | GET | `/api/1/vehicles/{vin}/service_data` | none | Service status of the vehicle. Field shape UNVERIFIED |
| Get Drivers | GET | `/api/1/vehicles/{vin}/drivers` | none | All allowed drivers. Owner-only endpoint |
| Remove Driver Access | DELETE | `/api/1/vehicles/{vin}/drivers` | Query: `share_user_id` opt (c) — omit to remove yourself | Command envelope. Share users can only remove themselves |
| Get Invitations | GET | `/api/1/vehicles/{vin}/invitations` | Pagination UNVERIFIED; max page size 25 (Tesla docs) | Active share invites |
| Create Invitation | POST | `/api/1/vehicles/{vin}/invitations` | none (c) | A single-use share link, expires after 24 h; up to five drivers at once |
| Revoke Invitation | POST | `/api/1/vehicles/{vin}/invitations/{id}/revoke` | `{id}` in path | Command envelope |
| Redeem Invitation | POST | `/api/1/invitations/redeem` | Body: `code` str req (c) | Command envelope |
| Send Signed Command | POST | `/api/1/vehicles/{vin}/signed_command` | Body: `routable_message` — base64 protobuf (c) | Protocol-level; this is what the proxy posts on your behalf |
| Fleet Status | POST | `/api/1/vehicles/fleet_status` | Body: `vins` array of str, req (c) | Per-VIN state incl. whether the virtual key is paired |
| Configure Fleet Telemetry | POST | `/api/1/vehicles/fleet_telemetry_config` | Body: `config` object req (c) | Command envelope |
| Configure Telemetry via JWS | POST | `/api/1/vehicles/fleet_telemetry_config_jws` | Signed config token. Shape UNVERIFIED | Tesla docs advise against direct use |
| Fetch Telemetry Config | GET | `/api/1/vehicles/{vin}/fleet_telemetry_config` | none | Config plus sync status |
| Remove Telemetry Config | DELETE | `/api/1/vehicles/{vin}/fleet_telemetry_config` | none | Command envelope |
| Get Telemetry Errors | GET | `/api/1/vehicles/{vin}/fleet_telemetry_errors` | none | Recent telemetry errors for that vehicle |

### `vehicle_data` response fields

The one response body worth spelling out, since it is the only read this project
depends on heavily. **Community-sourced** (`tesla-api.timdorr.com`) and
originally documented against the older Owner API, so treat it as the shape to
expect rather than a guarantee — Fleet API adds keys (e.g. `charge_schedule_data`,
`preconditioning_schedule_data`) that this list predates. Tesla publishes no
field list of its own; its docs point at `vehicle_data.proto` in the
fleet-telemetry repo instead.

Top level: `id`, `user_id`, `vehicle_id`, `vin`, `display_name`, `color`,
`access_type`, `tokens`, `state`, `in_service`, `id_s`, `calendar_enabled`,
`api_version`, `backseat_token`, `backseat_token_updated_at`, plus the six
nested objects below.

- **`charge_state`** — `battery_level`, `usable_battery_level`, `battery_range`,
  `est_battery_range`, `ideal_battery_range`, `charging_state`, `charge_limit_soc`
  (+`_max`/`_min`/`_std`), `charge_amps`-adjacent `charge_current_request`
  (+`_max`), `charger_actual_current`, `charger_power`, `charger_voltage`,
  `charger_phases`, `charger_pilot_current`, `charge_rate`, `charge_energy_added`,
  `charge_miles_added_ideal`/`_rated`, `charge_port_door_open`,
  `charge_port_latch`, `charge_port_cold_weather_mode`, `charge_enable_request`,
  `user_charge_enable_request`, `charge_to_max_range`, `max_range_charge_counter`,
  `minutes_to_full_charge`, `time_to_full_charge`, `conn_charge_cable`,
  `fast_charger_present`, `fast_charger_brand`, `fast_charger_type`,
  `trip_charging`, `battery_heater_on`, `not_enough_power_to_heat`,
  `scheduled_charging_pending`, `scheduled_charging_start_time`,
  `managed_charging_active`, `managed_charging_start_time`,
  `managed_charging_user_canceled`, `timestamp`
- **`climate_state`** — `inside_temp`, `outside_temp`, `driver_temp_setting`,
  `passenger_temp_setting`, `min_avail_temp`, `max_avail_temp`, `is_climate_on`,
  `is_auto_conditioning_on`, `is_preconditioning`, `climate_keeper_mode`,
  `defrost_mode`, `is_front_defroster_on`, `is_rear_defroster_on`, `fan_status`,
  `seat_heater_left`, `seat_heater_right`, `side_mirror_heaters`,
  `wiper_blade_heater`, `battery_heater`, `battery_heater_no_power`,
  `bioweapon_mode`, `left_temp_direction`, `right_temp_direction`,
  `remote_heater_control_enabled`, `timestamp`
- **`drive_state`** — `latitude`, `longitude`, `heading`, `gps_as_of`, `speed`,
  `power`, `shift_state`, `native_latitude`, `native_longitude`, `native_type`,
  `native_location_supported`, `timestamp`. **Requires the `location_data`
  endpoint parameter** on firmware 2023.38+, and requesting it shows a
  location-sharing icon on the car's screen
- **`vehicle_state`** — `locked`, `odometer`, `car_version`, `sentry_mode`,
  `sentry_mode_available`, `df`/`dr`/`pf`/`pr` (doors), `ft`/`rt` (trunks),
  `fd_window`/`fp_window`/`rd_window`/`rp_window`, `is_user_present`,
  `media_state`, `software_update`, `speed_limit_mode`, `valet_mode`,
  `valet_pin_needed`, `remote_start`, `remote_start_enabled`,
  `remote_start_supported`, `homelink_device_count`, `homelink_nearby`,
  `center_display_state`, `sun_roof_percent_open`, `sun_roof_state`,
  `calendar_supported`, `parsed_calendar_supported`, `notifications_supported`,
  `smart_summon_available`, `summon_standby_mode_enabled`, `autopark_state_v2`,
  `autopark_style`, `last_autopark_error`, `api_version`, `vehicle_name`,
  `timestamp`
- **`vehicle_config`** — `car_type`, `trim_badging`, `exterior_color`,
  `roof_color`, `wheel_type`, `spoiler_type`, `seat_type`, `rear_seat_type`,
  `rear_seat_heaters`, `third_row_seats`, `charge_port_type`,
  `motorized_charge_port`, `default_charge_to_max`, `can_actuate_trunks`,
  `can_accept_navigation_requests`, `has_air_suspension`, `has_ludicrous_mode`,
  `sun_roof_installed`, `eu_vehicle`, `rhd`, `ece_restrictions`,
  `car_special_type`, `use_range_badging`, `plg`, `timestamp`
- **`gui_settings`** — `gui_distance_units`, `gui_temperature_units`,
  `gui_charge_rate_units`, `gui_range_display`, `gui_24_hour_time`,
  `show_range_units`, `timestamp`

`can_actuate_trunks` and `can_accept_navigation_requests` in `vehicle_config`
are the documented capability flags behind two commands this project sends —
worth checking before blaming a failure on the proxy.

Two worth knowing even though unused: `POST /api/1/vehicles/fleet_status` is the
documented way to check whether the virtual key is actually paired (better than
inferring it from a failed command), and the fleet-telemetry endpoints are the
push alternative to this project's polling of `vehicle_data` — relevant if the
"polling is expensive" warning ever becomes a real problem.

## Vehicle Management

https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-management

None used by this project.

| Endpoint | Method | Path | Request fields | Response |
|---|---|---|---|---|
| Get Vehicle Options | GET | `/api/1/dx/vehicles/options` | Query: `vin` str req (c) | "Vehicle option details." Field shape UNVERIFIED |
| Get Vehicle Specifications | GET | `/api/1/vehicles/{vin}/specs` | `{vin}` in path | "Vehicle specifications as recorded at the time of sale." **Partner token required.** Field shape UNVERIFIED |
| Get Warranty Details | GET | `/api/1/dx/warranty/details` | Query: `vin` str (c) | "Warranty information for a vehicle." Field shape UNVERIFIED |
| Get Subscription Eligibility | GET | `/api/1/dx/vehicles/subscriptions/eligibility` | Query: `vin` str req | "Eligible vehicle subscriptions." Field shape UNVERIFIED |
| Get Upgrade Eligibility | GET | `/api/1/dx/vehicles/upgrades/eligibility` | Query: `vin` str req | "Eligibile vehicle upgrades" [sic]. Field shape UNVERIFIED |
| Get Pricing | POST | `/api/1/dx/vehicles/pricing` | Body UNVERIFIED — takes a vehicle model and a market | "Pricing details for a vehicle model in a specific market." Field shape UNVERIFIED |
| Get Enterprise Roles | GET | `/api/1/dx/enterprise/v1/{vin}/roles` | `{vin}` in path | Enterprise roles for a vehicle. Field shape UNVERIFIED |
| Set Payer Roles | POST | `/api/1/dx/enterprise/v1/{vin}/payer` | Body UNVERIFIED | Command envelope presumed. UNVERIFIED |

This is the thinnest-sourced category in the file: Tesla documents one line
each, and the community client implements only two of the eight (`options` and
`warranty_details`), so most request bodies and every response shape here are
genuinely unknown rather than merely omitted. Confirm against a live call before
relying on any of it.

`/specs` needs a partner token and the `vehicle_specs` scope — neither of which
this project has (see the scopes section at the end).

---

# Part 2 — What this project actually calls

Scope of the tables below: every Fleet API call `backend/app/tesla/fleet.py`
makes, i.e. everything `TeslaAdapter` (`backend/app/tesla/adapter.py`) declares.

## Signed vehicle commands (via the vehicle-command proxy)

All: `POST {tesla_proxy_url}/api/1/vehicles/{VIN}/command/{name}`, VIN not
numeric id (community + `fleet.py`'s own comment on `_resolve_vehicle`).
Scope bucket per section 3 of SKILL.md is `vehicle_cmds` unless noted.

| Adapter method | Command name | Payload fleet.py sends | Source | Project note |
|---|---|---|---|---|
| `set_temperature` | `set_temps` | `{driver_temp, passenger_temp}` | Tesla docs (listed) | matches |
| `start_climate` | `auto_conditioning_start` | `{}` | Tesla docs | matches |
| `stop_climate` | `auto_conditioning_stop` | `{}` | Tesla docs | matches |
| `set_seat_heater` | `remote_seat_heater_request` | `{seat_position, level}` | Tesla docs (verified via WebFetch, Aug 2026): "Sets seat heating. Requires preconditioning or climate keeper to be on." Numeric map confirmed against `pkg/proxy/command.go`'s own source (fetched raw, Aug 2026): `seat_position` indexes into the proxy's `seatPositions` array (`[]vehicle.SeatPosition{SeatFrontLeft, SeatFrontRight, SeatSecondRowLeft, SeatSecondRowLeftBack, SeatSecondRowCenter, SeatSecondRowRight, SeatSecondRowRightBack, SeatThirdRowLeft, SeatThirdRowRight}`, used as `seatPositions[int(index)]`) | matches exactly: index 0=front_left, 1=front_right, 2=SecondRowLeft(rear_left), 4=SecondRowCenter(rear_center), 5=SecondRowRight(rear_right) — fleet.py's `{front_left:0, front_right:1, rear_left:2, rear_center:4, rear_right:5}` map is correct, confirmed against the proxy's dispatch source rather than UNVERIFIED as previously recorded; the "requires preconditioning or climate keeper" Tesla-doc requirement is exactly what fleet.py's 200 + `{result:false, reason:"cabin comfort remote settings not enabled"}` handling works around by starting climate and retrying once |
| `media_control` | `media_toggle_playback` / `media_next_track` / `media_prev_track` / `media_volume_up` / `media_volume_down` | `{}` | Tesla docs (all five listed) | matches; `play` and `pause` both map to the single toggle command since Tesla exposes no separate play/pause |
| `lock` | `door_lock` | `{}` | Tesla docs | matches |
| `unlock` | `door_unlock` | `{}` | Tesla docs | matches; gated by `actions.CONFIRM_REQUIRED` |
| `set_charge_limit` | `set_charge_limit` | `{percent}` | Tesla docs | matches; charging bucket |
| `start_charging` | `charge_start` | `{}` | Tesla docs | matches; charging bucket |
| `stop_charging` | `charge_stop` | `{}` | Tesla docs | matches; charging bucket |
| `honk` | `honk_horn` | `{}` | Tesla docs (notes: vehicle must be in park) | matches |
| `flash_lights` | `flash_lights` | `{}` | Tesla docs (notes: vehicle must be in park) | matches |
| `set_cabin_overheat_protection` | `set_cabin_overheat_protection` | `{on, fan_only}` | Tesla docs (listed) | matches |
| `set_climate_keeper_mode` | `set_climate_keeper_mode` | `{climate_keeper_mode}` int 0-3 | Tesla docs: "Values: 0-3 (Off, Keep, Dog, Camp)" | matches fleet.py's `CLIMATE_KEEPER_MODES = {off:0, on:1, dog:2, camp:3}` — fleet.py's comment says the numbers come from the proxy's own `pkg/proxy/command.go`, consistent with the doc's 0-3 range |
| `set_sentry_mode` | `set_sentry_mode` | `{on}` | Tesla docs | matches; gated by `CONFIRM_REQUIRED` |
| `control_windows` | `window_control` | `{command}` `vent`/`close` | Tesla docs (verified via WebFetch, Aug 2026): "Control the windows of a parked vehicle. Supported commands: vent and close. When closing, specify lat and lon of user to ensure they are within range of vehicle (unless this is an M3 platform vehicle)." Independently confirmed against `pkg/proxy/command.go`'s own source (fetched raw, Aug 2026), which only reads `command` and never `lat`/`lon` for this case, with the comment "Latitude and longitude are not required for vehicles that support this protocol" | matches, not a divergence: two independent sources (Tesla docs' M3 exemption, and the proxy's own code/comment) agree that no coordinates are needed for this car — `fleet.py` sending `{command}` alone is the documented-correct payload, not an unconfirmed omission |
| `actuate_trunk` | `actuate_trunk` | `{which_trunk}` `front`/`rear` | Tesla docs | matches; gated by `CONFIRM_REQUIRED` |
| `charge_port` | `charge_port_door_open` / `charge_port_door_close` | `{}` | Tesla docs (both listed) | matches |
| `trigger_homelink` | `trigger_homelink` | `{lat, lon}` — the car's own current position | Tesla docs (listed, no payload detail found) | fleet.py's comment: coordinates must be the car's own position since HomeLink matches them against the paired device at that spot — UNVERIFIED against Tesla docs directly, but consistent with how HomeLink pairing works; gated by `CONFIRM_REQUIRED` |
| `set_charging_amps` | `set_charging_amps` | `{charging_amps}` | Tesla docs | matches; charging bucket |
| `set_steering_wheel_heater` | `remote_steering_wheel_heater_request` | `{on}` | Tesla docs (listed) | matches |
| `set_preconditioning_max` | `set_preconditioning_max` | `{on, manual_override: on}` | Tesla docs (listed, no field detail found) | `manual_override` field is UNVERIFIED against Tesla docs — fleet.py's comment says it mirrors the car's own max-defrost button (overrides rather than blends) |
| `set_cop_temp` | `set_cop_temp` | `{cop_temp}` int, `{low:0, medium:1, high:2}` | Tesla docs: "Values: 0-2 (Low, Medium, High)" | matches |
| `schedule_software_update` | `schedule_software_update` | `{offset_sec}` | Tesla docs (listed) | matches; gated by `CONFIRM_REQUIRED` |
| `cancel_software_update` | `cancel_software_update` | `{}` | Tesla docs (listed) | matches; gated by `CONFIRM_REQUIRED` |
| `set_volume` | `adjust_volume` | `{volume}` | Tesla docs: "Requires user presence" | matches; note "requires user presence" — if this ever fails only when the app/owner isn't detected near the car, that's the documented reason, not a bug |
| `media_favorite` | `media_next_fav` / `media_prev_fav` | `{}` | Tesla docs (both listed) | matches |
| `add_charge_schedule` | `add_charge_schedule` | `{days_of_week, enabled, lat, lon, start_enabled, start_time, end_enabled, one_time, id?}` | Tesla docs (endpoint listed; field shape from community/vehicle-command usage) | current, non-deprecated replacement for `set_scheduled_charging` per Tesla docs ("not recommended beginning with firmware version 2024.26"); charging bucket |
| `add_precondition_schedule` | `add_precondition_schedule` | `{days_of_week, enabled, lat, lon, precondition_time, one_time, id?}` | Tesla docs (endpoint listed) | current replacement for `set_scheduled_departure`'s preconditioning half |
| `remove_schedule` | `remove_charge_schedule` / `remove_precondition_schedule` | `{id}` | Tesla docs (both listed) | matches |

Deprecated, NOT used by this project (recorded so nobody reintroduces them):
`set_scheduled_charging`, `set_scheduled_departure` — Tesla docs: "not
recommended beginning with firmware version 2024.26."

## Unsigned commands (proxy refuses to sign — direct to Fleet API)

`POST {tesla_fleet_base}/api/1/vehicles/{numeric id}/command/{name}` — numeric
Fleet API id, not VIN, since this bypasses the proxy entirely.

| Adapter method | Command name | Payload fleet.py sends | Source | Project note |
|---|---|---|---|---|
| `set_route` | `navigation_gps_request` (once per stop, `order` incrementing) | `{lat, lon, order}` | Tesla docs lists `navigation_gps_request` as a real endpoint ("Coordinates with multi-stop support"); fleet.py's own comment says it's unsigned because the proxy handles no navigation commands | **UNVERIFIED / explicitly flagged in fleet.py itself**: whether repeated calls accumulate into one multi-stop route or each replaces the destination is not documented anywhere found, and fleet.py's `set_route` deliberately returns `verified_multi_stop: false` rather than claim it works — do not remove that caveat without an actual on-car confirmation |
| `set_navigation_destination` | `share` | `{type: "share_ext_content_raw", value: {"android.intent.extra.TEXT": address}, locale, timestamp_ms}` | community (`tesla-api.timdorr.com`): confirms `share` is the current command name (older name was `navigation_request`) and this exact payload shape, including the `android.intent.extra.TEXT` key. Tesla's own current docs list `navigation_request` as a still-valid endpoint too — the two names appear to coexist / `share` is the documented-by-community successor | fleet.py's comment ("the current, documented replacement for the retired `navigation_request`... `navigation_sc_request`'s params were never documented and reportedly hangs at 'calculating' forever") is community-sourced, not Tesla-official, but consistent with what was found here |

Also present in the proxy's dispatch table with `ErrCommandUseRESTAPI`
(confirmed via `pkg/proxy/command.go`), i.e. also must go unsigned if ever
added: `navigation_request`, `set_managed_charge_current_request`,
`set_managed_charger_location`, `set_managed_scheduled_charging_time`.
`remote_boombox` returns `ErrCommandNotImplemented` from the proxy — not
usable via the proxy at all.

## Reads (plain Fleet API, no signing)

| Adapter method | Endpoint | Method | Source | Project note |
|---|---|---|---|---|
| `get_state` (via `_fetch_vehicle_data`) | `/api/1/vehicles/{id}/vehicle_data` | GET | Tesla docs: never wakes the car, polling discouraged ("expensive"); community: returns HTTP `408` ("vehicle unavailable: vehicle is offline or asleep") when the car is asleep, rather than a real timeout | matches fleet.py's `VehicleAsleepError` handling exactly. fleet.py additionally checks the response body's top-level `state != "online"` even on a `200`, because a car caught going idle returned 200 with stale cached `charge_state`/`climate_state` — that specific 200-but-stale case is **UNVERIFIED against Tesla docs** (not documented anywhere found), it's an observed-in-production behavior per fleet.py's own comment. Don't remove that check without re-confirming |
| `get_location`/`_coordinates`, `trigger_homelink` (via `_fetch_vehicle_data` with `endpoints=drive_state;location_data`) | `/api/1/vehicles/{id}/vehicle_data?endpoints=drive_state;location_data` | GET | Tesla docs: "For vehicles running firmware 2023.38+, `location_data` is required to fetch vehicle location" and requesting it "triggers a location-sharing icon on the vehicle UI" | matches fleet.py's comment that `location_data` must be requested explicitly; the UI-icon side effect is worth knowing if the owner ever asks why a location icon appears after a location-only question |
| `list_schedules` | `/api/1/vehicles/{id}/vehicle_data?endpoints=charge_schedule_data;preconditioning_schedule_data` | GET | Tesla docs (verified via WebFetch, Aug 2026), on the `add_charge_schedule`/`add_precondition_schedule` command pages themselves: "To view existing schedules, call the vehicle_data endpoint and request `charge_schedule_data`" / "...request `preconditioning_schedule_data`" | matches — confirmed by name against Tesla docs, not just plausible by symmetry; the exact field shape returned under those keys is still UNVERIFIED (docs don't publish a parameter table for either command) |
| `wake` (`_wake_request`) | `/api/1/vehicles/{id}/wake_up` | POST | Tesla docs: "Wakes the vehicle from sleep, which is a state to minimize idle energy consumption" (verified via WebFetch, Aug 2026) | matches; fleet.py deliberately calls the plain Fleet API endpoint directly rather than through the signing proxy — **correction**: `pkg/proxy/command.go`'s dispatch table (fetched raw, Aug 2026) *does* have a `case "wake_up":` entry (`return func(v *vehicle.Vehicle) error { return v.Wakeup(ctx) }, nil`), so the proxy can also handle a signed `wake_up`; this row previously claimed wake_up is "not in the proxy's dispatch table at all," which is false — corrected here. `fleet.py`'s choice to use the plain, unsigned Fleet API endpoint instead is still correct (no vehicle key needed to ask Tesla's cloud to wake a car), it just isn't the *only* code path that could exist |
| `nearby_chargers` | `/api/1/vehicles/{id}/nearby_charging_sites` | GET | Tesla docs: "Returns the charging sites near the current location of the vehicle" | matches; fleet.py's comment that this *may* wake the car (only place a read is allowed to) is a project policy choice, not a Tesla API property — Tesla's docs don't say whether it wakes the car |
| `recent_alerts` | `/api/1/vehicles/{id}/recent_alerts` | GET | Tesla docs (listed) | matches |
| `release_notes` | `/api/1/vehicles/{id}/release_notes` | GET | Tesla docs (listed) | matches |
| `charging_history` | `/api/1/dx/charging/history` | GET | Tesla docs: "Returns the paginated charging history" — explicitly account-scoped, not vehicle-scoped | matches; fleet.py's comment that this is "a different path shape from everything else here" is correct — it's the only `/dx/` (account-level) call in the file, no vehicle id in the path |
| `_resolve_vehicle` | `/api/1/vehicles` | GET | Tesla docs: paginated, default page size 100 | matches; fleet.py only reads `vehicles[0]`, i.e. this project assumes a single-vehicle account — fine for this repo's stated scope (one owner, one Model 3), would need pagination handling to ever support more |

## Virtual key / signing proxy setup (context, not called directly by fleet.py)

- Pairing deep link format: `https://tesla.com/_ak/<domain>` — confirmed
  directly against `vehicle-command`'s own README (fetched raw, Aug 2026):
  "provide vehicle owners with a link to `https://tesla.com/_ak/<your_domain_name>`",
  consistent with the exact URL `fleet.py`'s "not been paired" error message
  builds from `TESLA_APP_DOMAIN` (`tesla-amp.duckdns.org` in this project,
  and fleet.py's own message carries no `?vin=` query param). The `[?vin=VIN]`
  variant recorded in earlier drafts of this table is **UNVERIFIED** — not in
  the README as fetched; drop it unless independently confirmed.
  Community + `pkg/proxy/command.go` also documents: owner accounts can add the
  key from anywhere in the Tesla app; a driver/co-owner account must be
  physically near the car in Bluetooth range with the physical key card —
  matches the wording fleet.py's error message already gives the owner.
- Public key must be hosted at
  `https://<domain>/.well-known/appspecific/com.tesla.3p.public-key.pem`
  (PEM, secp256r1/prime256v1) — Tesla docs (verified via WebSearch/WebFetch,
  Aug 2026: `developer.tesla.com/docs/fleet-api/virtual-keys/developer-guide`),
  **not** the `vehicle-command` README as an earlier draft of this table
  claimed — the README documents the `_ak` deep link but not this path; the
  two facts have different sources and shouldn't be cited together.
  Not this repo's concern directly (that's Caddy/static-file territory, outside
  `fleet.py`), but relevant if virtual-key pairing ever breaks — check this
  path is actually being served before assuming the proxy or Tesla is at fault.
- The proxy presents a self-signed cert; `fleet.py` pins to it via
  `TESLA_PROXY_CA` rather than disabling verification, specifically so a
  misconfigured `TESLA_PROXY_URL` can't silently receive a live Tesla bearer
  token — this is a project decision, not something Tesla's docs prescribe.

## OAuth scopes this project requests

From `backend/app/auth/oauth.py`'s `SCOPES`:
`openid offline_access user_data vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds`.

| Scope | Grants (Tesla docs, authentication overview) |
|---|---|
| `openid` | Sign in with Tesla credentials |
| `offline_access` | Refresh token without re-login |
| `user_data` | Contact info, home address, profile picture, referral info |
| `vehicle_device_data` | Live vehicle data, service history/scheduling, eligible upgrades, nearby Superchargers, ownership details |
| `vehicle_location` | Precise and coarse vehicle location |
| `vehicle_cmds` | Add/remove driver, live camera, unlock, wake up, remote start, schedule software updates — and by extension the general command set (climate, sentry, media, navigation, trunk, windows) |
| `vehicle_charging_cmds` | Charging history, billed amount, charging location, schedule/start/stop charging commands |

Not requested by this project (would need adding to `SCOPES` and re-running
`/auth/login` if ever needed): `vehicle_specs`, `vehicle_pricing_info`
(partner-token only), `energy_device_data`, `energy_cmds`,
`enterprise_management` — none of these apply to a single-vehicle Model 3
owner app.

Tesla does not publish a per-command scope table (confirmed: not present on
the vehicle-commands doc page as fetched) — the bucket-level mapping above is
the most granular thing documented.
