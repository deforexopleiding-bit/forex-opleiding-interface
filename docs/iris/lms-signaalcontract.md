# Wat Iris van een mentorsignaal verwacht

**Voor:** wie de mentormodule in het LMS bouwt
**Datum:** 21 september 2026
**Status:** voorstel — Iris leest deze velden zodra ze bestaan

De mentormodule wordt in een andere sessie gebouwd. Dit document zegt wat Iris
aan de CRM-kant verwacht, zodat de twee kanten niet langs elkaar heen werken.
**Vanuit deze sessie is er niets aan het LMS gewijzigd.**

---

## De tabel

`public.hlms_signaal` in het dfo-lms-project (`absicpdidnoblirngiia`).

Iris leest die met de sleutel die er al is (`DFO_LMS_SUPABASE_*`, via
`api/_lib/dfo-lms-db.js`) en **schrijft er nooit in**.

## De velden

| Veld | Nodig | Wat erin hoort |
|---|---|---|
| `id` | ja | uuid. Wordt de bron-sleutel (`lms:<id>`, UNIQUE aan onze kant). |
| `type` | ja | zie hieronder. **Vrije tekst, geen enum.** |
| `student_id` | ja | `hlms_student.id`, zodat we de persoon kunnen vinden. |
| `mentor_naam` | graag | de naam van de mentor, voor op de kaart. Ook `mentor` wordt gelezen. |
| `toelichting` | graag | de zin die een mens leest. Ook `omschrijving` en `notitie` worden gelezen. |
| `gevraagde_actie` | nee | wat de mentor wil dat er gebeurt. Staat dit er, dan wint het van ons eigen voorstel — het LMS weet meer van de situatie dan onze vertaaltabel. |
| `created_at` | ja | wanneer het signaal ontstond. Ook `aangemaakt_op` en `signaal_op` worden gelezen. |

Dat er drie namen per veld gelezen worden is geen slordigheid maar een
inschatting: de module bestaat nog niet, dus we weten niet hoe de kolommen
gaan heten. Meerdere namen proberen is goedkoper dan breken.

## De types

| Type | Wat Iris voorstelt |
|---|---|
| `uitstel` | on hold met reden, einddatum schuift mee |
| `reageert_niet` | op de belrij bij Dave |
| `halt` | stopzetten bespreken — **altijd een mens, nooit een handeling** |
| `no_show` | op de belrij |
| `factuur` | dossier nakijken in de Post |
| `taken_niet_gedaan` | op de belrij |

### Een type dat er niet bij staat, is geen fout

Dit is de belangrijkste afspraak in dit document.

Er staat **geen CHECK-constraint** op `iris_signalen.type`. Een onbekend type
komt gewoon in de lijst, met het voorstel "laat een mens kijken". De
synchronisatie valt er niet over.

De reden: de mentormodule wordt parallel gebouwd. Zou er een enum staan, dan
breekt de synchronisatie op de dag dat het LMS een zevende type toevoegt — en
een synchronisatie die stilvalt, merkt niemand. Dan blijven signalen liggen
terwijl iedereen denkt dat de koppeling werkt.

Dus: **voeg gerust types toe.** Laat het weten, dan krijgen ze een passend
voorstel in plaats van het neutrale.

## Wat er aan onze kant gebeurt

1. `cron-iris-werk` haalt elke vijf minuten de signalen van de laatste dertig
   dagen op.
2. Wat nog niet in `iris_signalen` staat, wordt toegevoegd. `bron_id` is
   UNIQUE, dus de cron mag zo vaak draaien als hij wil.
3. Het signaal verschijnt op de dossierkaart van die persoon, met het voorstel
   erbij.
4. Bij `reageert_niet`, `no_show` en `taken_niet_gedaan` kan er met één klik
   een belrij-regel van gemaakt worden.

Een LMS dat even niet bereikbaar is, legt de rest van Iris niet stil. Dat is
een waarschuwing in het logboek, geen fout.

## Wat Iris NIET doet

- Niet schrijven in `hlms_signaal` of welke `hlms_*`-tabel dan ook, met één
  uitzondering die de opdracht uitdrukkelijk toestaat: `hlms_student.eind_datum`
  bij een goedgekeurde verlenging, via `iris_acties`.
- Niet zelf een student op hold zetten. Dat is een voorstel dat een mens
  goedkeurt.
- Geen signaal als "afgehandeld" markeren in het LMS. Wij zetten
  `iris_signalen.verwerkt_op` aan onze kant; het LMS houdt zijn eigen
  boekhouding.
