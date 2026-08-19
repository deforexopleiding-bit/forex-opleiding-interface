# CRM RLS-hardening — rolcheck afdwingen (2026-08-19)

**Status:** klaar om te draaien, **migratie nog NIET uitgevoerd** (Maxim draait
de SQL zelf op productie).
**Branch:** `claude/crm-rls-role-check-k3dqiq`
**Project:** forex-command-center — Supabase ref `nsjnsvlmdhunzqkdvagm`
**Frontend:** deze repo (`forex-opleiding-interface`)

---

## 1. Het lek

`handle_new_user()` (zie `migrations/002-rbac-foundation.sql`) maakt bij **elk**
nieuw auth-account automatisch een rij in `public.profiles` aan:

```sql
v_role text := COALESCE(NEW.raw_user_meta_data->>'role', 'viewer');
```

Een deel van de RLS-policies in schema `public` controleert vervolgens alléén
of dat profiel **bestaat**:

```sql
USING ( EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid()) )
```

Er zit geen rolcheck in. Gevolg: iedere ingelogde gebruiker met een profiel —
inclusief de ~82 `viewer`-profielen, grotendeels studenten — kan CRM-data zoals
`public.leads` lezen.

Hetzelfde patroon zit ook op de **API-laag**: endpoints die met de
service-role client werken (die RLS ómzeilt) en alleen checken "is er een
geldig JWT?" hebben exact dezelfde zwakte.

---

## 2. De aanpak: wrappen, niet vervangen

De kern is één nieuwe functie:

```sql
public.is_crm_staff()  -- SECURITY DEFINER, STABLE
```

Die geeft `true` als `auth.uid()` een **actief** profiel heeft met een
CRM-medewerkersrol. Het is een **whitelist**: `viewer`, `student` en elke
onbekende/nieuwe rol krijgen `false`. Daarmee is het lek blijvend dicht —
een toekomstige rol komt er niet vanzelf doorheen.

Elke zwakke policy wordt vervolgens **niet herschreven maar gewrapt**:

```sql
ALTER POLICY <naam> ON <tabel>
  USING ( public.is_crm_staff() AND ( <exact de oude expressie> ) );
```

Waarom dit belangrijk is voor eis (c) — "CRM-staff houdt exact dezelfde
toegang": voor staff is `is_crm_staff()` gelijk aan `true`, en
`true AND <oud>` is per definitie `<oud>`. Er is geen policy die voor staff
strenger wordt. De enige gedragsverandering zit bij niet-staff.

Op `public.profiles` en `public.user_roles` is de poort ruimer, zodat elke
gebruiker zijn **eigen** rij blijft lezen (nodig voor login én voor de
rol-guard van het LMS):

```sql
USING ( ( public.is_crm_staff() OR id = auth.uid() ) AND ( <oud> ) )
```

### Rollen in de whitelist

```
super_admin, admin, manager, sales, mentor, administratie, marketing
```

> **Beslissing die je moet bevestigen.** De opdracht noemde CRM-staff als
> *super_admin / sales / mentor*. De whitelist is bewust ruimer: alle 7
> medewerkersrollen uit `VALID_ROLES` (`api/admin-users.js`), dus alles
> behalve `viewer` en `student`. Reden: `manager` en `admin` zijn echte
> CRM-rollen — Jeffrey staat in CLAUDE.md als `manager`, en
> `docs/sql-migrations/2026-07-28-leads-rbac.sql` kent `leads.view/update/
> promote` expliciet toe aan `manager` en `admin`. Een strikte trio-whitelist
> zou die accounts uit het hele CRM zetten, wat eis (c) zou breken.
> Het lek zit in `viewer`/`student`, en die zijn dicht.
>
> Wil je tóch strikt de trio? Pas de rollen-array aan op **drie** plekken —
> ze moeten identiek blijven:
> 1. `public.is_crm_staff()` in de hardening-migratie
> 2. `CRM_STAFF_ROLES` in `modules/shared/crm-guard.js`
> 3. `CRM_STAFF_ROLES` in `api/_lib/crm-roles.js`

