# WhatsApp builder Fase A — smoke-doc

Branch: `feat/whatsapp-builder-fase-a`
PR: open (NIET gemerged)
Migratie: **n.v.t.** (alles in bestaande jsonb-velden)
Extra infrastructuur (1 keer, via Chrome op Supabase Dashboard, NIET via SQL):
- Storage bucket `whatsapp-media` aanmaken, **Public** = ON
  (essentieel: Meta moet sample-media tijdens approval kunnen fetchen,
  en runtime-bijlages moeten zonder signature ophaalbaar zijn voor WhatsApp).

Verplichte guardrail (uit plan-gate):
**Bestaande body-only template-sends (finance/Joost) mogen niet stuk.**
Daarom is scenario 1 **vóór alles** verplicht.

## Pre-flight

| Stap | Hoe |
|---|---|
| Bucket `whatsapp-media` bestaat, public-read | Chrome → Supabase → Storage → Create bucket → naam `whatsapp-media`, public: ON |
| ≥1 APPROVED body-only template in `whatsapp_meta_templates` | bestaande finance-templates (bv. `factuur_herinnering_v2`) |
| ≥1 APPROVED IMAGE-header template | maak via huidige editor (uploadt nog niet, gebruik publieke URL als example) of submit een minimal `image_factuur_v1` |
| Een test-conversatie binnen het 24u-window | inbox-conversation kiezen waar de klant <24u geleden inbound stuurde |

## Scenario 1 — Body-only NO-regression (KRITISCH)

**Doel:** een bestaande body-only template verstuurt **exact identiek** aan vóór Fase A. Geen extra body, geen extra component, geen wijziging in audit-rij.

**Stappen:**
1. Open inbox → kies een conversatie met active 24h-window.
2. Klik op "Template versturen" → kies een **body-only** template (bv. `factuur_herinnering_v2`, `header_type='NONE'`).
3. Bevestig: in het modal toont het media-picker-blokje NIET (`#inboxTplMediaWrap` is hidden).
4. Vul named/positionele vars in zoals gewoonlijk, klik Verstuur.
5. Verwacht: 200 OK, klant ontvangt het bericht, identiek aan oude flow.

