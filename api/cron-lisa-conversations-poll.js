// api/cron-lisa-conversations-poll.js
//
// Vangnet-cron voor Lisa/Instagram inbound-berichten (elke 15 min).
// Pollt de GHL-API voor Instagram-conversaties + messages en spiegelt die
// PUUR-INGEST naar `lisa_conversations` + `lisa_messages`. Vangt gemiste
// webhook-events op (bv. Instagram-account tijdelijk losgekoppeld — 6 aug
// 2026 stilte).
//
// ABSOLUUT GEEN uitgaande DM's, GEEN AI-respond, GEEN follow-up-scheduling.
// Alleen zichtbaarheid herstellen. Onafhankelijk van `lisa_settings.live_mode_enabled`.
//
// Dedup-sleutel: `lisa_messages.ghl_message_id` (partial unique index
// `idx_lisa_msg_ghl`, migratie 003). Idempotent bij re-runs.
//
// Backfill: watermark = MAX(sent_at) van bestaande lisa_messages met
// ghl_message_id, minus 60 min veiligheid. Bij eerste run met stilte sinds
// 6 aug → begint daarvandaan en pagineert vooruit tot Vercel-timeout, dan
// pakt de volgende cron-tick verder op (dedup zorgt dat we niks dubbel
// invoegen).
//
// Schedule: */15 * * * *  (path /api/cron-lisa-conversations-poll)
// Auth: CRON_SECRET via Authorization header (of Vercel cron intern).

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { resolveContent } from './_lib/lisa-message-type.js';

const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION  = '2021-04-15';
const ABORT_MS     = 25_000;                     // Vercel default 30s
const MSG_PAGE     = 100;                        // /conversations/{id}/messages
const FALLBACK_START        = '2026-08-06T00:00:00Z';  // informatief — watermark bij lege DB
const FALLBACK_MAX_CONTACTS = 500;                // per run bij per-contact iteratie

// Round-robin cursor in app_settings. Elke run behandelt contacten met
// `id > cursor.last_contact_id` in stabiele `id asc`-volgorde. Bij einde-lijst
// wrapt de cursor terug naar null (nieuwe passe). Zonder deze cursor zou de
// poll steeds dezelfde eerste ~20 herkauwen, omdat de DB-trigger
// update_lisa_conv_timestamps() `last_message_at` op de conv bijwerkt bij elke
// message-insert → gebackfillde contacten zouden bovenaan blijven staan bij
// een `last_message_at desc`-sort.
const CURSOR_KEY = 'lisa_ig_poll_cursor';

async function readCursor() {
  try {
    const { data, error } = await supabaseAdmin
      .from('app_settings').select('value').eq('key', CURSOR_KEY).maybeSingle();
    if (error) { console.warn('[lisa-poll] cursor read:', error.message); return null; }
    const v = data?.value;
    if (v && typeof v === 'object') return v;
    return null;
  } catch (e) { console.warn('[lisa-poll] cursor read exception:', e?.message || e); return null; }
}

async function writeCursor(value) {
  try {
    const row = { key: CURSOR_KEY, value, updated_by_user_id: null };
    const { data: existing } = await supabaseAdmin
      .from('app_settings').select('key').eq('key', CURSOR_KEY).maybeSingle();
    if (existing) {
      const { error } = await supabaseAdmin.from('app_settings').update(row).eq('key', CURSOR_KEY);
      if (error) console.warn('[lisa-poll] cursor update:', error.message);
    } else {
      const { error } = await supabaseAdmin.from('app_settings').insert(row);
      if (error) console.warn('[lisa-poll] cursor insert:', error.message);
    }
  } catch (e) { console.warn('[lisa-poll] cursor write exception:', e?.message || e); }
}

// GHL levert bij IG Instagram-messages typisch als `messageType` = TYPE_INSTAGRAM_MESSAGE
// (of TYPE_IG / IG in oudere payloads). We tolereren varianten omdat de exacte
// naam per GHL API-versie kan drijven; niet-IG wordt geskipt (zie isInstagram).
function isInstagram(msgOrConv) {
  const raw = String(
    msgOrConv?.messageType
    || msgOrConv?.type
    || msgOrConv?.lastMessageType
    || ''
  ).toLowerCase();
  return raw.includes('instagram') || raw === 'ig' || raw === 'type_ig';
}