---

## 3. Wat er NIET wordt aangeraakt

| Uitgesloten | Waarom |
|---|---|
| `public.lms_students` | Trials-stroom via de website van een collega. Staat volledig los van dit CRM. |
| `public.lms_*` | LMS/student-facing tabellen (`lms_gebruikers`, `lms_toegang`, `lms_producten`, …). Studenten lezen die met hun **eigen** JWT — wrappen met `is_crm_staff()` zou het LMS breken. |
| `public.hlms_*` (incl. `hlms_student`) | Studenten-import. Bewust op de handmatige lijst gezet: eerst bevestigen dat het LMS deze tabel niet met een gebruikers-JWT leest. |
| policies alleen voor `anon` / `service_role` | Niet van toepassing. |
| policies zonder verwijzing naar `auth.uid()`/`profiles` (bv. `USING (true)`) | Daar zitten publieke token-pagina's (event-keuze), webhook-inserts en `role_permissions` tussen. Die staan in de audit-output onder "handmatig beoordelen" — niet automatisch aangepast. |

---

## 4. Volgorde van uitvoeren

1. **Nulmeting** — draai `docs/sql-migrations/2026-08-19-crm-rls-audit-weak-policies.sql`
   (read-only, muteert niets). Bewaar de output van sectie 0 en 1: dat is de
   lijst met zwakke policies vóór de fix.
2. **Hardening** — draai `docs/sql-migrations/2026-08-19-crm-rls-role-check-hardening.sql`.
   Het laatste statement is een restlek-check die **0 rijen** hoort te geven.
   Sectie 4 van datzelfde bestand geeft de complete lijst
   tabel + policy + commando die is aangepast (uit `public.rls_hardening_log`).
3. **Verificatie** — draai het audit-bestand opnieuw. Sectie 1 hoort nu leeg te
   zijn; sectie 2 toont alle gewrapte policies.
4. **Frontend** — deploy van deze branch is voldoende; er is geen extra
   env-var nodig (`LMS_SITE_URL` en `CRM_SITE_URL` zijn optioneel, met de
   juiste defaults).

Alle SQL is idempotent: een tweede run past 0 policies aan
(`DROP POLICY IF EXISTS` / `CREATE POLICY` voor nieuwe objecten, en het
DO-block slaat alles over dat al `is_crm_staff` bevat).

**Rollback:** `docs/sql-migrations/2026-08-19-crm-rls-role-check-rollback.sql`
zet elke policy terug op basis van `public.rls_hardening_log`.

---

## 5. Laag 2 — frontend-guard

RLS beschermt de **data**. `modules/shared/crm-guard.js` beschermt de **UI**,
zodat een student niet eens de Leads-knop ziet.

- Het script staat in `<head>` van alle 59 CRM-pagina's, **vóór** elk ander
  script. Bij het laden verbergt het de pagina synchroon
  (`html{visibility:hidden}`) — tenzij er een verse `staff`-uitspraak in
  `localStorage` staat, zodat staff geen flits ziet.
- `supabase-client.js` velt na de sessie-warmup het oordeel via
  `CrmGuard.applyVerdict(profile, hasSession)`:
  - staff → pagina vrijgeven + uitspraak 12u cachen;
  - geen staff → `location.replace('https://dfo-lms-prototype.vercel.app')`,
    pagina blijft verborgen;
  - geen sessie → vrijgeven, `requireAuth()` stuurt naar `/login.html`.
- **Bewust fail-open bij twijfel**: kan het profiel niet gelezen worden
  (netwerk-glitch, PostgREST 406), dan wordt de pagina vrijgegeven in plaats
  van staff naar het LMS te schoppen. Dat is veilig omdat RLS de
  autoritatieve laag is — deze guard is UX/zichtbaarheid, geen
  beveiligingsgrens.
- `AuthShared.signOut()` wist de cache-uitspraak, zodat de volgende sessie op
  hetzelfde apparaat opnieuw beoordeeld wordt.

