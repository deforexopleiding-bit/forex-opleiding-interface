# RLS-regels voor nieuwe tabellen

> Lees dit vóór je een `CREATE TABLE` in `docs/sql-migrations/` schrijft.

## De vaste regel

**Elke nieuwe tabel in schema `public` krijgt RLS aan én een policy met een
rolcheck. Nooit `USING (true)`.**

```sql
ALTER TABLE public.mijn_tabel ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mijn_tabel_staff ON public.mijn_tabel;
CREATE POLICY mijn_tabel_staff
  ON public.mijn_tabel
  FOR ALL
  TO authenticated
  USING      (public.is_crm_staff())
  WITH CHECK (public.is_crm_staff());
```

Dat is het hele recept voor 95% van de CRM-tabellen.

## Waarom dit een harde regel is

Postgres zet RLS **standaard uit** op een nieuwe tabel, en zodra `authenticated`
een `GRANT SELECT` heeft is die tabel via PostgREST voor iedere ingelogde
gebruiker leesbaar. En omdat `handle_new_user()` bij élke auth-signup
automatisch een `profiles`-rij met rol `viewer` aanmaakt, is "iedere ingelogde
gebruiker" ook elke student.

Dat ging in augustus 2026 twee keer mis:

* **ronde 1** — 69 policies die alleen checkten óf er een profiel *bestond*
  (`EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid())`), zonder rolcheck;
* **ronde 2** — 34 tabellen met een kale `USING (true)`, waaronder
  `customer_notes`, `audit_log` en `avg_data_requests`.

Beide keren was de tabel gewoon volgens de toen geldende gewoonte aangemaakt.
Vandaar deze regel, en vandaar de drift-check.

## De vier gevallen

| Situatie | Wat schrijf je |
|---|---|
| **CRM-data** (het normale geval) | `USING (public.is_crm_staff())` |
| **Eigen rij per gebruiker** — iedereen mag alleen zijn eigen record | `USING (public.is_crm_staff() OR gebruiker_id = auth.uid())` |
| **LMS / student-facing** | de student-check van de LMS-kant, nooit `is_crm_staff()`. Houd de tabelnaam onder het `lms_`-prefix: de drift-check en beide hardening-migraties slaan die groep over |
| **Écht publiek** (token-pagina, webhook-insert) | een policy `TO anon` of `TO public`, en zet in de migratie een comment-regel **waarom** het publiek mag |

Twijfel je? **Dicht zetten.** Een te strenge policy geeft een lege lijst en een
bugmelding; een te ruime policy geeft een datalek dat je pas maanden later vindt.

## Wat NIET telt als rolcheck

Deze zien er veilig uit maar zijn het niet — de drift-check markeert ze
allemaal als risico:

```sql
USING (true)                                -- iedereen
USING (auth.uid() IS NOT NULL)              -- "is er iemand ingelogd" = elke student
USING (auth.role() = 'authenticated')       -- idem
USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid()))
                                            -- "heeft een profiel" = elke student
```

Wat wél telt: `is_crm_staff()`, `is_super_admin()`, `has_any_role()`,
`user_has_permission()`, een join op `user_roles`, een check op een
`role`-kolom, of een binding aan de rij (`... = auth.uid()`).

## De drift-check

`docs/sql-migrations/rls-drift-check.sql` is read-only en vindt:

1. tabellen **zonder RLS** waar `authenticated` leesrechten op heeft;
2. policies voor ingelogde gebruikers **zonder rolcheck**.

Daarnaast twee beoordelingslijsten die géén alarm zijn: de bewust publieke
`anon`/`public`-policies, en tabellen met RLS aan maar zonder enkele policy.

Draaien kan op twee manieren:

* **handmatig** — plak het in de Supabase SQL-editor en Run. Het laatste getal
  is het aantal risico-tabellen; 0 is schoon.
* **automatisch** — `.github/workflows/rls-drift-check.yml` draait het dagelijks
  én bij elke PR die `docs/sql-migrations/**.sql` aanraakt, en faalt zodra dat
  getal boven 0 komt. Vereist het repository-secret `SUPABASE_DB_URL`; zolang
  dat niet gezet is slaat de workflow zichzelf netjes over.

## Als de check afgaat

1. Draai `rls-drift-check.sql` en kijk in sectie 1 en 2 welke tabel het is.
2. Hoort die tabel dicht? Voeg een migratie toe met de policy uit het recept
   bovenaan.
3. Hoort die tabel écht publiek te zijn? Maak er een `anon`/`public`-policy van
   met een comment die uitlegt waarom — dan verschijnt 'ie in sectie 3
   (beoordelen) in plaats van sectie 2 (alarm).

## Achtergrond

* `docs/crm-rls-role-check-hardening.md` — ronde 1 en 2, met testplan
* `docs/sql-migrations/2026-08-19-crm-rls-role-check-hardening.sql` — ronde 1
* `docs/sql-migrations/2026-08-20-crm-rls-open-tables-hardening.sql` — ronde 2
* `public.rls_hardening_log` — welke policy in welke ronde is aangepast
