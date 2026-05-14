# Sessie-log 2026-05-14 — Rol-architectuur + Endp-1A + C5 owner_id + C6.2 RLS prep

**Datum:** 2026-05-14  
**Commits:** f24491f · bac5bc0 · 708e8c3 · ba57a3f · a130e04 · 93a7243 · 1978f00 · bcb821f  
**Totaal wijzigingen:** 8 commits, 15+ bestanden

---

## Overzicht

Volledige dag gericht op de D1-voorbereiding van het RLS-systeem: twee-client Supabase architectuur
uitgerold, Bearer-headers ingevoerd op 9 browser-endpoints, rol-hiërarchie gedocumenteerd en
geïmplementeerd in de admin-gates, en `owner_id` geschreven bij CREATE op 5 tabellen.
Daarna twee post-C5 bugfixes: Authorization headers op meetings + agents modules, en READ-handlers
in agent-meeting.js omgezet naar per-request user client na eerste C6.2 RLS go-live.

---

## Tijdlijn

### Pre-D1 Two-client refactor (commit f24491f)

**Doel:** Supabase-architectuur splitsen voor veiligheid en RLS-gereedheid.

**Wijzigingen:**
- `api/supabase.js`: `createUserClient(req)` helper toegevoegd
  - Leest `Authorization: Bearer <token>` uit request-headers
  - Maakt per-request Supabase client met JWT; RLS `auth.uid()` evalueert correct
  - Fallback naar anon client als geen Bearer aanwezig
- `supabaseAdmin` (service_role) expliciet gescheiden van user-facing client
- `verifyAdmin()` en `logAudit()` als gedeelde helpers beschikbaar

**Beslissing:** Fallback naar anon client (i.p.v. error) voor backward compat — bestaande
endpoints breken niet zolang RLS nog niet actief is.

---

### Endp-1A — 9 browser-endpoints upgraden (commits bac5bc0 + 708e8c3)

**Doel:** Alle browser-triggered endpoints JWT-aware maken vóór D2 RLS go-live.

**Backend (bac5bc0):**
- Patroon: `import { createUserClient }` + `const supabase = createUserClient(req)` bovenaan handler
- Bestanden: email-actions.js, email-patterns.js, sent-replies.js, taken.js, undo.js,
  generate-reply.js, learn.js, send-email.js, kennisbank-sync.js
- Alias `const supabase = createUserClient(req)` — alle bestaande `.from()` calls ongewijzigd

**Frontend (708e8c3):**
- `agent-shared.js`: `apiFetch(url, options)` wrapper toegevoegd + geëxporteerd
  - Haalt token op via `window.AuthShared?.getAccessToken?.()` (graceful als niet beschikbaar)
  - Injecteert `Authorization: Bearer <token>` header automatisch
- `modules/email.html`: 9 aanroepen omgezet naar `apiFetch`
- `modules/kennisbank.html`: kennisbank-sync aanroepen omgezet
- `modules/taken.html`: taken-endpoint aanroepen omgezet
- `modules/agents.html`: agent-chat aanroepen omgezet

---

### C1 — Rol-architectuur document (commit ba57a3f)

**Doel:** Hiërarchische rol-architectuur vastleggen als referentie voor C2–C6 implementatie.

**Output:** `docs/role-architecture.md` (nieuw bestand)

**Inhoud:**
- Rol-hiërarchie: super_admin → manager → admin → sales/mentor/administratie/viewer
- Initiële toewijzingen: Amigo = super_admin, Jeffrey = manager
- DB-design: `profiles.role` enum, `owner_id uuid` kolommen op 5 tabellen
- SQL-helper functies: `is_super_admin()`, `is_admin_or_above()`, `is_manager_or_above()`
- 5 RLS-policy patronen gedocumenteerd:
  1. Owner + super_admin (eigen rows + super ziet alles)
  2. Authenticated all (iedereen ingelogd ziet en schrijft)
  3. Super admin only
  4. Manager+ (manager + admin + super)
  5. Via parent FK (child inherits owner van parent)
