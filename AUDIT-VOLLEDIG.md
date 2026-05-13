# Lessons Learned — forex-opleiding-interface

Chronologische verzameling van technische bevindingen en debuglessen opgedaan tijdens de bouw van het dashboard.

---

## Fase C sessie — 2026-05-13

### Les 1 — Silent INSERT failures: controleer kolomtypes (commit `2c5385b`)

**Symptoom:** `POST /api/agent-meeting` met 3 action points → response `{ ok: true, tasks_created: 0 }`. Geen foutmelding, loop loopt gewoon door.

**Oorzaak:** Kolom `taken_items.assigned_to_id` heeft type `uuid`. De code stuurde de agent-naam `'Simon'` als string. Postgres gooit een `invalid input syntax for type uuid: "Simon"` error. Deze werd gevangen door de try/catch in de loop — maar de task werd niet geteld, resultaat: 0 taken aangemaakt met een misleidende `ok: true`.

**Oplossing:** `toUuidOrNull()` helper die een waarde alleen doorlaat als het een geldig UUID-patroon heeft, anders `null`:
```js
function toUuidOrNull(id) {
  if (!id) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
}
```
Agents krijgen `assigned_to_id: null`; teamleden krijgen hun echte UUID.

**Algemene regel:** Verifieer altijd het werkelijke Supabase-schema vóór INSERT-queries. Postgres valideert kolomtypes strikt. Silent failures zijn extra moeilijk te debuggen als try/catch te breed is — overweeg de error message altijd mee te retourneren in de response.

---

### Les 2 — HTML-attribuut afgeknot door dubbele JSON.stringify (commit `c26588f`)

**Symptoom:** Dropdown-optie verschijnt correct, maar `onmousedown` vuurt niet. Drie verschillende klik-methoden geprobeerd — geen werkt. `getBoundingClientRect` geeft `{w:0, h:0}`.

**Oorzaak:** Template string gebruikte `JSON.stringify(JSON.stringify(o))`. De binnenste stringify geeft `'{"id":"...","name":"..."}'`, de buitenste geeft `'"{\\"id\\":\\"...\\"}"'`. Het resultaat begint met `"` (aanhalingsteken). De HTML-parser ziet dit als het *einde* van het attribuut — de rest van de handler wordt weggegooid. Functie wordt nooit geregistreerd.

**Oplossing:** Gebruik integer-indices in onclick/onmousedown-handlers i.p.v. geserialiseerde objecten:
```js
// FOUT — HTML-parser knipt af bij de tweede quote:
html += `<div onmousedown="selectAssignee(${idx}, ${JSON.stringify(JSON.stringify(o))})">`;

// GOED — integer-index is altijd veilig in HTML-attribuut:
html += `<div onmousedown="selectAssignee(${idx}, ${reviewAssigneeOpts.indexOf(o)})">`;
function selectAssignee(idx, optIdx) {
  const o = reviewAssigneeOpts[optIdx]; // opzoeken via gedeelde module-array
}
```

**Algemene regel:** Zet nooit geserialiseerde objecten in HTML-attribuut-waarden. Gebruik altijd primitieve waarden (integers, IDs). Sla objecten op in een gedeelde JS-array of in een `data-`-attribuut via `dataset` (dat escaped automatisch).

---

### Les 3 — Schema-first bij grote batches: vertrouw het werkelijke schema, niet de prompt

**Context:** De Fase C spec gebruikte kolomnamen die niet overeenkwamen met het werkelijke Supabase-schema:

| Spec-term | Werkelijke kolom |
|-----------|-----------------|
| `action_type` | `action` |
| `title` (aparte kolom) | opgeslagen in `payload.title` (jsonb) |
| `category_confidence` | `confidence` (integer 0-100) |
| `sender` | `from_address` / `from_name` |

**Aanpak:** Vóór het schrijven van queries: lees het werkelijke schema uit de migration-bestanden of een korte Supabase-query. Schrijf een overzichtstabel (spec-term → werkelijke kolom) vóórdat je aan de implementatie begint.

Genormaliseerde keuzes zijn vaak beter dan de originele spec:
- `action` i.p.v. `action_type` (kortere kolomnaam, consistenter met REST-conventies)
- `payload jsonb` i.p.v. aparte `title`-kolom (flexibeler voor uitbreidingen zonder migraties)
- FK via uuid i.p.v. duplicatie van gerelateerde data

**Algemene regel:** Bij batches van meerdere bestanden: begin altijd met een schema-verificatiestap als eerste actie. Schrijf geen queries op basis van spec-aannames.

---

### Les 4 — Geautomatiseerde browser-tests: gebruik ref_id en form_input, geen coordinate-clicks

**Context:** Bij browser-automatisering via Claude in Chrome zijn coordinate-clicks onbetrouwbaar — elementen kunnen buiten de viewport vallen of de positie kan verschuiven bij rendering.

**Regels:**
1. Gebruik altijd `ref_id` van `read_page` om elementen te identificeren, nooit absolute pixel-coördinaten.
2. Gebruik `form_input` voor tekstvelden — dit voorkomt de submit-bug waarbij een `Enter`-keypress na tekst direct het formulier indient.
3. Stuur single-line tekst i.p.v. multi-line om onbedoelde newlines en vroege submits te voorkomen.

---

## Eerdere sessies

*(Voeg hier lessen toe uit eerdere sessies zodra die worden gedocumenteerd.)*
