# Takenbeheer Fase 1 — PLAN (voor review, niet gebouwd)

**Scope:** CC/watchers + afbeelding/video-bijlagen zoals tickets-module. Verplaats "Takenbeheer" in de sidebar-nav naar de groep "Overzicht" onder "Inbox". Autonomie: **GEEL** (interne writes op bestaande endpoints + één nieuwe write-endpoint voor upload). Bewijs-scope tussen ~4-6u effectief werk verdeeld over 3 gestapelde PRs.

---

## Bestaande context (recon-samenvatting)

- Datamodel: `taken_items` (uuid PK, klant/email-koppeling optioneel, status enum `todo|progress|done`, created_by/created_by_agent XOR) + `taken_assignees` (M:N met profile.id). Zie `docs/sql-migrations/2026-05-29-taken-module-fundament.sql`.
- API: `api/taken.js` — één handler met acties `list/create/update/reorder/delete/bulk-upsert/bulk-status`.
- UI: `modules/taken.html` (~1797r) — kanban + lijst-weergaven, dashboard-widgets in andere modules.
- Sidebar-nav: `modules/shared/design-system/app-shell.js` regel 61 heeft Takenbeheer al onder groep 'Overzicht'. Verplaatsing "onder Inbox" is dus alleen een **volgorde-swap** binnen dezelfde groep — niet een cross-group move.
- Referentie voor UX-parity: `modules/tickets.html` + `modules/tickets-detail.html` — hebben al CC/watchers-model + attachments met lightbox voor afbeeldingen.

---

## Voorgestelde PR-opsplitsing (3 stacked PRs)

### PR-T1 — DB-migratie + backend-storage-strategie (ROOD, review verplicht)
- Alleen schema-wijziging + Storage-bucket. Geen UI, geen endpoint-writes.
- Rollback: `DROP TABLE`/`DROP COLUMN` mogelijk zolang PR-T2 nog niet live is.

### PR-T2 — Backend-endpoints (GEEL, self-merge na PR-T1)
- `POST /api/taken-cc-add`, `DELETE /api/taken-cc-remove`, `POST /api/taken-attachment-upload`, `DELETE /api/taken-attachment-remove`.
- Idempotente writes op bestaand `taken_items` + nieuwe `taken_watchers` + `taken_attachments` tabellen.
- Unit-tests + smoke-test op preview.

### PR-T3 — UI-refactor + sidebar-swap (GEEL, self-merge na PR-T2)
- `modules/taken.html`: CC-chips + watchers-lijst + attachment-uploader (drag-and-drop, image/video-preview met lightbox — copy patroon uit `tickets-detail.html`).
- Sidebar-swap: volgorde-swap in `app-shell.js` MODS[]-array (regels 60-61).
- Cache-buster bump.

Reden voor split: migratie is reversibel zolang code er niet op leunt; endpoint-fout in T2 kan gerollbackt zonder T1 raken; UI-only regressie in T3 is meetbaar zonder DB-terug.

---

## Kernkeuzes met aanbeveling

### Keuze 1 — CC/watchers-datamodel

**Opties:**
| Optie | Voor | Tegen |
|---|---|---|
| **A: nieuwe `taken_watchers` M:N-tabel** (parallel aan `taken_assignees`) | Duidelijk gescheiden semantiek (assignee = eigenaar-doet-taak, watcher = ontvangt notif). Aparte RLS-policies mogelijk. Consistent met tickets-patroon. | Extra tabel = extra migratie |
| B: `watcher_ids uuid[]` array-kolom op `taken_items` | 1 kolom, geen JOIN | Geen FK-integriteit, RLS-check zwaarder, geen per-watcher-metadata (bv. subscribed_at, notify_mode) |
| C: hergebruik `taken_assignees` met een `role`-kolom (`assignee`/`watcher`) | Geen nieuwe tabel | Semantische verwarring — een watcher is geen assignee; alle bestaande queries op assignees breken |

