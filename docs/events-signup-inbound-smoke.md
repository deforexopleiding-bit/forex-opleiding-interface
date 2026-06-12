# Events signup-inbound bridge — smoke-doc (Fase 1)

Branch: `feat/events-signup-inbound`
PR: open (NIET gemerged)
Migratie: `docs/sql-migrations/2026-06-12-event-signup-inbox.sql` — Chrome
draait 'm op prod Supabase vóór merge.

Vijf scenario's om de Fase 1 inbound-brug te valideren op de preview-URL.
Verwacht overal **HTTP 200** (webhook-vriendelijk) tenzij anders vermeld.

Vereiste env-vars op de preview-deployment:
- `EVENTS_INBOUND_WEBHOOK_SECRET` = `<random secret string>`
- Bestaande F2-vars: `WEBFLOW_API_TOKEN`, `WEBFLOW_SITE_ID`,
  `WEBFLOW_EVENTS_COLLECTION_ID`, `GHL_EVENTS_PIT_TOKEN`.

Helper: stel een `BASE_URL` en `SECRET` in je shell, dan zijn de calls hieronder
direct copy-paste.

```bash
BASE_URL='https://<preview-or-prod>.vercel.app'
SECRET='<events-inbound-secret>'
```

---

## Scenario 1 — matched (1 event)

**Doel:** Een geldige webhook met een label dat exact één published event
matcht maakt een attendee aan + draait de seat-fill helpers.

**Pre-flight:**
- Maak een testevent `SMOKE-INBOUND-MATCH` met `niveau='basis'`, `capacity=10`,
  `status='published'`, een datum > nu.
- Wacht tot F2 publish-sync klaar is.
- Bereken het verwachte label via Vercel logs of repl:
  `'<Weekday> <day> <maand> <jaar> | HH:MM - HH:MM | Basis'`
  (precies wat `formatEventLabel` produceert in nl-NL / Europe/Amsterdam).

**Call:**
```bash
curl -sS -X POST "$BASE_URL/api/events-signup-inbound" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $SECRET" \
  -d '{
    "first_name": "Smoke",
    "last_name":  "Matched",
    "email":      "smoke+inbound-matched@deforexopleiding.nl",
    "phone":      "+31612345600",
    "ghl_contact_id": "ghl_abc_001",
    "ghl_form_submission_id": "ghl_form_xyz_001",
    "event_date_label": "<exact label van SMOKE-INBOUND-MATCH>"
  }'
```

**Verwacht response:**
```json
{
  "ok": true,
  "inbox_id": "<uuid>",
  "match_status": "matched",
  "matched_event_id": "<event-uuid>",
  "attendee_id": "<attendee-uuid>",
  "candidate_count": 1,
  "deduplicated": false,
  "confirmed_count": 1,
  "gastenlijst_label": "1 / 10",
  "auto_closed": false
}
```

**Verifieer in DB:**
```sql
SELECT id, match_status, matched_event_id, matched_attendee_id, source
FROM public.event_signup_inbox
WHERE raw_payload->>'first_name'='Smoke' ORDER BY received_at DESC LIMIT 1;

SELECT id, status, created_via, email, phone, follow_up_flagged, ghl_contact_id
FROM public.event_attendees
WHERE email='smoke+inbound-matched@deforexopleiding.nl';
-- verwacht: status=aangemeld, created_via='ghl_inbound', follow_up_flagged=false
```

**Verwacht in Webflow:** Gastenlijst-veld op het CMS-item toont `"1 / 10"`.

---

## Scenario 2 — no_match (label past op geen enkel event)

**Doel:** Een label dat op geen enkel published event matcht produceert
een inbox-rij met `match_status='no_match'`. **Geen** event_attendees-rij.

**Call:**
```bash
curl -sS -X POST "$BASE_URL/api/events-signup-inbound" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $SECRET" \
  -d '{
    "first_name": "Lost",
    "last_name":  "Soul",
    "email":      "smoke+inbound-lost@deforexopleiding.nl",
    "phone":      "+31612345601",
    "event_date_label": "Maandag 31 februari 2099 | 99:99 | Onbestaand"
  }'
```

**Verwacht:**
```json
{ "ok": true, "inbox_id": "<uuid>", "match_status": "no_match",
  "candidate_count": <int> }
```

**Verifieer:**
```sql
SELECT match_status, matched_event_id, matched_attendee_id
FROM public.event_signup_inbox
WHERE email='smoke+inbound-lost@deforexopleiding.nl'
ORDER BY received_at DESC LIMIT 1;
-- verwacht: no_match | NULL | NULL

SELECT count(*) FROM public.event_attendees
WHERE email='smoke+inbound-lost@deforexopleiding.nl';
-- verwacht: 0
```

