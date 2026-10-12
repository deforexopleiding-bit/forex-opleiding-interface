# Taak 6 — de belrij vult zich, en escaleert met een voorstel

Wat er gebouwd is, waarom het zo is, en wat er bewust niet in zit.

---

## Waar dit over gaat

De belrij zei **"Niemand te bellen"** terwijl het dashboard 242 bel-acties en
negen wanbetalers toonde. Dat leek een fout in het scherm. Het was er geen.

Nagemeten: `iris_belrij` kreeg rijen uit precies één plek — de handmatige actie
`belrij_toevoegen` in `api/iris-actie.js`. Niets vulde hem uit de wanbetalers,
niets uit de mentorsignalen, niets uit de verlopen opvolgingen. De belrij was
leeg omdat niemand hem vulde. Geen bug maar een ontbrekende functie.

Datzelfde gold voor de escalatie: `moetEscaleren()` bestond al, zette een oranje
blok op de kaart, en daar bleef het bij. De handleiding zei "dan zet je in de
Post een bericht klaar" — met de hand, elke keer, voor elke persoon.

---

## 1. Drie bronnen, alle drie alleen lezen

| Bron | Waar | Hoe |
|---|---|---|
| Bel-taken van de wanbetalers | `pending_actions` | `action_type='MANUAL_FOLLOWUP'` + `payload->>kind='call'` |
| Mentorsignalen | `iris_signalen` | waarvan `voorstelVoor(type).actie === 'belrij_toevoegen'` |
| Verlopen opvolgingen | `iris_opvolgingen` | `status='verlopen'` |

Die eerste lezer dekt **twee** dingen tegelijk: de taken die iemand met de hand
in de inbox aanmaakt, én wat de aanmaanmotor als bellen markeert — die zet
`payload.kind='call'` zelf al zodra de titel met "Bel klant" begint
(`api/_lib/dunning-step-executors.js`). Eén lezer, geen tweede lijst met
titelpatronen die uit elkaar kan lopen. **Aan de wanbetalersmodule verandert
geen regel.**

Bij de tweede lezer wordt het type **niet** in de query gefilterd. `iris_signalen.type`
is met opzet vrije tekst (het LMS krijgt er types bij), en welke types op de
belrij horen staat in `VOORSTEL_PER_TYPE` in `signalen.js`. Diezelfde lijst nog
een keer in een `.in('type', …)` zetten levert twee lijsten op die uit elkaar
lopen zodra iemand er één aanpast.

`start_niet_op` ontbrak in die lijst en viel daardoor op de neutrale val "laat
een mens kijken". Betaald en niet begonnen is juist het geval waar bellen het
enige is dat helpt; dat type stuurt nu naar de belrij.

### Waarom een verlopen opvolging `geen_reactie` heet

`iris_belrij.bron` heeft een CHECK met vijf waarden. Een zesde erbij betekent de
constraint droppen en opnieuw aanmaken op een tabel die in productie staat. Dat
hoeft niet: een opvolging verloopt juist omdát er geen reactie kwam binnen het
venster, en `geen_reactie` leest al als "Reageert niet op berichten". De
`bron_sleutel` (`opvolging:<id>`) houdt de herkomst vast, dus er gaat niets
verloren.

---

## 2. Eén rij per persoon, meerdere redenen

`iris_belrij` is één rij per persoon; de redenen hangen eronder in
`iris_belrij_redenen` (`belrij_id`, `bron`, `bron_sleutel`, `reden`,
`reden_detail`, `bron_link`, `verwerkt_op`).

**Waarom een aparte tabel en geen `redenen jsonb`.** Eén persoon kan om drie
redenen tegelijk op de lijst staan: een bel-taak van de wanbetalers, een
mentorsignaal, en een verlopen opvolging. Die redenen komen uit drie systemen,
verdwijnen op drie momenten, en moeten ieder apart afgevinkt kunnen worden. In
een jsonb-kolom is "deze ene reden is weg" een read-modify-write over de hele
kolom; twee ronden die elkaar kruisen overschrijven dan elkaars werk. Als rij is
het een UPDATE op één regel. Zelfde afweging als bij
`payment_arrangements` / `pending_actions`.

**Waarom geen `ON CONFLICT` op `iris_belrij`.** "Eén open rij per persoon" is een
PARTIËLE unieke index (alleen waar `status in ('open','bezig')`), en een partiële
index kan in PostgREST/supabase-js geen `ON CONFLICT`-arbiter zijn. Daarom per
persoon: SELECT de open rij, dan UPDATE of INSERT. Op `iris_belrij_redenen` kán
het wél, want daar is de index volledig (`belrij_id, bron_sleutel`) — en dát
maakt de vuller idempotent per bron-item.

