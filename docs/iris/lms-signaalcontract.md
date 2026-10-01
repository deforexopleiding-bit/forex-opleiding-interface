# Wat Iris van een mentorsignaal verwacht

**Voor:** wie de mentormodule in het LMS onderhoudt
**Gemeten:** 1 oktober 2026, op de echte databank (`dfo-lms`)
**Status:** vastgesteld — dit zijn de kolommen zoals ze bestaan

> **Dit document is op 1 oktober 2026 herschreven.** De vorige versie was een
> *voorstel*: de mentormodule bestond nog niet, dus stonden er veldnamen in die
> we hoopten. Iris vroeg om `created_at` en `type`, en die kolommen bestaan niet.
> Gevolg: elke vijf minuten een 400 in de LMS-logs, en **Iris heeft nooit één
> mentorsignaal binnengekregen**. Wat hieronder staat is gemeten, niet gehoopt.
>
> **Vanuit deze sessie is er niets aan het LMS gewijzigd.**

---

## De tabel

`public.hlms_signaal` in het dfo-lms-project (`absicpdidnoblirngiia`).

Iris leest die met de sleutel die er al is (`DFO_LMS_SUPABASE_*`, via
`api/_lib/dfo-lms-db.js`) en **schrijft er nooit in**.

## De kolommen, zoals ze zijn

| Kolom | Wat Iris ermee doet |
|---|---|
| `id` | uuid. Wordt de bron-sleutel (`lms:<id>`, UNIQUE aan onze kant). |
| `soort` | → `iris_signalen.type`. Vrije tekst, geen enum. |
| `bron` | **filter.** Alleen `handmatig` wordt overgenomen. Zie hieronder. |
| `status` | **filter.** Alleen wat nog open staat. Zie hieronder. |
| `aangemaakt_op` | → `iris_signalen.signaal_op`. Ook het filter en de sortering. |
| `student_id` | → `hlms_student.email` → `iris_contacten` → `contact_id`. |
| `mentor_id` | auth-uid van de melder → `hlms_personeel.naam` → `mentor_naam`. |
| `onderwerp` · `zwaarte` · `bak` · `bewijs` · `eerste_op` · `laatst_gezien_op` | meegelezen, nog niet gebruikt. |

Volledige lijst in de databank: `id`, `onderwerp`, `student_id`, `mentor_id`,
`soort`, `zwaarte`, `status`, `bron`, `bewijs`, `eerste_op`, `laatst_gezien_op`,
`mentor_deadline`, `gesloten_op`, `gesloten_reden`, `oorzaak_weg_op`,
`afgehandeld_door`, `uitkomst`, `aangemaakt_op`, `wacht_tot`, `wacht_reden`,
`bak`, `in_behandeling_door`, `in_behandeling_sinds`, `controle_op`,
`voorstel_datum`.

### Wat er NIET op staat

Er is **geen** `toelichting`, `omschrijving` of `notitie`, en **geen**
`mentor_naam`. Iris haalt die ergens anders:

| Wat | Waar het echt staat |
|---|---|
| de tekst van de melder | `hlms_signaal_gebeurtenis` waar `soort = 'geopend'` → `tekst` (oudste regel; die tabel is alleen-toevoegen) |
| de naam van de mentor | `hlms_personeel.naam` op `id = hlms_signaal.mentor_id` |

Allebei fail-zacht: lukt de opzoeking niet, dan is het veld leeg en komt de
kaart er gewoon. Een kaart zonder naam is bruikbaar; een kaart die er niet is
niet.

Er wordt ook **geen `gevraagde_actie`** op de rij gelezen. Die kwam uit de
voorstel-tabel hieronder en kwam er in de vorige versie van dit document ook uit;
de kolom bestond nooit.

---

## Alleen `bron = handmatig`

`hlms_signaal_bron_check` laat drie bronnen toe:

| bron | Wat het is | Komt in de Post? |
|---|---|---|
| `lms_regel` | wat de nachtelijke LMS-motor zelf opmerkt | **nee** |
| `crm_cron` | wat ons eigen systeem erin zette | **nee** |
| `handmatig` | wat een mens zelf meldde | **ja** |

Op 1 oktober stonden er ~450 rijen in de tabel, bijna alles `lms_regel` — 59
open `geen_volgende_sessie`, 12 open `factuur_vervallen`. Die horen op het
**hoofdmentorbord in het LMS**, want daar worden ze afgehandeld. Zou Iris ze
overnemen, dan stonden er in één keer ruim honderd kaarten in de Post, en hielden
twee borden hetzelfde werk bij — dat is precies hoe je werk dubbel doet en
tegelijk kwijtraakt.

`crm_cron` terugslepen zou een kringetje zijn: wij schrijven het, wij lezen het.

`handmatig` is de uitzondering die het LMS zelf aanbracht zodat de nachtelijke
motor zo'n kaart niet opruimt — zie de toelichting bij
`hlms_kaart_start_niet_op()`. Dat is dezelfde grens die wij hier gebruiken.

---

## Alleen wat open staat

