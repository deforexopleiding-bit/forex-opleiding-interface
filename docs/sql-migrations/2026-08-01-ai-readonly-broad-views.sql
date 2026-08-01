-- ============================================================================
-- 2026-08-01-ai-readonly-broad-views.sql — AI Manager PR-B
-- ============================================================================
--
-- Vereist: PR-A al gedraaid (ai_readonly rol + schema + basis-views bestaan).
--
-- Voegt 14 nieuwe views toe aan ai_readonly, gegroepeerd per bedrijfsmodule:
--
--   Klanten & facturen (3):
--     v_klanten_overzicht, v_facturen_status_per_klant, v_openstaand_per_klant
--   Deals & omzet (3):
--     v_deals_per_status, v_deals_per_klant, v_verkoop_per_producttype
--   Leads & sales (3):
--     v_leads_per_status, v_leads_conversie, v_sales_pijplijn_open
--   Events (2):
--     v_events_historie, v_events_belstatus_per_event
--   Mentoren (3):
--     v_studenten_per_mentor, v_mentor_belasting_periode, v_klanten_met_mentor
--   Taken & tickets (2):
--     v_taken_open_per_persoon, v_tickets_open_per_module
--
-- Veiligheids-principes (identiek aan PR-A):
--   * Namen (super_admin OK).
--   * Nooit: email/telefoon/adres/IBAN/tokens/BSN/vrije-tekst/message-bodies.
--   * is_test-attendees + geanonimiseerde klanten uitgesloten.
--   * COMMENT ON VIEW per view (later gebruikt door v_schema_help).
-- ============================================================================


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. KLANTEN & FACTUREN
-- ═══════════════════════════════════════════════════════════════════════════

-- 1a. Klanten-overzicht: profiel + factuur-aggregaten per klant
CREATE OR REPLACE VIEW ai_readonly.v_klanten_overzicht AS
SELECT
  c.id                                                                           AS customer_id,
  TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))           AS klant_naam,
  c.is_company,
  c.created_at                                                                   AS klant_sinds,
  COUNT(i.id)                                                                    AS aantal_facturen_totaal,
  COUNT(i.id) FILTER (WHERE i.status IN ('open','partially_paid','overdue'))     AS aantal_facturen_open,
  COALESCE(SUM(
    GREATEST(0::numeric,
             COALESCE(i.amount_total, 0) - COALESCE(i.amount_paid, 0) - COALESCE(i.credited_amount, 0))
  ) FILTER (WHERE i.status IN ('open','partially_paid','overdue')), 0)           AS totaal_open_bedrag,
  MAX(i.issue_date)                                                              AS laatste_factuur_op
FROM public.customers c
LEFT JOIN public.invoices i ON i.customer_id = c.id
WHERE c.anonymized_at IS NULL
GROUP BY c.id, c.first_name, c.last_name, c.is_company, c.created_at;

COMMENT ON VIEW ai_readonly.v_klanten_overzicht IS
  'Klantprofiel + factuur-aggregaten per klant. Kolommen: customer_id, klant_naam, is_company, klant_sinds, aantal_facturen_totaal, aantal_facturen_open, totaal_open_bedrag (EUR), laatste_factuur_op. Excl. geanonimiseerde klanten.';


-- 1b. Facturen-status per klant (individueel, geen betaal/pdf-links)
CREATE OR REPLACE VIEW ai_readonly.v_facturen_status_per_klant AS
SELECT
  i.customer_id,
  TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))         AS klant_naam,
  i.id                                                                         AS invoice_id,
  i.invoice_number,
  i.issue_date,
  i.due_date,
  i.status,
  i.amount_total,
  i.amount_paid,
  i.credited_amount,
  GREATEST(0::numeric,
           COALESCE(i.amount_total, 0) - COALESCE(i.amount_paid, 0) - COALESCE(i.credited_amount, 0))  AS amount_open,
  CASE
    WHEN i.status IN ('open','partially_paid','overdue') AND i.due_date < CURRENT_DATE
      THEN (CURRENT_DATE - i.due_date)
    ELSE 0
  END                                                                          AS days_overdue
FROM public.invoices i
JOIN public.customers c ON c.id = i.customer_id
WHERE c.anonymized_at IS NULL;

COMMENT ON VIEW ai_readonly.v_facturen_status_per_klant IS
  'Facturen per klant: nummer, datums, status, bedragen, open_amount (berekend), days_overdue. Alle statuses (open/paid/credited/etc). Geen payment_url/pdf_url/tl_payment_link. Excl. geanonimiseerde klanten.';


