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

const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION  = '2021-04-15';
const ABORT_MS     = 25_000;                     // Vercel default 30s
const MSG_PAGE     = 100;                        // /conversations/{id}/messages
const FALLBACK_START        = '2026-08-06T00:00:00Z';  // informatief — watermark bij lege DB
const FALLBACK_MAX_CONTACTS = 500;                // per run bij per-contact iteratie

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
    strategy:            'per_contact',   // 2026-08-24: search-filter TYPE_INSTAGRAM
                                          // wordt door GHL genegeerd (retourneert alle
                                          // kanalen); per-contact over bekende
                                          // lisa_conversations is het enige betrouwbare
                                          // pad voor de bevroren-sinds-6-aug IG-set.
    watermark:           null,
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
    {
      const { data: knownConvs, error: kcErr } = await supabaseAdmin
        .from('lisa_conversations')
        .select('ghl_contact_id, last_message_at')
        .eq('is_sandbox', false)
        .not('ghl_contact_id', 'is', null)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(FALLBACK_MAX_CONTACTS);
      if (kcErr) {
        console.error('[lisa-poll fallback] known-convs select:', kcErr.message);
        stats.errors++;
      }

      for (const kc of (knownConvs || [])) {
        if (Date.now() - startTime > ABORT_MS) { stats.aborted = true; break; }
        const contactId = kc.ghl_contact_id;
        if (!contactId) continue;
        stats.contacts_iterated++;

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

            const content = msg.body || msg.text || msg.message || '';
            if (!content || !String(content).trim()) continue;

            const sentAt = msg.dateAdded || msg.dateCreated || msg.createdAt || new Date().toISOString();

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

            const { error: insErr } = await supabaseAdmin.from('lisa_messages').insert({
              conversation_id: lisaConvId,
              direction,
              content:         String(content),
              sent_at:         sentAt,
              ai_generated:    false,
              ghl_message_id:  ghlMsgId,
            });
            if (insErr) { console.warn('[lisa-poll fallback] msg insert:', ghlMsgId, insErr.message); stats.errors++; continue; }
            stats.messages_upserted++;
          }
        }
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
