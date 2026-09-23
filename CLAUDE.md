# VTrack — Claude Code build brief (CLAUDE.md)
 
> Drop this file at the root of the `vtrack` repo. It is the contract for every Claude Code session on this project. Design intent lives in `docs/design-brief.md`; screens live in the "VTrack Screens" canvas; this file says **what to build, in what order, and how we know it works**.
 
## 0. What VTrack is (one paragraph)
A tablet camera at **point A** reads licence plates of vehicles that **stop at the guard** at **point B**, under 10 m away, day and night. A **VTrack Engine** — an always-on **cloud container** — recognises the plate, validates the Singapore checksum, matches it against the approved-vehicle list and writes one event. Supabase pushes that event in real time to the **gate display** at B, where the guard sees `ALLOW` (green), `DENY` (red) or `CHECK` (amber) within ~1 s, watches it refine as more frames arrive, and can override with an attributed reason. **Every device is on its own mobile data — there is no LAN, no laptop at the site and no tunnel.** Proof-of-concept first; every piece is swappable for an on-prem deployment later (same container on a mini PC).
 
## 1. Working agreements
- **Plan before code.** Enter plan mode at the start of each milestone; list files to touch and tests to add; then build.
- **Milestone order is fixed** (§8). Do not start M2 before M1's acceptance test passes.
- **Engine logic is pure and tested.** `plates.py` and `decide.py` take values and return values — no I/O. Every rule in §5 has a pytest.
- **Never a confident wrong green.** When unsure, return `check`. Thresholds are config, not literals.
- **No secrets in the browser or in git.** Cloud ALPR keys and the Supabase service key live only in the engine's host secrets (`services/engine/.env` locally).
- **No LAN assumptions.** Capture, display and admin reach the engine and Supabase only over public HTTPS. Never code a `192.168.x.x`, a tunnel, or a "same wifi" step.
- **Design tokens are law** (§3). No new colours; brass only on the wordmark.
- Commit at the end of each milestone with the milestone name in the message.
## 2. Repository layout
```
vtrack/
  CLAUDE.md                       ← this file
  docs/design-brief.md            ← VTrack — Design Brief v0.2
  .env.example
  apps/web/                       ← one Vite + React + TypeScript PWA, three routes
    src/routes/display/           ← /display   point B gate screen
    src/routes/capture/           ← /capture   point A camera page
    src/routes/admin/             ← /admin     vehicles, events, devices, settings
    src/lib/supabase.ts  src/lib/plates.ts  src/lib/sounds.ts  src/lib/cache.ts
    src/styles/tokens.css
  services/engine/                ← Python 3.12 + FastAPI
    vtrack_engine/
      main.py                     ← routes: /recognise /manual /heartbeat /health
      config.py                   ← env → settings (pydantic-settings)
      plates.py                   ← normalise / classify / checksum / repair  (port of sg_plate.py, §5.1)
      decide.py                   ← pure decision rules (§5.2)
      dedupe.py                   ← 15 s window per plate
      alpr/base.py                ← Protocol: recognise(image_bytes) -> list[PlateRead]
      alpr/cloud_platerecognizer.py
      alpr/local_fastalpr.py
      db.py                       ← Supabase writes (events, crops, devices)
    tests/                        ← pytest; fixtures in tests/plates/*.jpg
    scripts/benchmark.py          ← runs both adapters over tests/plates, prints read rate / accuracy / p50 / p95
    Dockerfile  .dockerignore     ← always-on container; deployed by render.yaml at the repo root (§11, Engine host)
    pyproject.toml
  supabase/
    migrations/0001_init.sql      ← §4 schema
    migrations/0002_policies.sql  ← RLS + realtime publication
    seed.sql                      ← sample vehicles (§9 plates)
```
 
## 3. Stack and design tokens
**Web:** Vite 6, React 19, TypeScript strict, `@supabase/supabase-js` v2, `idb-keyval` (offline cache), Tailwind v4 *or* plain CSS — either way the tokens below are CSS variables in `tokens.css`. PWA manifest + service worker (`vite-plugin-pwa`). Hosted on GitHub Pages (HTTPS). System fonts only: `"Segoe UI", system-ui, sans-serif` for UI, `"Courier New", monospace` for plates, times and IDs.
 
