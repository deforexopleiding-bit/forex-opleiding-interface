# GESPREKKEN_V2 — wat er af is, en wat nog niet

**Datum:** 22 september 2026
**Hoort bij:** [`02-gesprekken-audit.md`](02-gesprekken-audit.md)

De audit meet tien gaten en zet er een volgorde op. Dit document houdt bij
welke daarvan dicht zitten, achter welke schakelaar, en wat er nog ligt. Het
wordt bijgewerkt per PR, niet per goed voornemen.

---

## De schakelaar

Omgevingsvariabele **`GESPREKKEN_V2`**. Alles behalve een uitdrukkelijke
`true` is uit. Gelezen op één plek: `api/_lib/gesprekken-vlag.js`.

De stand reist mee met het antwoord van `inbox-conversations-list` — het
scherm haalt die lijst toch al op, dus er komt geen opvraging bij. Het scherm
tekent de nieuwe onderdelen alleen als:

1. dat antwoord `vlaggen.gesprekken_v2 === true` zegt, **en**
2. `modules/shared/gesprekken-v2.js` geladen is.

Die tweede voorwaarde is geen overdaad. Blijft dat script weg — script-tag
vergeten na een herschikking, netwerkfout, blokkade — dan valt het scherm terug
op de opmaak van hiervoor in plaats van halverwege een draad te struikelen over
een functie die er niet is.

**Aanzetten:** `GESPREKKEN_V2=true` in Vercel (alle omgevingen), opnieuw
uitrollen. **Terug:** de variabele weghalen of op `false` zetten, opnieuw
uitrollen. Geen migratie, geen databankwijziging, niets om terug te draaien.

Dat is werk voor Maxim; omgevingsvariabelen zet hij zelf.

---

## Wat er af is

### G3 — het venster telt af

**Was:** het scherm toonde "24u-venster is verlopen" op het moment dat het te
laat was. Hoeveel tijd er nog was, stond nergens. Je liep tegen een muur op het
moment dat je wilde gaan typen.

**Nu:** de badge in de gesprekskop leest `24u ✓ · nog 6u12`, en wordt amber
zodra er minder dan twee uur over is — terwijl het venster nog open is, want
dát is het moment waarop je er nog iets mee kunt.

De aftreksom staat in `vensterStand()` in `modules/shared/gesprekken-v2.js` en
rekent op `whatsapp_conversations.last_inbound_at`, dat al in het lijst-antwoord
meekwam. `inbox-thread-unified` stuurt het nu ook mee, zodat de kop niet van de
lijst-cache afhangt.

Drie randgevallen die de test vastlegt, omdat ze het verschil zijn tussen een
badge en een leugen:

- **niet bekend ≠ verlopen.** Een gesprek waar nooit iets binnenkwam heeft geen
  venster dat afgelopen is; daar staat de oude badge.
- **"<1m", nooit "0m".** Nul minuten leest als dicht terwijl het open is.
- **precies 24 uur is dicht** — gelijk aan wat de server rekent, zodat scherm en
  server nooit iets anders beweren.

### G9 — de verzendstatus is zichtbaar

**Was:** `whatsapp_messages` houdt `status`, `sent_at`, `delivered_at`,
`read_at` en `failed_reason` bij. Het scherm toonde er niets van, dus een
**mislukt** bericht zag er precies zo uit als een afgeleverd bericht. Van de
tien gaten het stilste en daarom het gemeenste: je denkt dat je geantwoord hebt.

**Nu:** onder elke uitgaande WhatsApp-bel staat een teken — `✓` verstuurd,
`✓✓` afgeleverd, `✓✓` in blauw gelezen, `⏳` onderweg. Bij een mislukt bericht
staat er `⚠` mét de reden uitgeschreven, niet alleen in een tooltip: een
waarschuwing die je moet aanwijzen om te lezen, lees je niet.

Twee keuzes die de moeite van het opschrijven waard zijn:

- **Geen status → geen teken.** Rijen van vóór de statusbijhouding krijgen
  niets. Een vinkje eronder zou een bewering zijn die we niet kunnen waarmaken.
- **Een onbekende status wordt zichtbaar** (`?` plus de ruwe waarde). Verzint
  Meta er morgen een bij, dan valt dat op in plaats van eruit te zien als
  afgeleverd — precies de fout die G9 is.

Mail en inkomende berichten krijgen geen teken; die hebben geen Meta-status.

---

## Wat er nog ligt

Ongewijzigd ten opzichte van de tabel in de audit, minus de twee hierboven.

| Gat | Wat | Waarom het nog niet af is |
|---|---|---|
| G1 | microfoon overal waar tekst kan | vraagt `OPENAI_API_KEY`; die zet Maxim |
| G2 | ongedaan-venster van 30 seconden | raakt de verzendweg; eigen PR waard |
| G4 | toewijzing aan Maxim, Dave of Iris | heeft `iris_gesprekken` nodig |
| G5 | fijnere filters | twee ervan kunnen nu al (venster, niet gekoppeld), de rest heeft G4 nodig |
| G6 | mail aan het contact, niet aan de klant | raakt `inbox-thread-unified` dieper |
| G7 | IMAP `APPEND` naar Verzonden | raakt `send-email.js` |
| G8 | paginering en trager pollen | het grootste getal (≈ 54 MB per uur per tabblad), en de grootste ingreep |
| G10 | `onboarding@` erbij in de lijst | los van dit alles; kleine eigen PR |

---

## Meten of het geholpen heeft

De tabel in sectie 8 van de audit blijft openstaan tot de vlag op productie
aanstaat. Twee regels kunnen dan meteen ingevuld:

| Wat | Voor | Na |
|---|---|---|
| is te zien hoeveel venster er nog is | nee | **ja** |
| is te zien of een bericht aankwam | nee | **ja** |

De rest (netwerk per uur, klikken per antwoord) verandert pas met G8 en G1.