**Admin-resolve (handmatig koppelen):**
```bash
# Stel sessie-JWT in als $JWT (admin met events.attendee.create).
curl -sS -X POST "$BASE_URL/api/events-signup-inbox-resolve" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{
    "inbox_id": "<uuid uit vorige stap>",
    "event_id": "<id van SMOKE-INBOUND-MATCH>",
    "notes": "Label was typo - handmatig gekoppeld voor smoke."
  }'
```

**Verwacht:** `200 { ok:true, attendee_id, deduplicated:false, ... }`. De
inbox-rij heeft nu `match_status='matched'` + `resolved_at` + `resolved_by_user_id`.

---

## Scenario 3 — ambiguous (2 events met identiek label)

**Doel:** 2 published events met EXACT zelfde label → attendee komt bij
de eerste (vroegste starts_at sorteert eerst), `follow_up_flagged=true`,
`match_status='ambiguous'`.

**Pre-flight:**
- Maak 2 testevents `SMOKE-INBOUND-AMBIG-A` + `SMOKE-INBOUND-AMBIG-B` met
  **identieke** `starts_at`, `ends_at`, `niveau`. Beide published.
- Verifieer dat `formatEventLabel` voor beide rijen dezelfde string geeft.

**Call:**
```bash
curl -sS -X POST "$BASE_URL/api/events-signup-inbound" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $SECRET" \
  -d '{
    "first_name": "Two",
    "last_name":  "Match",
    "email":      "smoke+inbound-ambig@deforexopleiding.nl",
    "phone":      "+31612345602",
    "event_date_label": "<identical label>"
  }'
```

**Verwacht:**
```json
{ "ok": true, "match_status": "ambiguous", "matched_event_id": "<A-id>",
  "attendee_id": "<uuid>", "candidate_count": 2 }
```

**Verifieer:**
```sql
SELECT match_status, matched_event_id, match_candidate_ids
FROM public.event_signup_inbox
WHERE email='smoke+inbound-ambig@deforexopleiding.nl'
ORDER BY received_at DESC LIMIT 1;
-- verwacht: ambiguous | <A-id> | [<A-id>, <B-id>]

SELECT event_id, follow_up_flagged, follow_up_reason
FROM public.event_attendees
WHERE email='smoke+inbound-ambig@deforexopleiding.nl';
-- verwacht: <A-id> | true | 'AMBIGUOUS_LABEL: 2 candidates matched same label'
```

---

## Scenario 4 — dedup (zelfde email 2× → 1 attendee)

**Doel:** Een tweede webhook met dezelfde `email` op hetzelfde event maakt
**geen** nieuwe attendee-rij (partial UNIQUE op `(event_id, lower(email))`
wordt eerst code-side gedetecteerd, dan vangen we de race-23505).

**Call (eerste):**
```bash
curl -sS -X POST "$BASE_URL/api/events-signup-inbound" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $SECRET" \
  -d '{
    "first_name": "Dup",
    "last_name":  "Test",
    "email":      "smoke+inbound-dedup@deforexopleiding.nl",
    "phone":      "+31612345603",
    "event_date_label": "<label SMOKE-INBOUND-MATCH>"
  }'
```

Wacht **6 seconden** (om de IP-rate-limit van 5s te omzeilen).

**Call (tweede, exact dezelfde email):**
```bash
curl -sS -X POST "$BASE_URL/api/events-signup-inbound" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $SECRET" \
  -d '{
    "first_name": "Dup",
    "last_name":  "Test",
    "email":      "smoke+inbound-dedup@deforexopleiding.nl",
    "phone":      "+31612345604",
    "event_date_label": "<label SMOKE-INBOUND-MATCH>"
  }'
```

**Verwacht response 2:** `deduplicated: true`, **zelfde** `attendee_id`
als response 1.

**Verifieer:**
```sql
SELECT count(*) AS attendee_count
FROM public.event_attendees
WHERE email='smoke+inbound-dedup@deforexopleiding.nl';
-- verwacht: 1

SELECT count(*) AS inbox_count
FROM public.event_signup_inbox
WHERE email='smoke+inbound-dedup@deforexopleiding.nl';
-- verwacht: 2 (allebei matched, beide naar zelfde attendee_id)
```

---

## Scenario 4b — niveau-suffix tolerantie (legacy-labels)

**Doel:** Een binnenkomend label ZONDER `' | <niveau>'`-suffix matcht
nog steeds het event dat F2 mét suffix exporteert. Andersom werkt ook.

**Achtergrond:** Historisch heeft GHL labels zonder niveau opgeslagen
(voorbeeld: `'Zaterdag 13 juni 2026 | 10:00 - 13:00'`). De resolver
matched canoniek op `(date, startTime)` en gebruikt endTime + niveau
alleen als tiebreaker bij ≥ 2 hits.

**Pre-flight:**
- Eén event `SMOKE-INBOUND-TOL` published, `niveau='basis'`,
  `starts_at` = een unieke datum + tijd zodat er maar 1 candidate is.

