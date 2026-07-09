-- Migration: Inbound lead tracking columns
-- Applied: 2026-05-15
-- Adds columns needed by the respond-lead edge function (OpenClaw-equivalent inbound response).

ALTER TABLE isa_leads
  ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS inbound_channel   TEXT,
  ADD COLUMN IF NOT EXISTS inbound_message   TEXT;

COMMENT ON COLUMN isa_leads.first_response_at IS 'Timestamp of the first auto-response sent to this lead. Set once by respond-lead; never overwritten.';
COMMENT ON COLUMN isa_leads.inbound_channel   IS 'Channel the lead came in on: sms, email, website_form, zillow, etc.';
COMMENT ON COLUMN isa_leads.inbound_message   IS 'The raw message text the lead sent on first contact.';
