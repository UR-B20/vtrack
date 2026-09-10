# VTrack

A tablet camera at **point A** reads licence plates of vehicles that stop at the guard at **point B**. The VTrack Engine recognises the plate, validates the Singapore checksum, matches it against the approved-vehicle list and writes one event. Supabase pushes that event to the gate display, where the guard sees `ALLOW`, `DENY` or `CHECK` within about a second.

Design intent lives in [`docs/design-brief.md`](docs/design-brief.md); the build contract is [`CLAUDE.md`](CLAUDE.md).

**Every device is on its own mobile data — there is no LAN, no laptop at the site and no tunnel.**

---

## Where this is

**Milestone M0 — list + display.** The Supabase schema, the admin console Ranee uses to own the approved list, and the gate display driven by simulated events. The engine (M1), the camera node (M2) and heartbeats, crops and retention (M3) are not built yet; `/capture` is a placeholder.

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
| `/capture` | Point A. Placeholder until M1. |

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
supabase/            migrations, seed, admin_role, dev/
```

Four modules are pure and carry the tests: `plates.ts`, `status.ts`, `displayMachine.ts`, `csv.ts`. Everything that touches the network lives in the route components, which is what keeps those four testable.

### Things worth knowing before changing them

**The display's timers run on the local clock.** `ts` and `last_read_at` come from Postgres; the browser's clock is its own. Comparing them directly means a tablet 15 s fast clears a DENY on the first tick, and these tablets run on mobile data with no NTP guarantee. So every hold window is measured from when the read *arrived*. Server timestamps are used only for text the guard reads as a clock. `displayMachine.test.ts` asserts this under ±60 s of injected skew.

**`hydrate` never stages and never chimes.** Loading the last five events into the rail on connect must not be able to take the stage, or every reload and reconnect would flash a full-screen green for a vehicle that left hours ago — the confident wrong green that CLAUDE.md §1 exists to prevent.

**CSV import runs on `classify()`, not on a bare checksum.** "Reject rows whose checksum fails" read literally would reject `MID 12345`, which has no checksum. And `repair()` is never called on an import: a silently repaired row would put a plate on the approved list that nobody typed.

**Two deliberate departures from the canvas.**

`gate-allowed.png` shows the owner's name, unit, pass type and expiry under PROCEED. We render only "On the approved list". The guard needs none of it to wave a car through — the system has already decided — and the gate screen is readable from outside the post, so a green that broadcasts names is a privacy cost (brief §3.10) with no operational benefit. The details still appear where they are acted on: the DENY reason lines, manual mode, and `/admin`.

In `gate-check.png` the rail chip for the 14:25:40 event shows the raw read `SNB 953B E`, while `gate-allowed.png` shows the same event as the repaired `SNB 9538 E`. We render the best guess (`plate_norm`) everywhere; the raw read appears only in the CHECK stage's "what the camera saw" panel.

**TURNED AWAY is one tap; LET THROUGH is not.** Turning a vehicle away is the guard agreeing with a decision the system already made, so there is nothing to justify, and putting a form in front of the correct action is how you train people to stop using it. The row is still written to `guard_actions`. Letting a denied vehicle through is the override, and that one asks for a reason and a name (§3.10).

---

## Deploy

`.github/workflows/deploy.yml` builds `apps/web` and publishes to GitHub Pages on push to `main`, with the base path set to the repo name and `index.html` copied to `404.html` so deep links survive a cold load.

Enable it once under **Settings → Pages → Source: GitHub Actions**.
