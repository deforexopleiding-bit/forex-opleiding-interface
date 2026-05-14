# Role Architecture — Agency Command Center

> Bijgewerkt: 2026-05-15 — Conceptueel ontwerp ter voorbereiding op 
> hiërarchische RLS rollout.

## Probleemstelling

Vóór deze architectuur:
- 5 rollen op één niveau (admin/sales/mentor/administratie/viewer)
- Geen onderscheid platform-eigenaar vs operationele managers
- Geen team-relatie tussen users
- Owner-data in tabellen is text (namen) niet uuid
- Gevolg: geen per-user RLS mogelijk

## Doel

Strikte silo's met één bypass:
- super_admin (Amigo) ziet alles van iedereen
- Alle andere rollen zien alleen eigen werk
- Gedeelde bedrijfskennis blijft team-breed

## Rol-hiërarchie

```
super_admin (Amigo)
   └─ ziet alles op platform-niveau
   └─ enige rol die data van andere users kan zien
   └─ beheert users, settings, alle data
   
manager (Jeffrey, Maxim)
   └─ ziet ALLEEN eigen werk
   └─ ziet niet werk van directe ondergeschikten
   └─ ziet niet andere managers' werk
   
sales
   └─ ziet alleen eigen leads, taken, calls
   
mentor
   └─ ziet alleen eigen studenten, taken
   
administratie (intern, niet Rogier)
   └─ financiële + administratieve data (specifieke tabellen)
   
viewer (toekomst)
   └─ alleen lezen, scope per case
```

## Initial assignments

| User | Email | Rol | Manager |
|------|-------|-----|---------|
| Amigo Biemold | deforexopleiding@gmail.com | super_admin | — |
| Jeffrey Biemold | biemoldjeffrey@gmail.com | manager | — |
| Maxim (toekomst) | tbd | manager | — |
| Dave (toekomst) | tbd | sales | tbd |

## Database design

**Keuze: manager_id FK op profiles (Optie A).**