-- 1c. Openstaand per klant (ook niet-wanbetalers)
CREATE OR REPLACE VIEW ai_readonly.v_openstaand_per_klant AS
SELECT
  i.customer_id,
  TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))         AS klant_naam,
  COUNT(i.id)                                                                  AS aantal_open_facturen,
  COALESCE(SUM(GREATEST(0::numeric,
           COALESCE(i.amount_total, 0) - COALESCE(i.amount_paid, 0) - COALESCE(i.credited_amount, 0))), 0) AS totaal_open_bedrag,
  MIN(i.due_date)                                                              AS oudste_vervaldatum,
  GREATEST(0, COALESCE(CURRENT_DATE - MIN(i.due_date), 0))                     AS dagen_te_laat_max
FROM public.invoices i
JOIN public.customers c ON c.id = i.customer_id
WHERE c.anonymized_at IS NULL
  AND i.status IN ('open','partially_paid','overdue')
GROUP BY i.customer_id, c.first_name, c.last_name
HAVING COUNT(i.id) > 0;

COMMENT ON VIEW ai_readonly.v_openstaand_per_klant IS
  'Openstaand per klant — alle klanten met open/partially_paid/overdue facturen (breder dan v_wanbetalers_actief die pipeline-only is). Kolommen: customer_id, klant_naam, aantal_open_facturen, totaal_open_bedrag, oudste_vervaldatum, dagen_te_laat_max.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. DEALS & OMZET
-- ═══════════════════════════════════════════════════════════════════════════

-- 2a. Deals per status (portfolio-snapshot)
CREATE OR REPLACE VIEW ai_readonly.v_deals_per_status AS
SELECT
  d.status,
  COUNT(*)                              AS aantal_deals,
  COALESCE(SUM(d.total_amount), 0)     AS totaal_bedrag_excl_btw,
  COALESCE(AVG(d.total_amount), 0)     AS gem_bedrag_excl_btw
FROM public.deals d
WHERE (d.source IS NULL OR d.source <> 'tl_import')
GROUP BY d.status
ORDER BY aantal_deals DESC;

COMMENT ON VIEW ai_readonly.v_deals_per_status IS
  'Deals-portfolio-snapshot per status (active/paused/completed/delinquent/disputed/deceased). Sluit ghost-deals (tl_import) uit. EXCL BTW.';


-- 2b. Deals per klant (aantal + waarde)
CREATE OR REPLACE VIEW ai_readonly.v_deals_per_klant AS
SELECT
  d.customer_id,
  TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))  AS klant_naam,
  COUNT(*)                                                              AS aantal_deals,
  COALESCE(SUM(d.total_amount), 0)                                      AS totaal_deal_waarde_excl_btw,
  MIN(d.start_date)                                                     AS eerste_deal_op,
  MAX(d.start_date)                                                     AS laatste_deal_op,
  (SELECT status FROM public.deals d2 WHERE d2.customer_id = d.customer_id
    AND (d2.source IS NULL OR d2.source <> 'tl_import')
    ORDER BY d2.start_date DESC NULLS LAST, d2.created_at DESC LIMIT 1)  AS status_laatste_deal
FROM public.deals d
JOIN public.customers c ON c.id = d.customer_id
WHERE c.anonymized_at IS NULL
  AND (d.source IS NULL OR d.source <> 'tl_import')
GROUP BY d.customer_id, c.first_name, c.last_name;

COMMENT ON VIEW ai_readonly.v_deals_per_klant IS
  'Deal-aggregaten per klant: aantal, totaal waarde EXCL BTW, eerste/laatste deal-datum, status van laatste deal. Sluit ghost-deals + geanonimiseerde klanten uit.';


-- 2c. Verkoop per producttype (traject-variant)
-- Bron: deals.traject_variant_id (directe FK, sinds mig 2026-06-01-trajecten:43)
-- → traject_variants → trajects. Simpelere + betrouwbaardere join dan via
-- deal_line_items × traject_variant_products (dat is 1:N en zou dubbeltellingen
-- kunnen geven als een deal meerdere line-items in dezelfde variant heeft).
-- Deals zonder traject_variant_id (bv. oude of geïmporteerde deals) vallen
-- automatisch weg via INNER JOIN — acceptabele filter voor product-analyse.
CREATE OR REPLACE VIEW ai_readonly.v_verkoop_per_producttype AS
SELECT
  tv.id                                                  AS traject_variant_id,
  t.name                                                 AS traject_naam,
  tv.name                                                AS variant_naam,
  tv.default_duration_months,
  date_trunc('month', d.tl_quotation_accepted_at)::date  AS maand_start,
  COUNT(*)                                               AS aantal_verkopen,
  COALESCE(SUM(d.total_amount), 0)                       AS totaal_omzet_excl_btw
