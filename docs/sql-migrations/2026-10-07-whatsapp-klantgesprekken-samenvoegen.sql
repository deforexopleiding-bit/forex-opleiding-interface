-- 2026-10-07 · WhatsApp-klantgesprekken (finance + onboarding) naar het
--              klantnummer (1399327383258229), per klant samengevoegd tot ÉÉN
--              gesprek. Door Jeffrey te draaien — NA 2026-10-07-whatsapp-klantnummer-lijn.sql.
--
-- WAAROM
--   Finance (1194351613761790) en onboarding (1163203046877082) hadden elk een
--   eigen lijn. Vanaf nu bedient één nummer allebei; de inboxen filteren op de
--   klantnummer-lijn en verdelen per klant (api/_lib/klant-module.js). Zonder
--   deze datafix blijven de bestaande gesprekken onzichtbaar en opent een
--   antwoord van een klant een tweede gesprek. De code hecht een oud gesprek
--   ook zelf aan bij het eerste bericht; dit doet het in één keer voor alles.
--
-- WAT ER GEBEURT (per telefoonnummer met gesprekken op deze drie lijnen)
--   1. Overlever = het gesprek op het klantnummer als dat er al is, anders het
--      meest recente (last_message_at).
--   2. Berichten (whatsapp_messages) en Joost-suggesties (joost_suggestions)
--      van de andere gesprekken gaan naar de overlever.
--   3. Finance-verwijzingen: dunning_workflow_runs.paused_by_conversation_id
--      gaat mee naar de overlever (anders kijkt de herinneringen-cron naar een
--      leeg, geparkeerd gesprek). Joost-gespreksstatus (joost_conversation_state,
--      1 rij per gesprek): heeft de overlever er geen, dan verhuist die van het
--      meest recente andere gesprek mee; de rest blijft bij het geparkeerde.
--   4. Samenvattende velden van de overlever: laatste activiteit/inbound,
--      ongelezen = som, preview, klant/naam als leeg, 'open' als één open was.
--   5. De andere gesprekken worden GEPARKEERD, niet verwijderd:
--      phone_number_id = 'samengevoegd:<eigen id>', status 'archived'.
--   6. De overlever gaat naar lijn 1399327383258229.
--
-- NIET GERAAKT: de lead-lijnen (hoofdnummer en de opgeheven lead-lijnen) en
-- gesprekken zonder lijn-ID.
--
-- BACKUP: vóór elke wijziging in public.wa_lijnfix_20261007_gesprekken (oude
-- lijn + status per gesprek) en public.wa_lijnfix_20261007_verhuisd (per
-- verhuisde rij de oude conversation_id). Volledige ROLLBACK onderaan.
--
-- IDEMPOTENT: een tweede run vindt per nummer nog één gesprek, op het
-- klantnummer → niets te doen. Eén DO-block (bij een fout: niets doorgevoerd).
--
-- VOLGORDE: eerst de PR mergen, dan de env-vars + webhook + templates, dan
-- 2026-10-07-whatsapp-klantnummer-lijn.sql, dan blok 0 hier (bewaren), blok 1, blok 2.

-- ── 0. Vooraf (alleen lezen) ─────────────────────────────────────────────────
-- 0a. Gesprekken per lijn:
-- SELECT phone_number_id, count(*) AS gesprekken, max(last_message_at) AS laatste
--   FROM public.whatsapp_conversations
--  WHERE phone_number_id IN ('1399327383258229','1194351613761790','1163203046877082')
--  GROUP BY 1 ORDER BY 1;
--
-- 0b. Wat de datafix gaat doen:
-- WITH g AS (
--   SELECT id, phone_number, phone_number_id
--     FROM public.whatsapp_conversations
--    WHERE phone_number_id IN ('1399327383258229','1194351613761790','1163203046877082')
-- ), per AS (
--   SELECT phone_number, count(*) AS n, bool_or(phone_number_id <> '1399327383258229') AS oud
--     FROM g GROUP BY phone_number
-- )
-- SELECT
--   (SELECT count(*) FROM per WHERE n > 1 OR oud)         AS nummers_te_verwerken,
--   (SELECT count(*) FROM per WHERE n > 1)                AS nummers_met_meerdere_gesprekken,
--   (SELECT coalesce(sum(n - 1), 0) FROM per WHERE n > 1) AS gesprekken_te_parkeren,
--   (SELECT count(*) FROM per WHERE n = 1 AND oud)        AS gesprekken_alleen_omzetten;
--
-- 0c. Gepauzeerde aanmaan-runs op deze gesprekken (gaan mee naar de overlever):
-- SELECT count(*) FROM public.dunning_workflow_runs r
--   JOIN public.whatsapp_conversations c ON c.id = r.paused_by_conversation_id
--  WHERE c.phone_number_id IN ('1399327383258229','1194351613761790','1163203046877082');