**Call A — input zonder niveau-suffix:**
```bash
curl -sS -X POST "$BASE_URL/api/events-signup-inbound" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $SECRET" \
  -d '{
    "first_name": "Tol",
    "last_name":  "ZonderNiveau",
    "email":      "smoke+inbound-tol-a@deforexopleiding.nl",
    "event_date_label": "<label van SMOKE-INBOUND-TOL ZONDER \" | Basis\">"
  }'
```
Verwacht: `match_status: "matched"`, `resolve_reason: "unique-canonical-match"`,
gekoppeld aan SMOKE-INBOUND-TOL.

Wacht 6 sec. **Call B — input MET niveau-suffix (full label):**
```bash
curl -sS -X POST "$BASE_URL/api/events-signup-inbound" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $SECRET" \
  -d '{
    "first_name": "Tol",
    "last_name":  "MetNiveau",
    "email":      "smoke+inbound-tol-b@deforexopleiding.nl",
    "event_date_label": "<full label MET \" | Basis\">"
  }'
```
Verwacht: `match_status: "matched"`, `resolve_reason: "unique-canonical-match"`,
zelfde event.

**Bonus — tiebreaker scenario:** Maak 2 events op exact dezelfde
`(date, startTime)` maar verschillend `niveau` (één basis, één gevorderd).
Stuur een webhook met label inclusief `' | Basis'` → resolver kiest
de basis-rij met `resolve_reason: 'niveau-tiebreaker'`. Stuur dezelfde
label maar zonder niveau-suffix → `resolve_reason: 'ambiguous-multiple-canonical-matches'`,
beide rijen in `match_candidate_ids`.

---

## Scenario 5 — seat-fill + auto-vol op matched

**Doel:** Een matched-webhook op een capaciteits-bereikt event triggert
de PR 3 close-cascade (`signups_closed=true`, Webflow naar draft,
GHL-dropdown vernieuwd).

**WAARSCHUWING:** Alleen op een wegwerp-testevent met capaciteit ≤ 2.

**Pre-flight:**
- Testevent `SMOKE-INBOUND-AUTOVOL` met `capacity=2`, `status='published'`,
  `signups_closed=false`. Beide niveaus OK.

**Call (registratie 1):**
```bash
curl -sS -X POST "$BASE_URL/api/events-signup-inbound" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $SECRET" \
  -d '{
    "first_name": "Auto",
    "last_name":  "Vol-1",
    "email":      "smoke+inbound-autovol-1@deforexopleiding.nl",
    "phone":      "+31612345610",
    "event_date_label": "<label SMOKE-INBOUND-AUTOVOL>"
  }'
```
Verwacht: `gastenlijst_label: "1 / 2"`, `auto_closed: false`.

Wacht 6 sec. **Call (registratie 2):**
```bash
curl -sS -X POST "$BASE_URL/api/events-signup-inbound" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $SECRET" \
  -d '{
    "first_name": "Auto",
    "last_name":  "Vol-2",
    "email":      "smoke+inbound-autovol-2@deforexopleiding.nl",
    "phone":      "+31612345611",
    "event_date_label": "<label SMOKE-INBOUND-AUTOVOL>"
  }'
```

**Verwacht response 2:** `gastenlijst_label: "2 / 2"`, **`auto_closed: true`**.

**Verifieer:**
```sql
SELECT signups_closed, signups_closed_reason
FROM public.events WHERE title='SMOKE-INBOUND-AUTOVOL';
-- verwacht: true | 'auto_full'
```

GHL-dropdown vernieuwd (event uit upcoming-set verdwenen). Webflow-item
op draft (overzichts-CMS-page toont 'm niet meer na volgende site-publish).

**Opruimen:** reopen via `/api/events-reopen-signups?id=<uuid>` of archive
via `/api/events-delete?id=<uuid>`.

---

## Auth + abuse-edge-cases (snel)

| Situatie | Verwacht |
|---|---|
| `X-Webhook-Secret` ontbreekt of fout | `401 unauthorized`, **geen DB-mutatie** |
| `hp_company: 'spam'` in body | `422`, geen DB-mutatie |
| 2 calls binnen 5s vanaf zelfde IP | tweede = `429`, geen DB-mutatie |
| Geen `event_date_label` in body | `200 invalid_payload`, inbox-rij wel aangemaakt voor audit |
| Geen email én geen phone | `200 invalid_payload`, idem |
| `EVENTS_INBOUND_WEBHOOK_SECRET` env-var niet gezet | `503 inbound webhook niet geconfigureerd` |

---

## Lijst-endpoint (admin)

```bash
curl -sS "$BASE_URL/api/events-signup-inbox-list?status=no_match&limit=20" \
  -H "Authorization: Bearer $JWT"
```

Returnt rijen + counts per status + embedded `matched_event` per rij voor
direct in een admin-tabel te renderen zonder N+1.