**➜ Aanbeveling: A.** Consistent met tickets-module (`tickets_watchers` bestaat al waarschijnlijk — verifieer), makkelijker RLS ("watcher mag lezen maar niet muteren"), toekomst-vast voor notify_mode-uitbreiding.

### Keuze 2 — Attachment-opslag: Supabase Storage vs Vercel Blob

**Opties:**
| Optie | Voor | Tegen |
|---|---|---|
| **A: Supabase Storage** (bucket `taken-attachments`, RLS via policy) | Alles binnen 1 provider — auth-token uit dezelfde session-client bruikbaar. RLS-policies gebruiken zelfde `profile_id` als `taken_items`. Geen extra env-vars. Pro-plan geeft 100GB storage. Downloads via signed URLs met TTL. | Signed URL-generatie moet server-side (via service-role), extra endpoint-hop |
| B: Vercel Blob | Simpele upload-flow via `@vercel/blob` SDK, publieke URLs standaard | Extra env-var + billing dimension, geen native RLS — access-control moet in code, signed-URL alternatief bestaat maar minder handig; publieke default is een privacy-risico als iemand vergeet 'private' te zetten |
| C: R2/S3 direct | Cheapest storage, standaard tooling | Enorme setup-overhead (CORS, access keys, bucket-policies), niet in stack |

**➜ Aanbeveling: A (Supabase Storage).** Blijft binnen de bestaande auth-stack + RLS-mind, geen nieuwe billing-lijn, en de "eerste render = signed URL"-hop is acceptabel voor image/video attachments (browser cachet 1u). Bucket-config: private, 25MB per bestand (voldoende voor screenshots en korte videoclips; bewuste cap), toegestane types: `image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm`.

### Keuze 3 — Uploadpad: rechtstreekse client-upload vs proxy via server

**Opties:**
| Optie | Voor | Tegen |
|---|---|---|
| **A: Client-upload met signed-upload-URL** (server geeft PUT-URL, client uploadt direct naar Storage) | Snel + zonder Vercel-function 60s-timeout-risico bij grote uploads. Geen bandwidth via serverless. | Twee round-trips (server → URL → client → Storage). Client-code iets complexer. |
| B: Proxy via `/api/taken-attachment-upload` (multipart POST → server → Storage) | Simpel API-contract | Vercel serverless heeft 4.5MB body-limit + 60s timeout — video's van 15-20MB gaan falen |

**➜ Aanbeveling: A.** Vermijd Vercel body-limit issues. Server-endpoint `POST /api/taken-attachment-signed-upload { taskId, filename, mimeType, sizeBytes }` valideert (mime whitelist + max 25MB + gebruiker-mag-taak-muteren), maakt Storage-object aan als `taken-attachments/{taskId}/{uuid}-{filename}`, geeft signed-upload-URL (10min TTL) terug + insert `taken_attachments`-rij met `status='uploading'`. Client PUT direct. Client callt `POST /api/taken-attachment-confirm { attachmentId }` na succes — server valideert dat object echt bestaat via Storage-HEAD en flipt status naar `ready`.

### Keuze 4 — Sidebar-swap voor Takenbeheer

`app-shell.js` MODS[] regel 60-61: nu `inbox` → `taken`. User vroeg "verplaatst naar Overzicht onder Inbox" — al **onder Inbox** in de huidige config. **Actie: niets, is al zoals gevraagd.** In T3 wel bevestigen met visuele screenshot.

Als toch swap gewenst is (Takenbeheer *boven* Inbox bv.), is dat een 2-regel-swap in de array — geen wijziging aan andere files.

---

## Concrete schema-migratie (PR-T1)

