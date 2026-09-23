# VTrack

A tablet camera at **point A** reads licence plates of vehicles that stop at the guard at **point B**. The VTrack Engine recognises the plate, validates the Singapore checksum, matches it against the approved-vehicle list and writes one event. Supabase pushes that event to the gate display, where the guard sees `ALLOW`, `DENY` or `CHECK` within about a second.

Design intent lives in [`docs/design-brief.md`](docs/design-brief.md); the build contract is [`CLAUDE.md`](CLAUDE.md).

**Every device is on its own mobile data — there is no LAN, no laptop at the site and no tunnel.**

---

## Where this is

**Milestone M1 — first real read.** On top of M0's schema, admin console and gate display: the **VTrack Engine** (`services/engine`, Python 3.12 / FastAPI) and a working **`/capture`** page. Hold a plate to the laptop webcam, tap, and the decision reaches `/display` through Supabase Realtime. Everything runs on `localhost`.

**M2 — cloud deploy + tablet at the gate — in progress.**
- **Stage A (live):** the engine runs as one always-on container on Render (Singapore), built from [`render.yaml`](render.yaml).
- **Stage B:** `/capture` for the tablet at A, per `docs/screens/capture.png` — a lane ROI, presence gating that sends frames only while a vehicle is in the lane, QR pairing and a screen lock.
- **Still to come in M2:** the gate benchmark.

M3: heartbeat-driven OFFLINE banner, guard-action audit, crops and retention.

---

## Run it

Requires Node 22+ and pnpm 10+.

```bash
pnpm install
pnpm dev        # http://localhost:5173
pnpm test       # vitest — plates, status, display machine, CSV
pnpm build      # tsc -b && vite build
pnpm typecheck
```

`localhost` is a secure context, so no HTTPS is needed while developing.

| Route | What it is |
|---|---|
| `/display` | Point B, the gate screen. Add `?dev=1` for the Simulate panel. |
| `/admin` | Vehicles CRUD, CSV import/export. Needs sign-in and the admin role. |
| `/capture` | Point A, the camera. Pair once. Locked until the bottom bar is held for 2 s. **AUTO** sends frames while a vehicle is in the lane; **TAP** sends one per **CAPTURE NOW** (or Space). Needs the engine running. |

---

## Set up Supabase

Paste these into the Supabase SQL editor **in order**:

| # | File | |
|---|---|---|
| 1 | `supabase/migrations/0001_init.sql` | Schema. |
| 2 | `supabase/migrations/0002_policies.sql` | RLS, the two public views, realtime. Re-runnable. |
| 3 | `supabase/seed.sql` | The §9 fixtures + the three `devices` rows. Re-runnable. |
| 4 | — | **Sign in to `/admin` once with email OTP.** This creates your `auth.users` row. |
| 5 | `supabase/admin_role.sql` | Replace `you@example.com` (two places), run, then **sign out and back in**. |

Step 5's order matters: `app_metadata` is baked into the JWT when the token is issued, so an existing session keeps the old claim until it refreshes. Signing out and back in is the fix — do not loosen the policies to work around it.

Then create `apps/web/.env` from [`.env.example`](.env.example):

```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
VITE_SITE=gate1
VITE_LANE=A
```

The anon key is public by design — it ships in the browser. Everything it may do is defined by the policies in `0002_policies.sql`; the service key never leaves the engine's host secrets.

> Supabase's free tier **pauses after 7 idle days**. From M3 the engine's heartbeats keep it awake; until then, check the dashboard before a demo.

### Optional: round-trip the Simulate panel through Realtime

By default `?dev=1` tries a real `events` insert and falls back to injecting the row straight into the display when RLS refuses. To exercise the genuine Realtime INSERT/UPDATE path instead, apply `supabase/dev/simulate_policy.sql` and set `VITE_SITE=devlab`.

That grant is scoped to one device on one fake site precisely because the anon key is public — an open `anon can insert events` policy would let anyone who views source push a green `PROCEED` onto the guard's screen. **Revert it with `supabase/dev/simulate_policy_down.sql` before any device goes to the gate.**

