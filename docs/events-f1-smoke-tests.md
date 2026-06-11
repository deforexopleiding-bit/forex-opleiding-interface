# Events Module F1 — Smoke-tests

Acht scenarios om de F1 foundation te valideren voor merge naar `main`.
Volg ze sequentieel; elke stap heeft een verwachte uitkomst.

Branch: `feat/events-f1-foundation`
SQL migratie: `docs/sql-migrations/2026-06-11-events-f1-foundation.sql`

---

## 1. SQL migratie verificatie

**Doel:** Garanderen dat de 7 tabellen + ENUM + seeds + RLS schoon zijn
aangemaakt in Supabase.

**Stappen:**
1. Open Supabase Dashboard -> SQL Editor.
2. Plak inhoud van `docs/sql-migrations/2026-06-11-events-f1-foundation.sql`.
3. Run query (verwacht: geen errors, alle CREATE/INSERT statements OK).

**Verificatie-queries:**
```sql
-- Niveau-options seed (verwacht: 2 rijen)
SELECT * FROM event_niveau_options ORDER BY display_order;
-- Resultaat: 'basis' + 'gevorderd'

-- Tags catalog seed (verwacht: 6 rijen — 5 system + 1 vip)
SELECT key, label, is_system, color FROM event_tags_catalog ORDER BY key;
-- Resultaat: event-attended / event-no-show / event-cancelled-late /
--            event-cancelled-on-time / event-registered (system) + vip (manual)

-- Tabel-structuur check (verwacht: 7 tabellen aanwezig)
SELECT table_name FROM information_schema.tables
WHERE table_schema='public' AND table_name LIKE 'event%'
ORDER BY table_name;
-- Resultaat: event_attendee_audit_log / event_attendee_tags /
--            event_attendees / event_mentors / event_niveau_options /
--            event_tags_catalog / events

-- Kolommen-check op event_attendees (verwacht: id/event_id/customer_id/
-- email/status/...)
\d event_attendees

-- Indexes verifieer partial unique index op email (FIX 1)
SELECT indexname, indexdef FROM pg_indexes
WHERE tablename='event_attendees';
-- Verwacht: idx_event_attendees_email_unique met WHERE email IS NOT NULL
```

**Pass-criteria:** alle queries returneren verwachte rijen + tabel-structuur,
geen errors.

---

## 2. RBAC keys + permission-matrix

**Doel:** Verifieer dat de 17 nieuwe `events.*` keys in FEATURE_REGISTRY staan
en dat de standaard permission-matrix per rol correct is.

**Stappen:**
1. Login als `super_admin`.
2. Navigeer naar `/modules/admin.html#permissions`.
3. Filter op "events" — verwacht 17 keys:
   - `events.module.access`
   - `events.event.view` / `events.event.create` / `events.event.update` /
     `events.event.delete` / `events.event.archive`
   - `events.attendee.view` / `events.attendee.create` /
     `events.attendee.update` / `events.attendee.delete` /
     `events.attendee.status_change`
   - `events.mentor.assign` / `events.mentor.remove`
   - `events.tag.assign` / `events.tag.remove`
   - `events.audit.view`
   - `events.alternatives.suggest`
4. Verifieer kolom per kolom of de default-checkboxes overeenkomen met
   verwachte matrix:

| Key                              | super_admin | admin | manager | sales | mentor | marketing | administratie |
|----------------------------------|-------------|-------|---------|-------|--------|-----------|---------------|
| events.module.access             | x           | x     | x       | x     | x      | x         | x             |
| events.event.view                | x           | x     | x       | x     | x      | x         | x             |
| events.event.create              | x           | x     | x       | -     | -      | -         | -             |
| events.event.update              | x           | x     | x       | -     | -      | -         | -             |
| events.event.delete              | x           | x     | -       | -     | -      | -         | -             |
| events.event.archive             | x           | x     | x       | -     | -      | -         | -             |
| events.attendee.*                | x           | x     | x       | x     | -      | -         | x             |
| events.mentor.*                  | x           | x     | x       | -     | -      | -         | -             |
| events.tag.*                     | x           | x     | x       | x     | -      | -         | -             |
| events.audit.view                | x           | x     | x       | -     | -      | -         | -             |
| events.alternatives.suggest      | x           | x     | x       | x     | -      | -         | -             |