Het LMS houdt die lijst op **één** plek: `hlms_signaal_open_statussen()`. Die
geeft vandaag `nieuw`, `opgepakt`, `wacht_op_mentor`, `on_hold`, `wacht`, en de
CHECK laat daarnaast alleen `afgehandeld` en `auto_gesloten` toe.

Iris filtert op de **gesloten** kant: `status not in ('afgehandeld',
'auto_gesloten')`. Dat is een keuze over de richting van het falen:

- Zouden wij de **open** lijst hier overschrijven en zet het LMS er een nieuwe
  open status bij, dan valt die stil weg → **een mentorkaart die nooit
  aankomt.** Dat is de bug die hiervoor al een keer gebeurde.
- Zet het LMS er een nieuwe **gesloten** status bij, dan komt er een kaart binnen
  die al afgehandeld is → zichtbaar, hinderlijk, in één klik weg.

De tweede fout is de goedkope.

**Komt er een gesloten status bij, laat het weten** — dan zetten we hem in
`LMS_GESLOTEN_STATUSSEN` in `api/_lib/iris/signalen.js`. Er staat een test op
dat die lijst er is; er kan geen test op staan dat hij volledig is.

---

## De soorten

`soort` is vrije tekst. Wat we vandaag zien bij `bron = handmatig`:

| soort | Wat Iris voorstelt |
|---|---|
| `start_niet_op` | nog geen eigen voorstel → *"laat een mens kijken"* |

En de zes die al een voorstel hebben, voor als het LMS ze gaat melden:

| soort | Wat Iris voorstelt |
|---|---|
| `uitstel` | on hold met reden, einddatum schuift mee |
| `reageert_niet` | op de belrij bij Dave |
| `halt` | stopzetten bespreken — **altijd een mens, nooit een handeling** |
| `no_show` | op de belrij |
| `factuur` | dossier nakijken in de Post |
| `taken_niet_gedaan` | op de belrij |

### Een soort die er niet bij staat, is geen fout

Dit is de belangrijkste afspraak in dit document.

Er staat **geen CHECK-constraint** op `iris_signalen.type`. Een onbekende soort
komt gewoon in de lijst, met het voorstel "laat een mens kijken". De
synchronisatie valt er niet over.

De reden: de mentormodule wordt doorontwikkeld. Zou er een enum staan, dan breekt
de synchronisatie op de dag dat het LMS een zevende soort toevoegt — en een
synchronisatie die stilvalt, merkt niemand. Dan blijven signalen liggen terwijl
iedereen denkt dat de koppeling werkt.

Dus: **voeg gerust soorten toe.** Laat het weten, dan krijgen ze een passend
voorstel in plaats van het neutrale.

---

## Wat er aan onze kant gebeurt

1. `cron-iris-werk` haalt elke vijf minuten de **handmatige, open** signalen van
   de laatste dertig dagen op (hoogstens 100 per ronde).
2. Per groep worden drie dingen opgezocht, alle drie fail-zacht: de mentornaam,
   de openingsnotitie, en het Iris-contact.
3. Wat nog niet in `iris_signalen` staat, wordt toegevoegd. `bron_id` is UNIQUE,
   dus de cron mag zo vaak draaien als hij wil.
4. Het signaal verschijnt op de dossierkaart van die persoon, met het voorstel
   erbij.

### De koppeling naar een dossier

`hlms_signaal.student_id` → `hlms_student.email` → `iris_contacten.emails`.

**Bij 0 of meer dan 1 treffer blijft `contact_id` leeg.** Ambiguïteit is geen
"kies de eerste": een kaart aan de verkeerde persoon hangen is erger dan een
kaart zonder dossier. Er wordt ook **geen contact aangemaakt** — een student die
ons nooit geschreven heeft, hoort geen gespreksdossier te krijgen omdat zijn
mentor iets meldde.

Let op het gevolg: een signaal met een leeg `contact_id` staat wél in
`iris_signalen` maar is **nergens zichtbaar**, want de dossierkaart is de enige
plek die deze tabel leest en die filtert op `contact_id`. Dat is bewust — maar het
betekent dat "de kaart komt niet" twee oorzaken kan hebben, en de tweede is een
student die bij ons geen contact heeft.

Een LMS dat even niet bereikbaar is, legt de rest van Iris niet stil. Dat is een
waarschuwing in het logboek, geen fout.

## Wat Iris NIET doet

- Niet schrijven in `hlms_signaal`, `hlms_signaal_gebeurtenis`, `hlms_personeel`
  of welke `hlms_*`-tabel dan ook, met één uitzondering die de opdracht
  uitdrukkelijk toestaat: `hlms_student.eind_datum` bij een goedgekeurde
  verlenging, via `iris_acties`.
- Niet zelf een student op hold zetten. Dat is een voorstel dat een mens
  goedkeurt.
- Geen signaal als "afgehandeld" markeren in het LMS. Wij zetten
  `iris_signalen.verwerkt_op` aan onze kant; het LMS houdt zijn eigen
  boekhouding.
- Geen `lms_regel`- of `crm_cron`-signalen overnemen.
