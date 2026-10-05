# Factuurstand — vier toestanden, één bron (5 oktober 2026)

## Waarom

Gemeten op 5 oktober 2026 bij een klant aan wie nog **geen** factuur verstuurd
was (Manjit Kaur, "Jazz frituur"):

| scherm | toonde | bron |
| --- | --- | --- |
| CRM-onboardingoverzicht, kolom Betaling | "Open" | eigen `status = 'paid'`-vraag |
| LMS, onboardingkaart | "Eerste factuur open" | `hlms_crm_onboarding.eerste_factuur_betaald = false` |
| LMS, studentkaart | "Facturen in orde" | `hlms_crm_factuurstand` met 0 vervallen |

Drie berekeningen, drie antwoorden, alle drie fout. "Niet betaald" werd overal
als "open" gelezen, en "0 vervallen" als "in orde".

## Wat er nu is

Eén telling: `telFactuurstand()` in `api/_lib/factuurstand-spiegel.js`. Per klant:

| veld | betekenis |
| --- | --- |
| `verstuurd_aantal` | facturen met status `open`/`partially_paid`/`overdue`/`paid`, geen testrij, niet volledig gecrediteerd. **Concept telt niet.** |
| `open_aantal` | verstuurd én restbedrag > 0 (ongewijzigd) |
| `vervallen_aantal` | open én vervaldatum voorbij volgens `isOverdue()` van de wanbetalersmotor (ongewijzigd) |
| `openstaand_bedrag` | som van de restbedragen (ongewijzigd) |
| `toestand` | `geen_factuur` · `open_niet_vervallen` · `vervallen` · `in_orde` |

Volgorde van de toestand: vervallen gaat voor alles, dan open, dan "nooit iets
verstuurd", en pas dan in orde. De woorden en de ernst staan in
`factuurToestandWeergave()` — dezelfde woorden als in het LMS
(`src/lib/hlms/factuur-toestand.ts` aan LMS-kant).

Wie leest deze ene telling:

- de LMS-spiegel `hlms_crm_factuurstand` (nachtelijk + na elke factuurwijziging
  + nu ook na elke onboardingspiegel);
- `api/admin-future-students-list.js`, `api/mentor-future-students-self.js`,
  `api/onboarding-detail.js` via `factuurstandPerKlant()` → veld `factuur`;
- de kolom Betaling in `modules/shared/onboarding-overzicht.js`,
  `modules/klanten-v2/views/onboarding-v2.js` en `modules/mentor-onboarding.html`.

`tests/factuurstand-toestand.test.js` wordt rood zodra een van die schermen weer
zelf uit `paid` gaat rekenen. Het veld `paid` blijft bestaan voor oude lezers.

## Wie een rij krijgt in de spiegel

Sinds 5 oktober 2026 ook **studenten zonder LMS-account**. Een student in
onboarding staat in het LMS al bij zijn mentor voor zijn account af is; zonder
rij las het LMS daar "factuurstand onbekend". Membership en afgelopen trajecten
blijven buiten de spiegel.

## Migratie aan LMS-kant

`supabase/hlms_crm_factuurstand_toestand.sql` in `dfo-lms-prototype` voegt de
twee kolommen toe. Zolang die niet gedraaid is, schrijft de spiegel de rij
zonder `verstuurd_aantal`/`toestand` (herkend op PGRST204/42703) en blijft al
het andere werken.

## "Factuurstand onbekend" verklaren (dfo-lms, alleen lezen)

```sql
-- Per mentorship-student met een lopend traject: waarom staat er geen bekende stand?
select
  case
    when f.student_id is null and s.auth_id is null then 'geen rij - nog geen account (tot 5-10 buiten de spiegel)'
    when f.student_id is null then 'geen rij - nog niet gespiegeld'
    when f.bron_status = 'niet_gekoppeld' then 'niet gekoppeld: ' || coalesce(f.bron_fout, '?')
    when f.bron_status = 'onbereikbaar' then 'onbereikbaar: ' || coalesce(f.bron_fout, '?')
    else 'gelezen'
  end as reden,
  count(*) as studenten
from public.hlms_student s
left join public.hlms_crm_factuurstand f on f.student_id = s.id
where lower(coalesce(s.product_soort, '')) = 'mentorship'
  and (s.eind_datum is null or s.eind_datum >= current_date)
group by 1
order by 2 desc;
```