FROM public.deals d
JOIN public.traject_variants tv ON tv.id = d.traject_variant_id
JOIN public.trajects t ON t.id = tv.traject_id
WHERE d.tl_quotation_accepted_at IS NOT NULL
  AND d.tl_quotation_accepted_at >= now() - interval '24 months'
  AND (d.source IS NULL OR d.source <> 'tl_import')
GROUP BY tv.id, t.name, tv.name, tv.default_duration_months, date_trunc('month', d.tl_quotation_accepted_at)
ORDER BY maand_start DESC, totaal_omzet_excl_btw DESC;

COMMENT ON VIEW ai_readonly.v_verkoop_per_producttype IS
  'Verkoop per traject-variant per maand (laatste 24 mnd). Directe join via deals.traject_variant_id — 1 deal = 1 variant. EXCL BTW; ghost-deals uitgesloten; deals zonder variant vallen weg via INNER JOIN.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. LEADS & SALES
-- ═══════════════════════════════════════════════════════════════════════════

-- 3a. Leads per status per week
CREATE OR REPLACE VIEW ai_readonly.v_leads_per_status AS
SELECT
  COALESCE(l.status, '(onbekend)')               AS status,
  date_trunc('week', l.aangemaakt)::date         AS week_start,
  COUNT(*)                                       AS aantal
FROM public.leads l
WHERE l.aangemaakt >= now() - interval '180 days'
GROUP BY 1, 2
ORDER BY 2 DESC, 1;

COMMENT ON VIEW ai_readonly.v_leads_per_status IS
  'Leads per status per week (laatste 180 dagen). Statuses: nieuw/opgevolgd/gewonnen/verloren. Aggregaat — geen individuele leads.';


-- 3b. Leads-conversie per bron/soort per maand
-- Conversie-signaal: status='gewonnen' (expliciet gezet door leads-promote.js).
CREATE OR REPLACE VIEW ai_readonly.v_leads_conversie AS
SELECT
  COALESCE(l.soort, '(geen)')                        AS soort,
  COALESCE(l.bron, '(geen)')                         AS bron,
  date_trunc('month', l.aangemaakt)::date            AS maand_start,
  COUNT(*)                                           AS aantal_leads,
  COUNT(*) FILTER (WHERE l.status = 'gewonnen')      AS aantal_geconverteerd,
  CASE WHEN COUNT(*) > 0
       THEN ROUND(COUNT(*) FILTER (WHERE l.status = 'gewonnen')::numeric * 100.0 / COUNT(*), 1)
       ELSE 0
  END                                                AS conversie_pct
FROM public.leads l
WHERE l.aangemaakt >= now() - interval '12 months'
GROUP BY 1, 2, 3
ORDER BY 3 DESC, 1, 2;

COMMENT ON VIEW ai_readonly.v_leads_conversie IS
  'Conversie-percentage per soort × bron per maand (laatste 12 mnd). Conversie-signaal: status=''gewonnen''. Kolommen: soort, bron, maand_start, aantal_leads, aantal_geconverteerd, conversie_pct.';


-- 3c. Sales-pijplijn open (offertes verstuurd, wacht op akkoord)
CREATE OR REPLACE VIEW ai_readonly.v_sales_pijplijn_open AS
SELECT
  d.sales_user_id,
  COALESCE(p.full_name, '(onbekend)')                                       AS sales_naam,
  COUNT(*) FILTER (WHERE d.tl_quotation_status = 'sent')                    AS aantal_deals_verstuurd,
  COUNT(*) FILTER (WHERE d.tl_quotation_status = 'draft')                   AS aantal_deals_draft,
  COALESCE(SUM(d.total_amount) FILTER (WHERE d.tl_quotation_status = 'sent'), 0)  AS totaal_waarde_verstuurd_excl_btw,
  MIN(d.created_at) FILTER (WHERE d.tl_quotation_status = 'sent')           AS oudste_verstuurd_op
FROM public.deals d
LEFT JOIN public.profiles p ON p.id = d.sales_user_id
WHERE d.tl_quotation_status IN ('draft', 'sent')
  AND (d.source IS NULL OR d.source <> 'tl_import')
