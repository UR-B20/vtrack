# VTrack — Design Brief v0.2

**Status:** Proof-of-concept (POC) design · **Date:** 9 Sep 2026 (v0.2, same day) · **Owner:** Ranee
**Decisions so far:** POC first · approved list in Supabase · guard-in-the-loop at point B · camera A under 10 m from screen B · every vehicle stops at the guard · day **and** night, floodlit gate · each device on its own mobile data (no LAN) · **engine cloud-hosted** · MID plates on the list like everyone else · Ranee manages the list in the admin screen · chimes on with a mute toggle · IR/ANPR camera budget only if the phone fails the benchmark

**v0.2 changes:** §1 (stopped vehicle, live view), §3.1–3.4 (cloud engine, connectivity), §3.6 (rewritten), §3.9 (latency), §4.2 (hold/clear rule), §5 (M2), §6, §7.

---

## 1. What we are building

A vehicle checks in at **point A** (camera). By the time it reaches **point B** (guard post screen), the guard already sees one of:

| Screen | Meaning | Guard does |
|---|---|---|
| **ALLOWED** (green) | Plate read confidently and is on the active list | Waves through |
| **DO NOT ALLOW** (red) | Plate read confidently and is **not** on the list (or expired / suspended) | Stops vehicle, checks, may override |
| **VERIFY MANUALLY** (amber, recommended addition) | Plate could not be read confidently | Looks at the plate crop, types the plate, decides |
| **OFFLINE** (grey) | Camera, engine or connection is down | Falls back to manual list search on the same screen |

> **Position:** keep the green/red you asked for, but add amber. A misread shown as a confident red is the failure that destroys trust in the system within a week. Amber protects the credibility of red.

### Close camera, stopped vehicle — the display is a live view
Camera A sits under 10 m from screen B and **every vehicle stops at the guard**. So the lead time is a second or two, not five — but the camera gets **many frames of a slowing and stationary car**, which is worth more than lead time. Consequences:

- The stage shows **the vehicle in front of the guard now**, refined as better frames arrive (a CHECK can upgrade itself to ALLOW within seconds). The rail still keeps the last five reads for the audit trail and for a second vehicle nosing in behind.
- The result must land **before the greeting ends**: target ≤ 2 s (p95) from frame to screen, ≤ 1 s typical.
- The result **clears when the vehicle leaves** (5 s after its last read, minimum 8 s on screen), not on a fixed timer.
- The capture node must keep sampling a **stationary** vehicle (presence-gated, not only motion-gated) until a confident read exists.

---

## 2. Brainstorm — positions worth arguing about

| # | Position | Why it matters |
|---|---|---|
| 1 | **The list is the product; the ALPR is a commodity.** | Recognition engines are interchangeable behind one interface. Adoption lives in how vehicles get on/off the list (visitor pre-registration, expiry, who approves). Post-POC this is a FormSG → list flow — your existing stack. |
| 2 | **Ship manual mode first.** | A searchable list on the guard's screen works with no camera at all. Build it in week 1; the camera then becomes an accelerator, and demo day cannot fail. |
| 3 | **Phone before camera — with a night benchmark.** | The gate is floodlit and plates are retro-reflective, so a tablet may read fine after dark. Prove it at the gate in M2; the IR/ANPR camera budget is released only if the tablet fails at night. |
| 4 | **Two engines, one adapter, benchmark decides.** | Open-source model running on CPU inside your own cloud container (free per read, unlimited, on-prem path) vs a cloud API (accurate out of the box, per-lookup quota). Both are ~40 lines behind `recognise(image)`. Run both on the same 50 test photos and pick; default is the open-source model because a day-and-night gate burns through an API quota. |
| 5 | **Never show a confident wrong green.** | False accept is the cardinal sin. A false amber costs the guard 5 seconds; a false green costs credibility. Bias every threshold toward CHECK. |
| 6 | **Checksum is free accuracy.** | Singapore civilian plates carry a check letter. Validate every read; repair common OCR confusables (O↔0, B↔8, S↔5) only when exactly one repaired candidate validates. MID plates have no checksum — pattern-match them. |
| 7 | **Design for on-prem now, run in the cloud now.** | The engine is one container: today on a cloud host, later on a mini PC at the gate with local Postgres. Same code, config only. |