---

## Run the engine (M1)

The engine runs on your laptop next to `pnpm dev`. Windows PowerShell shown; macOS/Linux are the same commands.

**Once:**

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"   # installs uv; reopen PowerShell after
cd services\engine
uv sync                                                                              # Python 3.12 + everything, first time ~2 min
uv run python -c "import secrets; print(secrets.token_urlsafe(24))"                  # run twice: one token per device
```

Create `services\engine\.env` (git-ignored — it holds a secret):

```
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_KEY=sb_secret_…        # Supabase → Settings → API Keys → Secret keys. NOT the publishable key.
DEVICE_TOKENS={"cam-a":"<token 1>","display-b":"<token 2>"}
ALLOWED_ORIGINS=http://localhost:5173
```

and in `apps\web\.env` add `VITE_ENGINE_URL=http://localhost:8000`, keeping `VITE_SITE=gate1`. Restart `pnpm dev` after.

**Each time:**

```powershell
cd services\engine
uv run vtrack-engine        # 127.0.0.1:8000 · one worker · no access log. First start downloads the model (~11 MB).
```

Open **http://127.0.0.1:8000/health**. Ready means `"db": "ok"`, `"model_status": "ready"`, and every device `ok`. Anything else is spelled out in the body — e.g. a publishable key where the secret key should be, a placeholder token, or a device with no row in `devices`.

**Pair the camera:** open `http://localhost:5173/capture` and scan the code from `uv run vtrack-pair-qr cam-a`, or type the `cam-a` token. It is checked against the engine before it is kept, and stored only in that browser.

