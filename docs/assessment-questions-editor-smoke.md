# Assessment-vragen editor — smoke-doc

Branch: `feat/assessment-questions-editor`
PR: open (NIET gemerged)
Migratie: **n.v.t.** — `assessment_questions` schema bestaat al (Blok 2 PR 1, 2026-06-12). Geen DDL-wijziging.

## Forward-only invariant (kritisch)

Edits in deze editor beïnvloeden **GEEN bestaande `assessment_responses`**:
- Antwoorden zijn verbatim opgeslagen in `assessment_responses.answers` (geen FK naar question.id, alleen string keys).
- `score` jsonb + `routing_result` zijn at-submit-tijd vastgelegd door de scoring-engine (Blok 2 PR 2).
- Alleen **nieuwe inzendingen** ná een edit gebruiken de nieuwe config.
- **Geen retroactieve herberekening** van bestaande responses — bewust.

Hard-delete is bewust niet ondersteund. Vragen die niet meer relevant zijn moeten via `active=false` gedeactiveerd worden zodat de UNIQUE(key) constraint behouden blijft en geen referenties stuk gaan.

## Pre-flight (1 keer)

Permission `admin.joost_config` moet aan de relevante rollen gegrant zijn:
1. Admin → Rechten-tab.
2. Voor super_admin/admin/manager: vink `admin.joost_config` aan (`Joost configuratie aanpassen`).
3. Save.

Zonder deze permissie blijft de tab "Assessment-vragen" verborgen.

## Scenario 1 — Lijst laden + sectie-grouping

**Doel:** alle 12 seed-vragen (3 identiteit + 5 routing + 3 engagement + 1 doel) renderen gegroepeerd per section, gesorteerd op order_index.

**Stappen:**
1. Login als super_admin → `/modules/admin.html`.
2. Klik tab "Assessment-vragen".
3. Lijst toont 4 sectie-blokjes (identiteit, routing, engagement, doel) met respectievelijk 3 / 5 / 3 / 1 rij.
4. Elke rij toont: `#<order_index>` + label + (key) + type + badges (routing/verplicht/inactive waar van toepassing).
5. Voor "ervaring": badge "routing" + "verplicht" zichtbaar.
6. Voor "uitspraak" (geen is_routing): geen routing-badge.

## Scenario 2 — Nieuwe vraag toevoegen

**Doel:** vraag van het type `radio` met opties + is_routing met routing_weights toevoegen + zien op de publieke pagina.

**Stappen:**
1. Klik "+ Nieuwe vraag".
2. Vul in:
   - Key: `interesse_focus`
   - Section: `engagement`
   - Type: `radio`
   - Order index: `1050`
   - Label: `Waarop wil je je vooral focussen?`
   - Required: ✓
   - is_routing: ✓
   - Options (JSON):
     ```json
     [
       {"value":"techniek", "label":"Technische analyse"},
       {"value":"psychologie","label":"Trader-psychologie"},
       {"value":"risk",      "label":"Risk management"}
     ]
     ```
   - routing_weights (JSON):
     ```json
     { "techniek": 1, "psychologie": 2, "risk": 2 }
     ```