### Edge cases the POC must survive
- Same plate read 20 times while the car sits at the barrier → **dedupe** (15 s rolling window, refine confidence and upgrade CHECK → ALLOW/DENY instead of a new event).
- Two vehicles within 10 s → two events, display shows current + rail.
- Two-line square plates (325 × 160 mm), motorcycle plates (F-series, small) → OCR must handle 2-line output; test explicitly.
- Malaysian plates (no checksum) → classify as *foreign*, never "repair" them, match exact only.
- MID plates (`12345 MID` / `MID 12345`, 1–5 digits, no checksum) → normalise to `MID12345`.
- Night: floodlit gate + retro-reflective plates should be readable by the tablet; headlight glare on the approach is the real enemy — mount the camera high or at an angle, and benchmark at night in M2. IR/ANPR camera only if that fails.
- Tablet in direct sun → thermal throttling and screen dimming; shade it.
- Supabase free project **pauses after 1 week idle** → the always-on engine's heartbeats keep it awake; still check the dashboard before a demo.
- Mobile data drops at either device → capture buffers the last frames and retries; display falls to manual mode on the cached list.
- Guard overrides a red → must log who, when, why (audit trail).

### POC success criteria
| Metric | Target |
|---|---|
| Read rate (vehicles producing any read, daylight) | ≥ 90 % |
| Plate accuracy on decided reads (green/red shown) | ≥ 95 % |
| Confident-wrong greens | 0 |
| Frame → screen latency (p95) | ≤ 2 s |
| Guard can operate without training | 5-minute walkthrough |

---

## 3. System design

### 3.1 Options considered

| Option | Shape | Pros | Cons | Verdict |
|---|---|---|---|---|
| **1. Serverless cloud** | Capture PWA → Supabase Edge Function → cloud ALPR API → DB → Display | Zero servers, fastest to stand up | Locked to a cloud ALPR forever; no on-prem path; per-lookup quota on a day-and-night gate | Good for a 1-day spike only |
| **2. Cloud-hosted engine (recommended)** | Capture PWA → **VTrack Engine** (FastAPI in an always-on container, e.g. Fly.io / Railway / Render) → Supabase → Display | Engine holds all logic (ALPR adapter, checksum, matching); reachable from any device on any mobile data over HTTPS; runs 24/7; same container moves on-prem unchanged | ~US$5–10/month; public endpoint must be hardened (§3.10) | **Build this** |
| **3. ANPR camera** | Camera with built-in recognition (HTTP/ISAPI push) → Engine → Display | Best night performance, no ML to maintain | S$300–800 hardware, vendor lock-in, needs lane geometry known | Post-POC upgrade for the real site |
| **4. All-in-one phone** | One phone does camera + on-device OCR + list | Simplest possible | Breaks the A ≠ B requirement; browser OCR is weak on plates | No |

### 3.2 Recommended architecture (Option 2)

```
POINT A (mobile data)       CLOUD CONTAINER (always on)              CLOUD                       POINT B (mobile data)
┌─────────────┐  JPEG      ┌──────────────────────────┐  insert    ┌──────────────┐  realtime  ┌──────────────┐
│ Capture PWA │ ─────────▶ │ VTrack Engine (FastAPI)  │ ─────────▶ │ Supabase     │ ─────────▶ │ Gate Display │
│ tablet/phone│  (gated    │  ALPR adapter            │  event +   │  Postgres    │  push      │ PWA (tablet) │
│ presence-   │   frames,  │   ├ local: fast-alpr CPU │  crop      │  Realtime    │            │  + guard     │
│ gated, HTTPS│   HTTPS)   │   └ cloud: API (flag)    │            │  Storage     │ ◀───────── │  actions     │
└─────────────┘            │  normalise → checksum    │            │  Auth        │  override  └──────────────┘
                           │  → repair → match → rule │            └──────┬───────┘
                           └──────────────────────────┘                   │ CRUD
                                                                   ┌──────┴───────┐
                                                                   │ Admin app    │  vehicles, events,
                                                                   │ (same PWA)   │  devices, settings
                                                                   └──────────────┘
```

**Why the engine sits in the middle:** one place for the decision logic, one auth path (service key never leaves the server), one container that later swaps Supabase for a local Postgres when this moves inside the fence. Hosting it in the cloud is what makes "every device on its own mobile data" work: nothing needs a LAN, a laptop, or a tunnel.