### Wat er weer af gaat, en wat niet

Een reden die een bron niet meer aanlevert krijgt `verwerkt_op`. Geen DELETE: een
reden die ooit gold is een stuk geschiedenis van waarom er gebeld is.

Maar **alleen de prefixen die de vuller beheert** (`pending_action:`, `signaal:`,
`opvolging:`). Een reden die een mens met de hand toevoegde heeft geen
bronsysteem dat hem kan aanleveren, en zou dus bij de eerste ronde meteen op
verwerkt gaan — weg van de kaart, terwijl degene die hem zette denkt dat hij er
staat. Een onbekende prefix blijft ook staan: liever een reden te veel op de
kaart dan er stil een af.

### Wie belt er

`iris_instellingen.belrij_eigenaar`, per bron, **leeg gestart**. Een nieuwe rij
krijgt de eigenaar van zijn zwaarste bron. Een rij die al een eigenaar heeft
verandert **niet** van eigenaar als er een tweede reden bij komt — anders
verdwijnt werk uit iemands "Van mij" doordat de vuller een ronde deed, en daar
is geen melding voor.

Dit is een **stille** instelling: staat er een uuid die niet bestaat, dan komt de
rij op de lijst van niemand te staan — niet weg, maar onvindbaar voor wie op
"Van mij" filtert. Daarom een keuring op het lezen én het schrijven, een
keuzelijst met namen in plaats van een invoerveld, en bij een leesfout een
**lege** kaart in plaats van een halve.

---

## 3. Escalatie: een voorstel, geen bericht

Drie niet-opgenomen pogingen op drie **verschillende** dagen zonder contact.
`moetEscaleren()` zegt of die drempel gehaald is — dat is een **meting**. Wat er
dan mag gebeuren is een **mandaat**, en dat staat apart in
`api/_lib/iris/belrij-escalatie.js`.

Drie standen per bron: `uit` / `concept` (standaard) / `zelf`.

De vier poorten achter `zelf` zitten in **code**, niet in de instelling:

1. **Kantooruren 08-20**, via `Intl` met tijdzone en niet `getHours()`. De server
   staat op UTC; in de zomer zou een venster van 08:00 om 06:00 opengaan.
2. **Afkoeling van 72 uur** per persoon.
3. **Nooit tijdens een actieve betaalafspraak of toezegging** — uit
   `iris_beloftes` én `payment_arrangements`, **fail-CLOSED**: valt een van de
   twee opvragingen om, dan sturen we niet.
4. **Nooit een tweede concept** naast een eerste dat nog klaarstaat.

Een poort die dicht staat valt terug op **`concept`**, niet op `niets`. Werk dat
stil verdwijnt is erger dan werk dat op een mens wacht. Alleen stand `uit` en
poort 4 leveren niets op.

De hoofdschakelaar overrulet alles: staat `IRIS_AAN` uit, dan wordt `zelf`
gelezen als `concept` — niet als `uit`, want het werk moet zichtbaar blijven.

### Eén verzendweg

Ook bij stand `zelf` gaat de rij als `goedgekeurd` met een `verstuur_na` de
databank in, en verstuurt de **bestaande** cron hem binnen het ongedaan-venster
van G2. Geen tweede verzendweg betekent geen tweede plek waar de
claim-vóór-versturen vergeten kan worden.

### Vaste tekst

Een "we proberen je te bereiken"-bericht is elke keer hetzelfde bericht. Geen
modelaanroep: dat kost tokens, geeft drift tussen twee klanten die hetzelfde
meemaken, en voegt een kans toe dat er een bedrag of datum in belandt die
niemand heeft nagekeken.

Er staat **geen bedrag, geen factuurnummer en geen datum** in — niet omdat het
niet kan maar omdat het niet hoeft: de vraag is "wanneer kunnen we je bereiken".
Zo is er ook niets om te verzinnen, en geen `[invullen]` in een tekst die zo de
deur uit kan.

### Het ene gesprek

`iris_concepten.gesprek_id` is NOT NULL. Bij nul of meerdere gesprekken komt er
**geen** concept — dan blijft de rij op de belrij staan met de reden erbij. Bij
precies één WhatsApp en één mail wint WhatsApp, want daar tikt het venster.

