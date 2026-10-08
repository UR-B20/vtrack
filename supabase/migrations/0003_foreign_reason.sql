-- 0003 — a foreign plate is denied as such (CLAUDE.md §11, Foreign plates, 8 Oct 2026).
-- Only Singapore plates are admitted; the engine writes reason 'foreign' for them.
-- Apply BEFORE the engine that writes it is deployed. Re-runnable.
alter type public.deny_reason add value if not exists 'foreign';