- Beleidsmatrix: 21 tabellen × 3 operaties (SELECT, INSERT, UPDATE/DELETE)
- Backfill-strategie: Amigo UUID als tijdelijke owner voor historische rows
- Implementatievolgorde C1–C6 vastgelegd

---

### C2b — Admin gates uitbreiden (commit a130e04)

**Doel:** Admin panel toegankelijk maken voor super_admin en manager, niet alleen legacy admin.

**Aanleiding:** Na C1 zijn Amigo (super_admin) en Jeffrey (manager) de primaire gebruikers.
Beide werden geblokkeerd door `profile.role !== 'admin'` check.

**Verificatie voor implementatie:** `requireAuth` in supabase-client.js regel 84 gebruikt al
`.includes()` — array-signature was al ondersteund. Geen breaking change.

**Wijzigingen:**

`api/supabase.js`:
```js
const ADMIN_ROLES = ['super_admin', 'admin', 'manager'];
// verifyAdmin: profile.role !== 'admin' → !ADMIN_ROLES.includes(profile.role)
```

`api/admin-users.js`:
- `VALID_ROLES`: uitgebreid met `'super_admin'` en `'manager'`
- POST + PATCH: guard toegevoegd — alleen super_admin mag super_admin-rol toekennen:
  ```js
  if (role === 'super_admin' && admin.profile.role !== 'super_admin') return res.status(403)...
  ```

`modules/admin.html`:
- `requireAuth(['admin'])` → `requireAuth(['admin','super_admin','manager'])`
- Na requireAuth: super_admin optie verwijderd uit dropdown voor niet-super_admin users
- Static dropdown: super_admin + manager opties toegevoegd
- Inline role-selector: `[...(currentProfile?.role === 'super_admin' ? ['super_admin'] : []), 'manager','admin',...]`
- CSS: `.role-badge.super_admin` (paars) + `.role-badge.manager` (cyaan) toegevoegd

**Testmatrix:**

| Scenario | Resultaat |
|----------|-----------|
| Jeffrey (manager) → admin panel | ✅ Toegang |
| Amigo (super_admin) → admin panel | ✅ Toegang |
| sales-user → admin panel | ❌ Redirect |
| Jeffrey maakt user met rol super_admin | ❌ 403 |
| Amigo maakt user met rol super_admin | ✅ OK |

---

### C5 — Backend schrijft owner_id bij CREATE (commit 93a7243)

**Doel:** 5 tabellen met owner-kolommen vullen met `auth.uid()` bij CREATE, ter voorbereiding op C6 RLS.

**Patronen:**

**Patroon A (dual import):** `import { supabase, createUserClient }`
- `agent-meeting.js`: module-level `supabase` voor niet-RLS tabellen (agents); `createUserClient(req)` lokaal in `action === 'start'` voor `agent_meetings` insert
- `agent-chat.js`: `createUserClient(req)` + `auth.getUser()` vóór `agent_conversations` insert

**Patroon B (existing `createUserClient`):** `auth.getUser()` toevoegen in relevante branch
- `taken.js`: Optie A split
  - Existence-check via `.select('id').in('id', ids)`
  - `newRows` → `.insert({..., owner_id: userId, created_by_id: userId})`
  - `updateRows` → `.upsert({...})` zonder owner-velden
  - Single task: `.maybeSingle()` check → insert met owner; race-condition (code 23505) fallback
- `send-email.js`: `sentAt` al aanwezig → `auth.getUser()` daarna → `sent_by_id: userId` in insertPayload
- `undo.js`: in `action === 'save'` → `auth.getUser()` → `performed_by_id: userId`

**Backward compat:** `userId` null als geen sessie → owner-veld NULL in DB. Alleen super_admin ziet
NULL-rows na C6 RLS. Legacy text-kolommen (`created_by`, `performed_by`) behouden.

---

### C5 fix — Authorization headers meetings + agents (commit 1978f00)

**Symptoom:** Na C5 deploy: `owner_id = NULL` voor alle nieuwe agent_meetings.

**Root cause:** `meetings.html` viel buiten de endp-1A scope (die scope was expliciet begrensd tot
9 endpoints). De module stuurde geen `Authorization: Bearer` header → `createUserClient(req)`
fallback naar anon client → `auth.uid()` = NULL → `owner_id: null`.