5. Log uit, login als test-user met rol `sales`.
6. Open `/modules/events.html` — module laadt (heeft `events.module.access`).
7. Klik "Nieuw event" — verwacht: knop is hidden of toast "Geen permissie".
   Server-side: POST `/api/events-create` returnt 403 zonder
   `events.event.create`.

**Pass-criteria:** alle 17 keys zichtbaar, matrix-defaults kloppen,
sales kan event NIET aanmaken (UI + API gate beide actief).

---

## 3. Event CRUD

**Doel:** End-to-end create / read / update / soft-delete flow van events.

**Stappen:**
1. Login als `admin`.
2. Klik sidebar nav-item "Events" -> `/modules/events.html` opent.
3. Klik "Nieuw event" -> events-wizard.html opent met 4 stappen:
   - **Stap 1 — Basis:** titel "Smoke Event Q3", datum +14 dagen,
     niveau "basis", capacity 10.
   - **Stap 2 — Locatie:** type "online", URL (optioneel).
   - **Stap 3 — Mentoren:** kies 1 mentor uit dropdown.
   - **Stap 4 — Review + Publish:** klik "Aanmaken" -> redirect naar
     events-detail.html?id=<uuid>.
4. Verifieer in detail-view:
   - Info-tab toont alle ingevulde velden.
   - Mentoren-tab toont 1 mentor.
   - Aanwezigen-tab leeg.
   - Audit-tab toont 1 entry (event_created).
5. Klik "Bewerken" -> modal met dezelfde velden, wijzig capacity naar 15,
   submit. Verifieer audit-tab toont event_updated.
6. Klik 3-dots -> "Archiveren" -> verifieer soft-delete: event verdwijnt uit
   lijst (filter "Actief"), staat onder filter "Gearchiveerd".

**Pass-criteria:** wizard maakt event aan, detail-view rendert alle data,
edit + archive werken, audit-tab logt alle mutaties.

---

## 4. Attendee status flow + auto-tags

**Doel:** Verifieer attendee state-machine + auto-tag op `no_show`.

**Stappen:**
1. Open event uit stap 3 -> Aanwezigen-tab.
2. Klik "Aanmelder toevoegen" -> selecteer bestaande customer uit dropdown
   -> status default `aangemeld` -> submit.
3. Verifieer: rij verschijnt met badge "aangemeld" + tag `event-registered`
   automatisch toegevoegd.
4. Klik 3-dots op rij -> "Status wijzigen" -> kies `aanwezig` -> submit.
   Verifieer: badge wijzigt naar "aanwezig" + tag `event-attended` erbij.
5. Klik 3-dots -> "Status wijzigen" -> kies `no_show` -> submit.
   Verifieer: badge "niet verschenen" + tag `event-no-show` automatisch
   toegevoegd.
6. Open Audit-tab -> verifieer 3 status-change rijen met
   from/to + timestamp + user.

**SQL-check:**
```sql
SELECT et.tag_key, et.source, et.created_at
FROM event_attendee_tags et
WHERE et.attendee_id = '<uuid>'
ORDER BY et.created_at;
-- Verwacht: event-registered (system) + event-attended (system) +
--           event-no-show (system)
```

**Pass-criteria:** status overgangen werken, auto-tags verschijnen met
`source='system'`, audit-log compleet.

---

## 5. Capacity-guard

**Doel:** Verifieer 409-respons + alternatieven-lijst bij overboeking.