Uitgezonderd (geen guard): `/login.html`, `/auth-callback.html`,
`/reset-password.html`, `/modules/event-keuze.html`, `/modules/assessment.html`,
`/modules/onboarding.html` — pre-login flow en publieke token-pagina's.

---

## 6. Laag 3 — invite-redirect naar het LMS

De algemene Supabase **Site URL blijft ongemoeid** (die gebruiken CRM-staff
voor login en wachtwoord-reset). In plaats daarvan geeft de invite-/recovery-
flow nu een expliciete `redirectTo` mee, afhankelijk van de rol:

| Rol | `redirectTo` |
|---|---|
| CRM-staff | `https://forex-opleiding-interface.vercel.app/reset-password.html` |
| viewer / student / onbekend | `https://dfo-lms-prototype.vercel.app` |

Dat LMS-domein staat al in de Supabase Redirect-URL-allowlist.

Aangepast:
- `api/_lib/crm-roles.js` (nieuw) — `CRM_STAFF_ROLES`, `isCrmStaffRole()`,
  `authRedirectUrlForRole()`, `requireCrmStaff()`.
- `api/admin-users.js` — `generateRecoveryLink(email, role)`; zowel bij
  aanmaken als bij "opnieuw versturen". De mailtekst noemt voor niet-staff de
  "leeromgeving" in plaats van het "Agency Command Center".
- `api/admin-generate-link.js` — zoekt de rol van de doelgebruiker op en volgt
  dezelfde regel; profiel onvindbaar → LMS (whitelist, dus de veilige kant).

