# RBAC Overview — Agency Command Center

## Architectuur

### Lagen (defense in depth)
1. **Frontend gating** — knoppen/tabs verborgen via `window.RBAC.canSync()` (CSS-injectie per module).
2. **Sidebar gating** — modules verborgen in sidebar + page-block bij directe URL (`modules/shared/sidebar.js`).
3. **Backend enforcement** — `requirePermissionFailOpen` op zware/eenduidige endpoints.
4. **RLS** — DB-laag (toekomstig, voor interne CRUD).

### Fail-open filosofie
Bij DB-storingen / token-fouten / geen rollen → **ALLES tonen** (geen lockout). Een 403 valt alleen bij *bewezen-geen-permission*. `super_admin` krijgt altijd de `'*'` wildcard.

## Database schema

### Tabellen (migratie `migrations/002-rbac-foundation.sql`)
- `profiles.role` — legacy *primary* role (string). Wordt nog gelezen door `requireAuth(allowedRoles)`.
- `user_roles (user_id, role)` — N:M, multi-role per user. **Bron van waarheid voor permissions.**
- `role_permissions (role, feature_key, allowed)` — de matrix.

### Functies (PostgreSQL, SECURITY DEFINER)
- `get_user_all_roles(user_uuid) → text[]`
- `user_has_permission(user_uuid, fkey) → boolean` (incl. super_admin-shortcut)
- `has_any_role(required_roles text[])` — legacy compat, defensieve union over `user_roles` + `profiles.role`, met `is_active`-eis
- `is_super_admin()` — RLS-helper (vermijdt policy-recursie)

### Backfill
Migratie 002 kopieert alle bestaande `profiles.role` → `user_roles`. De trigger `handle_new_user()` spiegelt nieuwe signups (profiel + user_roles).

## Frontend API

### `window.RBAC` (`modules/shared/permissions.js`)
- `can(featureKey)` async → `Promise<boolean>`
- `canSync(featureKey)` → `boolean` (na `ensurePermissionsLoaded`)
- `ensurePermissionsLoaded()` → `Promise<Set>`
- `getUserRoles()` → `string[]`
- `resetPermissionsCache()` — na role-wijziging

`loadPermissions()` valt terug op `profiles.role` als `user_roles` (nog) leeg is.

### Pattern in modules
Elke inhoudelijke module heeft onderaan een zelfstandig gating-`<script>` (fail-open) dat na een succesvolle permission-load een `<style>` met `display:none` injecteert voor geweigerde features. CSS-injectie werkt ook op dynamisch gerenderde knoppen. `super_admin` (`'*'`) → niets verborgen.

### Sidebar (`modules/shared/sidebar.js`)
- `applyModuleGating()` — verbergt sidebar-links zonder `<module>.module.access`
- `blockPageAccess()` — page-content blokkering bij directe URL zonder toegang

## Backend API

### Helpers (`api/_lib/requirePermission.js`)
- `requirePermission(req, key)` — harde check (true/false; false bij geen token)
- `requirePermissionFailOpen(req, key)` — fail-open variant (true bij geen token / fout)
- `checkPermissionOrDeny(req, res, key)` — short-circuit met 403

> NB: `checkMultiActionPermission` is **niet geïmplementeerd** (server-side enforcement op gedeelde endpoints is bewust uitgesteld — zie hieronder).

### Welke endpoints enforced
- `send-email` → `email.reply.send` / `email.forward.send` (reply vs forward via `email_id`)
- `email-reclassify` → `email.reclassify.run`
- `reanalyze-all` → `email.heranalyseer.run`

### Bewust NIET enforced (zie comment in `requirePermission.js`)
Interne CRUD-endpoints (`kennisbank-sync`, `taken`, `agent-*`, `follow-up-*`):
- **Inert**: veel calls via raw `fetch` zonder Bearer-token → fail-open doet niets (o.a. follow-up: 13× raw fetch).
- **Ambigu**: gedeelde multi-purpose endpoints koppelen meerdere feature-keys aan één pad (bv. `kennisbank-sync` `upsert_item` = faq.add + material.upload + item.edit) → één-key-check zou legitieme acties met **false-positive 403** blokkeren.
→ Verdediging via frontend-gating + bestaande auth + (toekomstig) RLS.

## Feature keys (~91 totaal)
- `dashboard.module.access`
- `email.*` (24)
- `taken.*` (6)
- `kennisbank.*` (7)
- `agents.*` (9)
- `meetings.*` (11)
- `controlcenter.*` (6)
- `followup.*` (19, incl. sub-pages)
- `admin.*` (8)

Volledige lijst: `FEATURE_REGISTRY` in `modules/admin.html`.

## Rollen

| Rol | Doel |
|-----|------|
| super_admin | Alle rechten (wildcard `'*'`) |
| admin | Legacy alias |
| manager | Quasi-admin, meeste features |
| sales | Email + Follow-up focus |
| mentor | Kennisbank + Email + Vergaderruimte |
| marketing | Beperkte set, marketing-features |
| administratie | Finance + facturen |
| viewer | Default voor nieuwe signups |

(De `role`-CHECK in migratie 002 bevat exact deze 8 waarden.)

## Admin Matrix UI

Locatie: `modules/admin.html` → tab **"Rechten"** (alleen zichtbaar voor super_admin; RLS dwingt schrijven af).

- Module-gefocust: module-sidebar links, feature×rol-matrix rechts
- super_admin-kolom = "auto" (geen checkboxes)
- "Alles aan/uit" per module + per rol-kolom
- Zoekfilter, dirty-tracking + confirm bij tab-leave
- Bulk-upsert naar `role_permissions` (alle cellen, ook `allowed=false`)

## Operationele zaken

### Migratie 002 uitvoeren
Handmatig in Supabase SQL Editor (`migrations/002-rbac-foundation.sql`). Idempotent — herhaalbaar zonder breken.

### Matrix invullen
1. Login als super_admin
2. Admin → tab Rechten
3. Per module: vink per rol aan wat is toegestaan
4. Opslaan (schrijft alle cellen)

### Nieuwe feature toevoegen
1. Voeg `feature_key` toe aan `FEATURE_REGISTRY` (`modules/admin.html`)
2. Gate in module-code via `window.RBAC.canSync('module.feature')`
3. (Optioneel) `requirePermissionFailOpen` op een eenduidig, token-dragend endpoint
4. super_admin opent de matrix → vinkt aan voor relevante rollen

### Permission troubleshooting (Supabase SQL)
```sql
SELECT user_has_permission('user-uuid', 'feature.key');
SELECT * FROM user_roles WHERE user_id = 'user-uuid';
SELECT * FROM role_permissions WHERE feature_key = 'feature.key';
```

### Multi-role
Een user kan meerdere rollen hebben (`user_roles`). Permissions = **UNION** over alle rollen. Toewijzen via de admin-UI (Gebruikers-tab, multi-role chips).

## Wat is NIET gedaan (toekomstig werk)
- Per-tabel RLS-policies (zou interne CRUD echt afdwingen)
- Backend enforcement op gedeelde endpoints (per-action mapping / OR-logica)
- Audit-log van permission-checks
- Role-templates (kopieer rol-instellingen)

## Pad terug bij issues
1. Matrix ongeldig → vul/repareer via Supabase SQL direct
2. Jezelf uitgesloten → super_admin werkt altijd (`'*'`), kan matrix herstellen
3. Matrix wissen → `DELETE FROM role_permissions;` (super_admin blijft werken)
4. Hele systeem terugdraaien → `DROP TABLE user_roles, role_permissions;` → terug naar alleen `profiles.role`
