# Lead-Claim Mechanism

## The gap this fixes

While scoping this, I checked the live Make.com org's existing "assign a lead
to an agent" path (`ISA S10: Assign + Enrich Pipeline` → `notify-isa` →
`ISA Notify Receiver`). **It doesn't alert anyone.** `ISA Notify Receiver`
receives the payload and immediately writes a `log-touch` record with
`outcome: "no_answer"` — a placeholder that makes the pipeline *look* like
it's notifying an ISA, without ever sending an SMS, Slack message, or email
to a real person. Every lead the live system has routed through that path has
gone un-alerted. That's the actual current state, independent of anything to
do with rentals.

This doc describes a real fix, built as a reference implementation in this
repo (per your call to build here first rather than against the live org).

## Design

- `properties.claim_status` (`unclaimed` | `claimed`), `claimed_by`,
  `claimed_at` — added in migration `20240101000002`.
- `claim_property(p_id, p_agent)` SQL function does the claim as a single
  atomic `UPDATE ... WHERE claim_status = 'unclaimed' RETURNING *` — this is
  what actually prevents two agents claiming the same lead in a race; a
  plain "check then update" from application code would not be safe.
- `unclaimed_leads` view — unclaimed, scored leads ordered by score, for
  whatever "claim board" UI ends up in front of agents (Retool is the
  existing system of record here — see "Airtable vs. Retool" below).
- `claim-lead` edge function — the endpoint an agent's claim button calls.
  Returns `409` if the lead was already claimed (race lost).
- `notify-unclaimed` edge function — finds unclaimed, un-alerted leads and
  POSTs each to a Make webhook, then stamps `claim_alert_sent_at` so it
  doesn't re-alert on the same lead every time it runs.
- `InRange-lead-claim-alert.json` — the Make-side receiver blueprint.

## Airtable vs. Retool

You asked for "Airtable or Central Hub." There's no Airtable connection
anywhere in this Make team. The actual Central Hub is **Retool**, backed by
a Postgres database already wired into 15+ live scenarios (`Retool Database`
connection). Introducing Airtable would mean a second, separate system of
record that has to be kept in sync with the one that already exists — real
sync-drift risk for no clear benefit unless there's a reason (e.g. agents
specifically want Airtable's UI) I'm not aware of. This design extends
Retool/Postgres instead. Say so if Airtable is wanted anyway for a specific
reason and I'll design the sync instead.

## SMS alert: what's real vs. what needs your action

You picked SMS (Twilio) as the alert channel. Status:

- **Buildable now, in this repo:** `notify-unclaimed` posts a payload
  (including a pre-built `sms_message` string) to a Make webhook — done,
  see `supabase/functions/notify-unclaimed/index.ts`.
- **Not yet possible to activate:** the Make team has zero Twilio
  connections with send capability (only inbound SMS is wired, for a
  different scenario). Someone needs to add a Twilio account + connection
  in Make before `InRange-lead-claim-alert.json`'s SMS step can run. I
  flagged this directly in that file's `_note` rather than pretending the
  Twilio module is verified — I don't have a live Twilio-send connection to
  test the module against.
- Email is a reasonable interim fallback since the Gmail connection already
  exists live — worth adding as a second branch in the Make scenario if you
  want alerts working before Twilio is set up, even though you picked SMS
  as the primary channel.

## Env vars added

```
MAKE_CLAIM_ALERT_WEBHOOK=https://hook.us2.make.com/...   # InRange-lead-claim-alert.json's webhook URL
```