-- ── 1. De datafix ────────────────────────────────────────────────────────────
DO $$
DECLARE
  nieuw   text   := '1399327383258229';
  lijnen  text[] := ARRAY['1399327383258229','1194351613761790','1163203046877082'];
  g       record;
  surv    uuid;
  anderen uuid[];
  st_bron uuid;
  n_num   int := 0;
  n_park  int := 0;
  n_msg   int := 0;
  n_sug   int := 0;
  n_run   int := 0;
  n_st    int := 0;
  n_om    int := 0;
  x       int;
BEGIN
  -- Backup-tabellen (blijvend; na een geslaagde controle mag Jeffrey ze droppen).
  CREATE TABLE IF NOT EXISTS public.wa_lijnfix_20261007_gesprekken (
    conversation_id uuid PRIMARY KEY, phone_number text, oud_phone_number_id text,
    oud_status text, vastgelegd_op timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS public.wa_lijnfix_20261007_verhuisd (
    tabel text NOT NULL, rij_id uuid NOT NULL, oud_conversation_id uuid NOT NULL,
    vastgelegd_op timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tabel, rij_id));
  ALTER TABLE public.wa_lijnfix_20261007_gesprekken ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.wa_lijnfix_20261007_verhuisd   ENABLE ROW LEVEL SECURITY;

  FOR g IN
    SELECT phone_number,
           array_agg(id ORDER BY (phone_number_id = nieuw) DESC,
                                 last_message_at DESC NULLS LAST, created_at DESC) AS ids
      FROM public.whatsapp_conversations
     WHERE phone_number_id = ANY(lijnen)
     GROUP BY phone_number
    HAVING count(*) > 1 OR bool_or(phone_number_id <> nieuw)
  LOOP
    n_num   := n_num + 1;
    surv    := g.ids[1];
    anderen := g.ids[2:array_length(g.ids, 1)];

    -- Backup van de gesprekken (oude lijn + status) vóór de wijziging.
    INSERT INTO public.wa_lijnfix_20261007_gesprekken (conversation_id, phone_number, oud_phone_number_id, oud_status)
      SELECT id, phone_number, phone_number_id, status FROM public.whatsapp_conversations WHERE id = ANY(g.ids)
      ON CONFLICT (conversation_id) DO NOTHING;

    IF array_length(anderen, 1) IS NOT NULL THEN
      -- 2. Berichten + suggesties naar de overlever (eerst vastleggen waar ze vandaan komen).
      INSERT INTO public.wa_lijnfix_20261007_verhuisd (tabel, rij_id, oud_conversation_id)
        SELECT 'whatsapp_messages', id, conversation_id FROM public.whatsapp_messages WHERE conversation_id = ANY(anderen)
        ON CONFLICT DO NOTHING;
      INSERT INTO public.wa_lijnfix_20261007_verhuisd (tabel, rij_id, oud_conversation_id)
        SELECT 'joost_suggestions', id, conversation_id FROM public.joost_suggestions WHERE conversation_id = ANY(anderen)
        ON CONFLICT DO NOTHING;
      UPDATE public.whatsapp_messages SET conversation_id = surv WHERE conversation_id = ANY(anderen);
      GET DIAGNOSTICS x = ROW_COUNT; n_msg := n_msg + x;
      UPDATE public.joost_suggestions SET conversation_id = surv WHERE conversation_id = ANY(anderen);
      GET DIAGNOSTICS x = ROW_COUNT; n_sug := n_sug + x;

      -- 3a. Gepauzeerde aanmaan-runs wijzen naar de overlever.
      INSERT INTO public.wa_lijnfix_20261007_verhuisd (tabel, rij_id, oud_conversation_id)
        SELECT 'dunning_workflow_runs', id, paused_by_conversation_id FROM public.dunning_workflow_runs
         WHERE paused_by_conversation_id = ANY(anderen)
        ON CONFLICT DO NOTHING;
      UPDATE public.dunning_workflow_runs SET paused_by_conversation_id = surv
       WHERE paused_by_conversation_id = ANY(anderen);
      GET DIAGNOSTICS x = ROW_COUNT; n_run := n_run + x;

      -- 3b. Joost-gespreksstatus: alleen als de overlever er nog geen heeft.
      IF NOT EXISTS (SELECT 1 FROM public.joost_conversation_state WHERE conversation_id = surv) THEN
        SELECT s.conversation_id INTO st_bron
          FROM public.joost_conversation_state s
          JOIN public.whatsapp_conversations c ON c.id = s.conversation_id
         WHERE s.conversation_id = ANY(anderen)
         ORDER BY c.last_message_at DESC NULLS LAST
         LIMIT 1;
        IF st_bron IS NOT NULL THEN
          -- rij_id = de NIEUWE sleutel (overlever), oud_conversation_id = de oude.
          INSERT INTO public.wa_lijnfix_20261007_verhuisd (tabel, rij_id, oud_conversation_id)
            VALUES ('joost_conversation_state', surv, st_bron) ON CONFLICT DO NOTHING;
          UPDATE public.joost_conversation_state SET conversation_id = surv WHERE conversation_id = st_bron;
          GET DIAGNOSTICS x = ROW_COUNT; n_st := n_st + x;
        END IF;
      END IF;

      -- 4. Samenvattende velden op de overlever.
      UPDATE public.whatsapp_conversations s SET
        last_message_at      = a.max_msg,
        last_inbound_at      = a.max_in,
        unread_count         = a.som_unread,
        last_message_preview = coalesce(a.preview, s.last_message_preview),
        customer_id          = coalesce(s.customer_id, a.klant),
        display_name         = coalesce(s.display_name, a.naam),
        status               = CASE WHEN a.een_open THEN 'open' ELSE s.status END
      FROM (
        SELECT max(last_message_at) AS max_msg,
               max(last_inbound_at) AS max_in,
               coalesce(sum(unread_count), 0) AS som_unread,
               (array_agg(last_message_preview ORDER BY last_message_at DESC NULLS LAST))[1] AS preview,
               (array_agg(customer_id) FILTER (WHERE customer_id IS NOT NULL))[1] AS klant,
               (array_agg(display_name) FILTER (WHERE display_name IS NOT NULL))[1] AS naam,
               bool_or(status = 'open') AS een_open
          FROM public.whatsapp_conversations WHERE id = ANY(g.ids)
      ) a
      WHERE s.id = surv;

      -- 5. Parkeren (niet verwijderen).
      UPDATE public.whatsapp_conversations
         SET phone_number_id      = 'samengevoegd:' || id::text,
             status               = 'archived',
             unread_count         = 0,
             last_message_preview = 'Samengevoegd in gesprek ' || surv::text
       WHERE id = ANY(anderen);
      GET DIAGNOSTICS x = ROW_COUNT; n_park := n_park + x;
    END IF;

    -- 6. Overlever naar het klantnummer.
    UPDATE public.whatsapp_conversations SET phone_number_id = nieuw
     WHERE id = surv AND phone_number_id IS DISTINCT FROM nieuw;
    GET DIAGNOSTICS x = ROW_COUNT; n_om := n_om + x;
  END LOOP;

  RAISE NOTICE 'nummers: %, naar klantnummer: %, geparkeerd: %, berichten: %, suggesties: %, runs: %, joost-status: %',
    n_num, n_om, n_park, n_msg, n_sug, n_run, n_st;
