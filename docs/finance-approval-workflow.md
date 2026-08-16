# Finance Agents — Approval Workflow

## Principle

An agent may **analyze and recommend**. A human must **approve**. Execution
in the real world — paying an account down, opening a business bank
account, applying for a tradeline — is always a manual step taken by a
person, even after approval. This module does not hold bank credentials,
cannot move money, and cannot submit a credit application.

## Lifecycle of a recommendation

```
finance-analyze / finance-debt-payoff / finance-credit-builder
        │  INSERT finance.agent_recommendations (status = 'pending')
        ▼
   ┌─────────┐
   │ pending │  ← visible via finance.pending_recommendations
   └────┬────┘
        │  finance-approvals { decision: 'approve' | 'reject' }
        ▼
 ┌───────────┐        ┌───────────┐
 │ approved  │        │ rejected  │
 └─────┬─────┘        └───────────┘
       │  human executes the real-world action manually
       ▼
 ┌────────────┐
 │ completed  │  ← mark manually once done (see below)
 └────────────┘
```

## Reviewing what's pending

Query the view directly — there's no separate "list" edge function on
purpose, to keep the read path as simple as `SELECT * FROM
finance.pending_recommendations`:

```sql
select * from finance.pending_recommendations;
```

Each row has `title`, `rationale` (plain English — AI-written if
`ANTHROPIC_API_KEY` is set, templated otherwise), `details` (the underlying
numbers), and `priority`.

## Approving or rejecting

```bash
curl -X POST https://<project>.supabase.co/functions/v1/finance-approvals \
  -H "Content-Type: application/json" \
  -H "x-finance-secret: $FINANCE_WEBHOOK_SECRET" \
  -d '{
    "recommendation_id": "<uuid>",
    "decision": "approve",
    "decided_by": "James",
    "notes": "Approved — will set up the extra $200/mo payment manually next cycle."
  }'
```

Approving:
- Sets `agent_recommendations.status = 'approved'`, stamps `decided_at` /
  `decided_by` / `decision_notes`.
- Logs a row in `recommendation_events` (append-only audit trail — nothing
  is ever deleted from this table).
- If the recommendation is linked to a `debt_payoff_plans` row, that plan
  moves to `status = 'approved'`.
- If linked to a `credit_building_actions` row, that action moves to
  `status = 'in_progress'`.

Rejecting does the same bookkeeping but sets `status = 'rejected'` /
`'skipped'` instead, and the human's `notes` field is the place to record
*why* — useful when re-running the agent later so the reasoning isn't lost.

## Marking something completed

Once a human has actually made the extra payment or opened the account,
mark it done directly for now (a dedicated `finance-complete` function may
be added later, but the field already exists):

```sql
update finance.agent_recommendations set status = 'completed' where id = '<uuid>';
update finance.debt_payoff_plans      set status = 'completed' where id = '<uuid>';
update finance.credit_building_actions set status = 'completed', completed_at = now() where id = '<uuid>';
```

## Multi-entity note

A recommendation with `entity_id = NULL` applies across every entity (e.g. a
consolidated debt-payoff plan spanning household + business debts). Approve
those the same way — `entity_id` on the recommendation just tells you the
scope, it doesn't change the approval mechanics.