### 3.3 Components

| Component | Runs on | Stack | Job |
|---|---|---|---|
| **Capture node** | Samsung tablet at A on mobile data, mounted at the stop line (later: RTSP/ANPR camera) | React + Vite PWA, `getUserMedia`, canvas, Wake Lock API | Viewfinder with lane ROI; **presence + motion gating**; POST JPEG over HTTPS ≤ 2 fps on arrival, then 1 frame / 2 s while the vehicle is present and no confident read exists; heartbeat every 10 s; "tap to capture" fallback |
| **VTrack Engine** | Always-on cloud container (Fly.io / Railway / Render; 2 vCPU, 2 GB) — later a mini PC at the gate | Python 3.12, FastAPI, `sg_plate.py`, ALPR adapter (`fast-alpr` on CPU by default; cloud API behind a flag) | `/recognise`: detect → OCR → normalise → classify → checksum/repair → match → decision → write event + crop; `/heartbeat`; `/health` |
| **Database** | Supabase (free tier for POC) | Postgres + Realtime + Storage + Auth + RLS | Vehicles, events, guard actions, devices; push events to displays |
| **Gate display** | Tablet or phone at B on its own mobile data | Same PWA, route `/display` | Subscribe to `events` inserts; state machine; sounds; guard actions; offline manual mode with cached list |
| **Admin** | Anyone with login | Same PWA, route `/admin` | Vehicle CRUD, CSV import/export, event log with thumbnails, device health, thresholds |

### 3.4 Camera recommendation for the POC
**Use the Samsung tablet at A** (bigger battery, easier to clamp, decent camera) on its own mobile data, mounted where it sees the plate of a car stopped at the guard — roughly 1.5–2 m high, 10–20° off the lane axis so headlights don't fire straight into the lens; a powered mount and shade. Screen B can be the S25 Ultra. **Night:** the gate is floodlit and plates are retro-reflective, so the tablet may be enough — the M2 benchmark runs after dark at the gate and decides. If the tablet fails at night, the approved contingency is an IR/ANPR camera (S$300–800) feeding the same `/recognise` endpoint from a small box; nothing else changes.

### 3.5 Decision pipeline (inside the engine)

```
frame ──▶ detect plate(s) ──▶ OCR ──▶ normalise (A–Z0–9 only, uppercase)
      ──▶ classify: civilian | MID | foreign | invalid
      ──▶ civilian? validate checksum ──▶ fail? try ≤2 confusable substitutions
              ──▶ exactly one candidate validates → use it, flag repaired=true
              ──▶ none / several → CHECK
      ──▶ confidence < 0.60 → CHECK
      ──▶ match vehicles.plate_norm (exact)
              ──▶ no match → DENY (reason: not_on_list)
              ──▶ match, status≠active or outside validity → DENY (reason: expired | suspended)
              ──▶ match, active, in validity → ALLOW
      ──▶ dedupe: same plate_norm within 15 s → update existing event (max confidence, CHECK may upgrade), don't insert
      ──▶ insert event (+ crop to Storage) ──▶ Realtime pushes to display
```

Thresholds to tune in M2 benchmark: `conf_decide = 0.85`, `conf_check = 0.60`, `dedupe_window = 15 s`, `repair_max_subs = 2`. Repaired-and-not-on-list → **CHECK**, not DENY (we are not sure what we read). Display hold: a result stays until **5 s after the plate's last read** (min 8 s), then STANDBY.

### 3.6 Connectivity — no LAN anywhere
Every device is on **its own mobile data**: tablet at A, screen at B, admin wherever you are. Nothing can assume a shared network, a fixed IP, a laptop at the site, or a tunnel. Therefore:

| Piece | Where it lives | How it is reached |
|---|---|---|
| Capture + display + admin PWA | **GitHub Pages** (HTTPS — required for `getUserMedia`) | Any browser on any connection |
| VTrack Engine | **Cloud container**, always on, TLS terminated by the host (`https://vtrack-engine.<host>`) | Capture node → `POST /recognise` with a per-device token; IPs change constantly on mobile data, so auth is token-only |
| Supabase | Supabase cloud | Display/admin via anon key + RLS; engine via service key |
| Dev loop | Laptop only: webcam + `http://localhost:5173` + `localhost:8000` | `localhost` is a secure context — no HTTPS needed while developing |