**Engine:** Python 3.12, FastAPI, uvicorn, httpx, Pillow, numpy, `fast-alpr[onnx]` (open-source adapter on **CPU** — the default; `[onnx-gpu]` only for local dev on the RTX 3060 laptop), pydantic-settings, slowapi (rate limit), pytest. Runs with `uvicorn vtrack_engine.main:app --host 0.0.0.0 --port 8000`. **Deployed as one always-on container** (Fly.io: 2 shared vCPU / 2 GB, ~US$5–10/month; no free tier that sleeps). Model files are baked into the image at build time so cold starts don't download.
 
**Data:** Supabase (Postgres, Realtime, Storage bucket `crops`, Auth email OTP). Free tier for the POC — it **pauses after 7 idle days**; the engine's heartbeat writes keep it active, but check the dashboard before a demo.
 
```css
/* tokens.css — Command Console, gate variant */
:root {
  --navy: #0A1A2F; --navy-2: #10243F; --navy-3: #183459; --line: #1E3552; --line-2: #2A4262;
  --ink-on-navy: #E8E2D6; --muted-on-navy: #97A5B9; --brass: #C9A56B;       /* brass: wordmark only */
  --paper: #F3EEE4; --paper-2: #FBF8F2; --ink: #15212F; --muted: #5B6B7F; --line-paper: #D9D0BF; --hl: #1F4E8C;
  --allow-field: #0F6B3E; --allow: #2ECC71;      /* green field + accent */
  --deny-field:  #8E1B1B; --deny:  #FF6B6B;      /* red   */
  --check-field: #8A5A00; --check: #F2B632;      /* amber */
  --offline: #4A5568;
  --plate-bg: #111418; --plate-border: #F4F4F4;  /* plates render white-on-black, Courier New bold */
}
```
Display layout (1280×800 tablet landscape, see canvas): 56 px top bar · stage (fills the rest, status field ≥ 70 % of screen) · 320 px right rail with the last 5 reads · plate ≥ 104 px font · one verb (`PROCEED` / `DO NOT ALLOW` / `VERIFY MANUALLY`) at 68 px weight 800. The stage is a **live view of the vehicle at the guard**, refined in place; the rail is history.
 
## 4. Database (Supabase) — `0001_init.sql`
```sql
create type decision as enum ('allow','deny','check');
create type deny_reason as enum ('not_on_list','expired','suspended','unreadable','low_confidence','ambiguous','invalid_pattern');
create type plate_kind as enum ('civilian','mid','foreign','invalid');
 
create table vehicles (
  id uuid primary key default gen_random_uuid(),
  plate_norm text not null unique,          -- 'SBA1234G', 'MID12345'  (A-Z0-9 only)
  plate_display text not null,              -- 'SBA 1234 G'
  owner_name text not null,
  org_unit text,
  vehicle_type text check (vehicle_type in ('car','motorcycle','goods','bus','military','other')),
  pass_type text not null default 'permanent' check (pass_type in ('permanent','visitor','contractor')),
  status text not null default 'active' check (status in ('active','suspended')),
  valid_from date, valid_until date,
  notes text,
  created_by uuid, created_at timestamptz default now(), updated_at timestamptz default now()
);
 
create table devices (
  id text primary key,                      -- 'cam-a', 'display-b', 'engine-1'
  role text not null check (role in ('capture','display','engine')),
  name text, site text, lane text,
  token_hash text,                          -- sha256 of the device token (capture nodes)
  last_seen_at timestamptz, version text
);
 
create table events (
  id uuid primary key default gen_random_uuid(),
  ts timestamptz not null default now(),
  device_id text references devices(id),
  site text, lane text,
  plate_raw text, plate_norm text, plate_kind plate_kind,
  confidence numeric(4,3), checksum_ok boolean, repaired_from text,
  vehicle_id uuid references vehicles(id),
  decision decision not null, reason deny_reason,
  image_path text, bbox jsonb, engine text, latency_ms int,
  read_count int not null default 1,
  last_read_at timestamptz not null default now(),   -- bumped by dedupe; the display's hold/clear rule reads it
  source text not null default 'camera' check (source in ('camera','manual'))
);
create index events_ts_idx on events (ts desc);
create index events_plate_idx on events (plate_norm, ts desc);
 
create table guard_actions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references events(id),
  action text not null check (action in ('let_through','turned_away','manual_entry','confirmed')),
  reason text, actor text, ts timestamptz default now()
);
```
`0002_policies.sql` (intent — write the exact policies):
- `alter publication supabase_realtime add table events;` (INSERT + UPDATE reach the display).
- RLS on all tables. Anon role: `select` on `vehicles` (columns `plate_norm, plate_display, owner_name, org_unit, pass_type, status, valid_from, valid_until` only — use a view `vehicles_public`), `select` on `events`, `insert` on `guard_actions`. Authenticated users with `app_metadata.role = 'admin'`: full CRUD on `vehicles`, `select` on everything. Service role (engine only): everything.
- Storage bucket `crops`: private; engine uploads with the service key; display reads via signed URLs (60 s) requested through the anon client — or make the bucket public for the POC and note it.
- Retention (pg_cron, M3): delete `events` older than 90 days and crops older than 7 days; never delete `guard_actions`.
## 5. Engine — the rules
 