GROUP BY d.sales_user_id, p.full_name
HAVING COUNT(*) > 0
ORDER BY totaal_waarde_verstuurd_excl_btw DESC;

COMMENT ON VIEW ai_readonly.v_sales_pijplijn_open IS
  'Sales-pijplijn per sales-medewerker: aantal verstuurde offertes (sent = wacht op akkoord) + drafts + totaal waarde. Ghost-deals uitgesloten. Definitie ''open'' = tl_quotation_status IN (draft, sent).';


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. EVENTS
-- ═══════════════════════════════════════════════════════════════════════════

-- 4a. Events-historie: afgelopen events + resultaten
CREATE OR REPLACE VIEW ai_readonly.v_events_historie AS
SELECT
  e.id                                              AS event_id,
  e.title,
  e.starts_at,
  e.capacity,
  COUNT(a.id) FILTER (WHERE a.attendance_status = 'aanwezig'
                        AND a.is_test = false)      AS aantal_aanwezig,
  COUNT(a.id) FILTER (WHERE a.attendance_status = 'no_show'
                        AND a.is_test = false)      AS aantal_no_show,
  COUNT(a.id) FILTER (WHERE a.attendance_status = 'afgemeld'
                        AND a.is_test = false)      AS aantal_afgemeld,
  COUNT(a.id) FILTER (WHERE a.status = 'sale'
                        AND a.is_test = false)      AS aantal_sale,
  CASE WHEN COUNT(a.id) FILTER (WHERE a.attendance_status = 'aanwezig' AND a.is_test = false) > 0
       THEN ROUND(
         COUNT(a.id) FILTER (WHERE a.status = 'sale' AND a.is_test = false)::numeric * 100.0
         / NULLIF(COUNT(a.id) FILTER (WHERE a.attendance_status = 'aanwezig' AND a.is_test = false), 0),
         1)
       ELSE 0
  END                                              AS sale_conversie_pct
FROM public.events e
LEFT JOIN public.event_attendees a ON a.event_id = e.id
WHERE e.starts_at < now()
  AND e.status IN ('published', 'archived')
GROUP BY e.id, e.title, e.starts_at, e.capacity
ORDER BY e.starts_at DESC;

COMMENT ON VIEW ai_readonly.v_events_historie IS
  'Afgelopen events + attendance & sale resultaten. Kolommen: event_id, title, starts_at, capacity, aantal_aanwezig, aantal_no_show, aantal_afgemeld, aantal_sale, sale_conversie_pct (sale/aanwezig). Excl. is_test attendees.';


-- 4b. Events belstatus per event
CREATE OR REPLACE VIEW ai_readonly.v_events_belstatus_per_event AS
SELECT
  e.id                                              AS event_id,
  e.title,
  e.starts_at,
  COUNT(a.id) FILTER (WHERE a.call_status IS NULL     AND a.is_test = false)  AS aantal_te_bellen,
  COUNT(a.id) FILTER (WHERE a.call_status IS NOT NULL AND a.is_test = false)  AS aantal_gebeld,
  COUNT(a.id) FILTER (WHERE a.call_status = 'bevestigd'      AND a.is_test = false)  AS aantal_bevestigd,
  COUNT(a.id) FILTER (WHERE a.call_status = 'komt_niet'      AND a.is_test = false)  AS aantal_komt_niet,
  COUNT(a.id) FILTER (WHERE a.call_status = 'geen_gehoor'    AND a.is_test = false)  AS aantal_geen_gehoor,
  COUNT(a.id) FILTER (WHERE a.call_status = 'terugbellen'    AND a.is_test = false)  AS aantal_terugbellen
FROM public.events e
LEFT JOIN public.event_attendees a ON a.event_id = e.id
WHERE e.status = 'published'
GROUP BY e.id, e.title, e.starts_at
ORDER BY e.starts_at ASC;

COMMENT ON VIEW ai_readonly.v_events_belstatus_per_event IS
  'Bel-progress per event (published events). Kolommen: event_id, title, starts_at, aantal_te_bellen (call_status IS NULL), aantal_gebeld (IS NOT NULL), aantal_bevestigd, aantal_komt_niet, aantal_geen_gehoor, aantal_terugbellen. Excl. is_test attendees.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. MENTOREN & STUDENTEN
-- ═══════════════════════════════════════════════════════════════════════════