```sql
-- migratie: 2026-08-08-taken-fase-1-watchers-attachments.sql

BEGIN;

-- 1. Watchers M:N
CREATE TABLE public.taken_watchers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id      uuid NOT NULL REFERENCES public.taken_items(id) ON DELETE CASCADE,
  profile_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  added_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  added_at     timestamptz NOT NULL DEFAULT now(),
  notify_mode  text NOT NULL DEFAULT 'default' CHECK (notify_mode IN ('default','none')),
  UNIQUE (task_id, profile_id)
);
CREATE INDEX taken_watchers_task_idx    ON public.taken_watchers (task_id);
CREATE INDEX taken_watchers_profile_idx ON public.taken_watchers (profile_id);

-- 2. Attachments
CREATE TABLE public.taken_attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       uuid NOT NULL REFERENCES public.taken_items(id) ON DELETE CASCADE,
  uploaded_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  storage_path  text NOT NULL,   -- 'taken-attachments/{taskId}/{uuid}-{filename}'
  mime_type     text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400), -- 25MB
  original_name text NOT NULL,
  status        text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','ready','failed'))
);
CREATE INDEX taken_attachments_task_idx ON public.taken_attachments (task_id);

-- 3. RLS
ALTER TABLE public.taken_watchers    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.taken_attachments ENABLE ROW LEVEL SECURITY;

-- Watcher-policies: read voor iedereen die de taak mag zien; insert/delete
-- voor task-owner + admin. Gebruikt bestaande SECURITY DEFINER helper
-- `public.can_read_taken(task_id, auth.uid())` uit taken-module-fundament.sql.
CREATE POLICY taken_watchers_select ON public.taken_watchers
  FOR SELECT USING (public.can_read_taken(task_id, auth.uid()));
CREATE POLICY taken_watchers_write  ON public.taken_watchers
  FOR ALL USING (public.can_mutate_taken(task_id, auth.uid()))
             WITH CHECK (public.can_mutate_taken(task_id, auth.uid()));

-- Attachment-policies: idem — read voor task-lezers, insert door task-muteerders,
-- delete alleen door uploader zelf of admin.
CREATE POLICY taken_attachments_select ON public.taken_attachments
  FOR SELECT USING (public.can_read_taken(task_id, auth.uid()));
CREATE POLICY taken_attachments_insert ON public.taken_attachments
  FOR INSERT WITH CHECK (public.can_mutate_taken(task_id, auth.uid()));
CREATE POLICY taken_attachments_delete ON public.taken_attachments
  FOR DELETE USING (uploaded_by = auth.uid() OR public.is_admin(auth.uid()));

COMMIT;

-- Handmatig na COMMIT (buiten transactie): Storage-bucket aanmaken via
-- Supabase-dashboard OF via SQL:
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('taken-attachments', 'taken-attachments', false, 26214400,
        ARRAY['image/png','image/jpeg','image/gif','image/webp','video/mp4','video/webm'])
ON CONFLICT (id) DO NOTHING;
```

**Migratie-checklist:**
- Bestaan `can_read_taken` / `can_mutate_taken` / `is_admin` als SECURITY DEFINER-functies? → verifiëren in `taken-module-fundament.sql` en `taken-rls-recursion-fix.sql`; zo niet: eerst toevoegen aan migratie.
- Wat is de huidige `profiles`-tabel-naam? → cross-check dat migration deze correct refereert.
- Storage-bucket-config kan alleen via dashboard of via `storage.buckets` insert — heeft de service-role rechten hierop? → verifiëren voor merge.

---

## Concrete endpoints (PR-T2)

Alle endpoints achter `requirePermission('taken.update')` en RBAC-gate + eigen-taak-check via `can_mutate_taken(task_id, auth.uid())` in SQL.

- `POST /api/taken-cc-add`
  - Body: `{ task_id, profile_id }`
  - Insert in `taken_watchers` (idempotent via UNIQUE-constraint → `ON CONFLICT DO NOTHING`, returns "reeds toegevoegd" of "toegevoegd")
- `DELETE /api/taken-cc-remove?task_id=X&profile_id=Y`
  - Simple DELETE, geen soft-delete
