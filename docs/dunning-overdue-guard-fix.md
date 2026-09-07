# Aanmaan-motor: harde vervaldatum-poort + echte tier-keuze

**Aanleiding:** facturen die nog NIET vervallen waren kregen automatisch een
aanmaning.

Twee bevestigde gevallen:

| Klant | Factuur | Factuurdatum | Vervaldatum | Aanmaning verstuurd |
|---|---|---|---|---|
| Nanida Van Veen (`4a8a7d3b-b900-4ff7-912a-c94da4cbb7c8`) | 2026/1780 | 01-09-2026 | 08-09-2026 | 06-09-2026 09:00, template `aanmaning_dag14`, tekst "staat inmiddels **0 dagen** open" |
| JWA van Golverdinge Schut | — | — | 17-09-2026 | 16-08-2026 |

## 1. Waar `days_overdue` vandaan komt (situatie vóór deze fix)

Er is geen Supabase-view of RPC die `days_overdue` berekent voor de
wanbetalers-lijst of de motor — het gebeurt allemaal in JavaScript. De enige
SQL met `GREATEST(0, …)` staat in de **AI-read-only views** en wordt door de
motor niet gebruikt.

| Bestand | Regel(s) | Wat het deed |
|---|---|---|
| `api/wanbetalers-overzicht-list.js` | `daysOverdueFromIso()` | `diff > 0 ? diff : 0` — clamp op 0. Bron van de "68 van 157 rijen met `oldest_due_iso` in de toekomst en `days_overdue = 0`". |
| `api/_lib/dunning-engine.js` | `aggregatePerCustomer()` | `let days = 0; if (todayMs > oldestMs) days = …` — zelfde clamp, per klant over de **oudste** openstaande factuur. Dit is de teller die de selectie stuurde. |
| `api/_lib/dunning-template-render.js` | `buildVariables()` | `DAGEN_OVERDUE = Math.max(0, diff)` — de "**0** dagen open" in het verstuurde bericht. |
| `api/_lib/template-variables.js` | `factuur.dagen_overdue` | `String(Math.max(0, diff))` — idem voor named placeholders. |
| `api/_lib/incasso-auto.js` | `daysOverdue(iso, nowMs)` | `if (t >= nowMs) return 0` — toekomstige vervaldatum telt als 0. |
| `docs/sql-migrations/2026-08-01-ai-readonly-foundation.sql` / `-broad-views.sql` | `dagen_te_laat_max` | `GREATEST(0, CURRENT_DATE - MIN(i.due_date))` — alleen AI-read-only, geen motor-pad. |

Daarnaast rekenden al deze plekken met de **UTC**-datum
(`new Date().toISOString().slice(0,10)` of `setHours(0,0,0,0)` op een
UTC-runtime), niet met de kalenderdag in Europe/Amsterdam.

## 2. Waarom er een aanmaning uitging vóór de vervaldag

In `detectAndStartRuns` (`api/_lib/dunning-engine.js`) stond de enige
overdue-check op:

```js
if (agg.days_overdue < minDays) continue;
```

`minDays` komt uit `workflow.trigger_conditions` en valt terug op **-1** zodra
de workflow op `min_days_since_invoice_date` (het "dag-7-duwtje") óf op
`arrangement_breached` staat:

```js
const minDays = hasOverdueTrigger
  ? tc.min_days_overdue
  : ((hasIssueDateTrigger || arrangementBreached) ? -1 : 14);
```

Omdat `agg.days_overdue` op 0 geclampt was, is `0 < -1` altijd `false` →
**de overdue-check slaagde altijd**, ook bij een vervaldatum in de toekomst.
Zulke workflows selecteerden dus op de leeftijd van de *factuurdatum*
(`days_since_oldest_invoice`), waar de vervaldatum nooit meer aan te pas kwam.

## 3. Waarom de tier (`dag7` / `dag14` / …) niet klopte

De tier zit **niet** in code: elke stap in `dunning_workflow_steps` wijst via
`config.template_id` naar een rij in `dunning_templates`, en die rij draagt de
Meta-templatenaam (`aanmaning_dag14`). Welke stap aan de beurt is, werd
uitsluitend bepaald door de pointer `dunning_workflow_runs.current_step_id` en
de `wait`-stappen daartussen:

```js
if (currentStep.step_type === 'wait') {
  update.next_action_at = new Date(Date.now() + days * 86400000).toISOString();
}
```

De teller achter de tier-keuze was dus **"dagen sinds de run startte"**, niet
"dagen te laat". Omdat de run al vóór de vervaldag kon starten (zie §2),
schoof de hele reeks naar voren: `dag7` vuurde op dag 1, `dag14` op dag 0.

## 4. Wat er is gewijzigd