function detectDirection(msg) {
  const dir = String(msg?.direction || '').toLowerCase();
  if (dir === 'inbound' || dir === 'in') return 'in';
  if (dir === 'outbound' || dir === 'out') return 'out';
  const type = String(msg?.type || '').toLowerCase();
  if (type.includes('inbound')) return 'in';
  if (type.includes('outbound')) return 'out';
  // Heuristiek: userId zonder contactId = outbound (door user verstuurd).
  if (msg?.userId && !msg?.contactId) return 'out';
  return null;
}

async function ghlFetch(url) {
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.GHL_API_KEY}`,
      Version:       GHL_VERSION,
      Accept:        'application/json',
    },
  });
}

// Lookup of create een lisa_conversations-rij per ghl_contact_id. Alleen aan
// te roepen voor live conversaties (is_sandbox=false). Geeft { id } terug of
// null bij fout. Fail-soft.
async function ensureConversation({ contactId, ghlConversationId, locationId, contactName }) {
  try {
    const { data: existing, error: selErr } = await supabaseAdmin
      .from('lisa_conversations')
      .select('id')
      .eq('ghl_contact_id', contactId)
      .eq('is_sandbox', false)
      .maybeSingle();
    if (selErr) { console.warn('[lisa-poll] conv select:', selErr.message); return null; }
    if (existing && existing.id) return existing;

    // Create — nieuwe conv uit poll = cold historisch (geen actieve intake).
    // phase='cold' voorkomt dat het rijtje in KPI's als "actieve intro" telt.
    const { data: created, error: insErr } = await supabaseAdmin
      .from('lisa_conversations')
      .insert({
        ghl_contact_id:      contactId,
        ghl_conversation_id: ghlConversationId || null,
        ghl_location_id:     locationId || null,
        contact_name:        contactName || null,
        source:              'instagram',
        is_sandbox:          false,
        phase:               'cold',
        first_message_at:    new Date().toISOString(),
      })
      .select('id')
      .single();
    if (insErr) { console.warn('[lisa-poll] conv insert:', insErr.message); return null; }
    return created;
  } catch (e) {
    console.warn('[lisa-poll] ensureConversation exception:', e?.message || e);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  if (!process.env.GHL_API_KEY || !process.env.GHL_LOCATION_ID) {
    return res.status(500).json({ error: 'GHL_API_KEY of GHL_LOCATION_ID niet geconfigureerd.' });
  }

  const startTime = Date.now();
  const stats = {
    strategy:            'per_contact',
    watermark:           null,
    cursor_start:        null,           // id waar we deze run begonnen (na skip)
    cursor_end:          null,           // id van laatst behandelde contact
    wrapped:             false,          // true als we in deze run terug naar null gingen
    contacts_iterated:   0,
    messages_seen:       0,
    messages_upserted:   0,
    conversations_created: 0,
    dedup_skipped:       0,
    errors:              0,
    aborted:             false,
  };

  try {
    // 1. Bepaal watermark = MAX(sent_at) uit lisa_messages met ghl_message_id.
    //    Minus 60 min voor overlap-veiligheid. Bij lege DB → FALLBACK_START.
    const { data: latest } = await supabaseAdmin
      .from('lisa_messages')
      .select('sent_at')
      .not('ghl_message_id', 'is', null)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const latestIso = latest?.sent_at || FALLBACK_START;
    const watermarkMs = Math.max(0, new Date(latestIso).getTime() - 60 * 60 * 1000);
    const watermark = new Date(watermarkMs).toISOString();
    stats.watermark = watermark;

    // 2. Per-contact PRIMAIR pad: iterateer bekende ghl_contact_ids uit
    //    lisa_conversations. Nodig omdat GHL's /conversations/search
    //    `lastMessageType=TYPE_INSTAGRAM`-filter negeert (retourneert de 1000
    //    nieuwste over ALLE kanalen). Per-contact target precies onze
    //    bestaande IG-gesprekken — inclusief de bevroren-sinds-6-aug set die
    //    onder het scan-venster van bulk-search zou vallen.
    //
    //    Nadeel: vangt geen gloednieuwe IG-contacts op die nog niet in
    //    lisa_conversations staan. Voor die groep werkt de webhook (en de
    //    live_mode_off-ingest-branch die inbound tóch opslaat zodra GHL
    //    weer pusht).
    //
    //    Forward-progress-garantie: stabiele sort op `id asc` + round-robin-
    //    cursor in app_settings. `last_message_at desc` zou steeds dezelfde
    //    top-N herkauwen omdat de DB-trigger last_message_at bijwerkt bij
    //    elke message-insert → gebackfillde contacten glijden naar de top en
    //    verhinderen dat de onbehandelde contacten aan de beurt komen.
    {
      const cursor  = await readCursor();
      const startId = cursor?.last_contact_id || null;
      stats.cursor_start = startId;

      let q = supabaseAdmin
        .from('lisa_conversations')
        .select('id, ghl_contact_id')
        .eq('is_sandbox', false)
        .not('ghl_contact_id', 'is', null)
        .order('id', { ascending: true })
        .limit(FALLBACK_MAX_CONTACTS);
      if (startId) q = q.gt('id', startId);

      let { data: knownConvs, error: kcErr } = await q;
      if (kcErr) {
        console.error('[lisa-poll] known-convs select:', kcErr.message);
        stats.errors++;
      }

      // Wrap-around: cursor was gezet en er zit niks meer na → reset naar null
      // en herstart vanaf het begin binnen dezelfde run (blijft binnen ABORT_MS).
      if (startId && (!knownConvs || knownConvs.length === 0)) {
        stats.wrapped = true;
        await writeCursor({ last_contact_id: null, wrapped_at: new Date().toISOString() });
        const { data: fromStart, error: fsErr } = await supabaseAdmin
          .from('lisa_conversations')
          .select('id, ghl_contact_id')
          .eq('is_sandbox', false)
          .not('ghl_contact_id', 'is', null)
          .order('id', { ascending: true })
          .limit(FALLBACK_MAX_CONTACTS);
        if (fsErr) { console.error('[lisa-poll] wrap select:', fsErr.message); stats.errors++; }
        knownConvs = fromStart || [];
      }

      let lastProcessedId = startId;

      for (const kc of (knownConvs || [])) {
        if (Date.now() - startTime > ABORT_MS) { stats.aborted = true; break; }
        const contactId = kc.ghl_contact_id;
        if (!contactId) continue;
        stats.contacts_iterated++;
        lastProcessedId = kc.id;

        // Per-contact search (zelfde patroon als follow-up-ghl-conversations-poll).
        const csUrl = new URL(`${GHL_API_BASE}/conversations/search`);
        csUrl.searchParams.set('locationId', process.env.GHL_LOCATION_ID);
        csUrl.searchParams.set('contactId',  contactId);
        csUrl.searchParams.set('limit',      '5');

        let csRes;
        try { csRes = await ghlFetch(csUrl.toString()); }
        catch (e) { console.warn('[lisa-poll fallback] search:', contactId, e?.message || e); stats.errors++; continue; }
        if (!csRes.ok) {
          const errText = await csRes.text().catch(() => '');
          console.warn('[lisa-poll fallback] search HTTP', csRes.status, contactId, errText.slice(0, 160));
          stats.errors++;
          continue;
        }
        const csData = await csRes.json().catch(() => ({}));
        const conversations = csData.conversations || csData.data || [];

        for (const convo of conversations) {
          const convId = convo.id;
          if (!convId) continue;

          const msgUrl = `${GHL_API_BASE}/conversations/${convId}/messages?limit=${MSG_PAGE}`;
          let msgRes;
          try { msgRes = await ghlFetch(msgUrl); }
          catch (e) { console.warn('[lisa-poll fallback] msgs:', convId, e?.message || e); stats.errors++; continue; }
          if (!msgRes.ok) {
            const errText = await msgRes.text().catch(() => '');
            console.warn('[lisa-poll fallback] msgs HTTP', msgRes.status, convId, errText.slice(0, 160));
            stats.errors++;
            continue;
          }
          const msgData = await msgRes.json().catch(() => ({}));
          const messages = msgData.messages?.messages || msgData.messages || msgData.data || [];

          let lisaConvId = null;
          for (const msg of messages) {
            stats.messages_seen++;
            if (!isInstagram(msg)) continue;

            const ghlMsgId = msg.id || msg.messageId;
            if (!ghlMsgId) continue;

            const direction = detectDirection(msg);
            if (!direction) continue;

            // BP3 (2026-09-01) fix #1 — media-berichten (geen tekst-body)
            // niet meer skippen. resolveContent geeft altijd een geldige
            // combinatie { message_type <whitelist>, content <niet-leeg>,
            // attachment_url <string|null> }. Attachments-array uit GHL-API
            // wordt door parseAttachments in de helper geparsed.
            const { message_type: msgType, content: msgContent, attachment_url: msgAttachmentUrl } = resolveContent(msg);

            const sentAt = msg.dateAdded || msg.dateCreated || msg.createdAt || new Date().toISOString();

            // Vroegtijdig dedupe zodat we onnodige INSERTs sparen; de
            // ON CONFLICT hieronder is race-safety.
            const { data: dupe } = await supabaseAdmin
              .from('lisa_messages').select('id')
              .eq('ghl_message_id', ghlMsgId).limit(1).maybeSingle();
            if (dupe) { stats.dedup_skipped++; continue; }

            if (!lisaConvId) {
              const ensured = await ensureConversation({
                contactId,
                ghlConversationId: convId,
                locationId:        convo.locationId || process.env.GHL_LOCATION_ID,
                contactName:       convo.fullName || convo.contactName || null,
              });
              if (!ensured?.id) { stats.errors++; continue; }
              lisaConvId = ensured.id;
            }

            // BP3 v5 (2026-09-02) — .insert() met 23505-catch i.p.v. .upsert()
            // met onConflict-hint. PostgREST accepteert partial UNIQUE-index
            // (WHERE ghl_message_id IS NOT NULL) niet betrouwbaar als
            // on-conflict-target (42P10) — silent-failure. Nu:
            //   - error.code '23505' → duplicate (tel als dedup_skipped, geen fout)
            //   - andere error → console.error met code/message/details/hint
            const { error: insErr } = await supabaseAdmin.from('lisa_messages').insert({
              conversation_id: lisaConvId,
              direction,
              content:         msgContent,
              message_type:    msgType,
              attachment_url:  msgAttachmentUrl,
              sent_at:         sentAt,
              ai_generated:    false,
              ghl_message_id:  ghlMsgId,
            });
            if (insErr) {
              if (insErr.code === '23505') {
                stats.dedup_skipped++;
                continue;
              }
              console.error('[lisa-poll] insert faalde:',
                insErr.code, insErr.message, insErr.details || '', insErr.hint || '',
                { ghl_message_id: ghlMsgId, conv_id: lisaConvId, message_type: msgType });
              stats.errors++;
              continue;
            }
            stats.messages_upserted++;
          }
        }
      }

      // Persist cursor voor de volgende cron-run. Update ALTIJD (ook bij abort),
      // want lastProcessedId is de laatste contact die we daadwerkelijk in de
      // loop hebben aangeraakt. Bij lege lijst zonder wrap: laat cursor staan.
      if (lastProcessedId && lastProcessedId !== startId) {
        stats.cursor_end = lastProcessedId;
        await writeCursor({
          last_contact_id: lastProcessedId,
          updated_at:      new Date().toISOString(),
        });
      } else {
        stats.cursor_end = startId;
      }
    }

    stats.duration_ms = Date.now() - startTime;
    console.log('[lisa-poll] done:', JSON.stringify(stats));
    return res.status(200).json(stats);
  } catch (err) {
    console.error('[lisa-poll] fatal:', err?.message || err);
    return res.status(500).json({ error: err?.message || String(err), ...stats, duration_ms: Date.now() - startTime });
  }
}