- `POST /api/taken-attachment-signed-upload`
  - Body: `{ task_id, filename, mime_type, size_bytes }`
  - Server: validate + insert `taken_attachments` row (`status='uploading'`) + `storage.from(bucket).createSignedUploadUrl(path, { upsert: false })` → return `{ attachment_id, upload_url, storage_path, expires_at }`
- `POST /api/taken-attachment-confirm`
  - Body: `{ attachment_id }`
  - Server: HEAD Storage-object om te bevestigen upload gelukt → UPDATE status='ready'. Als HEAD faalt → status='failed' + delete-row + return 422.
- `DELETE /api/taken-attachment-remove`
  - Body: `{ attachment_id }`
  - Server: verify uploaded_by=auth.uid() OR admin → Storage `.remove([storage_path])` + DELETE row
- **Uitbreiding op bestaande `api/taken.js`**: `list`-actie moet `watchers` + `attachments` mee-returnen (JOIN of embedded selects `.select('*, watchers:taken_watchers(*), attachments:taken_attachments(*)')`). Backward-compat: bestaande shape blijft; nieuwe velden zijn additief.

---

## UI-wijzigingen (PR-T3)

- **Kanban-kaart + lijst-rij:** CC-chips (avatars kleiner formaat, tot 3 zichtbaar + "+N"-badge), attachment-icoon met count.
- **Detail-modal / drawer:** CC-picker (search + toevoegen via bestaande `profiles-list`-endpoint), watchers-lijst met verwijder-knop per rij, attachment-blok met drag-and-drop-zone.
- **Attachment-viewer:** lightbox voor afbeeldingen (reuse van `modules/shared/tickets-lightbox.js` als die bestaat, anders inline), inline video-player met `<video controls>` voor mp4/webm.
- **Sidebar-swap:** `modules/shared/design-system/app-shell.js` MODS[] — als user Takenbeheer BOVEN Inbox wil, swap regels 60-61. Anders geen wijziging (staat al onder Inbox).

---

## Risico's + mitigaties

| Risico | Kans | Impact | Mitigatie |
|---|---|---|---|
| Storage-bucket ontbreekt bij deploy | M | H | PR-T1 bevat SQL voor `storage.buckets` insert. Deploy-verify: check `SELECT count(*) FROM storage.buckets WHERE id='taken-attachments'`. |
| Storage-quota (100GB Pro) vol raakt | L | M | Cap 25MB/bestand + monitoring via Supabase-dashboard. Toekomst: retention-policy (na X maanden closed-tasks → delete attachments). |
| Signed-upload-URL laat malicious uploads toe binnen 10min | L | L | Mime + size gecheckt server-side vóór URL-uitgifte; upsert=false zodat client geen ander bestand kan overschrijven; storage-path bevat `{uuid}-` prefix zodat guessing niet werkt. |
| `taken_watchers`-tabel-naam botst met bestaande table | L | H | Pre-migration check: `SELECT * FROM information_schema.tables WHERE table_name='taken_watchers'`. |
| RLS-helpers `can_read_taken` / `can_mutate_taken` ontbreken | M | H | Bevestigen in T1 preview; anders eerste stap = helpers definiëren. |

---

## Uit-scope voor Fase 1

- Notif-emails naar watchers (Fase 2)
- File-versioning (attachments zijn immutable — nieuwe upload = nieuwe rij)
- OCR/preview-generatie voor PDFs (out of scope, focus is image/video zoals user vroeg)
- Bulk-CC (toevoegen van meerdere watchers ineens) — bewust laten voor v1

---

## Effort-schatting

| PR | Effort | Blockers |
|---|---|---|
| T1 | 2u (migratie + SQL-review + bucket-config) | Verifiëren RLS-helpers |
| T2 | 3u (5 endpoints + tests) | T1 gemerged |
| T3 | 4-6u (UI-refactor + wiring + smoke-test) | T2 gemerged, tickets-attachment-code als referentie |

**Totaal: ~9-11u effectief.** Gestapelde delivery over 3 sessies is redelijk.
