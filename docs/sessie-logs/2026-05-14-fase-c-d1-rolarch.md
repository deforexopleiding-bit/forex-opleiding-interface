# Sessie 2026-05-14 — Fase C + Role-architectuur + RLS + Auth-gate

## Tijdslijn

- **Ochtend:** Fase C admin panel afgerond. Amigo aangemaakt als super_admin. Mini Fase E auth-aware index.html.
- **Vroege middag:** Logo regression fix (handleLogoError → brand-mark div). Fase E rollout naar 6 modules. Pre-D1 refactor createUserClient.
- **Middag:** D1 batch 1 RLS (cron SQL). Endp-1A backend + frontend (9 endpoints + apiFetch wrapper).
- **Late middag:** Schema-onderzoek onthulde: owner-data was text, niet uuid. Beleidsmatrix herwerkt. Role-architectuur ontworpen.
- **Avond:** C1 documentatie. C2 schema-migratie + C2b admin gates. C3 owner-kolommen. C4 backfill 349 rijen. C5 backend schrijft owner_id. C6.1/2/3 RLS rollout. C7 UI auth-gate + race-condition fix.

---

## Commits

| Hash | Beschrijving |
|------|-------------|
| 1cdf138 | Fase C: admin panel met recovery link via Strato SMTP |
| f06a37f | Mini Fase E: renderUserSection + auth-aware index.html |
| c8aa3a3 | Logo regression fix: handleLogoError verwijderd uit alle modules |
| 82cccea | Fase E rollout: auth-aware sidebar naar 6 modules |
| 291a354 | docs: sessie-log 14 mei admin + Fase E |
| f24491f | Pre-D1 refactor: two-client Supabase architectuur |
| bac5bc0 | Endp-1A backend: createUserClient op 9 endpoints |
| 708e8c3 | Endp-1A frontend: apiFetch + 22 call-sites |
| ba57a3f | C1: docs/role-architecture.md |
| a130e04 | C2b: admin gates voor super_admin + manager |
| 93a7243 | C5: backend schrijft owner_id bij CREATE (5 endpoints) |
| 1978f00 | C5 fix: Authorization headers meetings + agents (14 call-sites) |
| bcb821f | C6.2 fix: read-handlers agent-meeting via createUserClient |
| 43d76e6 | docs: tussentijds log C1–C6.2 |
| c409033 | C7: requireAuth() auth-gate op 7 module-pagina's |
| 4d69ebf | C7 fix: await _authSharedReady race-condition fix |

**Via Supabase SQL-dashboard (geen commits):**
- D1 batch 1: backfill_progress + backfill_body_progress RLS
- C2: profiles role_check uitgebreid, manager_id FK + index
- C3: 6 owner-kolommen op 5 tabellen
- C4: backfill 349 rijen → Amigo uuid
- C6.1: kennisbank_items, agent_kennisbank, agent_learnings, learn_examples, email_actions
- C6.2: taken_items, agent_meetings, agent_conversations, email_replies, undo_history
- C6.3: email_patterns, email_sync_log, email_messages, decisions, agent_approval_queue, agent_audit_log, team_members

---

## Belangrijke beslissingen

1. **Strikte silo's** — managers zien geen team-taken/meetings van andere managers. Bewust: privacy + autonomie per lead.
2. **manager_id FK** behouden op profiles voor metadata; geen RLS-impact in huidige fase.
3. **Kennisbank + learnings team-breed** (C6.1 authenticated) — bedrijfskennis is gedeeld.
4. **Email inbox manager+** (C6.3) — team-breed want Jeffrey + Maxim moeten beide leads kunnen zien.
5. **Backfill alle bestaande rijen → Amigo** — super_admin ziet alles; historische data verloren gaan was geen optie.
6. **taken.js Optie A split** (insert/update gescheiden) — owner_id nooit overschreven bij updates.
7. **Legacy text-kolommen behouden** — `created_by`, `performed_by` naast uuid-kolommen; zachte migratie.
8. **Gefaseerde commits** met smoke test tussen elke sub-batch.
9. **UI auth-gate vereist op alle pagina's** — geen anonieme toegang, ook niet tot lege shells.
10. **Race-condition fix** — `await window._authSharedReady` vóór elke `requireAuth()` aanroep.

---

## Lessons learned

Zie AUDIT-VOLLEDIG.md sectie 2026-05-14 voor alle 8 lessen.

**Highlights:**
- Schema-onderzoek vóór SQL voorkomt beleidsmatrix-fouten
- Frontend Bearer is de zwakste schakel in de RLS-keten
- READ-handlers zijn blinde vlek bij INSERT-focus (C5 vs C6.2-bug)
- UI-filters kunnen RLS-correctheid verbergen (taken-filter op colleague.id)
- Gefaseerd uitrollen maakt diagnose simpel
- Async race in init() = silent killer zonder error (TypeError swallowed)

---

## Status na sessie

| Metric | Waarde |
|--------|--------|
| Tabellen RLS-aware | 17 |
| Pagina's auth-gegated | 7 |
| Productie-users | 2 (Amigo super_admin, Jeffrey manager) |
| Commits vandaag | ~16 |
| SQL-migraties | 7 |
| Rollbacks | 0 |
| Downtime | 0 |

**Klaar voor volgende sessie:** Maxim + Dave aanmaken, polish-items 3-9, nieuwe features.