### Nieuw: `api/_lib/dunning-overdue-guard.js`
Eén bron van waarheid, grotendeels pure functies (unit-tests in
`tests/dunning-overdue-guard.test.js`, 24 stuks):

* `todayIsoInTz(now, tz)` — kalenderdag in **Europe/Amsterdam**, DST-aware.
* `daysOverdueSigned(dueIso, todayIso)` — **ongeclampt**; negatief = vervalt
  over |n| dagen, 0 = vervalt vandaag, `null` = geen/onparseerbare datum.
* `isOverdue(dueIso, todayIso, graceDays)` — **de harde poort**:
  `due_date + grace < vandaag`. Geen `due_date` → `false` (fail-closed).
* `readGraceDaysSetting(db)` — `app_settings.dunning_grace_days`
  (`{ days: int 0..90 }`), default **0**, fail-soft naar 0.
* `resolveStepTierDays(step, template)` / `tierFromName(name)` —
  `aanmaning_dag14` → 14; expliciete `step.config.min_days_overdue` wint.
* `earliestSendIso(dueIso, minDays)` — de datum waarop het wél mag.

### `api/_lib/dunning-engine.js`
1. `aggregatePerCustomer()` levert nu ook `days_overdue_signed` en
   `is_overdue` naast de (ongewijzigde, geclampte) `days_overdue`.
2. **Detect-fase:** harde poort vóór álle workflow-condities. Geen enkele
   trigger kan 'm omzeilen. Geweigerde matches worden geteld en gelogd
   (`overdue-poort: N klant-match(es) geweigerd`).
3. **Advance-fase (defense in depth):** vóór elke `email`/`whatsapp`-stap
   opnieuw de poort + een tier-check. Bij blokkade wordt de pointer **niet**
   verschoven en alleen `next_action_at` vooruitgezet naar de dag waarop het
   wél mag, met een `dunning_log`-regel:
   * `send_skipped_not_overdue` — factuur nog niet vervallen.
   * `send_postponed_tier_not_reached` — `aanmaning_dagNN` bij te lage echte
     `days_overdue`; payload bevat `tier_min_days` + ongeclampte
     `days_overdue`.
4. **Pipeline-automatisering `on_overdue_to_nieuw`:** de query gebruikte de
   UTC-datum; nu de Amsterdamse kalenderdag minus de gratieperiode. `lt`
   sluit de dag zelf uit, dus instroom pas vanaf de dag ná de vervaldag.

### `api/wanbetalers-overzicht-list.js`
`days_overdue` blijft geclampt (de UI sorteert en filtert er numeriek op).
Nieuw per rij: `is_overdue`, `days_overdue_signed`, `days_until_due`; in
`totals`: `overdue_customers` en `not_yet_due_customers`.

### `api/_lib/incasso-auto.js`
Ongeclampte teller + harde poort vóór de instelbare drempels, zodat een klant
met alleen nog-niet-vervallen facturen nooit incasso-kandidaat wordt — ook niet
als `min_days_overdue` op `null` (uit) staat.

### `api/dunning-settings-get.js` / `api/dunning-settings-update.js`
`dunning_grace_days` (0..90, default 0) erbij. Beide keys zijn optioneel bij
POST; de bestaande UI die alleen `dunning_cooldown_days` stuurt blijft werken.

### `modules/klanten-v2/views/instellingen-v2.js`
Kaart "Gratieperiode na de vervaldag" naast de bestaande cooldown-kaart.

## 5. Bewust NIET aangeraakt

* **Handmatige bulk-flows** (`wanbetalers-bulk-start-workflow.js`,
  `wanbetalers-bulk-preview.js` → `cron-dunning-bulk-send.js`): daar selecteert
  een medewerker expliciet klanten/facturen, en `min_days_overdue` wordt daar
  al bewust genegeerd. Dat is geen automatische selectie. Wil je de poort daar
  óók (of als waarschuwing in de preview), dan is dat een aparte beslissing.
* De clamp in `dunning-template-render.js` / `template-variables.js` blijft
  staan: een negatief getal in een klantbericht is erger dan 0, en met de
  poort erboven kan `DAGEN_OVERDUE` bij een automatische send niet meer 0 zijn.
* Rechten, datamodel en migraties: ongewijzigd. `dunning_grace_days` is een
  gewone `app_settings`-rij en hoeft niet vooraf te bestaan (afwezig = 0).

## 6. Nog te doen buiten deze PR (DB-config)

De workflow-configuratie in `dunning_workflows.trigger_conditions` leunt nog
op `min_days_since_invoice_date`. De code blokkeert nu het verkeerde gedrag,
maar de nettere inrichting is een expliciete `min_days_overdue` per workflow
en, waar gewenst, `config.min_days_overdue` per stap (die wint boven de uit de
templatenaam afgeleide tier).
