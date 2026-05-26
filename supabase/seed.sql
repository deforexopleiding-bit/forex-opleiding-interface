-- supabase/seed.sql
-- ============================================================================
-- ⚠️  DEV / TEST ONLY  —  wordt door Supabase Branching automatisch GESKIPT
--     bij merge naar protected branches ("Skipping seed data for protected
--     branch"). Bewust: deze fake-klanten horen NIET op productie.
--
-- Doel : realistische test-data voor Fase 2A.1 klant-overzicht UI
--        (filter / search / sortering / pagination).
-- Idempotent : ON CONFLICT DO NOTHING op alle inserts.
-- Vaste UUIDs : reproduceerbaar over herhaalde runs + deterministische FKs.
-- created_by_user_id : NULL (anders FK-failure op clean db zonder profielen).
-- Fictief : geen echte personen; emails op +seed@example.test domein.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 0) customer_tag_definitions (5 system tags)
--    NOTE: Hoewel deze óók in migratie 012 INSERT staan, kopieert Supabase
--    Branching alleen schema (DDL) bij branch-creation — niet data.
--    Op productie zijn deze handmatig geseed na de Fase 1 merge.
--    Voor reproduceerbare preview-branches moet seed.sql self-contained zijn.
--    Idempotent via ON CONFLICT (slug) DO NOTHING.
-- ============================================================================
INSERT INTO customer_tag_definitions (slug, label, color, is_system, display_order) VALUES
  ('vip',         'VIP',         '#F59E0B', true, 1),
  ('risico',      'Risico',      '#EF4444', true, 2),
  ('ambassadeur', 'Ambassadeur', '#10B981', true, 3),
  ('pilot',       'Pilot',       '#3B82F6', true, 4),
  ('oud-lead',    'Oud-lead',    '#9CA3AF', true, 5)
ON CONFLICT (slug) DO NOTHING;

-- ============================================================================
-- 1) Customers (9 stuks)
--    Mix:
--    - klant 1-5,7,8: volledig contact-data
--    - klant 6      : alleen telefoon (geen email)        → test email-filter
--    - klant 9      : archived (archived_at gezet)        → test status-filter
--    Spreid: created_at van 90 dagen geleden tot nu.
-- ============================================================================
INSERT INTO customers (
  id, first_name, last_name, email, phone, date_of_birth,
  address_street, address_number, address_postal, address_city,
  created_at, archived_at
) VALUES
  ('c0000001-0000-0000-0000-000000000001',
   'Jan', 'Jansen', 'jan.jansen+seed@example.test', '+31612345001', '1985-03-15',
   'Hoofdstraat', '12', '1011AA', 'Amsterdam',
   now() - interval '5 days', NULL),

  ('c0000002-0000-0000-0000-000000000002',
   'Marie', 'de Vries', 'marie.devries+seed@example.test', '+31612345002', '1978-11-22',
   'Kerkstraat', '45', '3511LD', 'Utrecht',
   now() - interval '12 days', NULL),

  ('c0000003-0000-0000-0000-000000000003',
   'Pieter', 'van den Berg', 'pieter.vandenberg+seed@example.test', '+31612345003', '1990-07-08',
   'Damrak', '78', '1012LP', 'Amsterdam',
   now() - interval '21 days', NULL),

  ('c0000004-0000-0000-0000-000000000004',
   'Sophie', 'Bakker', 'sophie.bakker+seed@example.test', '+31612345004', '1992-02-14',
   'Lange Voorhout', '3-A', '2514EA', 'Den Haag',
   now() - interval '32 days', NULL),

  ('c0000005-0000-0000-0000-000000000005',
   'Lars', 'Hendriks', 'lars.hendriks+seed@example.test', NULL, '1982-09-30',
   'Coolsingel', '100', '3012AG', 'Rotterdam',
   now() - interval '45 days', NULL),

  ('c0000006-0000-0000-0000-000000000006',
   'Emma', 'Visser', NULL, '+31612345006', '1995-05-19',
   'Veemarkt', '22', '5611AA', 'Eindhoven',
   now() - interval '60 days', NULL),

  ('c0000007-0000-0000-0000-000000000007',
   'Daan', 'de Jong', 'daan.dejong+seed@example.test', '+31612345007', '1988-12-01',
   'Markt', '7', '6211CK', 'Maastricht',
   now() - interval '70 days', NULL),

  ('c0000008-0000-0000-0000-000000000008',
   'Lotte', 'van Dijk', 'lotte.vandijk+seed@example.test', '+31612345008', '1980-04-25',
   'Grote Markt', '18bis', '9712HN', 'Groningen',
   now() - interval '80 days', NULL),

  ('c0000009-0000-0000-0000-000000000009',
   'Tim', 'Mulder', 'tim.mulder+seed@example.test', '+31612345009', '1975-08-11',
   'Stationsplein', '5', '5038WV', 'Tilburg',
   now() - interval '90 days', now() - interval '3 days')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- 2) customer_tags (tag-slugs uit migratie 012 seeds:
--    vip / risico / ambassadeur / pilot / oud-lead)
--    Spreiding voor KPI-tegel "risico"-count + filter-multiselect-tests.
-- ============================================================================
INSERT INTO customer_tags (customer_id, tag_slug) VALUES
  ('c0000001-0000-0000-0000-000000000001', 'vip'),
  ('c0000002-0000-0000-0000-000000000002', 'vip'),
  ('c0000003-0000-0000-0000-000000000003', 'ambassadeur'),
  ('c0000004-0000-0000-0000-000000000004', 'risico'),
  ('c0000005-0000-0000-0000-000000000005', 'vip'),
  ('c0000007-0000-0000-0000-000000000007', 'pilot'),
  ('c0000008-0000-0000-0000-000000000008', 'oud-lead')
ON CONFLICT (customer_id, tag_slug) DO NOTHING;

-- ============================================================================
-- 3) customer_notes (bouwsteen voor 2A.4 notitie-toevoegen UI)
--    Verspreid over 2 klanten — 2 notes op klant 1, 1 note op klant 2.
-- ============================================================================
INSERT INTO customer_notes (
  id, customer_id, body, created_by_user_id, created_at
) VALUES
  ('a0000001-0000-0000-0000-000000000001',
   'c0000001-0000-0000-0000-000000000001',
   'Eerste kennismakingsgesprek positief verlopen. Interesse in Premium-traject.',
   NULL,
   now() - interval '4 days'),

  ('a0000002-0000-0000-0000-000000000002',
   'c0000001-0000-0000-0000-000000000001',
   'Afspraak gemaakt voor opleidingsintake. Stuurt eerst voorbereidingsmateriaal door.',
   NULL,
   now() - interval '2 days'),

  ('a0000003-0000-0000-0000-000000000003',
   'c0000002-0000-0000-0000-000000000002',
   'Heeft eerder TradersLeague-account aangemaakt; profiel verifieren.',
   NULL,
   now() - interval '10 days')
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- ============================================================================
-- VALIDATIE (handmatig in SQL Editor na seed)
-- ============================================================================
-- SELECT count(*) FROM customers WHERE email LIKE '%+seed@example.test'
--   OR id::text LIKE 'c00000%';                                                -- 9
-- SELECT count(*) FROM customer_tags
--   WHERE customer_id::text LIKE 'c00000%';                                    -- 7
-- SELECT count(*) FROM customer_notes
--   WHERE customer_id::text LIKE 'c00000%';                                    -- 3
-- SELECT first_name, last_name, archived_at FROM customers
--   WHERE id='c0000009-0000-0000-0000-000000000009';                           -- Tim, archived