**Verifieer:**
```sql
SELECT id, template_name, template_variables, body, meta_wamid, status
FROM whatsapp_messages
ORDER BY sent_at DESC
LIMIT 1;
```
- `template_name` = de gekozen template
- `template_variables` jsonb gelijk aan vóór Fase A (positioneel key→value)
- `body` = de gerenderde preview-tekst
- `meta_wamid` ingevuld (Meta heeft 'm geaccepteerd)
- `status` = 'queued' (webhook promoot later naar sent/delivered/read)

**Vercel logs check** — geen `component-build warnings: ...` regel verschijnt (body-only-pad produceert geen warnings).

**Verwacht eindbeeld:** zero observable verschil met oude productie. Regression hier = STOP.

## Scenario 2 — Media-header template MET bijlage

**Doel:** een IMAGE-header template wordt verstuurd inclusief de geüploade afbeelding als WhatsApp-bijlage.

**Pre-flight:**
- APPROVED template `image_factuur_v1` (header_type=`IMAGE`) bestaat. Body mag variabelen hebben of niet.
- Testafbeelding ≤ 3 MB JPEG of PNG bij de hand.

**Stappen:**
1. Open inbox → kies test-conversatie binnen 24u-window.
2. Klik "Template versturen" → kies `image_factuur_v1`.
3. Bevestig: media-picker-blokje **zichtbaar**, label = `Bijlage (afbeelding)`, `accept='image/jpeg,image/png'`.
4. Kies een afbeelding ≤ 3 MB → status-regel kleurt geel "uploaden…" → groen "✓ <filename> (<size> bytes)".
5. Vul body-vars (indien aanwezig), klik Verstuur.
6. Verwacht: 200 OK, klant ontvangt template MET de afbeelding bovenaan.

**Verifieer DB:**
```sql
SELECT template_name, template_variables, meta_wamid, status
FROM whatsapp_messages
ORDER BY sent_at DESC LIMIT 1;
```
- `template_name` = `image_factuur_v1`
- `meta_wamid` ingevuld

**Verifieer Vercel logs:**
- `[whatsapp-media-upload] storage upload` regel met `kind=image`
- GEEN `component-build warnings` (image-header netjes opgebouwd)

**Verifieer storage:**
- Supabase Storage → bucket `whatsapp-media` → `image/<yyyy-mm>/<uuid>-<naam>.jpg` aanwezig
- Public URL klikbaar (200 OK in een incognito-tab)

## Scenario 3 — Guard: media-header zonder bijlage

**Doel:** server weigert media-template-send zonder runtime_media met `400 RUNTIME_MEDIA_REQUIRED`.

**Stappen:**
1. Trigger via DevTools console (omzeil de UI-guard om server-guard te testen):
   ```js
   fetch('/api/inbox-send-template', {
     method:'POST',
     headers:{'Content-Type':'application/json','Authorization':'Bearer '+localStorage.getItem('sb-access-token')},
     body: JSON.stringify({
       conversation_id: '<actieve-conv-uuid>',
       template_name  : 'image_factuur_v1',
       language       : 'nl',
       // GEEN runtime_media
     })
   }).then(r => r.json().then(j => ({status:r.status, ...j}))).then(console.log);
   ```
2. Verwacht response:
   ```json
   { "status": 400, "code": "RUNTIME_MEDIA_REQUIRED",
     "error": "Template heeft een IMAGE-header maar geen runtime_media meegegeven." }
   ```
3. Geen `whatsapp_messages`-rij toegevoegd, geen Meta-call gedaan.

**Mismatch-variant:** runtime_media meegeven met `kind='video'` voor IMAGE-template →
```json
{ "status": 400, "code": "RUNTIME_MEDIA_KIND_MISMATCH",
  "error": "Template-header verwacht kind='image' maar runtime_media.kind='video'." }
```

## Scenario 4 — Upload-validation paden

**Doel:** `/api/whatsapp-media-upload` weigert nette inputs correct.

| Test | Verwacht |
|---|---|
| POST zonder auth | 401 |
| POST zonder body | 400 |
| `kind='image'` + `content_type='application/pdf'` | 400 (MIME-mismatch) |
| `data_base64` decodeert > 3 MB | 400 (te groot voor base64-JSON) |
| `data_base64` van 0 bytes | 400 (decode 0) |
| OK upload | 200 met `{ ok:true, url:'https://<project>.supabase.co/storage/v1/object/public/whatsapp-media/...' }` |
| Bucket `whatsapp-media` niet aangemaakt | 503 (admin moet via Chrome bucket maken) |

## Vereisten voor merge

- [ ] Scenario 1 groen — body-only no-regression bevestigd
- [ ] Scenario 2 groen — image-template + bijlage bezorgd bij de klant
- [ ] Scenario 3 + 4 groen — server-side guards werken
- [ ] Storage-bucket `whatsapp-media` bestaat op productie + public-read
- [ ] Geen tech-debt in PR-diff buiten de surgical patch in `modules/finance.html` (alleen send-modal media-picker)

## Wat er NIET in deze PR zit (komt in Fase B)

- File-picker in de **editor** voor sample-media (nu nog URL-input).
- Body-opmaak-toolbar (B / I / S / `</>`).
- Buttons-cap 3 → 10.
- Editor-validaties voor max-lengths per categorie.

## Wat er NIET in deze PR zit (komt later, Fase C)

- Meta Resumable Upload (echte media-handle i.p.v. publieke URL).
- Direct-to-storage signed-upload voor docs > 3 MB.
- Send-modal media-library (hergebruik eerdere uploads).
