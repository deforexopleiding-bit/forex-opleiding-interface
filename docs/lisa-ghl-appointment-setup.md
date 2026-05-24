# Lisa Appointment Tracking — GHL Setup

Lisa detecteert automatisch wanneer een afspraak wordt geboekt/gewijzigd via de GHL-agenda en
werkt de conversatie bij (qualified, call geboekt, follow-ups pauzeren, enz.). Dit vereist een
**tweede** GHL-workflow naast "Lisa Instagram Inbound".

## Vereisten
- `LISA_WEBHOOK_SECRET` staat al in Vercel (hetzelfde secret wordt hergebruikt).
- `GHL_PIT_TOKEN` / `GHL_API_KEY` staat al in Vercel.
- **Migratie 009 gedraaid** (`is_system`-kolom op `lisa_messages`).

---

## Webhook-URL
```
https://forex-opleiding-interface.vercel.app/api/lisa-ghl-appointment-webhook?secret=JOUW_SECRET
```
> ⚠️ Vervang `JOUW_SECRET` door de waarde van `LISA_WEBHOOK_SECRET` (zelfde als de IG-webhook).

---

## Workflow: "Lisa Appointment Sync"

### Stap 1 — Workflow aanmaken
GHL → Automation → Workflows → **+ Create Workflow** → Start from Scratch. Naam: "Lisa Appointment Sync".

### Stap 2 — Trigger(s)
GHL ondersteunt meerdere triggers per workflow; beide vuren naar dezelfde Webhook-action:
- **Appointment Created** (of "Customer Booked Appointment") — filter eventueel op je sales-agenda.
- **Appointment Status Changed** — voor cancelled / no-show / completed / rescheduled.

### Stap 3 — Action: Webhook
- **+ Add Action → Webhook**
- URL: de URL hierboven (incl. `?secret=…`)
- Method: `POST`
- Header: `Content-Type: application/json`
- Body (JSON):

```json
{
  "contactId": "{{contact.id}}",
  "appointmentId": "{{appointment.id}}",
  "appointmentStatus": "{{appointment.status}}",
  "startTime": "{{appointment.startTime}}",
  "eventType": "{{event.type}}",
  "calendarId": "{{appointment.calendarId}}"
}
```

> ⚠️ **Variabelenamen verschillen per GHL-account.** Bekijk "Available Variables" in de editor.
> Het endpoint leest ook `customData.*` en geneste objecten (`appointment.status` etc.) als fallback.
> Cruciaal: `contactId` (koppelt aan de Lisa-conversatie) en `appointmentStatus` (bepaalt de actie).

### Stap 4 — Testen (workflow als Draft)
1. Open Lisa → **Live**-tab, kies een echte (niet-sandbox) conversatie en noteer de `ghl_contact_id`.
2. Maak in GHL handmatig een test-afspraak voor dat contact (sales-agenda, tijd nu + 1u).
3. De workflow vuurt → webhook-hit zichtbaar in Vercel-logs (`/api/lisa-ghl-appointment-webhook`).
4. Controleer in Supabase:
   ```sql
   SELECT call_booked, call_booked_at, phase, qualified, followup_paused
   FROM lisa_conversations WHERE ghl_contact_id = '<contactId>';
   -- verwacht: call_booked=true, phase='qualified', qualified=true, followup_paused=true
   SELECT direction, content, is_system, sent_at FROM lisa_messages
   WHERE conversation_id = '<conv_id>' ORDER BY sent_at DESC LIMIT 3;
   -- verwacht: rij met is_system=true, content "📅 Afspraak geboekt…"
   ```
5. Bij groene test → **Publish** de workflow.

---

## Status-mapping

| GHL-status | Lisa-actie |
|---|---|
| `booked` / `confirmed` / `new` (of event = created) | `call_booked=true`, `phase=qualified`, `qualified=true`, follow-ups gepauzeerd + scheduled geannuleerd |
| `cancelled` | `call_booked=false`, `phase=band`, follow-up hervat |
| `no_show` | `call_booked=false`, `phase=band`, follow-up hervat |
| `completed` / `showed` | `phase=done` |
| `rescheduled` | `call_booked_at` bijgewerkt (boeking blijft) |
| onbekend | log + skip (geen wijziging, geen crash) |

---

## Belangrijke notes
- Lisa stuurt **geen** bevestiging naar de volger (GHL doet dat al).
- De AI blijft actief op de conversatie — stuurt de volger tussen boeking en afspraak een DM, dan antwoordt Lisa gewoon. Alleen de **follow-ups** zijn gepauzeerd.
- Bij annulering/no-show **hervat** Lisa de nurture (geen verloren leads).
- Acties verschijnen als **systeem-event** in de Live-tab (apart van Lisa-berichten).

---

## Troubleshooting

### Afspraak geboekt maar Lisa weet het niet
1. Workflow Active? 2. Vercel-logs voor `lisa-ghl-appointment-webhook` checken.
3. `SELECT * FROM lisa_conversations WHERE ghl_contact_id='<contactId>';` — bestaat de conversatie?
4. Mogelijk: `contactId` in de afspraak ≠ `ghl_contact_id` van de Lisa-conversatie.

### `skipped: no_conversation`
Er is (nog) geen live Lisa-conversatie voor dit contact (de afspraak komt van buiten Instagram-Lisa). Verwacht gedrag.

### `skipped: unknown_status`
GHL stuurt een status die we (nog) niet mappen — plak de Vercel-log-payload, dan breiden we de mapping uit.

### 401 op de webhook
`LISA_WEBHOOK_SECRET` in de URL klopt niet met Vercel (zelfde secret als de IG-webhook).