### 5.1 `plates.py` — reference implementation (verified against published examples)
```python
import re, itertools
CHECK_LETTERS = "AZYXUTSRPMLKJHGEDCB"; WEIGHTS = (9, 4, 5, 4, 3, 2)
CIVILIAN = re.compile(r"^([A-Z]{1,3})(\d{1,4})([A-Z])$")
MID = re.compile(r"^(?:MID(\d{1,5})|(\d{1,5})MID)$")
CONFUSABLE = {"0": "OD", "O": "0", "D": "0", "1": "I", "I": "1", "8": "B", "B": "8",
              "5": "S", "S": "5", "2": "Z", "Z": "2", "6": "G", "G": "6", "4": "A", "A": "4"}
 
def normalise(raw: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", raw.upper())
 
def checksum_letter(prefix: str, number: str) -> str:
    letters = prefix[-2:].rjust(2, "@")               # 1-letter prefix → first slot is 0
    vals = [0 if c == "@" else ord(c) - 64 for c in letters] + [int(d) for d in number.zfill(4)]
    return CHECK_LETTERS[sum(w * v for w, v in zip(WEIGHTS, vals)) % 19]
 
def classify(plate: str):
    """→ (kind, canonical, checksum_ok)  kind ∈ civilian | mid | foreign | invalid"""
    p = normalise(plate)
    if (m := MID.match(p)):
        return "mid", f"MID{int(m.group(1) or m.group(2))}", True
    if (m := CIVILIAN.match(p)):
        prefix, number, check = m.groups()
        return "civilian", p, checksum_letter(prefix, number) == check
    if re.match(r"^[A-Z]{1,3}\d{1,4}[A-Z]?$", p):      # e.g. Malaysian JHA1234 — no checksum
        return "foreign", p, True
    return "invalid", p, False
 
def repair(plate: str, max_subs: int = 2) -> list[str]:
    """Confusable substitutions until a civilian plate validates. Returns all candidates found at the smallest k."""
    p = normalise(plate); pos = [i for i, c in enumerate(p) if c in CONFUSABLE]; found = []
    for k in range(1, max_subs + 1):
        for combo in itertools.combinations(pos, k):
            for repl in itertools.product(*[CONFUSABLE[p[i]] for i in combo]):
                cand = list(p)
                for i, r in zip(combo, repl): cand[i] = r
                kind, canon, ok = classify("".join(cand))
                if kind == "civilian" and ok and canon not in found: found.append(canon)
        if found: return found
    return found
```
Tests that must pass: `checksum_letter("SBS","9889")=="U"`, `("E","23")=="H"`, `("SG","2017")=="C"`, `("SNB","9538")=="E"`; `classify("12345 MID")==("mid","MID12345",True)`; `repair("SNB953BE")==["SNB9538E"]`; `repair("SG2O17C")==["SG2017C"]`; `repair("SBS988OU")==[]` (9→O is not a confusable — stays CHECK).
 
