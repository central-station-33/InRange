# Finance Agents — Business Entities & Credit-Building Playbook

## Seeded entities

`supabase/migrations/20260816000000_finance_schema.sql` seeds one row per
book of finances in `finance.entities`. These are structural rows only —
name, type, legal structure, status — no balances or account numbers.

| Name | `entity_type` | Business |
|---|---|---|
| Household | `personal` | Personal/household finances |
| BT Capital | `family_fund` | Family investment fund — just started (`status = 'forming'`) |
| The J.E.T Group | `destination_services` | Destination service provider |
| Jet Realty Advisors | `real_estate_brokerage` | Real estate brokerage |
| Kei Productions Inc | `film_production` | Film/TV production |
| Keia Bounds Costume Design | `creative_services` | Costume designer |
| James Thompson — Highline Residential | `professional_services` | Residential association broker |

`legal_structure` (`sole_prop` / `llc` / `s_corp` / `c_corp` / `partnership`)
and `formed_date` were left `NULL` since the actual structures weren't
specified — fill those in directly once known:

```sql
update finance.entities set legal_structure = 'llc', formed_date = '2026-06-01'
  where name = 'BT Capital';
```

## The business-credit-building playbook

`finance-credit-builder` (`supabase/functions/finance-credit-builder/index.ts`)
walks each business through the same standard sequence — it's the order
lenders and vendors generally expect a business credit file to be built in,
regardless of industry:

1. **Obtain a federal EIN** — separates the business's credit identity from
   personal SSN-based credit.
2. **Open a dedicated business bank account** — in the legal business name,
   using the EIN.
3. **Register a D-U-N-S number** — free registration with Dun & Bradstreet;
   most bureaus and vendors require one to open a file.
4. **Open 2-3 net-30 vendor tradelines** that report to business bureaus
   (e.g. Uline, Quill, Grainger) — pay in full, on time, every cycle.
5. **Apply for a starter/secured business credit card** appropriate to the
   file's current thickness.
6. **Enroll in monitoring** across at least two of: D&B, Experian Business,
   Equifax Business.
7. **Maintain 6-12 months of on-time payment history** across every open
   tradeline/card.
8. **Apply for a revolving business credit line** or a second card from a
   mainstream issuer once the file is established.

Each business's progress against this sequence lives in
`finance.business_credit_profiles` (one row per entity, auto-created on
first `finance-credit-builder` run) and `finance.credit_building_actions`
(one row per recommended/completed step). Query
`finance.credit_building_status` for a per-entity summary.

### Running it per business

```bash
curl -X POST https://<project>.supabase.co/functions/v1/finance-credit-builder \
  -H "Content-Type: application/json" -H "x-finance-secret: $FINANCE_WEBHOOK_SECRET" \
  -d '{"entity_id": "<jet-realty-advisors-uuid>"}'
```

Run it once per business entity (not `Household`, which is `entity_type =
'personal'` and the function rejects). Each call recommends up to
`max_actions` (default 2) unmet steps and files one `agent_recommendation`
for review.

### BT Capital note

BT Capital is seeded with `status = 'forming'` since it "just started" — its
credit profile will start at every playbook step unmet (`estimated_stage =
'not_started'`). That's expected; step 1 (EIN) is the right starting point
once formation is complete.
