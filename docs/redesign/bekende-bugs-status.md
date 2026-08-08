# Bekende bugs — status uit REDESIGN-BOUWPLAN §8

**Bron:** `docs/redesign/REDESIGN-BOUWPLAN.md:211-221` + §6 (regel 186, WA-integratie).

**Recon-uitkomst:** 10 punten uit §8 + 1 aanverwant uit §6. Van deze 11 is er **1 grotendeels afgerond** (#7 intent-consolidatie), rest is nog **open** of **onbekend** (geen fix-commit gevonden in log).

## Overzicht

| # | Punt | Bron | Status | Impact | Fix-scope | Zelf gefixt? |
|---|---|---|---|---|---|---|
| 1 | `dunning-engine.js` schrijft geen `paused_by_conversation_id` bij `paused_customer_replied` | `BOUWPLAN.md:212` + `api/_lib/dunning-engine.js:976-985` | OPEN (bevestigd) | Blocker (resume-branch verwacht FK) | Triviaal (1 regel) | **Nee — beschermde zone** (api/_lib/dunning-engine) |
| 2 | 25 onzichtbare dunning-runs koppelen | `BOUWPLAN.md:213` | Onbekend | Medium (data-integriteit) | Data-migratie (eenmalige SQL) | Nee — data, geen code |
| 3 | Reminder-cirkel: eigen reminder blokkeert volgende | `BOUWPLAN.md:214` + `api/_lib/conv-reminder-stage.js` | Onbekend | Medium (klant hangt) | Gedrag-wijziging (stage-selector-logica) | **Nee — beschermde zone** |
| 4 | Muno WA emoji-reactie als ruwe JSON + emoji-kiezer | `BOUWPLAN.md:215+186` | OPEN (geen `reactions`-render gevonden) | Cosmetisch → medium (UX inbox) | Gedrag-wijziging (webhook parser + inbox-renderer) | **Nee — beschermde zone (inbox)** |
| 5 | E-mailbijlagen backfill | `BOUWPLAN.md:216` + `api/backfill-email-attachments.js` + `docs/sql-migrations/2026-08-04-email-attachments.sql` | Endpoint klaar; run open | Medium | Triviaal (POST + monitor) | Nee — ops-actie, geen code |
| 6 | WA `{{klant.voornaam}}` niet ingevuld in inbox | `BOUWPLAN.md:217+186` + `api/_lib/template-variables.js` + `render-template-preview.js` | Onbekend (helpers bestaan; inbox-pad onduidelijk) | Medium (customer-facing) | Gedrag-behoud (inbox door renderer laten lopen) | **Nee — beschermde zone (finance-inbox)** |
| 7 | Intent-keys consolideren | `BOUWPLAN.md:218` + `api/_lib/joost-suggest-core.js` (canonical) + archived migratie | **GROTENDEELS AFGEROND** (migratie is in `docs/sql-migrations/archived/`) | Cosmetisch | Verify | Nee — verify-only actie (grep-check aanbevolen) |
| 8 | Dubbeltelling "Open acties" vs "Goedkeuringen" in centrale inbox | `BOUWPLAN.md:219` + `api/super-admin-inbox-counts.js` + `index.html:369` | OPEN (geen dedup in counts-endpoint) | Medium (KPI-cijfers) | Gedrag-behoud (count-query filter) | Nee — count-logica raakt approval-workflow |
| 9 | Leadsonderhoud-cron valt stil op onboarding-WA-lijn | `BOUWPLAN.md:220` + `api/cron-leadsonderhoud.js` + `api/_lib/leadsonderhoud-gesprekken.js` | Onbekend | Blocker (cron-halt) | Gedrag-wijziging (line/lock scope) | **Nee — cron + beschermde zone** |
| 10 | Lisa dode tabellen (`lisa_qualification`, `lisa_stats`) | `BOUWPLAN.md:221` + `migrations/003-lisa-tables.sql` | Aanwezig; "dood" niet bevestigd (`api/lisa-conversations.js` refereert Lisa-code) | Cosmetisch | Triviaal (DROP + RLS opschonen) — MITS echt ongebruikt | Nee — schema-cleanup vereist bevestiging dat niets meer schrijft |
| §6 | Bubble-mirror mentor-toewijzing: 2 waarheden `onboardings.mentor_user_id` + Bubble | `BOUWPLAN.md:189` + `api/_lib/bubbleStudentMentors.js` + `api/mentor-bubble-link.js` | Onbekend | Medium | Gedrag-wijziging (source-of-truth beslissing) | Nee — architecture-decision-required |

## Wat ik veilig zelf kan fixen: 0

**Elke** open bug raakt óf de beschermde zone (dunning/joost/inbox/arrangements/cron) óf een gedrag-wijziging (count-dedup, cron-lock, source-of-truth) óf een ops-actie (backfill runnen). Geen enkele valt binnen mijn autonome-run-scope (CSS/DS-tokens/inline error-teksten only).

## Aanbevolen fix-volgorde bij review

**BLOCKERs eerst:**
1. **#1 `paused_by_conversation_id`** — 1-regel fix in `dunning-engine.js`, hoge impact op resume-flow. **Risico:** null-safety op de conv-id-lookup; check `reply.conversationId` bestaat vóór spread.
2. **#9 Leadsonderhoud-cron stil op WA-lijn** — cron-halt betekent leads komen niet door. Recon nodig: waar precies faalt de lock/scope? Log-analyse eerste stap.

**Medium na blockers:**
3. **#3 Reminder-cirkel** — stage-selector debuggen; wellicht test-migratie eerst zodat je reproduceerbare fail-case hebt.
4. **#6 WA `{{klant.voornaam}}` in inbox** — helpers bestaan; inbox-render-pad in kaart brengen dan wire-up.
5. **#4 Emoji-reacties** — Meta-webhook uitbreiden voor `reactions`-events + inbox-renderer aanpassen.
6. **#8 Dubbeltelling counts** — filter-query in `super-admin-inbox-counts.js`.
7. **#2 25 dunning-runs koppelen** — eenmalige SQL na verify (welke 25? welke customers?).

**Cosmetisch / cleanup:**
8. **#5 Backfill runnen** — POST + monitor.
9. **#7 Intent-consolidatie verify** — grep-sweep.
10. **#10 Lisa dode tabellen** — usage-recon eerst, dan DROP.
11. **§6 Mentor-bubble-mirror** — architectuur-beslissing eerst (single-source: DB of Bubble?), dan migreren.

## Waarom deze status vandaag

De autonome-run-scope was strikt CSS/DS/inline-error-teksten. Elke §8-fix raakt óf beschermde-zone-code (dunning/joost/arrangements/inbox/cron) óf gedrag-wijziging (count-filter, source-of-truth). Beide zijn expliciet **uitgesloten** in de opdracht ("NIET zelf mergen wat gedrag/rechten wijzigt of de beschermde zone raakt — dat wordt een plan voor review").

Bij groen licht: de fixes zijn per stuk klein (paar regels code + verify), scope-baar in 1 PR per bug.