-- 5a. Studenten per mentor (aantallen)
CREATE OR REPLACE VIEW ai_readonly.v_studenten_per_mentor AS
SELECT
  mle.mentor_user_id,
  COALESCE(p.full_name, '(onbekend)')                                        AS mentor_naam,
  COUNT(DISTINCT mle.customer_id)                                            AS aantal_totaal_studenten,
  COUNT(DISTINCT mle.customer_id) FILTER (
    WHERE EXISTS (
      SELECT 1 FROM public.subscriptions s
      JOIN public.deals d ON d.id = s.deal_id
      WHERE d.customer_id = mle.customer_id AND s.status = 'active'
    )
  )                                                                          AS aantal_actieve_studenten,
  MAX(mle.created_at)                                                        AS laatste_ledger_entry_at
FROM public.mentor_ledger_entries mle
LEFT JOIN public.profiles p ON p.id = mle.mentor_user_id
WHERE mle.customer_id IS NOT NULL
GROUP BY mle.mentor_user_id, p.full_name
ORDER BY aantal_actieve_studenten DESC;

COMMENT ON VIEW ai_readonly.v_studenten_per_mentor IS
  'Mentor-portfolio: aantal studenten per mentor. Kolommen: mentor_user_id, mentor_naam, aantal_totaal_studenten, aantal_actieve_studenten (met actief abbo via deals.customer_id->subscriptions.deal_id), laatste_ledger_entry_at.';


-- 5b. Mentor-belasting per periode (bonus-uitgifte per mentor per maand)
CREATE OR REPLACE VIEW ai_readonly.v_mentor_belasting_periode AS
SELECT
  mle.mentor_user_id,
  COALESCE(p.full_name, '(onbekend)')                                        AS mentor_naam,
  date_trunc('month', mle.created_at)::date                                  AS periode_maand,
  COUNT(*) FILTER (WHERE mle.entry_type = 'bonus')                           AS aantal_bonus_entries,
  COUNT(*) FILTER (WHERE mle.entry_type = 'uitgave')                         AS aantal_uitgave_entries,
  COALESCE(SUM(mle.amount) FILTER (WHERE mle.entry_type = 'bonus'), 0)       AS totaal_bonus_eur,
  COALESCE(SUM(mle.amount) FILTER (WHERE mle.entry_type = 'uitgave'), 0)     AS totaal_uitgave_eur,
  COUNT(DISTINCT mle.customer_id)                                            AS aantal_unieke_studenten
FROM public.mentor_ledger_entries mle
LEFT JOIN public.profiles p ON p.id = mle.mentor_user_id
WHERE mle.created_at >= now() - interval '12 months'
GROUP BY mle.mentor_user_id, p.full_name, date_trunc('month', mle.created_at)
ORDER BY periode_maand DESC, totaal_bonus_eur DESC;

COMMENT ON VIEW ai_readonly.v_mentor_belasting_periode IS
  'Mentor-belasting per maand: bonus/uitgave-entries + bedragen + unieke studenten. Laatste 12 mnd. amount is EUR (basis × pct). Kolommen: mentor_user_id, mentor_naam, periode_maand, aantal_bonus_entries, aantal_uitgave_entries, totaal_bonus_eur, totaal_uitgave_eur, aantal_unieke_studenten.';


-- 5c. Klanten met mentor (omgekeerde van v_klanten_zonder_mentor)
CREATE OR REPLACE VIEW ai_readonly.v_klanten_met_mentor AS
SELECT
  c.id                                                                       AS customer_id,
  TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))       AS klant_naam,
  mle.mentor_user_id,
  COALESCE(p.full_name, '(onbekend)')                                        AS mentor_naam,
  MIN(mle.created_at)                                                        AS gekoppeld_sinds,
  MAX(mle.created_at)                                                        AS laatste_activity_at,
  EXISTS (
    SELECT 1 FROM public.subscriptions s
    JOIN public.deals d ON d.id = s.deal_id
    WHERE d.customer_id = c.id AND s.status = 'active'
  )                                                                          AS heeft_actief_abonnement
FROM public.customers c
JOIN public.mentor_ledger_entries mle ON mle.customer_id = c.id
LEFT JOIN public.profiles p ON p.id = mle.mentor_user_id
WHERE c.anonymized_at IS NULL
GROUP BY c.id, c.first_name, c.last_name, mle.mentor_user_id, p.full_name;

COMMENT ON VIEW ai_readonly.v_klanten_met_mentor IS
  'Klant-mentor-koppeling (indicator: aanwezigheid in mentor_ledger_entries). Kolommen: customer_id, klant_naam, mentor_user_id, mentor_naam, gekoppeld_sinds, laatste_activity_at, heeft_actief_abonnement. Excl. geanonimiseerde klanten. LET OP: als klant meerdere mentoren heeft (over tijd) verschijnt hij meerdere keren.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. TAKEN & TICKETS (v1: aggregatie-only, geen titles/omschrijvingen)