Data volume on mobile data: ≈ 150 KB per frame, ≈ 4–6 frames per vehicle → ~1 MB per vehicle, ~100–300 MB/month at 100 vehicles/day. Fine on any SIM plan.

**On-prem later (M4):** the same container runs on a mini PC at the gate with a local Postgres; the PWA is served by the engine over the gate LAN. No internet dependency.

### 3.7 Data model (Postgres)

```sql
create type decision as enum ('allow','deny','check');
create type deny_reason as enum ('not_on_list','expired','suspended','unreadable','low_confidence','ambiguous','invalid_pattern');
create type plate_kind as enum ('civilian','mid','foreign','invalid');

create table vehicles (
  id uuid primary key default gen_random_uuid(),
  plate_norm text not null unique,           -- 'SBA1234A', 'MID12345'
  plate_display text not null,               -- 'SBA 1234 A'
  owner_name text not null,
  org_unit text,                             -- company / unit / block
  vehicle_type text check (vehicle_type in ('car','motorcycle','goods','bus','military','other')),
  pass_type text not null default 'permanent' check (pass_type in ('permanent','visitor','contractor')),
  status text not null default 'active' check (status in ('active','suspended')),
  valid_from date, valid_until date,
  notes text,
  created_by uuid, created_at timestamptz default now(), updated_at timestamptz default now()
);

create table devices (
  id text primary key,                       -- 'cam-a', 'display-b', 'engine-1'
  role text not null check (role in ('capture','display','engine')),
  name text, site text, lane text,
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
  image_path text,                           -- storage key of the crop
  bbox jsonb, engine text, latency_ms int,
  read_count int default 1,                  -- bumped by dedupe
  last_read_at timestamptz default now(),    -- bumped by dedupe; display hold/clear reads it
  source text not null default 'camera' check (source in ('camera','manual'))
);
create index on events (ts desc);
create index on events (plate_norm, ts desc);

create table guard_actions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references events(id),
  action text not null check (action in ('let_through','turned_away','manual_entry','confirmed')),
  reason text, actor text, ts timestamptz default now()
);
```

**Realtime:** publication on `events` (INSERT + UPDATE). Display filters by `site`/`lane`.
**RLS:** display/admin use the anon key → `vehicles` readable (limited columns), `events` readable, `guard_actions` insertable; engine uses the service key server-side only; admin writes require Supabase Auth (email OTP) with an `admin` role claim.
**Retention:** crops 7 days, events 90 days (pg_cron), guard actions kept.

### 3.8 API contracts (engine)

| Endpoint | Body | Returns |
|---|---|---|
| `POST /recognise` | multipart: `image` (JPEG), `device_id`, `captured_at`, optional `roi` | `{event_id, plate_norm, plate_kind, confidence, checksum_ok, repaired_from, decision, reason, vehicle:{owner_name, org_unit, pass_type, valid_until}, latency_ms, deduped:boolean}` |
| `POST /heartbeat` | `{device_id, role, version, stats}` | `204` |
| `GET /health` | – | `{engine:'cloud'|'local', model, db:'ok', uptime_s}` |
| `POST /manual` | `{device_id, plate_text, actor}` | same as `/recognise` (kind = manual entry) |

Auth: `X-Device-Token` header per device (stored hashed in `devices`).

### 3.9 Latency budget (target ≤ 2 s p95)

| Stage | Budget |
|---|---|
| Presence gate + JPEG encode on tablet | 50–150 ms |
| Upload over mobile data (~150 KB) | 150–600 ms |
| ALPR in the container (open-source model on 2 vCPU ≈ 150–400 ms · cloud API ≈ 400–900 ms) | 150–900 ms |
| Normalise + checksum + DB match + insert | 80–200 ms |
| Realtime push to display (mobile data) | 150–350 ms |
| **Total — open-source model** | **0.6–1.7 s** |
| **Total — cloud API** | **0.8–2.2 s** (over budget at the worst case) |

The vehicle is stationary, so a 1.5 s read still lands before the greeting ends — but the open-source model in your own container is the only path that fits the budget *and* the quota.

