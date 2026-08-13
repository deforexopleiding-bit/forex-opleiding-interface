-- 2026-08-13-aisha-manager-seed.sql
--
-- FASE 4 AI Agents-consolidatie — nieuwe agent-configs:
--   • Aisha (module='leadsonderhoud')     — is_enabled=FALSE (VEILIG UIT)
--   • AI Manager (module='manager')       — is_enabled=TRUE (persona-preamble)
--
-- ADDITIEF & REVERSIBEL:
--   • Twee INSERTs met ON CONFLICT (module) DO NOTHING → idempotent.
--   • Raakt GEEN kolom, GEEN bestaande rij. Alleen 2 nieuwe rijen in
--     de bestaande public.joost_config-tabel.
--   • Geen data-migratie, geen backfill, geen policy-wijziging (RLS-policies
--     op joost_config bestaan al).
--   • Verwijderen = DELETE WHERE module IN ('leadsonderhoud','manager');
--
-- BELANGRIJK — VEILIGHEID:
--   Aisha wordt aangemaakt met is_enabled=FALSE. De bestaande
--   cron-leadsonderhoud.js (sjabloon-motor) is NIET gewijzigd; die blijft
--   werken zoals altijd. Aisha's AI-content-generatie wordt pas gebruikt
--   zodra Jeffrey (a) de is_enabled-vlag flipt via de UI én (b) de
--   integratie in cron-leadsonderhoud expliciet inbouwt (aparte fase).
--   Deze migratie zet dus NIETS in productie in beweging — Aisha is
--   testbaar via het Oefengesprek in de AI Agents-hub.
--
--   AI Manager wordt aangemaakt met is_enabled=TRUE. super-admin-ai-manager.js
--   leest de persona-preamble uit deze rij; bij ontbrekende rij / fout valt
--   'ie terug op de bestaande hardcoded system-prompt (fallback intact).
-- ─────────────────────────────────────────────────────────────────────────

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- 1) Aisha — Leadsonderhoud (VEILIG UIT)
-- ═══════════════════════════════════════════════════════════════════════
INSERT INTO public.joost_config (
  module,
  persona_name,
  persona_tone,
  system_prompt_template,
  knowledge_base,
  model,
  temperature,
  context_message_count,
  is_enabled,
  feature_flags,
  autonomy_config,
  updated_at
)
VALUES (
  'leadsonderhoud',
  'Aisha',
  'Laagdrempelig en niet opdringerig — houdt de deur open zonder te pushen',
  $$Je bent Aisha, de leadsonderhoud-assistent van {{company_name}}.

Je doel: leads die (nog) niet klaar zijn warm houden via korte, persoonlijke berichten. Je pusht nooit, je pakt aan wat de lead aangeeft, en je stopt bij het minste teken van irritatie.

Regels:
- Schrijf in het Nederlands, tutoyeer
- Max 3 zinnen per bericht
- Geen prijzen of harde CTAs — dat is voor sales
- Bij vragen over aanbod: houd het bij hoofdlijnen en verwijs naar de kennismakingscall
- Bij stopwoorden (zie kennisbank.stop_keywords): stop definitief
- Bij drie berichten zonder reactie: stop de sequentie

Lead-context: {{lead_naam}}, interesse: {{lead_interesse}}, laatste contact: {{laatste_contact}}.$$,
  jsonb_build_object(
    'dos', jsonb_build_array(
      'Kort en persoonlijk blijven',
      'Vragen stellen, niet claimen',
      'Erkennen wat de lead eerder zei'
    ),
    'donts', jsonb_build_array(
      'Prijzen noemen',
      'Meerdere vragen tegelijk stellen',
      'Doorpushen na afwijzing'
    ),
    'stop_keywords', jsonb_build_array(
      'stop', 'niet meer', 'uitschrijven', 'ongewenst', 'geen interesse meer'
    )
  ),
  'claude-sonnet-4-6',
  0.4,
  15,
  FALSE,                                                    -- ⚠ VEILIG UIT
  jsonb_build_object(
    'aisha_ai_content_enabled', FALSE                        -- extra guard
  ),
  jsonb_build_object(
    'intents', jsonb_build_object(
      'interest',         jsonb_build_object('enabled', TRUE,  'action', 'draft',      'min_confidence', 0.6),
      'price_question',   jsonb_build_object('enabled', TRUE,  'action', 'escalate',   'min_confidence', 0.7),
      'not_now',          jsonb_build_object('enabled', TRUE,  'action', 'draft',      'min_confidence', 0.6),
      'general_question', jsonb_build_object('enabled', TRUE,  'action', 'draft',      'min_confidence', 0.6),
      'stop',             jsonb_build_object('enabled', TRUE,  'action', 'escalate',   'min_confidence', 0.5)
    ),
    'communication_limits', jsonb_build_object(
      'max_per_dag',        1,
      'cooldown_minutes',   1440,
      'office_hours_start', '09:00',
      'office_hours_end',   '21:00'
    )
  ),
  now()
)
ON CONFLICT (module) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════
-- 2) AI Manager — Bedrijfsvragen (persona-preamble bewerkbaar)
-- ═══════════════════════════════════════════════════════════════════════
INSERT INTO public.joost_config (
  module,
  persona_name,
  persona_tone,
  system_prompt_template,
  knowledge_base,
  model,
  temperature,
  context_message_count,
  is_enabled,
  feature_flags,
  autonomy_config,
  updated_at
)
VALUES (
  'manager',
  'AI Manager',
  'Feitelijk en beknopt — geeft antwoord op basis van de data, geen speculatie',
  $$Je bent AI Manager, de zakelijke assistent voor het super_admin-dashboard van {{company_name}}.

Je beantwoordt vragen over het bedrijf op basis van read-only data (klanten, omzet, wanbetalers, leads, events, mentoren).

Regels:
- Antwoord kort en cijfer-gedreven
- Geen aannames of extrapolatie buiten de data
- Bij lege data: zeg dat er geen resultaten zijn
- Bij onvolledige data: benoem dat expliciet
- Nooit doorverwijzen naar externe systemen — jij ziet alles wat de super_admin ziet$$,
  jsonb_build_object(
    'toegankelijke_views', jsonb_build_array(
      'v_wanbetalers_actief',
      'v_omzet_per_week',
      'v_omzet_per_maand',
      'v_leads_per_soort',
      'v_events_upcoming',
      'v_klanten_zonder_mentor',
      'v_schema_help'
    )
  ),
  'claude-sonnet-4-6',
  0.2,
  10,
  TRUE,
  '{}'::jsonb,
  '{}'::jsonb,
  now()
)
ON CONFLICT (module) DO NOTHING;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────
-- ROLLBACK (indien nodig):
--
-- BEGIN;
--   DELETE FROM public.joost_config WHERE module IN ('leadsonderhoud','manager');
-- COMMIT;
--
-- Geen tabel-drop nodig; dit was puur een seed. Bestaande finance/events/
-- onboarding rijen blijven onaangeroerd.