END $$;

-- ── 2. Controle (alleen lezen) ───────────────────────────────────────────────
-- 2a. Niets meer op de oude klantlijnen (verwacht: 0 rijen):
-- SELECT phone_number_id, count(*) FROM public.whatsapp_conversations
--  WHERE phone_number_id IN ('1194351613761790','1163203046877082') GROUP BY 1;
--
-- 2b. Per nummer hooguit één gesprek op het klantnummer (verwacht: 0 rijen):
-- SELECT phone_number, count(*) FROM public.whatsapp_conversations
--  WHERE phone_number_id = '1399327383258229' GROUP BY 1 HAVING count(*) > 1;
--
-- 2c. Geparkeerde gesprekken hebben geen berichten en geen gepauzeerde runs meer (verwacht: 0, 0):
-- SELECT count(*) FROM public.whatsapp_messages m
--   JOIN public.whatsapp_conversations c ON c.id = m.conversation_id
--  WHERE c.phone_number_id LIKE 'samengevoegd:%';
-- SELECT count(*) FROM public.dunning_workflow_runs r
--   JOIN public.whatsapp_conversations c ON c.id = r.paused_by_conversation_id
--  WHERE c.phone_number_id LIKE 'samengevoegd:%';

-- ── ROLLBACK (volledig, met de backup-tabellen) ──────────────────────────────
-- Draai in deze volgorde (losse statements):
-- UPDATE public.whatsapp_messages m SET conversation_id = v.oud_conversation_id
--   FROM public.wa_lijnfix_20261007_verhuisd v WHERE v.tabel = 'whatsapp_messages' AND m.id = v.rij_id;
-- UPDATE public.joost_suggestions j SET conversation_id = v.oud_conversation_id
--   FROM public.wa_lijnfix_20261007_verhuisd v WHERE v.tabel = 'joost_suggestions' AND j.id = v.rij_id;
-- UPDATE public.dunning_workflow_runs r SET paused_by_conversation_id = v.oud_conversation_id
--   FROM public.wa_lijnfix_20261007_verhuisd v WHERE v.tabel = 'dunning_workflow_runs' AND r.id = v.rij_id;
-- UPDATE public.joost_conversation_state s SET conversation_id = v.oud_conversation_id
--   FROM public.wa_lijnfix_20261007_verhuisd v WHERE v.tabel = 'joost_conversation_state' AND s.conversation_id = v.rij_id;
-- UPDATE public.whatsapp_conversations c SET phone_number_id = b.oud_phone_number_id, status = b.oud_status
--   FROM public.wa_lijnfix_20261007_gesprekken b WHERE c.id = b.conversation_id;
-- (Samenvattende velden van de overlever blijven op de samengevoegde waarde; cosmetisch.)
--
-- Opruimen na een geslaagde controle (2a–2c) en een paar dagen meekijken:
-- DROP TABLE public.wa_lijnfix_20261007_verhuisd;
-- DROP TABLE public.wa_lijnfix_20261007_gesprekken;