Buiten het venster is een goedgekeurde template nodig (`opvolging_geen_reactie2`).
Is die er niet, `PAUSED`, of onder `MARKETING` ingedeeld, dan komt er geen
WhatsApp-concept en blijft de mail over.

Een gesprek dat is ingedeeld als `opzeg_klacht_juridisch` krijgt **nooit** een
concept. Die regel staat nu op drie plekken (`instellingen.js`, `templates.js`,
`belrij-escalatie-concept.js`) omdat dit een derde weg naar de klant is.

---

## 4. Mentorsignaal afvinken

Een knop per signaal op de dossierkaart die `iris_signalen.verwerkt_op` zet.

**Alleen onze kant.** `hlms_signaal` wordt niet gelezen en niet geschreven; de
mentor sluit zijn signaal in het LMS zelf af. Dit is onze stand: "wij hebben
ernaar gekeken". Dat staat ook op het scherm, anders denkt iemand dat de mentor
het ziet.

**Het kan terug.** `afgehandeld: false` zet `verwerkt_op` weer op NULL. Dat is
geen extra functie maar de voorwaarde om de knop zónder bevestigingsvraag te
durven aanbieden: een knop waar je bang voor bent, wordt niet gebruikt.

Een afgehandeld signaal verdwijnt niet van de kaart; hij staat onderaan en
gedimd. Verbergen zou betekenen dat je niet kunt zien dat iemand er net op
geklikt heeft, en dan klikt de volgende nog een keer.

---

## Migraties

| Bestand | Wat | Wanneer |
|---|---|---|
| `2026-10-12-iris-belrij-redenen.sql` | nieuwe tabel `iris_belrij_redenen` + 3 indexen + RLS | zodra deel 1 gemerged is |
| `2026-10-12-iris-belrij-een-rij-per-persoon.sql` | partiële unieke index op `(contact_id)` waar status open/bezig | **pas ná** deel 2b |

Die tweede heeft een volgorde-eis: ervoor zou elke handmatige toevoeging voor
iemand die al op de lijst staat falen met `23505`. De controle vooraf telt of er
al dubbele rijen staan — welke daarvan weg of samengevoegd moet, is een keuze
over werk dat iemand misschien al heeft opgepakt, en die maakt de migratie niet
voor je.

Deel 3 en deel 4 hebben geen migratie: hun instellingen leven in
`iris_instellingen` (leeg = veilige standaard) en `iris_signalen.verwerkt_op`
bestond al.

Zolang de eerste migratie niet gedraaid is blijft de belrij leeg — fail-soft, de
rest van Iris werkt ongewijzigd.

---

## Wat hier bewust niet in zit

- **Geen zesde `bron`-waarde.** Een CHECK op een productietabel verbouwen voor
  een naam die `geen_reactie` al dekt, is kosten zonder opbrengst.
- **Niets terug naar het LMS.** Niet bij het afvinken van een signaal, niet
  ergens anders.
- **Geen tweede verzendweg**, ook niet voor `zelf`.
- **Geen advies om `zelf` aan te zetten.** Het scherm zegt wat de stand doet en
  wat hem daarna nog tegenhoudt. Welke bron op `zelf` mag, is geen technische
  afweging.

---

## Waar de code staat

| Bestand | Wat |
|---|---|
| `api/_lib/iris/belrij-bronnen.js` | puur: kandidaten uit de drie bronnen, samenvoegen, wat er af gaat |
| `api/_lib/iris/belrij-vullen.js` | de databankkant: lezen, wegschrijven, met de hand toevoegen |
| `api/_lib/iris/belrij-escalatie.js` | puur: het mandaat, de vier poorten in vaste volgorde |
| `api/_lib/iris/belrij-escalatie-concept.js` | puur: welk gesprek, welk kanaal, welke tekst |
| `api/_lib/iris/belrij-escalatie-ronde.js` | de databankkant van de escalatie |
| `api/iris-signaal-afhandelen.js` | het afvinken van een mentorsignaal |
| `api/cron-iris-werk.js` | stap 7 (vullen) en stap 8 (escaleren), beide fail-soft |

`tests/vast/nep-db.js` is de nep-PostgREST waar de gedrags-toetsen op draaien.
Die stond eerst in drie kopieën in drie toetsbestanden, en twee ervan pasten een
`update()` toe op wat de filters tót dan toe selecteerden in plaats van op de
rijen uit de `.in()` erna. Daardoor raakte een UPDATE méér rijen dan in
productie, en liet de toets die juist moest bewijzen dát er één reden werd
afgevinkt een echte bug door. Een nabouw die ruimer is dan het echte ding
bewijst niets.
