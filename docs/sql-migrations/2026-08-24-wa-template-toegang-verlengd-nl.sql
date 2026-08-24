-- 2026-08-24 · whatsapp_meta_templates seed: toegang_verlengd_nl
--
-- CONTEXT
-- api/leadsonderhoud-extend-access.js verstuurt bij access-verleng een WA-
-- template `toegang_verlengd_nl` (positional {{1}}=voornaam, {{2}}=einddatum).
-- Jeffrey maakt/keurt het template goed via Meta Business Manager. Deze
-- SQL-seed maakt een LOCAL-status registry-entry aan zodat:
--   1) Het template zichtbaar wordt in de CRM-templates-UI (indien aanwezig).
--   2) Toekomstige named-var-callers de mapping ({{1}}→voornaam,{{2}}→einddatum)
--      kunnen resolven i.p.v. positional-alleen.
--   3) De status-lifecycle (LOCAL → SUBMITTED → APPROVED) traceerbaar is.
--
-- De extend-access send zelf roept sendTemplate direct met positional array
-- aan en is NIET afhankelijk van deze registry — de send werkt zodra Meta
-- het echte template heeft goedgekeurd, ongeacht de registry-status hier.
-- Deze entry is puur informatief/config, geen runtime-blocker.
--
-- Idempotent: ON CONFLICT DO UPDATE. Re-run veilig.
-- 0 incasso-writes; puur config in whatsapp_meta_templates.

BEGIN;

INSERT INTO public.whatsapp_meta_templates (
  business_account_id,
  name,
  language,
  category,
  header_type,
  body_text,
  body_examples,
  meta_param_mapping,
  status
)
VALUES (
  '990429800401598',                              -- Meta WABA-id (bestaand, uit foundation-migratie)
  'toegang_verlengd_nl',
  'nl',
  'UTILITY',
  'NONE',
  'Hoi {{1}}! Je toegang is verlengd tot {{2}} 🎉 Je kunt zo weer verder. Vragen? Stuur gerust een bericht.',
  jsonb_build_object('body_text', jsonb_build_array(jsonb_build_array('Jeffrey', '30 september 2026'))),
  jsonb_build_object(
    'body', jsonb_build_object(
      '1', 'lead.voornaam',
      '2', 'toegang.einddatum'
    )
  ),
  'LOCAL'                                          -- pending Meta-submit + approval
)
ON CONFLICT (business_account_id, name, language) DO UPDATE
  SET body_text          = EXCLUDED.body_text,
      body_examples      = EXCLUDED.body_examples,
      meta_param_mapping = EXCLUDED.meta_param_mapping,
      category           = EXCLUDED.category,
      header_type        = EXCLUDED.header_type,
      updated_at         = now();

DO $$
BEGIN
  RAISE NOTICE '── toegang_verlengd_nl geseed ─────────────────────';
  RAISE NOTICE '  status = LOCAL (submit + approve nog te doen in Meta)';
  RAISE NOTICE '  positional {{1}}=voornaam, {{2}}=einddatum';
  RAISE NOTICE '  extend-access werkt zodra Meta approves — geen code-wijziging nodig';
END $$;

COMMIT;

-- Verificatie:
--   SELECT name, language, status, body_text, meta_param_mapping
--   FROM public.whatsapp_meta_templates
--   WHERE name = 'toegang_verlengd_nl';
--
-- Post-Meta-approval flow (handmatig of via admin-meta-templates-sync):
--   UPDATE public.whatsapp_meta_templates
--   SET status='APPROVED', approved_at=now(), meta_template_id='<Meta-id>'
--   WHERE name='toegang_verlengd_nl' AND language='nl';