**Stappen:**
1. Maak nieuw event "Capacity Test" capacity=2, status=published, niveau=basis.
2. Voeg attendee 1 toe (status `aangemeld`) -> OK.
3. Voeg attendee 2 toe -> OK. Capacity-pill toont "2 / 2 vol".
4. Voeg attendee 3 toe -> verwacht:
   - HTTP 409 van `/api/events-attendees` (POST).
   - Toast in UI: "Event vol — bekijk alternatieven".
   - Modal opent met resultaat van `/api/events-alternatives?source_event_id=<id>`.
5. Verifieer modal toont alleen events met:
   - `status='published'`
   - `niveau='basis'` (zelfde als source)
   - `current_attendee_count < capacity`
   - `start_at > NOW()`

**Pass-criteria:** 409 + toast + alternatieven met juiste niveau-filter
(FIX 2 in actie).

---

## 6. Mentoren assign/remove

**Doel:** Verifieer mentoren-koppeling alleen `team_members.type='mentor'`
+ PK voorkomt dubbel-add.

**Stappen:**
1. Open events-detail -> Mentoren-tab.
2. Klik "Mentor toevoegen" -> verifieer dropdown toont ALLEEN
   `team_members WHERE type='mentor' AND is_active=true`.
3. Selecteer mentor -> submit. Rij verschijnt.
4. Probeer dezelfde mentor opnieuw toe te voegen -> verwacht:
   - Server returnt 409 (PK violation `event_mentors(event_id, mentor_id)`).
   - UI toont toast "Mentor al gekoppeld".
5. Verwijder mentor via 3-dots -> rij verdwijnt.

**SQL-check:**
```sql
SELECT em.event_id, em.mentor_id, tm.name, tm.type
FROM event_mentors em
JOIN team_members tm ON tm.id = em.mentor_id
WHERE em.event_id = '<uuid>';
-- Verwacht: alleen mentor-type rijen, geen duplicaten
```

**Pass-criteria:** dropdown filtert correct, PK voorkomt duplicaat,
remove werkt.

---

## 7. Tags handmatig (vip)

**Doel:** Verifieer dat alleen `source='manual'` tags via UI te
verwijderen zijn, system-tags niet.

**Stappen:**
1. Open attendee uit stap 4 in detail-modal.
2. Klik kebab "Tag toevoegen" -> selecteer `vip` (alleen non-system
   tag in catalog).
3. Submit -> verifieer rij verschijnt met `source='manual'`.
4. SQL-check:
   ```sql
   SELECT tag_key, source FROM event_attendee_tags
   WHERE attendee_id='<uuid>' ORDER BY created_at;
   -- Verwacht: laatste rij is vip / manual
   ```
5. Klik X op `vip`-tag -> verwijderd OK.
6. Probeer X te klikken op `event-attended` (system) -> verwacht:
   - UI: knop hidden of disabled, of klik geeft toast "System-tag kan
     niet verwijderd worden".
   - Indien wel knop: server `/api/events-tags` DELETE returnt 403
     met error_code `SYSTEM_TAG_NOT_REMOVABLE`.

**Pass-criteria:** vip toevoegen/verwijderen werkt, system-tags blokkeren
remove (UI + server beide).

---

## 8. Alternatieven niveau-precedentie (FIX 2 verificatie)

**Doel:** Verifieer dat `events-alternatives` query-param `niveau` voorrang
heeft op de niveau van het `source_event_id`. App-code resolve, geen
OR-keten in SQL.

**Setup:**
1. Maak event A: titel "Basis A", niveau=basis, status=published,
   capacity=10, start_at +7 dagen, 0 attendees.
2. Maak event B: titel "Gevorderd B", niveau=gevorderd, status=published,
   capacity=10, start_at +7 dagen, 0 attendees.

**Test-cases:**

**8a — source_event_id only (niveau van source):**
```
GET /api/events-alternatives?source_event_id=<A.id>
Authorization: Bearer <admin-token>
```
Verwacht: response.alternatives bevat ALLEEN events met `niveau='basis'`
(dus B verschijnt NIET, want gevorderd).