**The M1 test:** `/capture` and `/display` in **two side-by-side windows** (not tabs — a hidden tab throttles the display's clock). Unlock (hold the bottom bar 2 s), switch to **TAP**, hold a printed plate inside the dashed lane box and press **CAPTURE NOW**; the result is on both screens within about a second.

| On a laptop | Why |
|---|---|
| Engine on `127.0.0.1`, never `0.0.0.0` | reachable from this machine only: no firewall prompt, no LAN exposure (CLAUDE.md §1) |
| Web app at `localhost:5173`, not `127.0.0.1:5173` | the engine allows exactly the origins in `ALLOWED_ORIGINS` |
| The published Pages `/capture` cannot reach a laptop engine | Chrome blocks public sites from calling local addresses. M2 deploys the engine |
| Front camera only | `/capture` asks for the rear camera as `ideal`, so a laptop falls back to its front one |

**Tests:**

```powershell
cd services\engine
uv run pytest            # everything fast — no network, no model
uv run pytest -m slow    # the REAL model on rendered plates (downloads it on first run)
```

`tests/test_db_schema.py` replays the engine's real payloads on Postgres 16 with the real migrations; it runs when `VTRACK_TEST_PG_DSN` points at a superuser DSN, and always in CI.

---

## How it is laid out

```
apps/web/src/
  lib/plates.ts      normalise · checksumLetter · classify · repair · formatPlate · diffPlates
  lib/status.ts      the derived vehicle status — ACTIVE / EXPIRING n d / EXPIRED / SUSPENDED
  lib/cache.ts       IndexedDB snapshot of vehicles_public, refreshed every 5 min
  lib/sounds.ts      Web Audio chimes, no files
  routes/display/displayMachine.ts   the pure state machine
  routes/display/…   TopBar · Stage → SlabStage | CheckStage · Rail · ManualMode · OfflineBanner
  routes/admin/…     VehiclesTable · VehicleDrawer · csv.ts
  routes/capture/…   CaptureRoute · PairDevice · CameraView (+ parts, ScreenLock, DevPanel, grab, useCamera) · readView.ts
  lib/presence.ts    when the camera sends a frame (pure; presence.test.ts)
  lib/roi.ts         the lane ROI · lib/captureStore.ts what the tablet keeps · lib/updates.ts idle-only updates
  lib/engine.ts · device.ts · frame.ts   the engine client, per-role pairing, JPEG fit + box mapping
supabase/            migrations, seed, admin_role, dev/
services/engine/vtrack_engine/
  plates.py          §5.1 verbatim + format_plate
  decide.py          §5.2 — interpret → (lookup) → decide                     PURE
  dedupe.py          §5.3 — merge on the exact key                            PURE
  clock.py · images.py · config.py · auth.py · events.py
  db.py              httpx → PostgREST with the service key
  alpr/              base · local_fastalpr (default) · cloud_platerecognizer
  main.py            /recognise /manual /heartbeat /health
```

The pure modules carry the tests — on the web side `plates.ts`, `status.ts`, `displayMachine.ts`, `csv.ts`, `frame.ts`, `engine.ts` (its health classification), `device.ts`, `readView.ts`; in the engine `plates`, `decide`, `dedupe`, `clock`, `images`. Everything that touches the network lives in route components and `db.py`, which is what keeps the rest testable.

### Things worth knowing before changing them

**The display's timers run on the local clock.** `ts` and `last_read_at` come from Postgres; the browser's clock is its own. Comparing them directly means a tablet 15 s fast clears a DENY on the first tick, and these tablets run on mobile data with no NTP guarantee. So every hold window is measured from when the read *arrived*. Server timestamps are used only for text the guard reads as a clock. `displayMachine.test.ts` asserts this under ±60 s of injected skew.

**`hydrate` never stages and never chimes.** Loading the last five events into the rail on connect must not be able to take the stage, or every reload and reconnect would flash a full-screen green for a vehicle that left hours ago — the confident wrong green that CLAUDE.md §1 exists to prevent.

**CSV import runs on `classify()`, not on a bare checksum.** "Reject rows whose checksum fails" read literally would reject `MID 12345`, which has no checksum. And `repair()` is never called on an import: a silently repaired row would put a plate on the approved list that nobody typed.

**Two deliberate departures from the canvas.**

`gate-allowed.png` shows the owner's name, unit, pass type and expiry under PROCEED. We render only "On the approved list". The guard needs none of it to wave a car through — the system has already decided — and the gate screen is readable from outside the post, so a green that broadcasts names is a privacy cost (brief §3.10) with no operational benefit. The details still appear where they are acted on: the DENY reason lines, manual mode, and `/admin`.

In `gate-check.png` the rail chip for the 14:25:40 event shows the raw read `SNB 953B E`, while `gate-allowed.png` shows the same event as the repaired `SNB 9538 E`. We render the best guess (`plate_norm`) everywhere; the raw read appears only in the CHECK stage's "what the camera saw" panel.

**TURNED AWAY is one tap; LET THROUGH is not.** Turning a vehicle away is the guard agreeing with a decision the system already made, so there is nothing to justify, and putting a form in front of the correct action is how you train people to stop using it. The row is still written to `guard_actions`. Letting a denied vehicle through is the override, and that one asks for a reason and a name (§3.10).

### The engine's decisions worth knowing

**Confidence is the weakest character, never the average.** fast-alpr reports per-character probabilities *including* near-certain padding slots. Averaged, a real misread with a 0.15 character scored 0.90 — a confident answer on a guess. `local_fastalpr.py` takes the minimum over the characters actually read, and the real model's output is a regression fixture.

**Dedupe keys on `(site, lane, plate_norm)`, never "the latest event in the lane".** Otherwise an allowed car pulling away while a denied car sits at the guard would insert a newer event and take the stage: a green over a red.

**A dropped check letter asks; it does not deny.** Through a webcam the real model once read a clear `SNB 9538 E` as `SNB9538` at 0.997. Without its letter that is the shape §5.1 calls *foreign*, which is never repaired — a confident DENY for an approved car. A Singapore check letter is determined by the rest of the plate, so when the read is not on the list but its one completion is, the answer is CHECK with the completion as the best guess. Never ALLOW: Sabah plates also begin with S.

**An `invalid` read is offered to repair.** Every repair example in §5.1 breaks the pattern rather than the checksum, so read literally §5.2 would never repair them. `STRICT_SPEC_REPAIR` in `decide.py` restores the literal reading.

**If the write fails, the answer has no decision in it.** `/capture` must never show a colour the guard's screen did not get.

**Events take their site from the device's row.** `/display` filters on site; a token whose device has no row, or no site, is refused before anything is written.

**Tokens never enter the bundle.** `vite.config.ts` refuses a production build while `VITE_DEVICE_TOKEN` is set, and CI proves it with a canary. Devices pair from their own screen, one storage key per role.

**One plate in position, or no decision.** The frame is the lane ROI around the stop line. A plate cut by its edge belongs to a car not in position; with a calibrated plate width, a plate much bigger or smaller is a car nearer or further than the stop line. Of what is left there must be exactly one plate — two is no decision, with the reason in the response. M1 took the largest plate, which from behind is the car queued nearest the camera.

**`/ready` is Render's, `/health` is the pills'.** `/ready` is latched: 200 once the model is loaded and Supabase has answered once, then for the life of the process. A deploy with a wrong key never goes live, and a Supabase blip never gets a working engine restarted. `/health` is the live truth, status only in public; a paired device's token adds the detail.

**The camera sends only while a vehicle is in the lane** (`lib/presence.ts`). It compares a 64×36 thumbnail of the lane ROI with a picture of the lane empty. Each thumbnail is divided by its own brightness, so auto-exposure and headlights don't count, and presence is a *fraction* of changed cells, so a motorcycle does.
- Per vehicle: a burst of up to 2 frames/s for 3 s, then one every 2 s, stopping at a confident answer or 12 frames.
- A queued car that pulls in behind another gets its own frames, even though the lane never emptied.
- Floodlights that make the lane look occupied for a minute with no plate are taken as the new empty lane.

**No buffered retry.** The brief asked capture to buffer frames through a mobile-data drop. With presence gating, the next frame two seconds later is the retry, and it is fresher. A failed send doesn't use up the vehicle's 12.

**A new version never reloads a screen mid-vehicle.** The service worker waits (`lib/updates.ts`) until the lane is empty (`/capture`) or the display is in standby.

**Supabase keys:** a new-style `sb_secret_…` key travels in `apikey` only; a legacy service-role JWT in both headers. A publishable key is refused at startup, and `/health`'s database probe reads a table the public key cannot, so `db: ok` proves the key is the right one.

---

## Deploy

`.github/workflows/deploy.yml` builds `apps/web` and publishes to GitHub Pages on push to `main`, with the base path set to the repo name and `index.html` copied to `404.html` so deep links survive a cold load.

Enable it once under **Settings → Pages → Source: GitHub Actions**.

`.github/workflows/ci.yml` runs on every pull request and push to `main`: web typecheck, tests, build and the device-token canary; engine lint and tests against a Postgres 16 service; and the engine **image**, built and run with no network at half a CPU, which must load its model offline and read a real plate inside 400 ms.

### The engine on Render (M2)

One always-on container: Render **Starter** (512 MB, half a CPU, about US$7/month) in **Singapore**, next to the Supabase project. Measured in that shape: 167 MB, a plate read in ~105 ms (p95 ~175 ms). The model weights are baked into the image, so a cold start never downloads anything.

**Set it up once:**

1. Merge the M2 Stage A pull request (Render deploys `main`).
2. [render.com](https://render.com) → sign up with GitHub → **New → Blueprint** → pick `UR-B20/vtrack`. Render reads [`render.yaml`](render.yaml).
3. It asks for three values. Copy them from `services/engine/.env` on your laptop:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY` — the **secret** key (`sb_secret_…`)
   - `DEVICE_TOKENS` — the whole `{"cam-a":"…","display-b":"…"}` line
4. **Apply.** The first build takes a few minutes. In **Logs**, wait for `ready: plate model loaded, database answered`. If it says `not able to decide frames: db_auth`, the key is wrong; `db_unreachable`, the URL is wrong or the project is paused. `DEVICE_TOKENS is empty` means step 3's third value is missing.
5. Copy the service URL (`https://vtrack-engine-….onrender.com`). In GitHub: **Settings → Secrets and variables → Actions → Variables → New repository variable** `VITE_ENGINE_URL` = that URL.
6. **Actions → Deploy web to GitHub Pages → Run workflow.** The URL is compiled into the site, so the site must be rebuilt once it is set.
7. On a tablet **on mobile data** (Wi-Fi off): open `<engine URL>/health` — `"db": "ok"`, `"model_status": "ready"` — then the Pages `/display`: the pill reads **ENGINE · CLOUD OK**.

**How it deploys:** every push to `main` whose CI passes (`autoDeployTrigger: checksPass`). Render starts the new version beside the old one and switches only when `/ready` answers, so for up to a minute both run; the worst case is a duplicate event, never a wrong decision. **Merge engine changes outside gate hours.** A deploy that never becomes ready is cancelled after 15 minutes and the running engine keeps the gate.

**Where to look:** Render → the service → **Logs**. The engine logs readiness changes and nothing else — no plates, no tokens (§5.5).

### The tablets at the gate (M2)

**Before you go:** if you ever ran `supabase/dev/simulate_policy.sql`, run `supabase/dev/simulate_policy_down.sql` now.

**Tablet A (the camera)**
1. Turn **auto-rotate off**. Mount the tablet facing the vehicles as they arrive: queued cars then sit further back and look smaller, and motorcycles show their front number sticker.
2. In Chrome, open **https://ur-b20.github.io/vtrack/capture?dev=1** on mobile data. `?dev=1` shows the setup panel; drop it once set up.
3. **Pair it.**
   - On the laptop, in `services/engine`, run `uv run vtrack-pair-qr cam-a`. It prints a QR code in the terminal.
   - On the tablet, tap **SCAN PAIRING CODE** and point it at the laptop screen.
   - Close the terminal afterwards: the code is the tablet's key. (If the scanner won't work, **TYPE THE TOKEN INSTEAD** does the same.)
4. **Unlock:** hold the bottom bar for 2 s. It locks itself again after 30 s untouched.
5. **EDIT LANE ROI:**
   - Drag the dashed box over the spot where a stopped vehicle's plate will be, and use the corner handle to size it.
   - Keep it at least 640 px wide; the label warns below that.
   - Tap **DONE — SAVE THE LANE ROI**.
6. **Let it calibrate:** keep the lane empty until the chip changes from **CALIBRATING** to **LANE EMPTY**. **LANE IS EMPTY** in the dev panel redoes this at any time.
7. **Set the plate size:** when the first car stops and shows a green box, tap **SET PLATE SIZE**. Plates much bigger or smaller than that (a car nearer or further than the stop line) are then ignored.
8. **Watch a few vehicles**, including a motorcycle.
   - The chip shows **VEHICLE IN LANE · 3/12**: frames sent for that vehicle, never more than 12.
   - If a vehicle is missed, lower **PRESENT AT**. If shadows or headlights count as vehicles, raise it.
9. **Pin the screen** so the page can't be left: Android **Settings → Security → App pinning** (the name varies by model) → on. Then, from Recents, tap Chrome's icon → **Pin**.

**Tablet B (the guard's screen):** open **https://ur-b20.github.io/vtrack/display**. The OFFLINE banner stays off until M3 wires the camera's heartbeats to it.

**Benchmark photos (Stage C).** In the dev panel, tick **SAVE EVERY FRAME SENT**. Each frame the tablet sends is also saved to its Downloads, named by vehicle (`v20260923-143206-01.jpg`, `-02`, …). These are personal data (PDPA):
- turn off cloud backup of Downloads (Samsung Cloud / Google Photos);
- move them to the laptop by USB, into a folder **outside** the repository and outside OneDrive;
- delete them from the tablet, including its Trash.