### 5.2 `decide.py` — pure decision (input: one `PlateRead`, the vehicle row if any, settings)
```
kind, canon, ok = classify(read.text)
if kind == "invalid":                          → check, reason=invalid_pattern
if kind == "civilian" and not ok:
    cands = repair(read.text)
    if len(cands) == 1: canon = cands[0]; repaired_from = normalise(read.text)
    else:                                      → check, reason=unreadable (0) | ambiguous (>1)
if read.confidence < CONF_CHECK (0.60):        → check, reason=low_confidence
vehicle = lookup(canon)                         # exact match on vehicles.plate_norm
if vehicle is None:
    if repaired_from:                          → check, reason=not_on_list   (we are not sure what we read)
    else:                                      → deny,  reason=not_on_list
if vehicle.status == 'suspended':              → deny,  reason=suspended
if today < valid_from or today > valid_until:  → deny,  reason=expired
→ allow  (attach owner_name, org_unit, pass_type, valid_until)
```
Confidence between `CONF_CHECK` and `CONF_DECIDE` (0.85) still decides but sets `flags.verify=true` so the display shows a small "verify" badge. `foreign` and `mid` kinds are never repaired.

> **Amended 23 Sep 2026 — see §11:** `invalid` reads are also offered to `repair()`, and a foreign-shaped read whose Singapore completion is on the list is CHECK. The code in `decide.py` follows the amended rule.
 
### 5.3 Dedupe and refinement
Key = `(site, lane, plate_norm)`. A stopped vehicle produces many reads. If an event with the same key exists in the last `DEDUPE_S` (15 s, rolling from the last read): update it (`read_count += 1`, `last_read_at = now()`, keep the higher confidence, upgrade `check → allow/deny` if the new read decides) instead of inserting. A read whose plate differs from the current event's plate but is a confusable variant (checksum-repair candidate of it) is treated as the same vehicle. The display receives the UPDATE via Realtime and re-renders in place.
 
### 5.4 ALPR adapter
```python
class PlateRead(BaseModel): text: str; confidence: float; bbox: tuple[int,int,int,int]; engine: str
class ALPR(Protocol):
    def recognise(self, image: bytes, region: str = "sg") -> list[PlateRead]: ...
```
- `local_fastalpr.py` (**default**): `ALPR(detector_model="yolo-v9-t-384-license-plate-end2end")`, `predict(np_image)`; map `ocr.text` / `ocr.confidence` / detection box. Load the model once at startup; CPU ONNX; target ≤ 400 ms per frame on 2 vCPU (measure in `benchmark.py`).
- `cloud_platerecognizer.py` (flag / benchmark comparison): POST `https://api.platerecognizer.com/v1/plate-reader/` with `regions=sg`, header `Authorization: Token …`; map `results[].plate` / `score` / `box`. Evaluation tier is 2,500 lookups/month and not for production — a day-and-night gate would exceed it, which is why it is not the default.
- Selected by `ALPR_ENGINE=local|cloud`; `/health` reports which one is live.
### 5.5 HTTP contract
| Route | Auth | Body | Returns |
|---|---|---|---|
| `POST /recognise` | `X-Device-Token` | multipart `image` (JPEG ≤ 400 KB), `device_id`, `captured_at` (ISO), optional `roi` | `{event_id, plate_norm, plate_display, plate_kind, confidence, checksum_ok, repaired_from, decision, reason, flags, vehicle:{owner_name, org_unit, pass_type, valid_until} \| null, latency_ms, deduped}` |
| `POST /manual` | `X-Device-Token` | `{device_id, plate_text, actor}` | same shape; `source='manual'` |
| `POST /heartbeat` | `X-Device-Token` | `{device_id, role, version, stats}` | `204` (upserts `devices.last_seen_at`) |
| `GET /health` | none (a device token adds detail) | – | `{engine, model, model_status, db:'ok'\|'error', reason, thresholds, uptime_s, version}`; with a valid token also `{devices, db_error, model_error}` (§11, 23 Sep 2026) |
| `GET /ready` | none | – | `200 {ready:true}` once the model is loaded and the DB has answered once, latched; else `503 {ready:false, reason}`. The host's health check |
The engine is a **public endpoint**: CORS allows the Pages origin only; every route except `/health` and `/ready` requires a valid `X-Device-Token` (compare against `devices.token_hash`); rate limit 5 req/s per token (429 beyond); reject non-JPEG, images over 400 KB or under 320 px wide; log nothing but the event row. Tokens are rotated from the admin Devices page.
 
