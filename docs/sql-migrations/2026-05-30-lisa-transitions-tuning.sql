-- ============================================================================
-- Lisa: tune phase_situatie + phase_band transitions
-- Datum: 2026-05-30
-- Branch: fix/lisa-prompt-tuning
--
-- Doel: aanscherpen wanneer Lisa naar call-fase springt zodat ze:
--   1. Direct overschakelt bij expliciete triggers (kosten/info/bellen)
--   2. Band-fase bewust kort houdt (richtlijn 2-4 berichten)
--   3. Geen onnodige relatie-opbouw als persoon klaar is om verder
--
-- ⚠ BELANGRIJK — UI overschrijft deze fix:
--   De /modules/lisa.html Config-tab maakt bij elke "Publiceer" een
--   NIEUWE lisa_config-row. Zodra je daar publiceert na deze SQL,
--   gaat jouw aangepaste transition verloren. Synchroniseer dus ook
--   het transition-veld in de UI Config-editor (fase situatie + band)
--   zodat de volgende publish de juiste tekst bevat.
--
-- Backup van oude waarden in lisa_config_backup_2026_05_30 tabel
-- (rollback-blok onderaan als comment).
-- ============================================================================

BEGIN;

-- ── 1. BACKUP — bewaar huidige actieve config voor rollback ─────────────────
-- IF NOT EXISTS: idempotent. Bij re-run worden GEEN nieuwe rijen toegevoegd,
-- dus rollback gaat altijd naar de eerste-run-snapshot. Acceptabel: SQL is
-- bedoeld voor één enkele uitrol-actie.
CREATE TABLE IF NOT EXISTS public.lisa_config_backup_2026_05_30 AS
  SELECT id, version, is_active,
         phase_situatie, phase_band,
         now() AS backed_up_at
  FROM public.lisa_config
  WHERE is_active = true;

-- ── 2. UPDATE phase_situatie.transition ─────────────────────────────────────
UPDATE public.lisa_config
SET phase_situatie = jsonb_set(
      COALESCE(phase_situatie, '{}'::jsonb),
      '{transition}',
      to_jsonb(
'Ga naar band-fase als de persoon een duidelijk verhaal heeft gedeeld over hun situatie:
- Wat ze proberen te bereiken met traden
- Waar ze nu staan (ervaring, resultaten, frustraties)
- Wat hun zou helpen om verder te komen

Stel meerdere situatie-vragen totdat je dit beeld hebt. Toon oprechte interesse, geen interview-stijl. Stel max 1 vraag per bericht.

HARDE OVERGANG NAAR CALL (skip band):
Als de persoon expliciet vraagt om concrete info of contact:
- Wat kost het? / Hoeveel is het?
- Hoe werkt het precies?
- Kunnen we bellen? / Kan ik iemand spreken?
- Stuur me meer info
- Of vergelijkbare directe vragen

Spring DIRECT naar call-fase. Geen omweg via band.'::text
      )
    )
WHERE is_active = true;

-- ── 3. UPDATE phase_band.transition ─────────────────────────────────────────
UPDATE public.lisa_config
SET phase_band = jsonb_set(
      COALESCE(phase_band, '{}'::jsonb),
      '{transition}',
      to_jsonb(
'Band-fase is een korte verbinding, geen lange relatie-opbouw. Ga naar call-fase wanneer:

1. Je de waarde van een gesprek hebt aangetoond (waarom hen specifiek helpen)
2. De persoon laat zien dat ze openstaan voor een volgende stap (woorden als "klinkt interessant", "vertel meer", "graag", "ja ik wil dat wel weten")
3. Er een natuurlijk moment is om concreet te worden

Houd band-fase bewust kort (richtlijn: 2-4 berichten). Het is een brug, geen bestemming.

Als persoon ineens een directe vraag stelt over kosten/info/bellen, spring direct naar call.

Niet doorgaan met onnodig verbinding maken als de persoon klaar is om verder te gaan.'::text
      )
    )
WHERE is_active = true;

COMMIT;

-- ============================================================================
-- VERIFICATIE (handmatig na run)
-- ============================================================================
-- SELECT phase_situatie->>'transition' AS situatie_transition,
--        phase_band->>'transition'    AS band_transition
-- FROM public.lisa_config
-- WHERE is_active = true;
--
-- Backup-snapshot bekijken:
-- SELECT id, version,
--        phase_situatie->>'transition' AS old_situatie,
--        phase_band->>'transition'    AS old_band,
--        backed_up_at
-- FROM public.lisa_config_backup_2026_05_30;

-- ============================================================================
-- ROLLBACK (handmatig — bij ongewenst gedrag in productie)
-- ============================================================================
-- BEGIN;
--   UPDATE public.lisa_config c
--      SET phase_situatie = b.phase_situatie,
--          phase_band     = b.phase_band
--     FROM public.lisa_config_backup_2026_05_30 b
--    WHERE c.id = b.id;
--   -- Pas DROP TABLE doen ná verificatie dat rollback werkt.
--   -- DROP TABLE public.lisa_config_backup_2026_05_30;
-- COMMIT;