Env-vars (beide optioneel, defaults zijn de productie-URL's):
`CRM_SITE_URL`, `LMS_SITE_URL`.

---

## 7. Laag 4 — API-endpoints met service-role client

De service-role client omzeilt RLS. Twee endpoints lieten **elk** geldig JWT
door en lazen daarna CRM-data — hetzelfde lek, andere laag:

- `api/follow-up-notities.js` (lezen én schrijven van follow-up-notities)
- `api/follow-up-appointment-history.js`

Beide gebruiken nu `requireCrmStaff(req)` → `403` voor niet-staff.

### Nog open (bewust buiten deze PR)

| Endpoint | Bevinding | Waarom niet hier |
|---|---|---|
| `api/email-body.js` | **Geen enkele auth-check.** POST met `mailbox`+`uid` (of `email_id`) geeft de volledige mailbody terug. | Andere bugklasse (ontbrekende auth, niet ontbrekende rolcheck). `modules/email.html` roept het aan met een kale `fetch()` zónder Bearer-token, dus een gate vereist óók een frontend-wijziging + eigen testronde. |
| `api/mark-read.js` | Idem: geen auth-check, markeert IMAP-mail als gelezen. | Zelfde reden. |

Aanbeveling: PR 2 — Bearer-token toevoegen aan de e-mailmodule-calls
(`apiFetch` i.p.v. `fetch`) en dan `requireCrmStaff` op beide endpoints.

---

## 8. Testplan

### 8.1 SQL-verificatie (zonder in te loggen)

Draai in de Supabase SQL-editor. `set_config('request.jwt.claims', …)` laat je
RLS onder de identiteit van een specifieke gebruiker testen.

```sql
-- 1) Pak een viewer/student en een sales-medewerker
SELECT id, email, role FROM public.profiles WHERE role IN ('viewer','student') LIMIT 3;
SELECT id, email, role FROM public.profiles WHERE role = 'sales'            LIMIT 1;

-- 2) Doe je voor als de VIEWER — hoort 0 rijen te geven
BEGIN;
  SELECT set_config('role', 'authenticated', true);
  SELECT set_config('request.jwt.claims',
    json_build_object('sub', '<VIEWER_UUID>', 'role', 'authenticated')::text, true);
  SELECT public.is_crm_staff();               -- verwacht: false
  SELECT count(*) FROM public.leads;          -- verwacht: 0
  SELECT count(*) FROM public.profiles;       -- verwacht: 1 (alleen eigen rij)
ROLLBACK;

-- 3) Doe je voor als SALES — hoort exact hetzelfde te zijn als vóór de migratie
BEGIN;
  SELECT set_config('role', 'authenticated', true);
  SELECT set_config('request.jwt.claims',
    json_build_object('sub', '<SALES_UUID>', 'role', 'authenticated')::text, true);
  SELECT public.is_crm_staff();               -- verwacht: true
  SELECT count(*) FROM public.leads;          -- verwacht: zelfde aantal als de nulmeting
ROLLBACK;
```

Herhaal stap 3 voor een `super_admin` en een `mentor`.

**Nulmeting vóór de migratie** (draaien als service_role/postgres, dus zonder
RLS) zodat je stap 3 kunt vergelijken:

```sql
SELECT count(*) AS leads_totaal FROM public.leads;
```

### 8.2 Restlek-check

Sectie 5 van de hardening-migratie (en sectie 1 van het audit-bestand) hoort
**0 rijen** te geven. Elke rij die overblijft is een policy die nog steeds
alleen op "profiel bestaat" checkt.

### 8.3 Frontend (browser)

| Stap | Verwacht |
|---|---|
| Log in als **student/viewer** op de CRM-URL | Direct doorgestuurd naar `dfo-lms-prototype.vercel.app`; geen sidebar, geen Leads-knop, geen flits van CRM-UI |
| Log in als **sales** | Sales-dashboard laadt normaal, geen extra vertraging of blanco scherm |
| Idem **mentor** | Mentor-home laadt normaal |
| Idem **super_admin** | Super-admin-dashboard laadt normaal |
| Idem **manager** (Jeffrey) | `/index.html` laadt normaal |
| Als student direct naar `/modules/leads.html` | Doorgestuurd naar het LMS; DevTools → Network toont geen `leads`-rijen |
| Als staff: uitloggen en opnieuw inloggen | Werkt; `localStorage.dfo_crm_staff_verdict` wordt gewist bij signOut |

### 8.4 API-laag

```bash
# Met een JWT van een viewer/student → verwacht 403
curl -s -H "Authorization: Bearer <VIEWER_JWT>" \
  "https://forex-opleiding-interface.vercel.app/api/follow-up-notities?appointment_id=<ID>"

# Met een JWT van sales → verwacht 200 + notities
curl -s -H "Authorization: Bearer <SALES_JWT>" \
  "https://forex-opleiding-interface.vercel.app/api/follow-up-notities?appointment_id=<ID>"
```

### 8.5 Invite-redirect

1. Maak via `/modules/admin.html` een testgebruiker met rol `viewer` →
   controleer in de mail dat de `redirect_to`-parameter in de action-link naar
   `dfo-lms-prototype.vercel.app` wijst.
2. Maak een testgebruiker met rol `sales` → `redirect_to` wijst naar
   `forex-opleiding-interface.vercel.app/reset-password.html`.
3. `POST /api/admin-generate-link` met het e-mailadres van een bestaande
   student → link bevat het LMS-domein.

---

## 9. Wat er al is geverifieerd (lokaal, PostgreSQL 16)

De SQL is niet alleen geschreven maar ook **gedraaid** — op een lokale
PostgreSQL 16 met een fixture die de productie-situatie nabootst: schema `auth`
met `auth.uid()`, `profiles` / `user_roles` / `role_permissions`, CRM-tabellen
(`leads`, `customers`, `taken_items`, `kennisbank_artikelen`), LMS/trials-
tabellen (`lms_students`, `lms_gebruikers`, `hlms_student`), een publieke
anon-tabel, en 5 gebruikers (viewer, sales, mentor, super_admin, manager).

Policies in de fixture: het zwakke `EXISTS (SELECT 1 FROM profiles …)`-patroon
op SELECT/INSERT/ALL, een `auth.uid() IS NOT NULL`-variant, eigen-rij-policies
op `profiles`/`user_roles`, een policy die al wél een rolcheck heeft, een
`USING (true)`-policy en een anon-only policy.

**Rijen zichtbaar per rol, vóór → na de hardening:**

| Rol | leads | customers | taken | profiles | lms_students | hlms_student |
|---|---|---|---|---|---|---|
| viewer / student | 5 → **0** | 3 → **0** | 4 → **0** | 5 → **1** (eigen rij) | 1 → 1 | 1 → 1 |
| sales | 5 → **5** | 3 → **3** | 4 → **4** | 5 → 5 | 1 → 1 | 1 → 1 |
| mentor | 5 → **5** | 3 → **3** | 4 → **4** | 5 → 5 | 1 → 1 | 1 → 1 |
| super_admin | 5 → **5** | 3 → **3** | 4 → **4** | 5 → 5 | 1 → 1 | 1 → 1 |
| manager | 5 → **5** | 3 → **3** | 4 → **4** | 5 → 5 | 1 → 1 | 1 → 1 |

Voor alle vier de staff-rollen is **elk** getal identiek voor en na — dat is
eis (c). Voor de viewer valt elke CRM-tabel dicht, met precies één uitzondering:
zijn eigen `profiles`-rij (nodig om te kunnen inloggen en voor de rol-guard van
het LMS). `lms_students` en `hlms_student` zijn onaangeroerd, zoals gevraagd.

Verder getest:

- **Schrijven** — viewer krijgt `new row violates row-level security policy` op
  `leads` én `customers`; sales' INSERT slaagt gewoon.
- **Gedeactiveerd account** — een `sales`-profiel met `is_active = false`
  valt terug naar 0 rijen. *Let op: dit is een bewuste verscherping.* De oude
  zwakke policies keken niet naar `is_active`, dus een gedeactiveerde
  medewerker kon nog steeds lezen; `is_crm_staff()` eist een actief profiel —
  net als `requireAuth()` in de frontend al deed.
- **Idempotentie** — de hardening een tweede keer draaien meldt
  `0 policies gehard`; `rls_hardening_log` blijft op 7 regels staan.
- **Uitsluitingen** — na de run rapporteert de audit nog precies 3 "zwakke"
  policies: `lms_students`, `lms_gebruikers` en `hlms_student`, allemaal
  gelabeld *"NEE — LMS/student-facing, handmatig beoordelen"*.
- **Rollback** — het rollback-bestand zet alle 7 policies terug; daarna bevat
  geen enkele policy nog `is_crm_staff` en zien viewer en sales weer exact
  dezelfde aantallen als in de nulmeting.

Wat hiermee **niet** getest is (dat kan alleen op de echte database): de
werkelijke ~341 policies. De fixture bewijst dat de mechaniek klopt; de
audit-output op productie bewijst dat er niets overblijft.

De Node-testsuite van de repo draait onveranderd: 887 pass / 20 fail, exact
dezelfde 20 als op `main` vóór deze branch.

---

## 10. Bestanden in deze PR

| Bestand | Wat |
|---|---|
| `docs/sql-migrations/2026-08-19-crm-rls-audit-weak-policies.sql` | Read-only audit van alle policies in schema `public`, in 5 secties |
| `docs/sql-migrations/2026-08-19-crm-rls-role-check-hardening.sql` | `is_crm_staff()` + `rls_hardening_log` + rewrite van alle zwakke policies |
| `docs/sql-migrations/2026-08-19-crm-rls-role-check-rollback.sql` | Rollback op basis van `rls_hardening_log` |
| `modules/shared/crm-guard.js` | Frontend-guard (nieuw) |
| `modules/shared/supabase-client.js` | Roept de guard aan na de sessie-warmup; `signOut()` wist de cache |
| 59 × `*.html` | `<script src="/modules/shared/crm-guard.js">` in `<head>` |
| `api/_lib/crm-roles.js` | Gedeelde rollen-whitelist, redirect-regel en `requireCrmStaff()` (nieuw) |
| `api/admin-users.js`, `api/admin-generate-link.js` | Rol-afhankelijke `redirectTo` |
| `api/follow-up-notities.js`, `api/follow-up-appointment-history.js` | `requireCrmStaff()` i.p.v. "geldig JWT" |