## 6. Web app
 
### 6.1 `/display` (point B)
- Subscribe: `supabase.channel('events').on('postgres_changes', {event:'*', schema:'public', table:'events', filter:'site=eq.<SITE>'}, …)`; on connect, load the last 5 events for the rail.
- State machine: `standby → result(allow|deny|check) → standby`. **Hold/clear rule:** `allow` clears 5 s after the event's `last_read_at` (minimum 8 s on screen); `deny`/`check` hold until a guard action, the next vehicle's event, or 15 s after `last_read_at` (vehicle gone). A newer event replaces the stage; the previous one moves to the rail. UPDATE on the current event re-renders in place (dedupe upgrades — a `check` becoming `allow` swaps the stage colour with the allow chime).
- Overlays: `OFFLINE` banner when `devices.cam-a.last_seen_at` is older than 30 s (poll every 10 s) or the engine `/health` fails; `MANUAL MODE` when the Realtime channel is not `SUBSCRIBED` — a search box over the cached list (`cache.ts`: full `vehicles_public` snapshot in IndexedDB, refreshed every 5 min while online).
- Guard actions: `LET THROUGH · OVERRIDE` (requires a reason; inserts `guard_actions{action:'let_through'}`), `TURNED AWAY`, and on `check` a `CONFIRM <plate>` that calls `/manual`. `TYPE A PLATE` in the rail is always available.
- Sounds (`sounds.ts`, Web Audio, no files): allow = two rising tones, deny = one low tone twice, check = single mid tone. Mute toggle persists in `localStorage`.
- Redundant encoding everywhere: colour + word + icon (+ sound). Plate rendered as white-on-black Courier New slab. Wake Lock on.
### 6.2 `/capture` (point A)
- `getUserMedia({video:{facingMode:'environment', width:{ideal:1920}}})` into a `<video>`; draw the **ROI** (draggable rectangle, saved in `localStorage`) to a canvas.
- **Presence + motion gate** (the vehicle stops, so motion alone is not enough): keep a slowly-updated background reference of the ROI (64×36 grey, updated only while the lane is empty). `present` = mean absolute difference vs background > `PRESENCE_T`; `moving` = difference vs the previous frame > `MOTION_T`. On arrival (`present` turns true): burst at 2 frames/s for 3 s. While `present` and the last engine response for this vehicle is not a confident decision: 1 frame every 2 s. Stop when a confident `allow`/`deny` arrives or after 12 frames. Reset when `present` turns false for 3 s. JPEG quality 0.85 of the ROI at full resolution, ≤ 400 KB. `TAP` mode sends one frame on tap. Heartbeat every 10 s. Mobile-data budget ≈ 1 MB per vehicle.
- Overlay the detection box + plate + confidence from the last response for 3 s; show the last read chip and engine status pill; Wake Lock; a hold-to-unlock screen lock so the page can't be closed by accident.
### 6.3 `/admin`
- Supabase Auth (email OTP); `admin` role required. Vehicles table (search, filters: all/visitors/expiring/suspended), Add/Edit drawer with **live checksum validation** (`plates.ts` mirrors §5.1), CSV import (`plate,owner_name,org_unit,vehicle_type,pass_type,valid_from,valid_until,notes` — reject rows whose checksum fails and show why), export. Events page with crop thumbnails and decision/reason filters; Devices page (last seen, version); Settings (thresholds are read from the engine `/health` and documented, not edited, in the POC).
## 7. Connectivity, deployment & environments
- **No shared network anywhere.** Tablet at A, screen at B and the admin each use their own mobile data. All traffic is public HTTPS.
- **Web app** → GitHub Pages (HTTPS is required for `getUserMedia`). Base path configured in `vite.config.ts`.
- **Engine** → one always-on container. Fly.io default: `fly launch` in `services/engine`, secrets via `fly secrets set …`, health check on `/health`, `min_machines_running = 1` (never scale to zero — the gate runs day and night). Railway is an acceptable substitute. Free tiers that sleep are not. **Amended 23 Sep 2026 — see §11 (Engine host):** Render Starter in Singapore via `render.yaml`, health check on `/ready`.
- **Dev loop** stays on the laptop: `pnpm dev` on `http://localhost:5173`, engine on `localhost:8000`, laptop webcam. `localhost` is a secure context, so no HTTPS is needed locally.
- Mobile data changes addresses constantly → never allow-list IPs; auth is token-only (§5.5).
- `.env.example`
```
# services/engine/.env  (production: host secrets, never committed)
SUPABASE_URL=            SUPABASE_SERVICE_KEY=
ALPR_ENGINE=local        # local (default, CPU) | cloud
PLATERECOGNIZER_TOKEN=   # only if ALPR_ENGINE=cloud or for benchmark.py
DEVICE_TOKENS={"cam-a":"<random 32 chars>","display-b":"<…>"}   # M0 bootstrap; M3 moves these to devices.token_hash
CONF_DECIDE=0.85  CONF_CHECK=0.60  DEDUPE_S=15  REPAIR_MAX_SUBS=2  REGION=sg  RATE_LIMIT_PER_S=5
ALLOWED_ORIGINS=http://localhost:5173,https://<user>.github.io
# apps/web/.env
VITE_SUPABASE_URL=  VITE_SUPABASE_ANON_KEY=  VITE_ENGINE_URL=http://localhost:8000   # prod: https://vtrack-engine….onrender.com
VITE_SITE=gate1  VITE_LANE=A  VITE_DEVICE_ID=display-b  VITE_DEVICE_TOKEN=
```
 
