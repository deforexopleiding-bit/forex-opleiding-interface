# WhatsApp-templates voor The Lab — in te dienen bij Meta

*Opgesteld 15 okt 2026. Taal: `nl`. Lijn: de welkom-/leadsonderhoud-lijn.*

WhatsApp naar een lead gaat **alleen** met een template die Meta heeft goedgekeurd. Tot die er zijn, gaan de onderstaande berichten per mail. Er zijn vier templates nodig: welkom, herinnering 24 uur, herinnering 1 uur en opvolging.

**Wat er nu al per WhatsApp gaat:** voor de bevestiging, de herinnering 24 uur vooraf, de herinnering 30 minuten vooraf en "we beginnen zo" gebruikt een Lab-boeking de algemene afspraak-templates. Die zijn al goedgekeurd (`afspraak_bevestiging_v1`, `afspraak_reminder_24u_v1`, `afspraak_reminder_30m_v1`, `afspraak_zoom_5min_v1`).

**Wat er nog niet per WhatsApp gaat:** de herinnering **1 uur** vooraf. Die gaat alleen per mail, want de goedgekeurde template zegt "over 2 uur".

Variabelen zijn positioneel (`{{1}}`, `{{2}}`, …). De volgorde staat bij elke template, en die volgorde moet in `onderhoud_sjablonen.variabele_volgorde` komen.

---

## 1 · `lab_welkom_v1` — welkom + loginlink

- **Categorie:** UTILITY (de lead vroeg zelf om toegang)
- **Variabelen:** `{{1}}` = voornaam, `{{2}}` = loginlink
- **Gekoppeld aan:** `onderhoud_sjablonen` met `traject_slug='the-lab'`, `soort='welkom'`, `kanaal='whatsapp'`, `variabele_volgorde=["voornaam","loginlink"]`

```
Hoi {{1}}, je toegang tot The Lab staat klaar.

Neem 20 minuten en ga zitten met je laptop: je plaatst je eerste trade in een echte chart, stap voor stap uitgelegd.

Inloggen kan meteen, zonder wachtwoord:
{{2}}

Je toegang loopt 7 dagen.
— De Forex Opleiding
```

## 2 · `lab_sessie_24u_v1` — herinnering 24 uur vóór de sessie met Dave

- **Categorie:** UTILITY
- **Variabelen:** `{{1}}` = voornaam, `{{2}}` = moment ("woensdag 21 oktober om 16:00"), `{{3}}` = Zoom-link, `{{4}}` = verzetlink
- **Gekoppeld aan:** de afspraakherinnering in `api/_lib/afspraak-berichten.js` (moment `r24`, Lab-variant). Na goedkeuring vervangt deze template `afspraak_reminder_24u_v1` voor Lab-boekingen.

```
Hoi {{1}}, morgen is je strategiesessie met Dave: {{2}}, 30 minuten via Zoom.

Neem je resultaat uit The Lab erbij en denk na over één vraag: wat wil je over een jaar met trading bereikt hebben?

Deelnemen: {{3}}
Past het toch niet? Verzet hier: {{4}}
```

## 3 · `lab_sessie_1u_v1` — herinnering 1 uur vóór de sessie

- **Categorie:** UTILITY
- **Variabelen:** `{{1}}` = voornaam, `{{2}}` = uur ("16:00"), `{{3}}` = Zoom-link
- **Knop (optioneel, quick reply):** "Ik ben erbij"
- **Gekoppeld aan:** moment `r2` in de Lab-variant, dat voor Lab-boekingen 1 uur vooraf valt. Tot deze template is goedgekeurd, gaat dit moment alleen per mail.

```
Hoi {{1}}, over een uur ({{2}}) start je strategiesessie met Dave. Zit je er een paar minuten vroeger klaar voor? Een rustige plek en je laptop of gsm volstaan.

Deelnemen: {{3}}
```

## 4 · `lab_opvolging_v1` — opvolging (niet gestart / bijna klaar / Lab af)

- **Categorie:** MARKETING (Meta beschouwt opvolging zonder actieve afspraak als marketing). Alleen versturen met toestemming; de motor checkt dat al.
- **Variabelen:** `{{1}}` = voornaam, `{{2}}` = loginlink
- **Gekoppeld aan:** `onderhoud_sjablonen` met `traject_slug='the-lab'`, `kanaal='whatsapp'`, `variabele_volgorde=["voornaam","loginlink"]`. De motor zoekt per stap een template met `soort` = de stapnaam: `niet-gestart-24u`, `bezig-24u`, `afgewerkt-d1`, `afgewerkt-d3`, `dag6`, `dag8`.
  - Eén template volstaat. Zet dezelfde `meta_template` op de stappen die je per WhatsApp wilt laten gaan.
  - Aanbevolen: `niet-gestart-24u` en `afgewerkt-d1`.

```
Hoi {{1}}, je plek in The Lab staat nog voor je klaar.

Geen 20 minuten? Kijk de korte startvideo en plan meteen 30 minuten met Dave, gratis.

Verder gaan: {{2}}
```

---

## Na goedkeuring — wat er nog moet gebeuren

1. **Welkom en opvolging (1 en 4):** zet `meta_template` en `variabele_volgorde` op de rijen in `onderhoud_sjablonen`, met `actief = true`.
   - `stuurLabWhatsApp` controleert bij elke verzending live bij Meta of de template goedgekeurd is. Een rij voor een template die nog niet goedgekeurd is, geeft dus `niet_goedgekeurd` en verstuurt niets.
2. **Sessie 24u en 1u (2 en 3):** in `api/_lib/afspraak-berichten.js` (`labVariant`) de template-namen invullen voor `r24` en `r2`, en voor `r2` WhatsApp aanzetten. Dat is één regel per moment.
3. **Meten:** na de eerste echte boeking kijken of de WhatsApp-uitkomst in `whatsapp_messages` (via `logOutboundWa`) op `verstuurd` staat. Gebruik daarvoor een testlead, niet een echte lead.

**Verboden:** templates voor echte leads uitproberen. Test met `maxim.delombaerde96+labtest1@gmail.com` of `+labtest2` (`is_test`).