3. Klik Opslaan → banner "Vraag aangemaakt.", modal sluit, lijst herlaadt → nieuwe rij staat in sectie `engagement` tussen `motivatie` (#900) en `uitspraak` (#1000) bij order_index 1050... wacht — 1050 > 1000, dus ná uitspraak. Pas indien gewenst order_index aan.
4. Open `/modules/assessment.html` (publieke pagina, evt. incognito) → vraag verschijnt in de engagement-sectie.

**Verifieer DB:**
```sql
SELECT key, type, order_index, options, routing_weights, active
FROM public.assessment_questions
WHERE key='interesse_focus';
```

## Scenario 3 — Label + optie wijzigen

**Stappen:**
1. Klik bewerk-knop (potlood) op een bestaande vraag (bv. `ervaring`).
2. Wijzig het label van "Hoe lang ben je al bezig met traden?" naar "Hoe lang trade je al?".
3. In de Options-textarea wijzig de label van `{"value":"<3mnd","label":"Minder dan 3 maanden"}` naar `"label":"<3 maanden"`.
4. Klik Opslaan.
5. Refresh `/modules/assessment.html` → nieuwe tekst zichtbaar.

**Verifieer forward-only:**
```sql
-- Bestaande responses moeten nog steeds de oude value-strings hebben in answers,
-- niet de nieuwe labels. answer-keys zijn altijd de option-values, niet labels:
SELECT id, answers->>'ervaring' AS ervaring_value, routing_result, score->>'skill_score' AS skill
FROM public.assessment_responses
WHERE answers ? 'ervaring'
ORDER BY submitted_at DESC LIMIT 3;
-- verwacht: value-strings ('<3mnd', '3-12mnd', etc.) blijven onveranderd,
--           score + routing_result onveranderd.
```

## Scenario 4 — Deactiveren (active=false)

**Doel:** vraag verbergen voor toekomstige deelnemers maar bestaande responses behouden.

**Stappen:**
1. Klik oog-knop op een vraag (bv. de testvraag `interesse_focus`).
2. Bevestig prompt "deactiveren? Forward-only: bestaande inzendingen blijven hun antwoorden behouden."
3. Banner "Vraag gedeactiveerd." → rij is nu opacity 0.55 met badge "inactive".
4. Refresh `/modules/assessment.html` → vraag verschijnt niet meer.

**Verifieer:**
```sql
SELECT key, active FROM public.assessment_questions WHERE key='interesse_focus';
-- verwacht: active = false
```

Aanvinken oog-knop opnieuw → reactiveren.

## Scenario 5 — Herordenen (order_index swap)

**Stappen:**
1. Klik op de omhoog-pijl bij `kennis` (order 800 in routing).
2. order_index wisselt met de buur boven (`winstgevend`, order 700).
3. Lijst sorteert opnieuw.

**Verifieer:**
```sql
SELECT key, order_index FROM public.assessment_questions
WHERE section='routing' ORDER BY order_index;
-- kennis en winstgevend staan nu in omgewisselde volgorde.
```

## Scenario 6 — routing_weights aanpassen → nieuwe submission gebruikt nieuwe config

**Doel:** bevestigen dat scoring at-submit gebruikt de actuele config; bestaande responses retroactief NIET hergescoord worden.

**Stappen:**
1. Pak een radio-routing-vraag, bv. `winstgevend`. Bestaande routing_weights:
   ```json
   { "nog_niet": 0, "af_en_toe": 1, "consistent": 2 }
   ```
2. Wijzig naar:
   ```json
   { "nog_niet": 0, "af_en_toe": 1, "consistent": 5 }
   ```
3. Opslaan.
4. Doe een nieuwe assessment-submit op `/modules/assessment.html` met `winstgevend='consistent'` + andere routing-antwoorden zo dat skill_score ≥ 7 met de nieuwe weights.
5. Verifieer in DB:
   ```sql
   SELECT id, routing_result, score
   FROM public.assessment_responses
   ORDER BY submitted_at DESC LIMIT 1;
   ```
   `score->>'skill_breakdown'` toont `consistent: 5` (nieuwe weight) en bijhorend hogere skill_score.
6. Verifieer **GEEN retroactieve hergebruik**: een eerdere submission met `winstgevend='consistent'` heeft nog steeds de OUDE score in `score->'skill_breakdown'->>'winstgevend'` = `2`.

## Scenario 7 — Validatie-fouten (server-side)

**Stappen (via DevTools console of de UI):**
1. Probeer een radio-vraag op te slaan zonder `options` → 400 "options vereist voor type=radio".
2. Probeer `is_routing: true` zonder `routing_weights` → 400 "routing_weights vereist als is_routing=true".
3. Probeer een tweede vraag met dezelfde `key` aan te maken → 409 `KEY_EXISTS`.
4. Probeer een `type` buiten de enum → 400 / DB CHECK constraint.
5. Probeer een `routing_weights` met een non-number value → 400 "routing_weights.X moet een geldig getal zijn".

## Hygiene

```bash
$ node -e "
  const fs = require('node:fs');
  const html = fs.readFileSync('modules/admin.html', 'utf8');
  const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  const blocks = []; let m;
  while ((m = re.exec(html)) !== null) {
    if (!/\bsrc=/.test(html.slice(m.index, m.index + m[0].indexOf('>') + 1))) blocks.push(m[1]);
  }
  fs.writeFileSync('.tmp-admin-scripts.mjs', blocks.join('\n\n'));
"
$ node --check .tmp-admin-scripts.mjs
$ echo $?
0
```
Schone parse op de inline JS van admin.html (vangt template-literal-traps zoals Fase B PR #184 had).

## Wat NIET in deze PR

- Hard-delete (bewust — referenties zouden breken)
- Retroactieve herberekening van bestaande scores (forward-only invariant)
- Drag-and-drop reorder (up/down-arrows zijn voldoende voor v1)
- Pair-list-builder voor options (textarea+JSON is voor admin v1 OK)
- Per-option weight-input voor routing_weights (textarea+JSON is voor admin v1 OK)
