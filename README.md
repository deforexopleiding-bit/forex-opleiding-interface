# forex-opleiding-interface
Command &amp; Control Center - De Forex Opleiding

## RLS-regels voor nieuwe tabellen

Elke nieuwe tabel in schema `public` krijgt **RLS aan én een policy met een
rolcheck** — `USING (public.is_crm_staff())` voor CRM-data, de student-check
voor LMS-tabellen. **Nooit `USING (true)`**, en "heeft een profiel" of
`auth.uid() IS NOT NULL` telt niet als rolcheck: elke auth-signup krijgt
automatisch een `viewer`-profiel, dus dat is toegang voor elke student.

Volledig recept, de vier gevallen en wat te doen als de check afgaat:
[`docs/rls-regels-nieuwe-tabellen.md`](docs/rls-regels-nieuwe-tabellen.md).

Bewaakt door `docs/sql-migrations/rls-drift-check.sql` (read-only, ook
handmatig te draaien) en de workflow `.github/workflows/rls-drift-check.yml`.