## 8. Milestones and acceptance tests
| # | Build | Accept when |
|---|---|---|
| **M0 List + display** | Supabase migrations + policies + seed; `/admin` vehicles CRUD + CSV import; `/display` with a dev-only "simulate event" panel; manual mode + cache | Simulated allow/deny/check render correctly in all states from the canvas; kill the network → manual search still finds seeded plates; `pnpm test` (plates.ts) green |
| **M1 First real read** | Engine with **both** adapters (`local` default, `cloud` flag); `plates.py` + `decide.py` + pytest; `/capture` on the laptop webcam; `/recognise` end to end, all on `localhost` | Hold a printed plate (or a photo on a phone) to the webcam → correct green/red on `/display` within 2 s; `pytest` green; `/health` ok |
| **M2 Cloud deploy + tablet at the gate** | Dockerfile + deploy; Pages deploy; tablet at A and phone at B on **mobile data**; capture PWA with ROI + presence gating; `scripts/benchmark.py` over `tests/plates/` (≥ 50 photos **taken at the gate, day and night**: car/bike, 1-line/2-line, 3 MID, 2 Malaysian) | Benchmark table (read rate, accuracy, p50/p95 latency, day vs night) for both adapters; `ALPR_ENGINE` switch works with no code change; presence gate sends ≤ 12 frames per vehicle; **go/no-go on the IR camera** written down |
| **M3 Harden + demo** | Heartbeats + offline banner; guard actions + audit; sounds (on, mute toggle); dedupe upgrades; hold/clear rule; token rotation + rate limit; retention job; events page with crops; PWA install on both devices | Dry run **after dark**: 20 vehicles incl. 3 unknown, 1 expired, 1 suspended, 1 MID, 1 dirty plate → 0 confident-wrong greens, ≥ 95 % accuracy on decided reads, p95 ≤ 2 s, every override attributed |
| **M4 Site path (post-POC)** | Same container on a mini PC at the gate with local Postgres (`docker-compose`); `capture-rtsp/` (ffmpeg frame grab → `/recognise`) for an RTSP/ANPR camera; FormSG → visitor rows | Same engine, no internet |
 
