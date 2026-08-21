-- Migration: Fix lead_touches foreign key and constraint sync
-- Applied: 2026-05-15
--
-- Problem: migration 20240101000002 created lead_touches with:
--   lead_id REFERENCES leads(id)
-- Migration 20260515000000 tried to CREATE TABLE IF NOT EXISTS lead_touches
-- pointing to isa_leads(id) — a no-op since the table already existed.
-- Result: every edge function inserts isa_leads UUIDs into a column that
-- enforces leads UUIDs, causing FK violations or orphaned records.
--
-- This migration re-points the FK to isa_leads and syncs the channel/outcome
-- CHECK constraints to match what the edge functions actually send.

-- ─── 1. Re-point lead_id FK from leads → isa_leads ───────────────────────────

ALTER TABLE lead_touches
  DROP CONSTRAINT IF EXISTS lead_touches_lead_id_fkey;

ALTER TABLE lead_touches
  ADD CONSTRAINT lead_touches_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES isa_leads(id) ON DELETE CASCADE;

-- ─── 2. Sync channel constraint (add 'mailer', keep existing values) ──────────

ALTER TABLE lead_touches
  DROP CONSTRAINT IF EXISTS lead_touches_channel_check;

ALTER TABLE lead_touches
  ADD CONSTRAINT lead_touches_channel_check
  CHECK (channel IN ('call', 'sms', 'email', 'dm', 'voicemail', 'mailer'));

-- ─── 3. Sync outcome constraint (add 'wrong_number', 'callback_requested') ───

ALTER TABLE lead_touches
  DROP CONSTRAINT IF EXISTS lead_touches_outcome_check;

ALTER TABLE lead_touches
  ADD CONSTRAINT lead_touches_outcome_check
  CHECK (outcome IN (
    'no_answer', 'voicemail', 'callback_requested',
    'not_interested', 'interested', 'appointment_set', 'wrong_number'
  ));