**Fix:**
- `modules/meetings.html`: alle 12 `fetch(`-aanroepen naar `/api/agent-meeting` → `AgentShared.apiFetch(`
  - 4 GET-calls + 8 POST-calls
- `modules/agents.html`: 2 `fetch(`-aanroepen naar `/api/agent-chat` → `AgentShared.apiFetch(`
- Beide modules hadden al een `<script src="/modules/shared/agent-shared.js">` tag ✅

**Les:** Scope-grenzen in een plan zijn geen garantie dat alle callers gefixed zijn. Na elke
Bearer-upgrade: grep alle `fetch(` op de betreffende URL en vervang door `apiFetch`.

---

### C6.2 fix — READ-handlers agent-meeting (commit bcb821f)

**Symptoom:** Na C6.2 RLS go-live (owner+super policies op agent_meetings): `get_history` voor Jeffrey
retourneerde leeg array. Jeffrey heeft 1 meeting; verwacht 1 resultaat.

**Root cause:** Dual-import patroon had een blinde vlek. In C5 werd alleen de `action === 'start'`
INSERT-branch gefixed. De 5 overige GET-branches (`get_history`, `get_meeting_tasks`, `get_decisions`,
`preview_tasks`, generieke GET) gebruikten nog steeds de module-scope anon `supabase`.
Na RLS go-live: anon client heeft geen auth.uid() → RLS filtert alle rows weg → lege array.

**Fix — 6 branches omgezet naar `userClient`:**
1. GET-branch entry: `const userClient = createUserClient(req)` toegevoegd
2. `get_history`: `let q = supabase` → `let q = userClient`
3. `get_meeting_tasks`: `agent_meetings` + `taken_items` reads → `userClient`
4. `get_decisions`: decisions read → `userClient`
5. `preview_tasks` block: `const userClient = createUserClient(req)` + beide reads → `userClient`
6. Agents-lees (regels 269, 332): bewust op `supabase` gelaten (agents heeft geen RLS)

**Smoke test resultaten:**
- TEST C-1: Jeffrey ziet 1 meeting ✅ (niet Amigo's 29)
- Tests C-2 t/m G: niet afgerond (Chrome extension disconnected)

---

## Openstaand na deze sessie

| Item | Status | Actie |
|------|--------|-------|
| C6.2 smoke test C-2 t/m G | ⏳ Onvolledig | Chrome extension herstarten + hertest |
| C6.1 rollout (5 auth-all tabellen) | ⏳ Niet gestart | Na C6.2 smoke test groen |
| C6.3 rollout (7 admin/super tabellen) | ⏳ Niet gestart | Na C6.1 + C6.2 validated |
| E2 Admin-link voor ADMIN_ROLES | ⏳ Niet gestart | `includes()` check in renderUserSection |
| E3 Maxim + Dave aanmaken | ⏳ Niet gestart | Jeffrey via admin panel |
| endp-2 opschoning | ⏳ Gepland | One-time endpoints verwijderen |
| D2 RLS rollout | ⏳ Gepland | Na C6 volledig + team-accounts actief |

---

## Commits samenvatting

| Hash | Message | Bestanden |
|------|---------|-----------|
| f24491f | refactor: two-client Supabase architecture + shared auth helpers | api/supabase.js |
| bac5bc0 | refactor(endp-1a): user-aware Supabase client for browser endpoints | 9 api/*.js |
| 708e8c3 | feat(endp-1a): send Authorization header from browser modules | agent-shared.js + 4 modules |
| ba57a3f | docs: add role architecture proposal for hierarchical RLS | docs/role-architecture.md |
| a130e04 | fix(c2b): support super_admin + manager in admin gates | supabase.js + admin-users.js + admin.html |
| 93a7243 | feat(c5): backend writes owner_id on create for 5 RLS-target tables | 5 api/*.js |
| 1978f00 | fix(c5): add Authorization header to meeting + chat endpoints | meetings.html + agents.html |
| bcb821f | fix(c6.2): read-handlers in agent-meeting use createUserClient for RLS | agent-meeting.js |
