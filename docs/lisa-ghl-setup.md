# Lisa GHL Integratie — Setup Guide

Stap-voor-stap handleiding om de Instagram → Lisa integratie aan te zetten in GoHighLevel (GHL).

## Overzicht

Lisa verwerkt Instagram-DM's via GHL. De volledige keten:

```
Instagram DM → GHL workflow (trigger: inbound IG) → Outbound webhook
   → /api/lisa-ghl-webhook → Lisa genereert AI-antwoord
   → kantooruren? direct terug via GHL : plannen (cron stuurt later)
```

Benodigdheden:
1. GHL workflow die op Instagram-inbound triggert
2. Outbound webhook in die workflow naar het Lisa-endpoint
3. `LISA_WEBHOOK_SECRET` in Vercel + dezelfde waarde in de GHL-webhook-URL
4. Een Private Integration Token (PIT) met de juiste scopes (`GHL_PIT_TOKEN`)
5. Migratie 005 gedraaid (`lisa_settings` + delayed-velden)
6. Live mode AAN in de Lisa-module

---

## Stap 0: Environment variables in Vercel

Zet in Vercel → Settings → Environment Variables (Production):

| Var | Doel |
|---|---|
| `LISA_WEBHOOK_SECRET` | Beveiligt de webhook. Genereer met `openssl rand -hex 32`. |
| `GHL_PIT_TOKEN` | Private Integration Token om berichten terug te sturen (fallback: `GHL_API_KEY`). |
| `ANTHROPIC_API_KEY` | Voor de AI-generatie (bestaat al). |
| `CRON_SECRET` | Voor de delayed-cron (bestaat al). |

Na het toevoegen/wijzigen: **redeploy** zodat de nieuwe waarden actief zijn.

---

## Stap 1: PIT-scopes verifiëren

GHL → Settings → Private Integrations → open je bestaande token.

Vereiste scopes voor Lisa:
- View Conversations
- Edit Conversations
- View Conversation Messages
- Edit Conversation Messages
- View Contacts

Ontbreken er scopes? Maak een nieuwe PIT met deze scopes en zet de waarde in Vercel als `GHL_PIT_TOKEN`.

---

## Stap 2: Webhook-URL voorbereiden

Endpoint:
```
https://forex-opleiding-interface.vercel.app/api/lisa-ghl-webhook
```

Auth via query-parameter `?secret=<LISA_WEBHOOK_SECRET>`:
```
https://forex-opleiding-interface.vercel.app/api/lisa-ghl-webhook?secret=JOUW_SECRET
```

> ⚠️ Vervang `JOUW_SECRET` door de exacte waarde van `LISA_WEBHOOK_SECRET` uit Vercel.

---

## Stap 3: GHL-workflow maken

**3a.** GHL → Automation → Workflows → **+ Create Workflow**.

**3b. Trigger**
- Type: "Customer Reply" (of "Inbound Webhook")
- Filter: Channel = Instagram, Direction = Inbound

**3c. Action: Webhook**
- Action type: Webhook
- URL: de URL uit Stap 2 (incl. `?secret=…`)
- Method: `POST`
- Body type: JSON
- Header: `Content-Type: application/json`
- Body (kies de juiste variabelen uit de workflow-editor):

```json
{
  "contactId": "{{contact.id}}",
  "conversationId": "{{conversation.id}}",
  "locationId": "{{location.id}}",
  "messageId": "{{message.id}}",
  "type": "{{message.type}}",
  "direction": "{{message.direction}}",
  "message": "{{message.body}}"
}
```

> ⚠️ **Veldnamen variëren per GHL-account.** Bekijk "Available Variables" in de editor en map ze op de keys hierboven. Het endpoint verwacht exact deze body-keys.
>
> Belangrijk: het endpoint verwerkt **alleen** berichten met `type` = `"IG"` en `direction` = `"inbound"`. Komt jouw GHL-payload met andere waarden (bv. `type` = `"Instagram"`), dan moeten die in de workflow naar `IG`/`inbound` gemapt worden — of geef de echte payload door zodat de mapping in `api/lisa-ghl-webhook.js` wordt aangepast.

**3d.** Publiceer de workflow.

---

## Stap 4: Testen (met Live mode UIT)

1. Live mode in de Lisa-module blijft **OFF**.
2. Stuur een test-DM naar je Instagram-account.
3. Controleer in Supabase:
   ```sql
   SELECT ghl_webhook_last_received_at, ghl_webhook_total_received, ghl_webhook_last_error
   FROM lisa_settings;
   ```
   Verwacht: recente timestamp, `total_received` > 0, geen error.
