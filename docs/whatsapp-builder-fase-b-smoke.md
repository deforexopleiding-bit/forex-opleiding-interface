# WhatsApp builder Fase B — smoke-doc

Branch: `feat/whatsapp-builder-fase-b`
PR: open (NIET gemerged)
Migratie: **n.v.t.** — alles in bestaande jsonb-velden (Fase B is editor-UX only).

Bouwt voort op Fase A (PR #183 merge-commit `6b6714e`):
- Upload-endpoint `/api/whatsapp-media-upload` (Fase A) wordt nu ook door
  de editor gebruikt voor het sample-bestand.
- Storage-bucket `whatsapp-media` (Fase A pre-flight) is voorwaarde.

## Scenario 1 — Header sample-upload per kind

**Doel:** in de editor (Finance > Instellingen > WhatsApp Templates →
Nieuwe template) kun je een afbeelding/video/document uploaden als
header-sample. De publieke URL belandt automatisch in het URL-veld
(behoudt backward-compat met submit-payload-builder die `header_handle`
op die URL zet).

**Stappen (per kind: IMAGE / VIDEO / DOCUMENT):**
1. Open editor → Header-sectie → Type = **Afbeelding**.
2. Bevestig: sectie "Sample-bestand" verschijnt met file-picker (oude
   URL-veld als alternatief blijft staan).
3. `accept`-attribuut = `image/jpeg,image/png` (voor IMAGE), in DevTools
   te verifiëren.
4. Kies een JPEG ≤ 3 MB → status kleurt geel "Uploaden naar storage…"
   → groen "✓ <filename> (<size> bytes) — URL in veld hieronder."
5. URL-veld toont nu de Supabase public URL.
6. Preview-bubble (rechts) toont een thumbnail van de afbeelding ipv
   `[IMAGE]` placeholder.

**Herhaal voor Type = Video** (accept = `video/mp4,video/3gpp`) →
preview toont "Video bijgevoegd" icoon.

**Herhaal voor Type = Document** (accept = PDF/DOCX/XLSX/PPTX/TXT) →
preview toont "Document bijgevoegd" icoon.

**Wissel van kind tijdens edit** → status reset, file-keuze leeg, URL-
veld blijft tot je opnieuw uploadt (defense: oude URL is mogelijk niet
geldig voor nieuw kind, dus admin moet bewust opnieuw kiezen).

## Scenario 2 — Size-guard weigert netjes

**Doel:** een te groot bestand wordt gestopt VÓÓR de upload-call met een
duidelijke melding, niet pas door Vercel met een 413-platformfout.

**Stappen:**
1. Editor → Header = Afbeelding.
2. Selecteer een JPEG/PNG > 3 MB.
3. Status-regel kleurt rood:
   `Bestand te groot (<X.Y> MB > 3 MB). Splits het op of gebruik Fase C (komt later).`
4. Geen netwerk-call gemaakt (DevTools Network blijft leeg voor deze
   actie).
5. URL-veld blijft leeg (geen pollutie van vorige uploads).

## Scenario 3 — Body-opmaak-toolbar (B / I / S / `</>`)

**Doel:** wrap-selectie in `*…*` / `_…_` / `~…~` / `` `…` `` en live-
preview rendert het als bold/italic/strike/monospace.

**Stappen:**
1. Editor → Body textarea: typ `Hallo wereld dit is een test`.
2. Selecteer "wereld" → klik knop **B** → textarea wordt:
   `Hallo *wereld* dit is een test`. Selectie blijft op `wereld`.
3. Preview-bubble rendert `wereld` in `<b>` (vet).
4. Selecteer "test" → knop **I** → `_test_` + cursief in preview.
5. Selecteer "dit is" → knop **S** → `~dit is~` + doorgehaald in preview.
6. Selecteer "een" → knop **</>** → `` `een` `` + monospace background
   in preview.
7. Plaats cursor zonder selectie → klik **B** → `**` ingevoegd, cursor
   tussen de sterren zodat je direct kunt typen.

**Edge cases:**
- Markdown render werkt binnen één regel (geen overrunning op `\n`).
- WhatsApp-syntax binnen `{{klant.naam}}` wordt NIET als opmaak
  beschouwd (placeholder-segment wint).
- Onbekende `{{onbestaand}}` markering blijft rood/diagnose-visible.

## Scenario 4 — Buttons tot 10

**Doel:** de cap is verhoogd van 3 naar 10. Per-type Meta-limieten
worden gewaarschuwd (niet hard-geblokkeerd; submit kan, Meta beslist).

**Stappen:**
1. Editor → Knoppen-sectie.
2. Label leest "Knoppen (max 10)".
3. Voeg 10 knoppen toe (mix van URL / Telefoon / Snel antwoord).
4. Bij 10 knoppen: "+ Knop toevoegen" knop disabled.
5. Voeg 4 quick-reply-knoppen toe → onder de knoppen verschijnt rood:
   `⚠ Max 3 quick-reply-knoppen.`
6. Voeg 3 URL + 0 Telefoon → geen waarschuwing (CTA = 3 totaal? CTA-cap
   is 2). Bij 3 URL: `⚠ Max 2 CTA-knoppen (URL + telefoon).`
7. Helptekst onder de Knop-toevoeg-knop herhaalt: "Meta-limieten: max
   3 quick-reply, max 2 CTA, hybride combineren tot 10 totaal."

**Submit-payload:** ongewijzigd t.o.v. Fase A — `admin-meta-templates-submit.js`
weet al om te gaan met QUICK_REPLY/URL/PHONE_NUMBER. Meta zelf beslist
of de combinatie wordt geaccepteerd.

## Scenario 5 — Validaties + mixed-named-positional

**Doel:** bestaande mixed-vars-guard blijft werken; nieuwe size-guard
kicked in vóór de submit.

**Stappen:**
1. Body = `Hallo {{klant.naam}}, je {{1}} is `... → save → fout:
   `Body bevat zowel named ({{klant.naam}}) als positionele ({{1}})
    placeholders. Kies één stijl.` (bestond al).
2. Body langer dan 1024 chars → textarea maxlength=1024 blokt input
   client-side.
3. Header tekst > 60 chars → maxlength=60 blokt input.
4. Footer > 60 chars → maxlength=60 blokt input.
5. Button-text > 25 chars → input maxlength=25 blokt input.

## Vereisten voor merge

- [ ] Scenario 1 groen — upload per kind werkt, URL belandt in veld,
      preview toont thumbnail/icoon
- [ ] Scenario 2 groen — size-guard weigert vóór netwerk-call met
      duidelijke melding
- [ ] Scenario 3 groen — toolbar wrapt selectie, preview rendert
      *bold*/_italic_/~strike~/`mono`
- [ ] Scenario 4 groen — cap 10, per-type warnings, helptekst leesbaar
- [ ] Scenario 5 groen — bestaande validaties ongewijzigd, mixed-vars-
      guard werkt
- [ ] Geen wijziging aan submit-payload-builder (Fase A code ongemoeid)
- [ ] Geen wijziging aan send-laag (Fase A code ongemoeid)
- [ ] Tech-debt-zone (`modules/finance.html`, `modules/shared/finance-
      views/camtbank.js`) ongemoeid

## Wat er NIET in deze PR zit (komt in Fase C)

- Meta Resumable Upload (echte media-handle i.p.v. publieke URL)
- Direct-to-storage signed-upload voor docs > 3 MB
- Quick-Reply payload-veld (voor events-automation: inbound button-tap
  → trigger)
- Send-modal media-library (hergebruik eerdere uploads)
- TEXT-header met dynamische vars (vereist header_text-parameters in
  send-laag uitbreiden)