**8b — expliciet niveau override:**
```
GET /api/events-alternatives?source_event_id=<A.id>&niveau=gevorderd
```
Verwacht: response.alternatives bevat ALLEEN events met `niveau='gevorderd'`
(dus B verschijnt WEL, A niet — query-param wint van source).

**8c — geen filter:**
```
GET /api/events-alternatives
```
Verwacht: response.alternatives bevat events van BEIDE niveaus
(ongefilterd, beide A en B verschijnen).

**8d — ongeldige niveau:**
```
GET /api/events-alternatives?niveau=ongeldig
```
Verwacht: HTTP 400 met error_code `INVALID_NIVEAU`.

**Pass-criteria:** niveau-precedentie volgens spec — query-param > source >
geen-filter. Geen lek tussen niveaus.

---

## Pre-merge checklist

Vink elk item af voordat je squash-merge inroept op `main`.

- [ ] SQL migratie `docs/sql-migrations/2026-06-11-events-f1-foundation.sql`
      gerund in productie-Supabase, alle CREATE/INSERT geslaagd.
- [ ] Vercel preview-build groen (check status-API + UI-deploy).
- [ ] Smoke 1 (SQL verificatie) OK.
- [ ] Smoke 2 (RBAC + matrix) OK.
- [ ] Smoke 3 (event CRUD) OK.
- [ ] Smoke 4 (attendee status + auto-tags) OK.
- [ ] Smoke 5 (capacity-guard + alternatieven) OK.
- [ ] Smoke 6 (mentoren assign/remove) OK.
- [ ] Smoke 7 (tags handmatig + system-protect) OK.
- [ ] Smoke 8 (niveau-precedentie FIX 2) OK.
- [ ] Geen errors in Vercel function-logs van 1-2 testronde-minuten.
- [ ] Audit-log entries zichtbaar in `event_attendee_audit_log` voor alle
      smoke-mutaties.

---

## Merge-instructie (STRICT lesson #148)

KRITIEK: Volg dit pad — geen shortcuts.

1. **Squash-merge alleen bij `{merged: true}` response:**
   ```
   PUT /repos/deforexopleiding-bit/forex-opleiding-interface/pulls/<PR>/merge
   {
     "merge_method": "squash",
     "commit_title": "feat(events): F1 foundation - 7 tabellen + 17 RBAC keys + 14 API endpoints + 3 UI modules (#PR)",
     "commit_message": "<gegenereerde body>"
   }
   ```
   Parse JSON-response. Assert `response.merged === true` EN
   `response.sha` is een 40-char hex. Bij ALLES anders: STOP, log
   response, vraag user-input.

2. **Branch-delete alleen na strict-assertion success:**
   ```
   DELETE /repos/deforexopleiding-bit/forex-opleiding-interface/git/refs/heads/feat/events-f1-foundation
   ```
   Verwacht: HTTP 204. Bij 422 ("Reference does not exist") -> branch
   was al weg, accepteer. Bij andere status: STOP.

3. **Vercel build polling (legacy status API):**
   Na merge: poll `https://api.vercel.com/v6/deployments?projectId=<id>&limit=5`
   tot meest recente deployment `state` == `READY`. Bij `ERROR` of `CANCELED`
   binnen 5 min: STOP, rapporteer logs-URL, geen rollback zonder user-OK.

4. **Lesson #148 anti-pattern (NIET doen):**
   - NIET aannemen dat HTTP 200 == merged.
   - NIET branch deleten voor je `merged:true` in response zag.
   - NIET retry op merge-call bij 5xx zonder body-check (je krijgt soms
     200 OK met `merged:false` + `message: "Pull Request is not mergeable"`).
   - NIET force-pushen op main na merge.

5. **Bij failure:**
   - Mergeable-status check: GET PR -> `mergeable_state`.
     - `blocked` -> CI faalt, fix eerst.
     - `behind` -> rebase nodig, gebruik GitHub UI "Update branch".
     - `dirty` -> conflict, lokale rebase + force-push naar feature-branch.
   - Geen automatic rebase via API zonder user-OK (kan agent-work
     overschrijven).
