# Wanbetalers-zone re-skin-plan (DEEL C.1)

**Status:** PLAN — NIET GEBOUWD. Deze zone stond de hele sessie op OFF-LIMITS (elke re-skin-PR had lege beschermde-zone-diff). Dit doc beschrijft **exact welke wijzigingen veilig zijn** wanneer je groen licht geeft.

## Scope

Alles binnen `modules/finance.html#view-wanbetalers` (regels ~4294–~5474) plus WBX-body-level elementen (`.wbx wbx-bulk-bar` r3742, `.wbx wbx-bulk-scrim` r3762, `.wbx wbx-call-outcome-scrim` r4085). De sub-view is opgesplitst in 5 zichtbare tabs + 10 hidden legacy-tabs, elk met eigen wbx-* container.

### Zichtbare sub-tabs (huidig)
- `#wb-sub-inbox` — Gesprekken (WhatsApp-master-detail)
- `#wb-sub-openacties-nieuw` — Acties (Te doen / Later / Afgehandeld / Afgewezen)
- `#wb-sub-overzicht-nieuw` — Overzicht (alleen-lezen tabel)
- `#wb-sub-instellingen` — Joost / Workflows / Berichten / Bureaus / Sandbox / Geschiedenis

### Verborgen legacy-tabs (nog bereikbaar via `?sub=`)
- `#wb-sub-open-acties` (oud Acties)
- `#wb-sub-pipeline`, `#wb-sub-te-doen`, `#wb-sub-facturen`, `#wb-sub-opruimen`
- `#wb-sub-arrangements`, `#wb-sub-vandaag`, `#wb-sub-sandbox`, `#wb-sub-brieven`
- `#wb-sub-joost`, `#wb-sub-crediteren`, `#wb-sub-incasso`

## Wat WEL veilig re-skinnen (alleen uiterlijk)

Zelfde patroon als M-cluster/E-cluster:

1. **`.wbx wbx-tabs` / `.wbx-c` / `.wbx-chip`** — tab-nav + counter-badges. Kleuren nu deels via `--ds-text` / `--ds-surface-2` fallbacks (r3363, r3568). Vervang overige hardcoded fallbacks door DS-tokens; behoud CSS-var-namen (`--wbx-mono` etc.).
2. **`.wbx-table thead/tbody`** — kolom-headers, hover-rijen. Alleen kleur/border, geen `.wbx-cust-cell` layout aanraken (max-width + ellipsis is functioneel).
3. **`.wbx-btn` / `.wbx-icon-btn`** — status-bar buttons (heeft eerder al DS-swaps gehad in T1-fase; verify sluitend).
4. **`.wbx-badge`** — badge-counters (`#wbxNavActiesBadge`).
5. **Body-level scrims** (bulk-bar, bulk-scrim, call-outcome-scrim) — rgba(0,0,0,0.xx) → laat scrim rgba met rust; alleen tekst/borders naar tokens.
6. **Call-log-note / set-picker / set-card / cleanup-card** — bekende DS-safe classes uit eerdere task-lijst #1-#5 (al gefixt, hier alleen verify).
7. **Inline "Fout: X" / "Laden…" strings** in wb-sub-* containers — kleine cosmetische error-tekstjes.

## Wat ABSOLUUT NIET aanraken (reken- + workflow-logica)

**Reken-code / logica**:
- Alle `api/_lib/dunning-engine.js` + stage-logic
- `api/_lib/conv-reminder-stage.js`, `api/_lib/dunning-step-executors.js`
- `api/_lib/incasso-pre-brief-core.js` (brief-PDF generator)
- Alle `api/arrangements-*` (11 files: propose/detail/list/cancel/vat-preview + cron-breach-check)
- Alle `api/dunning-*` (23 files: pipeline-* + brief-* + call-log-* + bulk-* + cron-*)
- Alle `api/joost-*` (14 files: suggest/config/autonomy/outbound/*)
- `api/inbox-*` waar het finance-conversaties raakt

**Handler-flows** in JS:
- Bulk-aanmaan approval-flow (dunning_bulk_jobs / dunning_bulk_recipients)
- Pipeline auto-triggers (`dunning_pipeline_auto` app_settings)
- Joost decision-engine + autonomy-config
- Arrangement approval-cascade (pending_actions TL_* action_types)
- Payment-verify-task flow

**Semantische kleuren van signal-status** — houden zoals ze zijn:
- Pipeline-fase-kleuren (nieuw/aangemaand/in_gesprek/regeling/brief_verstuurd/incasso/afschrijven/opgelost — 8 fases uit `dunning_pipeline_stages` seed)
- Arrangement-type-badges (UITSTEL/SPLITSING/ABONNEMENT_PAUZE/ABONNEMENT_STOP/KWIJTSCHELDING)
- Arrangement-status (VOORGESTELD/ACTIEF/NAGEKOMEN/VERBROKEN/GEANNULEERD)
- Joost-suggestion-status (PROPOSED/USED_*/BLOCKED_*/SENT_AUTONOMOUSLY)
- Call-outcome pill-palette (bevestigd/komt_niet/geen_gehoor/voicemail/terugbellen/foutief_nummer)
- Message-status (verzonden/mislukt/wacht)

Deze zijn semantisch dominant en willekeurige DS-swap kan operator-verwarring geven op geldstromen.

## Aanbevolen aanpak (per PR)

1 zichtbare tab per PR, elk klein en review-baar. Volgorde klein→groot:

| PR | Sub-view | Est. hex-hits | Risico |
|---|---|---|---|
| W1 | `#wb-sub-openacties-nieuw` | ~15 | GEEL — pill-styling actie-status |
| W2 | `#wb-sub-overzicht-nieuw` | ~20 | GROEN — read-only tabel |
| W3 | `#wb-sub-inbox` (Gesprekken) | ~40 | GEEL — grote master-detail, veel status-badges |
| W4 | `#wb-sub-instellingen` (6 sub-tabs) | ~60 | GEEL — Joost-config wizard, autonomy-settings |
| W5 | `.wbx-tabs` + `.wbx-nav` + body-scrims | ~15 | GROEN — nav-styling |
| W6 | Hidden legacy sub-tabs (bulk-cleanup) | ~30 | GEEL — code die nog live is via `?sub=` deeplinks |

**Per PR eisen (identiek aan M/E-cluster ronde):**
- CSS/inline-style-only, geen JS-flow-refactor
- `git diff --stat` toont alleen `modules/finance.html` (of specifieke wbx-*.css indien extract)
- Beschermde zone excl. wanbetalers zelf (klanten.html, andere finance-subviews, api-endpoints) blijft leeg
- Semantische signal-kleuren per hierboven-lijst BEWUST BEHOUDEN
- Node syntax-verify voor commit
- Live-verify: elke gereskinde sub-tab handmatig openen post-deploy

## Voorafgaand: dark-mode audit

`.wbx` heeft eigen `--wbx-*` scoped vars (`--wbx-mono` font, en meer). Voor dark-mode consistency: run `grep -nE '\-\-wbx-' modules/finance.html | head -40` en check of alle `--wbx-*` vars ook een `[data-theme="dark"]` variant hebben. Als niet: eerst een W0-PR die dark-mode-vars uitrolt vóór de kleuren-swaps beginnen.

## Rollback-strategie

- Elke W-PR = 1 squash-commit → revert per PR mogelijk zonder dependencies
- Geen SQL-mutaties, geen endpoint-wijziging → runtime-rollback = code-only
- Bij regressie op Vercel: revert-PR + auto-deploy (~60s)