### 3.10 Security & privacy (PDPA applies even in a POC)
- Plates + owner names are personal data: store crops, not full frames; retention as above; least-privilege RLS; admin login required for the list.
- No API keys in the browser: cloud ALPR key (if used) lives only in the engine's host secrets.
- The engine is a **public HTTPS endpoint**: per-device tokens (rotate from admin), rate limit per token (e.g. 5 req/s), reject non-JPEG or tiny images, CORS restricted to the Pages origin, no directory of anything — `/health` returns status only.
- Every override is attributed (`guard_actions.actor`).
- For a camp deployment later: vehicle lists may be sensitive → the on-prem path in §3.6, no cloud at all.

---

## 4. UI / UX

### 4.1 Design language — "Command Console", adapted for a gate
- **Grounds:** navy `#0A1A2F` for the gate display (night-safe), warm paper `#F3EEE4` for admin.
- **Type:** Segoe UI for UI text; **Courier New** for plates, timestamps, IDs. The plate is rendered like a physical Singapore plate — white on black, monospace, rounded slab.
- **Brass `#B8935A`** only on the wordmark and the active-tab underline. Never on status, never as a large fill.
- **Status colours own the screen:** allow green `#1E9E5A` on `#0F6B3E` field · deny red `#D93636` on `#8E1B1B` field · check amber `#E3A21A` on `#7A5200` field · offline slate `#4A5568`.
- **Redundant encoding:** colour + word + icon + sound. ~8 % of men are colour-vision deficient; the guard may not be looking at the screen.

### 4.2 Gate display (point B) — principles
| Principle | Implementation |
|---|---|
| Glanceable at 3 m | Status field fills ≥ 70 % of the screen; plate ≥ 120 px tall; one verb: PROCEED / DO NOT ALLOW / VERIFY MANUALLY |
| Live view + history | Stage = the vehicle at the guard now, refined in place as better frames arrive; right rail: last 5 reads (time, plate chip, decision dot) |
| Hold and clear | Result holds while the vehicle is in front of the guard: clears **5 s after the plate's last read** (min 8 s), or is replaced by the next vehicle's event; back to STANDBY |
| Guard actions | On DENY/CHECK only: **LET THROUGH (override)** — asks for a reason; **TURNED AWAY**. On CHECK also: plate crop + typed-plate keypad with live checksum validation |
| Sound | Chimes **on by default** — two rising tones (allow), one low tone twice (deny), one mid tone (check); mute toggle in the top bar |
| Night mode | Dark base always; status fields drop luminance after 19:00 |
| Offline | Grey banner "Camera A offline since 14:02" / "No connection — manual mode": search box over the last-synced list (cached in IndexedDB) |
| Trust cues | Small line under the plate: `read 0.8 s ago · confidence 0.97 · checksum ✓` ; "repaired" badge when a confusable was fixed |

### 4.3 Capture node (point A)
Viewfinder · draggable lane ROI rectangle · **presence** indicator (vehicle in ROI) · detection box flashes on read · "last read" chip · engine status pill · Auto / Tap mode toggle · screen lock to prevent accidental exit · keep-awake · mobile-data friendly (frames only while a vehicle is present and unread).

### 4.4 Admin
Vehicle table (search, status/pass-type filters, expiry warnings) · Add/edit side panel with plate validation (auto-computes checksum) · CSV import/export · Event log with crop thumbnails, decision filter, override audit · Devices (last seen, version) · Settings (thresholds, dedupe window, retention).

### 4.5 Display state machine

```
             event(decision)                 5 s after last read (min 8 s) | next vehicle
 STANDBY ───────────────────────▶ ALLOW / DENY / CHECK ─────────────────────────▶ STANDBY
                                        ▲ │ UPDATE on the same event (dedupe) re-renders in place
    ▲                                    │ guard action (let_through | turned_away | manual)
    │                                    ▼
    └──────────────────────────── logged to guard_actions

 any state ── heartbeat miss > 30 s ──▶ OFFLINE banner (state preserved underneath)
 any state ── realtime disconnected ──▶ MANUAL MODE (cached list search)
```

---

## 5. Roadmap