manager_id is metadata voor team-overzicht en user management UI. 
Heeft GEEN RLS-impact (strikte silo's). Schrappen kan altijd later.

```sql
ALTER TABLE profiles 
  DROP CONSTRAINT profiles_role_check;
ALTER TABLE profiles 
  ADD CONSTRAINT profiles_role_check 
  CHECK (role IN ('super_admin','manager','sales','mentor','administratie','viewer'));
  
ALTER TABLE profiles 
  ADD COLUMN manager_id uuid REFERENCES profiles(id);

CREATE INDEX idx_profiles_manager_id ON profiles(manager_id);
```

## Helper functies

```sql
CREATE OR REPLACE FUNCTION public.is_super_admin() 
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles 
    WHERE id = auth.uid() AND role = 'super_admin' AND is_active
  );
$$;

CREATE OR REPLACE FUNCTION public.is_manager_or_above() 
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles 
    WHERE id = auth.uid() 
      AND role IN ('super_admin','manager')
      AND is_active
  );
$$;
```

Geen is_in_my_team functie nodig — strikte silo's hebben dat niet 
nodig.

## Owner-kolommen per tabel

| Tabel | Nieuwe kolom | Backfill |
|-------|--------------|----------|
| taken_items | owner_id, created_by_id | Amigo |
| agent_meetings | owner_id | Amigo |
| agent_conversations | user_id | Amigo |
| email_replies | sent_by_id | Amigo |
| undo_history | performed_by_id | (tabel leeg, geen backfill) |

Tabellen zonder eigen owner-kolom (gebruikt parent of authenticated):
- taken_assignees (via parent taken_items)
- decisions (via parent agent_meetings)
- kennisbank_items, agent_kennisbank, agent_learnings, learn_examples 
  (gedeelde bedrijfskennis)
- email_messages, email_patterns, email_sync_log (mailbox-niveau, niet 
  per-user)
- email_actions (acties zijn team-event log)
- agent_approval_queue, agent_audit_log (admin-only)
- team_members (info-tabel)

## RLS-policy patronen

**Patroon 1 — Eigen + super (strikte silo):**
```sql
USING (
  owner_id = auth.uid()
  OR public.is_super_admin()
);
```

**Patroon 2 — Authenticated (gedeelde kennis):**
```sql
USING (auth.uid() IS NOT NULL);
```

**Patroon 3 — Super admin only:**
```sql
USING (public.is_super_admin());
```

**Patroon 4 — Manager or above:**
```sql
USING (public.is_manager_or_above());
```

**Patroon 5 — Via parent (subquery):**
```sql
-- bv. decisions via agent_meetings
USING (
  EXISTS (
    SELECT 1 FROM agent_meetings 
    WHERE id = decisions.meeting_id 
      AND (owner_id = auth.uid() OR public.is_super_admin())
  )
);
```

## Beleidsmatrix per tabel

| Tabel | Patroon | Read | Write |
|-------|---------|------|-------|
| taken_items | 1 | owner+super | owner+super |
| taken_assignees | 5 | via parent | via parent |
| agent_meetings | 1 | owner+super | owner+super |
| agent_conversations | 1 | user+super | user+super |
| email_replies | 1 | sender+super | sender+super |
| undo_history | 1 | performer+super | performer |
| kennisbank_items | 2 | authenticated | authenticated |
| agent_kennisbank | 2 | authenticated | authenticated |
| agent_learnings | 2 | authenticated | authenticated |
| learn_examples | 2 | authenticated | authenticated |
| email_actions | 2 | authenticated | authenticated |
| team_members | 2/3 | authenticated | super |
| email_messages | 4 | manager+ | service_role |
| email_patterns | 3 | super | super |
| email_sync_log | 3 | super | service_role |
| decisions | 5 | via meeting | super |
| agent_approval_queue | 3 | super | super |
| agent_audit_log | 3 | super | service_role |

## Inbox-toewijzing

Beleid: alle binnenkomende mail blijft team-breed zichtbaar voor 
managers + super_admin (Patroon 4). Geen per-mail owner. Email 
behandeling is platform-niveau, niet per-user.

Verschil met operationele data: taken/meetings/leads die ontstaan 
UIT een mail krijgen wel een eigenaar (de manager die de lead 
oppakt).

## Backfill-strategie

Alle bestaande rijen krijgen owner = Amigo's UUID (super_admin). 
Reden: bestaande text-velden zijn niet betrouwbaar te mappen 
(mix van agent-namen, voornamen, externe uuids). Super_admin 
ziet alles toch via RLS, dus geen functionele impact.

Backfill is reversibel: oude text-kolommen blijven staan tot 
later opruim-commit.

## Frontend impact

Voor elke create-call in nieuwe code:
```js
const userId = await window.AuthShared.getProfile().then(p => p?.id);
body: JSON.stringify({...formdata, owner_id: userId});
```

Helper getCurrentUserId() toevoegen aan agent-shared.js voor 
consistent gebruik.

## Open vragen (parkeren)

1. Dave: onder Jeffrey of onder Maxim? Beslissen wanneer Dave 
   wordt aangemaakt.
2. Mentors-studenten relatie: aparte tabel of velden op profiles? 
   Wanneer mentor toegevoegd wordt.
3. Cross-team escalatie (manager-vervanging bij ziekte): later 
   evalueren of team_memberships migratie nodig is.
4. Agents (Simon/Leon/Aron) eigenaarschap: nu platform-breed 
   gedeeld. Toekomstig: per-team agents?
5. Manager-bewerkbaarheid: kan een manager nieuwe sales/mentor 
   onder zichzelf aanmaken via admin panel? (Nu: alleen 
   super_admin maakt users aan.)

## Implementatie-volgorde

- C1 ✅ Deze document (commit 1)
- C2 → Profiles schema-migratie + helpers + initial assignments
- C3 → Owner-kolommen toevoegen op data-tabellen
- C4 → Backfill bestaande data (alles → Amigo)
- C5 → Backend endpoints + frontend modules bijwerken
- C6 → RLS aanzetten met juiste policies (gefaseerd per categorie)

Tussen elke commit: validatie via Claude in Chrome smoke test.