4. De webhook antwoordt met `{ "skipped": "live_mode_off" }` (HTTP 200) — dat is correct zolang Live mode uit staat.

Foutdiagnose:
- **401** → de `secret` in de URL klopt niet met `LISA_WEBHOOK_SECRET`.
- **500 "Server misconfigured"** → `LISA_WEBHOOK_SECRET` niet gezet in Vercel.
- **`skipped: not_ig_inbound`** → `type`/`direction` in de payload kloppen niet (zie Stap 3c).
- **Geen log / geen timestamp** → de workflow-trigger vuurt niet; controleer het kanaal-/richting-filter.

---

## Stap 5: Live mode activeren

1. Open de Lisa AI-module.
2. Klik **"Activeer Live mode"** in de header.
3. Bevestig de waarschuwing.
4. De status-bar wordt groen: **"Lisa is LIVE"**.

> Alleen rollen met de permission `lisa.config.publish` (super_admin/manager) zien deze knop.

---

## Stap 6: Eerste echte test

1. Stuur een test-DM naar het Instagram-account **tijdens kantooruren** (default 07:00–23:30 NL).
2. Lisa antwoordt binnen enkele seconden in dezelfde IG-thread.
3. Controleer in Supabase:
   ```sql
   SELECT id, ghl_contact_id, phase, source FROM lisa_conversations
   WHERE is_sandbox = false ORDER BY created_at DESC LIMIT 5;

   SELECT direction, content, sent_at FROM lisa_messages
   ORDER BY sent_at DESC LIMIT 10;
   ```

**Buiten kantooruren** verstuurt Lisa niet direct, maar plant het antwoord:
```sql
SELECT id, status, is_delayed_response, scheduled_for
FROM lisa_followups ORDER BY created_at DESC LIMIT 5;
```
Verwacht: een rij met `is_delayed_response = true`, `status = 'scheduled'`. De cron `cron-lisa-delayed` draait elke 5 minuten en verstuurt deze zodra het binnen kantooruren valt.

---

## Stap 7: Troubleshooting

### Lisa antwoordt niet
1. Staat Live mode AAN? (status-bar groen)
2. Is het binnen kantooruren? (default 07:00–23:30 NL)
3. Is de GHL-workflow gepubliceerd?
4. Klopt het webhook-secret?
5. Check `lisa_settings.ghl_webhook_last_error` in Supabase.

### Lisa antwoordt verkeerd
- Pas Config aan (Persona / Do's & Don'ts / Fases / Knowledge).
- Test eerst in de **Sandbox**-tab vóór je publiceert.
- Gebruik de 👍/👎-feedbackknoppen.

### 401 op de webhook
- `LISA_WEBHOOK_SECRET` in Vercel = de `secret` in de GHL-URL? Re-paste, opslaan, redeploy.

### 500 op de webhook
Mogelijke oorzaken:
- Migratie 005 niet gedraaid (`lisa_settings` ontbreekt → body `no_settings`)
- `ANTHROPIC_API_KEY` ontbreekt
- `GHL_PIT_TOKEN`/`GHL_API_KEY` ontbreekt of verkeerde scopes
- DB-verbindingsprobleem (zie Vercel function-logs)

### Delayed berichten worden niet verstuurd
- Draait de cron? (Vercel → Cron / function-logs voor `/api/cron-lisa-delayed`)
- Live mode AAN en binnen kantooruren?
- `CRON_SECRET` gezet?

---

## Stap 8: Live deactiveren (noodstop)

Drie manieren om Lisa direct uit te zetten:

1. **Snelste** — Lisa-module → "Deactiveer Live mode" → bevestigen.
2. **Via DB** — Supabase SQL:
   ```sql
   UPDATE lisa_settings SET live_mode_enabled = false WHERE id = 1;
   ```
3. **Via GHL** — pauzeer of verwijder de workflow.

Optie 1/2 stopt nieuwe responses én de delayed-cron (die checkt live mode). Reeds verstuurde berichten blijven uiteraard staan.

---

## Bekende aandachtspunten

- **GHL payload-mapping** is per account verschillend; verifieer de variabelen (Stap 3c).
- **Model-string**: Lisa draait op het model uit `LISA_MODEL` in `api/lisa-respond.js`. Geeft de generatie een "model not found"-fout, dan moet die constante naar een geldig model voor jouw Anthropic-account.
- **Delayed-sends** missen AI-metadata (model/tokens) omdat alleen de antwoordtekst vooraf wordt bewaard.

## Volgende stappen (na MVP)
- F6: Live-conversaties view in de Lisa-module
- F7: Configureerbaar follow-up systeem
- F8: Stats-dashboard
- F9: Logs/audit-tab