## 9. Fixtures
Valid civilian plates (checksum computed): `SBA 1234 G`, `SNB 9538 E`, `FBA 2210 T` (motorcycle), `SNB 9517 R`, `SNB 9502 H`, `SGX 4471 M`, `SLM 3090 J`, `SKN 8821 R`. MID: `MID 12345`, `12345 MID` → `MID12345`. Foreign: `JHA 1234`. Invalid: `SBA 1234 F` (F is never a check letter), `SNB 9538 F`.
Seed rows (also in the canvas): Tan Wei Ming/HQ Coy/permanent; Nurul Aisyah/A Coy/permanent; Muhammad Faiz/B Coy/motorcycle; Lim Hui Ling/S1 Branch/expiring; Priya Nair/visitor valid today; Chua Boon Keng/ABC Facilities/contractor expired; Rajesh Kumar/C Coy/suspended; `MID 12345` pool vehicle. `SKN 8821 R` is deliberately **not** seeded (the DENY example).
 
## 10. Out of scope for the POC
Barrier control (relay/GPIO), face or driver identification, plate spoofing detection, multi-lane arbitration. An IR/ANPR camera is **conditional**, not out of scope: the M2 night benchmark decides.
 
## 11. Decisions log (9 Sep 2026)
| Decision | Value |
|---|---|
| Deployment | Proof-of-concept first; on-prem path kept open |
| A → B distance | Under 10 m; every vehicle stops at the guard |
| Hours | Day and night; gate is floodlit |
| Connectivity | Each device on its own mobile data — no LAN, no laptop at the site, no tunnel |
| Engine hosting | Cloud container, always on |
| ALPR | Open-source model on CPU by default; cloud API behind a flag; benchmark at the gate decides |
| Camera | Samsung tablet at A; IR/ANPR camera only if the tablet fails the night benchmark (budget approved on evidence) |
| Database | Supabase (free tier) |
| Point B | Guard-in-the-loop; amber CHECK state; chimes on with a mute toggle |
| MID plates | On the list like everyone else (`vehicle_type='military'`) |
| List owner | Ranee, in `/admin`; CSV import; FormSG visitor flow post-POC |
| Plate repair (23 Sep 2026) | An `invalid` read is also offered to `repair()`: every §5.1 repair example (`SNB953BE`, `SG2O17C`, `SBS988OU`) is `invalid`, so §5.2 read literally would never repair them. Exactly one checksum-valid candidate that is on the list → ALLOW, marked REPAIRED; not on the list → CHECK. `STRICT_SPEC_REPAIR` in `decide.py` restores the literal §5.2 |
| Dropped check letter (23 Sep 2026) | A foreign-shaped read not on the list whose one Singapore completion is on the list (`SNB9538` → `SNB9538E`) → CHECK `ambiguous`, never DENY and never ALLOW. Found when the real model dropped a check letter at 0.997 confidence |
| Engine host (23 Sep 2026) | **Render Starter, Singapore** (Supabase's region), from `render.yaml`: Docker, one instance, deploys `main` after CI passes, health check `/ready`. Measured in its shape (0.5 CPU / 512 MB): 167 MB, read p50 ~105 ms / p95 ~175 ms, inference on one thread. Replaces §2's `fly.toml` and §7's Fly.io steps |
| Screen at B (23 Sep 2026) | A tablet, not a phone (§8 M2): the display runs as designed at 1280×800 |
| Benchmark photos (23 Sep 2026) | Stay on the owner's laptop, never in git: the repo is public and plates are personal data (PDPA). `tests/plates/` is git-ignored; only aggregate results are committed. The M2 benchmark runs the local model only — no gate photo goes to Plate Recognizer; the `ALPR_ENGINE` switch stays built and tested in CI |
| Motorcycles (23 Sep 2026) | Singapore motorcycles carry a front number sticker, so a camera facing arriving vehicles can read them; "bike, front sticker" is its own benchmark category |
| Plate selection (23 Sep 2026) | The engine reads a plate only if it is fully inside the frame (the lane ROI) and, when `/capture` sends a calibrated `roi.plate_w` band, the width a plate has at the stop line. Exactly one such plate is read; two is no decision (`rejected: multiple_plates`). Replaces "largest plate wins", which from behind picks the car queued nearest the camera |
| `/health` in public (23 Sep 2026) | Status only (brief §3.10) plus a coarse `reason`; a valid device token adds device list and error text. `/ready`, latched, is what the host routes by, so a deploy with a wrong key never takes the gate and a Supabase blip never restarts a working engine |
 