-- ═══════════════════════════════════════════════════════════════════════════

-- 6a. Taken open per persoon (aantallen)
CREATE OR REPLACE VIEW ai_readonly.v_taken_open_per_persoon AS
SELECT
  t.assigned_to_id,
  COALESCE(p.full_name, '(onbekend)')                                         AS medewerker_naam,
  COUNT(*)                                                                    AS aantal_open,
  COUNT(*) FILTER (WHERE NULLIF(t.deadline, '')::timestamptz::date < CURRENT_DATE)  AS aantal_overdue,
  COUNT(*) FILTER (WHERE t.prioriteit = 'Hoog')                               AS aantal_hoog_prioriteit,
  COUNT(*) FILTER (WHERE t.prioriteit = 'Urgent')                             AS aantal_urgent,
  MIN(t.aangemaakt)                                                           AS oudste_open_sinds
FROM public.taken_items t
LEFT JOIN public.profiles p ON p.id = t.assigned_to_id
WHERE t.status = 'todo'
GROUP BY t.assigned_to_id, p.full_name
HAVING COUNT(*) > 0
ORDER BY aantal_urgent DESC, aantal_overdue DESC, aantal_open DESC;

COMMENT ON VIEW ai_readonly.v_taken_open_per_persoon IS
  'Open taken (status=todo) per assignee. Aggregatie-only — geen titels/omschrijvingen/notities (kunnen klant-PII in vrije tekst bevatten). Kolommen: assigned_to_id, medewerker_naam, aantal_open, aantal_overdue, aantal_hoog_prioriteit, aantal_urgent, oudste_open_sinds.';


-- 6b. Tickets open per module (aantallen)
CREATE OR REPLACE VIEW ai_readonly.v_tickets_open_per_module AS
SELECT
  COALESCE(t.module, '(geen)')                                                AS module,
  t.type,
  t.status,
  t.priority,
  COUNT(*)                                                                    AS aantal,
  MIN(t.created_at)                                                           AS oudste_open_sinds
FROM public.tickets t
WHERE t.status IN ('open', 'in_progress')
GROUP BY t.module, t.type, t.status, t.priority
ORDER BY module, type, status;

COMMENT ON VIEW ai_readonly.v_tickets_open_per_module IS
  'Open tickets aggregaat per module/type/status/priority. v1 aggregatie-only — geen title/description (kans op klantnamen in vrije tekst).';


-- ═══════════════════════════════════════════════════════════════════════════
-- GRANTS — ai_readonly krijgt SELECT op alle 14 nieuwe views
-- (Wordt automatisch gedekt door ALTER DEFAULT PRIVILEGES uit PR-A, maar
-- expliciet voor idempotentie.)
-- ═══════════════════════════════════════════════════════════════════════════
GRANT SELECT ON ai_readonly.v_klanten_overzicht           TO ai_readonly;
GRANT SELECT ON ai_readonly.v_facturen_status_per_klant   TO ai_readonly;
GRANT SELECT ON ai_readonly.v_openstaand_per_klant        TO ai_readonly;
GRANT SELECT ON ai_readonly.v_deals_per_status            TO ai_readonly;
GRANT SELECT ON ai_readonly.v_deals_per_klant             TO ai_readonly;
GRANT SELECT ON ai_readonly.v_verkoop_per_producttype     TO ai_readonly;
GRANT SELECT ON ai_readonly.v_leads_per_status            TO ai_readonly;
GRANT SELECT ON ai_readonly.v_leads_conversie             TO ai_readonly;
GRANT SELECT ON ai_readonly.v_sales_pijplijn_open         TO ai_readonly;
GRANT SELECT ON ai_readonly.v_events_historie             TO ai_readonly;
GRANT SELECT ON ai_readonly.v_events_belstatus_per_event  TO ai_readonly;
GRANT SELECT ON ai_readonly.v_studenten_per_mentor        TO ai_readonly;
GRANT SELECT ON ai_readonly.v_mentor_belasting_periode    TO ai_readonly;
GRANT SELECT ON ai_readonly.v_klanten_met_mentor          TO ai_readonly;
GRANT SELECT ON ai_readonly.v_taken_open_per_persoon      TO ai_readonly;
GRANT SELECT ON ai_readonly.v_tickets_open_per_module     TO ai_readonly;