| Milestone | Scope | Done when |
|---|---|---|
| **M0 · List + display (week 1)** | Supabase schema + RLS; admin CRUD + CSV import; display with a "simulate event" button; manual mode | Guard screen shows correct green/red for simulated events; manual search works offline |
| **M1 · First real read** | Engine with the open-source adapter (CPU) and the cloud-API adapter behind a flag; capture page on the laptop webcam, all on `localhost`; `sg_plate.py` + tests | Your car on the driveway → green on the display in < 2 s |
| **M2 · Cloud deploy + tablet at the gate** | Dockerfile + deploy to the container host; tablet at A and phone at B on mobile data; **50-photo benchmark at the gate, day and night** (car/bike, 1-line/2-line, MID, foreign) for both adapters | Benchmark table incl. night read rate; engine chosen by config flag; go/no-go on the IR camera |
| **M3 · Harden + demo** | Heartbeats, offline banner, guard actions, sounds, dedupe upgrades, hold/clear rule, retention, event log, token rotation, rate limit | Dry run with 20 vehicles incl. 3 unknown, 1 expired, 1 suspended, 1 dirty plate, after dark; success metrics met |
| **M4 · Site path (post-POC)** | Same container on a mini PC at the gate; local Postgres; RTSP/ANPR camera; visitor pre-registration via FormSG → list | Same engine, no internet dependency |

---

## 6. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Open-source model weak on SG plates | Accuracy | Benchmark in M2; cloud-API adapter stays as a fallback flag |
| Night / headlight glare | Read rate | Floodlit gate + retro-reflective plates; camera angle; night benchmark in M2; IR/ANPR camera if it fails (budget approved on evidence) |
| Cloud ALPR quota (evaluation tier 2,500/month) | Cost | Open-source model is the default; API only for the benchmark or as a paid fallback |
| Public engine endpoint | Abuse | Per-device tokens, rate limit, image validation, CORS (§3.10) |
| Mobile data drop at A or B | Gaps | Capture retries with a short buffer; display manual mode on cached list; every event still lands when the link returns |
| Supabase free project auto-pauses | Demo fails | Engine heartbeats keep it active; check the dashboard before a demo |
| Tablet heat / battery | Uptime | Shade, powered mount, Wake Lock |
| PDPA | Compliance | Minimal data, retention, access control (§3.10) |

---

## 7. Decisions log (answered 9 Sep 2026)
| Question | Answer | Design consequence |
|---|---|---|
| A→B distance | Under 10 m | Live view, not a lead-time queue; hold/clear on vehicle presence |
| Vehicle flow | Every vehicle stops at the guard | Many frames per vehicle; presence-gated capture; dedupe upgrades |
| Hours | Day and night; gate floodlit | Night benchmark at the gate in M2; IR/ANPR camera only if the tablet fails (budget approved on evidence) |
| MID plates | On the list like everyone else | No auto-allow; MID rows have `vehicle_type='military'` |
| List owner | Ranee, in the admin screen | Admin CRUD + CSV import in M0; FormSG visitor flow stays post-POC |
| Sound | Yes, with a mute toggle | Chimes on by default |
| Connectivity | Each device on its own mobile data — no LAN | Engine cloud-hosted; PWA on GitHub Pages; token auth; no tunnel |
| Engine | Cloud-hosted container | Open-source model on CPU by default; same container on-prem in M4 |

**Still open:** rough vehicles per day (sizes the container and any API plan); which container host (Claude Code can pick — Fly.io is the default); whether screen B is the S25 Ultra or a tablet.

---

## Sources
- Checksum algorithm and worked examples: [Vehicle registration plates of Singapore — Wikipedia](https://en.wikipedia.org/wiki/Vehicle_registration_plates_of_Singapore), [Vehicle Checksum Formula — SgWiki](https://sgwiki.com/wiki/Vehicle_Checksum_Formula), [Deuellau/Vehicle-Registration-Plate-Checksum](https://github.com/Deuellau/Vehicle-Registration-Plate-Checksum)
- MID plate format: [Senang Diri — Guide to SAF MID vehicle number plates](http://kementah.blogspot.com/2013/08/guide-to-singapore-armed-forces-saf-mid.html)
- Local engine: [ankandrew/fast-alpr (MIT)](https://github.com/ankandrew/fast-alpr)
- Cloud engine: [Plate Recognizer pricing](https://platerecognizer.com/pricing/)
- Database: [Supabase pricing 2026 — UI Bakery](https://uibakery.io/blog/supabase-pricing)
