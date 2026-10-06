-- 2026-10-06 · WhatsApp-lead-gesprekken naar de huidige lijn (1273723375834177),
--              per lead samengevoegd tot ÉÉN gesprek. Door Jeffrey te draaien.
--
-- WAAROM
--   Na de nummerwissel staan de lead-gesprekken nog op drie opgeheven lijn-ID's:
--     758003047390806   oorspronkelijk leadnummer +31657210825
--     1232908829908396  oude Esmee-lijn (toegang/afspraken)
--     1156034510929407  oude events-lijn
--   De lead- en events-inboxen filteren op de huidige lijn, dus die gesprekken
--   zijn onzichtbaar; een antwoord van een lead maakt een NIEUW gesprek op de
--   nieuwe lijn (gesplitste draad). De code (PR "WhatsApp-gesprekken op de
--   huidige lijn") hecht een oud gesprek voortaan bij het eerste bericht aan
--   de nieuwe lijn; deze datafix doet dat in één keer voor alles wat er al ligt.
--
-- WAT ER GEBEURT (per telefoonnummer met gesprekken op deze vier lijnen)
--   1. Overlever = het gesprek op de nieuwe lijn als dat er al is, anders het
--      meest recente gesprek (last_message_at).
--   2. Alle berichten (whatsapp_messages) en Joost/Simone-suggesties
--      (joost_suggestions) van de andere gesprekken gaan naar de overlever.
--      → Eén draad, volledige historie.
--   3. De overlever krijgt: laatste activiteit/inbound = de meest recente,
--      ongelezen = de som, preview van het meest recente gesprek, klant/naam als
--      die nog leeg was, status 'open' als één van de gesprekken open was.
--   4. De andere gesprekken worden GEPARKEERD, niet verwijderd:
--      phone_number_id = 'samengevoegd:<eigen id>', status 'archived'. Zo is de
--      unieke sleutel (telefoon, lijn) vrij en blijft elke verwijzing
--      (joost_conversation_state, paused_by_conversation_id) gewoon bestaan.
--   5. De overlever gaat naar lijn 1273723375834177.
--
-- NIET GERAAKT: finance (1194351613761790), onboarding (1163203046877082) en
-- gesprekken zonder lijn-ID.
--
-- BACKUP: vóór elke wijziging legt het block per geraakt gesprek de oude lijn-ID
-- en status vast in public.wa_lijnfix_20261006_gesprekken, en per verhuisd
-- bericht/suggestie het oude gesprek in public.wa_lijnfix_20261006_verhuisd.
-- Daarmee is alles volledig terug te draaien (zie ROLLBACK onderaan).
--
-- IDEMPOTENT: een tweede run vindt per nummer nog maar één gesprek, op de nieuwe
-- lijn → er gebeurt niets. Eén DO-block (Supabase SQL-editor: één statement =
-- één transactie; bij een fout wordt niets doorgevoerd).
--
-- VOLGORDE: na de merge van de PR (dan maakt de code zelf geen nieuwe splitsing
-- meer). Draai eerst blok 0 en bewaar de uitkomst.

-- ── 0. Vooraf (alleen lezen) ─────────────────────────────────────────────────
-- 0a. Gesprekken per lijn:
-- SELECT phone_number_id, count(*) AS gesprekken, max(last_message_at) AS laatste
--   FROM public.whatsapp_conversations
--  WHERE phone_number_id IN ('1273723375834177','758003047390806','1232908829908396','1156034510929407')
--  GROUP BY 1 ORDER BY 1;
--
-- 0b. Wat de datafix gaat doen (aantal nummers, te parkeren gesprekken, te verhuizen berichten):
-- WITH g AS (
--   SELECT id, phone_number, phone_number_id
--     FROM public.whatsapp_conversations
--    WHERE phone_number_id IN ('1273723375834177','758003047390806','1232908829908396','1156034510929407')
-- ), per AS (
--   SELECT phone_number, count(*) AS n, bool_or(phone_number_id <> '1273723375834177') AS oud
--     FROM g GROUP BY phone_number
-- )
-- SELECT
--   (SELECT count(*) FROM per WHERE n > 1 OR oud)                          AS nummers_te_verwerken,
--   (SELECT count(*) FROM per WHERE n > 1)                                 AS nummers_met_meerdere_gesprekken,
--   (SELECT coalesce(sum(n - 1), 0) FROM per WHERE n > 1)                  AS gesprekken_te_parkeren,
--   (SELECT count(*) FROM per WHERE n = 1 AND oud)                         AS gesprekken_alleen_omzetten;

-- ── 1. De datafix ────────────────────────────────────────────────────────────
DO $$
DECLARE
  nieuw   text   := '1273723375834177';
  lijnen  text[] := ARRAY['1273723375834177','758003047390806','1232908829908396','1156034510929407'];
  g       record;
  surv    uuid;
  anderen uuid[];
  n_num   int := 0;
  n_park  int := 0;
  n_msg   int := 0;
  n_sug   int := 0;
  n_om    int := 0;
  x       int;
BEGIN
  -- Backup-tabellen (blijvend; na een geslaagde controle mag Jeffrey ze droppen).
  CREATE TABLE IF NOT EXISTS public.wa_lijnfix_20261006_gesprekken (
    conversation_id uuid PRIMARY KEY, phone_number text, oud_phone_number_id text,
    oud_status text, vastgelegd_op timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS public.wa_lijnfix_20261006_verhuisd (
    tabel text NOT NULL, rij_id uuid NOT NULL, oud_conversation_id uuid NOT NULL,
    vastgelegd_op timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tabel, rij_id));
  ALTER TABLE public.wa_lijnfix_20261006_gesprekken ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.wa_lijnfix_20261006_verhuisd   ENABLE ROW LEVEL SECURITY;

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
    INSERT INTO public.wa_lijnfix_20261006_gesprekken (conversation_id, phone_number, oud_phone_number_id, oud_status)
      SELECT id, phone_number, phone_number_id, status FROM public.whatsapp_conversations WHERE id = ANY(g.ids)
      ON CONFLICT (conversation_id) DO NOTHING;

    IF array_length(anderen, 1) IS NOT NULL THEN
      -- 2. Berichten + suggesties naar de overlever (eerst vastleggen waar ze vandaan komen).
      INSERT INTO public.wa_lijnfix_20261006_verhuisd (tabel, rij_id, oud_conversation_id)
        SELECT 'whatsapp_messages', id, conversation_id FROM public.whatsapp_messages WHERE conversation_id = ANY(anderen)
        ON CONFLICT DO NOTHING;
      INSERT INTO public.wa_lijnfix_20261006_verhuisd (tabel, rij_id, oud_conversation_id)
        SELECT 'joost_suggestions', id, conversation_id FROM public.joost_suggestions WHERE conversation_id = ANY(anderen)
        ON CONFLICT DO NOTHING;
      UPDATE public.whatsapp_messages SET conversation_id = surv WHERE conversation_id = ANY(anderen);
      GET DIAGNOSTICS x = ROW_COUNT; n_msg := n_msg + x;
      UPDATE public.joost_suggestions SET conversation_id = surv WHERE conversation_id = ANY(anderen);
      GET DIAGNOSTICS x = ROW_COUNT; n_sug := n_sug + x;

      -- 3. Samenvattende velden op de overlever.
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

      -- 4. Parkeren (niet verwijderen).
      UPDATE public.whatsapp_conversations
         SET phone_number_id      = 'samengevoegd:' || id::text,
             status               = 'archived',
             unread_count         = 0,
             last_message_preview = 'Samengevoegd in gesprek ' || surv::text
       WHERE id = ANY(anderen);
      GET DIAGNOSTICS x = ROW_COUNT; n_park := n_park + x;
    END IF;

    -- 5. Overlever naar de huidige lijn.
    UPDATE public.whatsapp_conversations SET phone_number_id = nieuw
     WHERE id = surv AND phone_number_id IS DISTINCT FROM nieuw;
    GET DIAGNOSTICS x = ROW_COUNT; n_om := n_om + x;
  END LOOP;

  RAISE NOTICE 'nummers verwerkt: %, gesprekken naar nieuwe lijn: %, gesprekken geparkeerd: %, berichten verhuisd: %, suggesties verhuisd: %',
    n_num, n_om, n_park, n_msg, n_sug;
END $$;

-- ── 2. Controle (alleen lezen) ───────────────────────────────────────────────
-- 2a. Geen lead-gesprekken meer op de oude lijnen (verwacht: 0 rijen):
-- SELECT phone_number_id, count(*) FROM public.whatsapp_conversations
--  WHERE phone_number_id IN ('758003047390806','1232908829908396','1156034510929407') GROUP BY 1;
--
-- 2b. Per nummer hooguit één gesprek op de nieuwe lijn (verwacht: 0 rijen):
-- SELECT phone_number, count(*) FROM public.whatsapp_conversations
--  WHERE phone_number_id = '1273723375834177' GROUP BY 1 HAVING count(*) > 1;
--
-- 2c. Geparkeerde gesprekken hebben geen berichten meer (verwacht: 0):
-- SELECT count(*) FROM public.whatsapp_messages m
--   JOIN public.whatsapp_conversations c ON c.id = m.conversation_id
--  WHERE c.phone_number_id LIKE 'samengevoegd:%';

-- ── ROLLBACK (volledig, met de backup-tabellen) ──────────────────────────────
-- Draai in deze volgorde (losse statements):
-- UPDATE public.whatsapp_messages m SET conversation_id = v.oud_conversation_id
--   FROM public.wa_lijnfix_20261006_verhuisd v WHERE v.tabel = 'whatsapp_messages' AND m.id = v.rij_id;
-- UPDATE public.joost_suggestions j SET conversation_id = v.oud_conversation_id
--   FROM public.wa_lijnfix_20261006_verhuisd v WHERE v.tabel = 'joost_suggestions' AND j.id = v.rij_id;
-- UPDATE public.whatsapp_conversations c SET phone_number_id = b.oud_phone_number_id, status = b.oud_status
--   FROM public.wa_lijnfix_20261006_gesprekken b WHERE c.id = b.conversation_id;
-- (De samenvattende velden van de overlever — laatste activiteit, ongelezen,
--  preview — blijven dan op de samengevoegde waarde staan; dat is cosmetisch.)
--
-- Opruimen na een geslaagde controle (2a–2c) en een paar dagen meekijken:
-- DROP TABLE public.wa_lijnfix_20261006_verhuisd;
-- DROP TABLE public.wa_lijnfix_20261006_gesprekken;
