// api/inbox-webhook.js
// Webhook-endpoint voor Meta WhatsApp Cloud API. Twee modes:
//
//   GET  ?hub.mode=subscribe&hub.verify_token=X&hub.challenge=Y
//        Meta-subscription handshake. Echo `hub.challenge` als token klopt,
//        anders 403. Plain-text response.
//
//   POST { object, entry: [{ id, changes: [{ field, value }] }] }
//        Meta levert inbound messages + status-updates (sent/delivered/read/
//        failed). PR A2 implementeert: persist whatsapp_messages + update
//        whatsapp_conversations + customer match op phone_number.
//
// Belangrijk: voor X-Hub-Signature-256 verificatie hebben we de RAW request
// body nodig. Vercel parsed standaard de JSON, dus disable bodyParser en
// lees de body handmatig als string.
//
// MOCK MODE: voor lokale curl-tests + preview-deploys met fake Meta-payloads
// kan signature-check geskipt worden via MOCK_MODE=true. Defense-in-depth:
// NOOIT actief op production (VERCEL_ENV==='production' overrided ALTIJD,
// ongeacht MOCK_MODE waarde).
//
// IDEMPOTENCY: Meta retried bij timeout/non-2xx. We gebruiken meta_wamid
// UNIQUE constraint op whatsapp_messages → dubbele inserts falen stil.
// Conversation upsert is 2-step (select-then-update/insert) zodat we
// concurrent webhooks veilig kunnen samenvoegen.

import { verifyWebhookSubscription, verifyWebhookSignature } from './_lib/meta-whatsapp.js';
import { supabaseAdmin } from './supabase.js';
import { getClientIp } from './_lib/audit-customer.js';

// Vercel-eis: bodyParser uit zodat we de raw body kunnen lezen voor HMAC.
export const config = {
  api: {
    bodyParser: false,
  },
};

/**
 * Helper: lees de request body als string (raw).
 */
async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end',  ()    => resolve(Buffer.concat(chunks)));
    req.on('error', err  => reject(err));
  });
}

// ── Helpers: phone normalisatie ────────────────────────────────────────────
/**
 * Meta levert inbound 'from' in E.164 ZONDER + (bv. '31612345678').
 * We slaan op met + zodat het matched met onze klanten-DB conventie.
 */
function toE164Plus(metaNumber) {
  if (!metaNumber) return '';
  const s = String(metaNumber).trim();
  return s.startsWith('+') ? s : '+' + s;
}

/**
 * Strip alles behalve cijfers + leading '+' (gelijk aan customer-check-duplicate.js).
 * Voor server-side filter op customers.phone (klant-input is vrij geformatteerd).
 */
function normalizePhone(s) {
  if (!s) return '';
  return String(s).replace(/[^\d+]/g, '');
}

/**
 * Zoek klant op phone-number. Returnt customer.id bij exact 1 match.
 * Bij 0 of >1 matches: returnt null (UI moet handmatig koppelen).
 *
 * Strategie: fetch active customers met non-null phone, filter client-side
 * op genormaliseerd-equals. Trade-off zoals customer-check-duplicate.js:
 * over-fetch is acceptabel voor MVP (klantbestand < 5k).
 */
async function findCustomerByPhone(phoneE164Plus) {
  const target = normalizePhone(phoneE164Plus);
  if (!target) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from('customers')
      .select('id, phone')
      .not('phone', 'is', null)
      .is('archived_at', null)
      .is('anonymized_at', null);
    if (error) {
      console.error('[inbox-webhook] customer phone-fetch fail:', error.message);
      return null;
    }
    const matches = (data || []).filter(c => normalizePhone(c.phone) === target);
    if (matches.length === 1) return matches[0].id;
    return null;
  } catch (e) {
    console.error('[inbox-webhook] findCustomerByPhone exception:', e.message);
    return null;
  }
}

/**
 * Audit-log helper (fail-soft). Schrijf event naar audit_log tabel.
 * user_id is altijd NULL — webhook draait zonder user-session.
 */
async function logInboxAudit(req, { action, entityType, entityId, afterJson }) {
  try {
    const { error } = await supabaseAdmin.from('audit_log').insert({
      user_id:     null,
      action,
      entity_type: entityType,
      entity_id:   entityId,
      after_json:  afterJson || null,
      ip_address:  getClientIp(req),
    });
    if (error) console.error('[inbox-webhook] audit', action, 'insert failed:', error.message);
  } catch (e) {
    console.error('[inbox-webhook] audit', action, 'exception:', e && e.message);
  }
}

// ── Helpers: conversation upsert ───────────────────────────────────────────
/**
 * Upsert whatsapp_conversations op phone_number. 2-step pattern (SELECT
 * → UPDATE/INSERT) i.p.v. ON CONFLICT, omdat lesson learned 20 mei: bij
 * partial unique index kan ON CONFLICT niet als arbiter; veiliger pattern
 * generaliseert ook hier.
 *
 * Returnt { id, created } — created=true bij nieuwe conversation (voor audit-log).
 */
async function upsertConversation(req, { phoneE164Plus, displayName, inboundTimestamp, previewText, phoneNumberId }) {
  // 1. Bestaande conversation ophalen
  const { data: existing, error: selErr } = await supabaseAdmin
    .from('whatsapp_conversations')
    .select('id, customer_id, unread_count, phone_number_id')
    .eq('phone_number', phoneE164Plus)
    .maybeSingle();
  if (selErr) {
    console.error('[inbox-webhook] conv select fail:', selErr.message);
    throw selErr;
  }

  const preview = previewText ? String(previewText).slice(0, 120) : null;
  const tsIso = inboundTimestamp ? inboundTimestamp.toISOString() : new Date().toISOString();

  if (existing) {
    // 2a. UPDATE — bestaande conversation
    const newUnread = (existing.unread_count || 0) + 1;
    const updatePayload = {
      last_message_at:      tsIso,
      last_message_preview: preview,
      unread_count:         newUnread,
      last_inbound_at:      tsIso,
    };
    if (displayName) updatePayload.display_name = displayName;
    // phone_number_id: preserve original mapping — alleen zetten als nog NULL.
    // Bij multi-line setup is de eerst-binnenkomende lijn leidend; switchen
    // zou outbound-routing breken (we sturen terug via dezelfde lijn).
    if (phoneNumberId && !existing.phone_number_id) {
      updatePayload.phone_number_id = phoneNumberId;
    }
    const { error: updErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .update(updatePayload)
      .eq('id', existing.id);
    if (updErr) {
      console.error('[inbox-webhook] conv update fail:', updErr.message);
      throw updErr;
    }
    return { id: existing.id, created: false, customerId: existing.customer_id };
  }

  // 2b. INSERT — nieuwe conversation, probeer direct customer-match
  const customerId = await findCustomerByPhone(phoneE164Plus);
  const insertPayload = {
    phone_number:         phoneE164Plus,
    phone_number_id:      phoneNumberId || null,
    display_name:         displayName || null,
    customer_id:          customerId,
    status:               'open',
    last_message_at:      tsIso,
    last_message_preview: preview,
    unread_count:         1,
    last_inbound_at:      tsIso,
  };
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('whatsapp_conversations')
    .insert(insertPayload)
    .select('id')
    .single();
  if (insErr) {
    // Race condition: andere webhook insertte intussen. Re-select.
    if (insErr.code === '23505') {
      const { data: again } = await supabaseAdmin
        .from('whatsapp_conversations')
        .select('id, customer_id')
        .eq('phone_number', phoneE164Plus)
        .maybeSingle();
      if (again) return { id: again.id, created: false, customerId: again.customer_id };
    }
    console.error('[inbox-webhook] conv insert fail:', insErr.message);
    throw insErr;
  }

  // Audit: conversation created (alleen 1e keer)
  await logInboxAudit(req, {
    action:     'whatsapp.conversation_created',
    entityType: 'whatsapp_conversation',
    entityId:   inserted.id,
    afterJson:  {
      phone_number:    phoneE164Plus,
      phone_number_id: phoneNumberId || null,
      customer_id:     customerId,
      display_name:    displayName || null,
    },
  });
  if (customerId) {
    await logInboxAudit(req, {
      action:     'whatsapp.customer_auto_matched',
      entityType: 'whatsapp_conversation',
      entityId:   inserted.id,
      afterJson:  { customer_id: customerId, match_reason: 'phone_exact' },
    });
  }

  return { id: inserted.id, created: true, customerId };
}

// ── Helpers: message persist ───────────────────────────────────────────────
/**
 * Insert inbound message, idempotent op meta_wamid UNIQUE constraint.
 * Returnt true bij nieuwe insert, false bij duplicate (Meta retry).
 */
async function insertInboundMessage(conversationId, msg) {
  const wamid = msg.id;
  const type  = msg.type || 'text';
  let body = null;
  let mediaUrl = null;
  let mediaType = null;

  if (type === 'text') {
    body = msg.text?.body || null;
  } else if (type === 'image' || type === 'document' || type === 'audio' || type === 'video' || type === 'sticker') {
    mediaType = type;
    // Meta levert media-id; resolve naar URL is een aparte Graph API call.
    // PR A2: alleen id loggen in body, later (PR A3) media-fetch implementeren.
    body = msg[type]?.caption || null;
    mediaUrl = msg[type]?.id ? `meta-media-id:${msg[type].id}` : null;
  } else if (type === 'button') {
    body = msg.button?.text || null;
  } else if (type === 'interactive') {
    body = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || null;
  } else {
    // Unknown type: log raw payload als body voor debugging
    body = `[${type}] ` + JSON.stringify(msg[type] || {}).slice(0, 200);
  }

  const tsIso = msg.timestamp
    ? new Date(parseInt(msg.timestamp, 10) * 1000).toISOString()
    : new Date().toISOString();

  const { error } = await supabaseAdmin
    .from('whatsapp_messages')
    .insert({
      conversation_id: conversationId,
      direction:       'in',
      meta_wamid:      wamid,
      body,
      media_url:       mediaUrl,
      media_type:      mediaType,
      status:          'delivered',  // inbound is per definitie geleverd aan ons
      delivered_at:    tsIso,
      created_at:      tsIso,
    });
  if (error) {
    // UNIQUE violation op meta_wamid → Meta retry, geen écht probleem
    if (error.code === '23505') return false;
    console.error('[inbox-webhook] msg insert fail wamid=' + wamid + ':', error.message);
    throw error;
  }
  return true;
}

/**
 * Verwerk een status-update (sent/delivered/read/failed) op een outbound msg.
 * Status monotoon: alleen upgraden (sent < delivered < read). Bij failed: log
 * errors[]-payload in failed_reason.
 */
async function applyStatusUpdate(statusObj) {
  const wamid = statusObj.id;
  const newStatus = statusObj.status; // 'sent' | 'delivered' | 'read' | 'failed'
  if (!wamid || !newStatus) return false;

  const tsIso = statusObj.timestamp
    ? new Date(parseInt(statusObj.timestamp, 10) * 1000).toISOString()
    : new Date().toISOString();

  // Order voor monotone check
  const order = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 99 };

  // Huidige msg ophalen
  const { data: msg, error: selErr } = await supabaseAdmin
    .from('whatsapp_messages')
    .select('id, status')
    .eq('meta_wamid', wamid)
    .maybeSingle();
  if (selErr) {
    console.error('[inbox-webhook] status select fail wamid=' + wamid + ':', selErr.message);
    return false;
  }
  if (!msg) {
    // Status komt soms binnen vóór de outbound-send response wamid in onze DB
    // heeft geupdated. PR A2: log + skip; PR A3 kan dit bufferen.
    console.warn('[inbox-webhook] status for unknown wamid=' + wamid + ' (no msg)');
    return false;
  }

  const cur = order[msg.status] ?? -1;
  const next = order[newStatus] ?? -1;
  // Failed kan ALTIJD; anders alleen forward
  if (newStatus !== 'failed' && next <= cur) return false;

  const updatePayload = { status: newStatus };
  if (newStatus === 'sent')      updatePayload.sent_at = tsIso;
  if (newStatus === 'delivered') updatePayload.delivered_at = tsIso;
  if (newStatus === 'read')      updatePayload.read_at = tsIso;
  if (newStatus === 'failed') {
    const reason = Array.isArray(statusObj.errors) && statusObj.errors.length
      ? statusObj.errors.map(e => `[${e.code}] ${e.title || e.message || ''}`).join('; ')
      : 'unknown';
    updatePayload.failed_reason = reason.slice(0, 500);
  }

  const { error: updErr } = await supabaseAdmin
    .from('whatsapp_messages')
    .update(updatePayload)
    .eq('id', msg.id);
  if (updErr) {
    console.error('[inbox-webhook] status update fail wamid=' + wamid + ':', updErr.message);
    return false;
  }
  return true;
}

// ── Main handler ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // GET: Meta subscription verify
  if (req.method === 'GET') {
    try {
      const challenge = verifyWebhookSubscription(req.query || {});
      if (challenge === null) {
        console.warn('[inbox-webhook] GET verify rejected (mode/token mismatch)');
        res.setHeader('Content-Type', 'text/plain');
        return res.status(403).send('Forbidden');
      }
      console.log('[inbox-webhook] GET verify OK');
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send(challenge);
    } catch (e) {
      console.error('[inbox-webhook] GET verify config-fout:', e.message);
      res.setHeader('Content-Type', 'text/plain');
      return res.status(503).send('Webhook not configured');
    }
  }

  // POST: Meta inbound delivery
  if (req.method === 'POST') {
    let rawBody;
    try { rawBody = await readRawBody(req); }
    catch (e) {
      console.error('[inbox-webhook] readRawBody fout:', e.message);
      return res.status(400).json({ error: 'bad request body' });
    }

    // MOCK MODE guard: alleen op non-production deploys met expliciete env-var.
    const isProd        = process.env.VERCEL_ENV === 'production';
    const isMockAllowed = !isProd && process.env.MOCK_MODE === 'true';

    if (isMockAllowed) {
      console.warn('[inbox-webhook] MOCK MODE active — signature check skipped (VERCEL_ENV=' + (process.env.VERCEL_ENV || 'unset') + ')');
    } else {
      // Signature-verificatie (verplicht op production en bij ontbreken MOCK_MODE)
      const sigHeader = req.headers['x-hub-signature-256'] || null;
      let signatureOk = false;
      try {
        signatureOk = verifyWebhookSignature(sigHeader, rawBody);
      } catch (e) {
        console.warn('[inbox-webhook] POST signature config-fout:', e.message);
        return res.status(503).json({ error: 'webhook signature not configured' });
      }
      if (!signatureOk) {
        console.warn('[inbox-webhook] POST signature mismatch - rejected');
        return res.status(403).json({ error: 'invalid signature' });
      }
    }

    // Parse JSON
    let body = null;
    try { body = JSON.parse(rawBody.toString('utf8')); } catch (e) {
      console.error('[inbox-webhook] JSON parse fail:', e.message);
      // Return 200 zodat Meta niet retried op invalid JSON (zou eindeloos doorgaan)
      return res.status(200).json({ ok: true, parsed: false });
    }

    // Process entries: per change.value: messages[] + statuses[]
    // CRITICAL: per-item try/catch + ALTIJD 200 returnen, ook bij partiele fail,
    // anders retried Meta de hele batch en triggeren we duplicate-processing.
    let stats = { msgs_new: 0, msgs_dup: 0, statuses_updated: 0, errors: 0 };

    try {
      const entries = Array.isArray(body?.entry) ? body.entry : [];
      for (const entry of entries) {
        const changes = Array.isArray(entry?.changes) ? entry.changes : [];
        for (const change of changes) {
          if (change?.field !== 'messages') continue;
          const value = change.value || {};
          const contacts = Array.isArray(value.contacts) ? value.contacts : [];
          const messages = Array.isArray(value.messages) ? value.messages : [];
          const statuses = Array.isArray(value.statuses) ? value.statuses : [];
          // value.metadata levert phone_number_id van de WABA-lijn die het
          // bericht ontving + display_phone_number (zonder +). We bewaren
          // phone_number_id op de conversation zodat we outbound antwoorden
          // via dezelfde lijn kunnen sturen (module-scoping).
          const metadata = value.metadata || {};
          const recvPhoneNumberId = metadata.phone_number_id
            ? String(metadata.phone_number_id)
            : null;

          // ── Inbound messages ─────────────────────────────────────────────
          for (const msg of messages) {
            try {
              const fromRaw = msg.from;
              if (!fromRaw) {
                console.warn('[inbox-webhook] msg without .from skipped wamid=' + (msg.id || '?'));
                continue;
              }
              const phoneE164Plus = toE164Plus(fromRaw);
              // Display name uit contacts[] (match op wa_id)
              const contact = contacts.find(c => c?.wa_id === fromRaw);
              const displayName = contact?.profile?.name || null;
              const tsDate = msg.timestamp
                ? new Date(parseInt(msg.timestamp, 10) * 1000)
                : new Date();
              const preview = (msg.text?.body)
                || (msg[msg.type]?.caption)
                || `[${msg.type || 'message'}]`;

              // 1. Upsert conversation
              const conv = await upsertConversation(req, {
                phoneE164Plus,
                displayName,
                inboundTimestamp: tsDate,
                previewText: preview,
                phoneNumberId: recvPhoneNumberId,
              });

              // 2. Insert message
              const inserted = await insertInboundMessage(conv.id, msg);
              if (inserted) stats.msgs_new++;
              else          stats.msgs_dup++;
            } catch (e) {
              stats.errors++;
              console.error('[inbox-webhook] msg processing fail wamid=' + (msg.id || '?') + ':', e.message);
            }
          }

          // ── Status updates ──────────────────────────────────────────────
          for (const st of statuses) {
            try {
              const ok = await applyStatusUpdate(st);
              if (ok) stats.statuses_updated++;
            } catch (e) {
              stats.errors++;
              console.error('[inbox-webhook] status processing fail wamid=' + (st.id || '?') + ':', e.message);
            }
          }
        }
      }
    } catch (e) {
      stats.errors++;
      console.error('[inbox-webhook] top-level processing fail:', e.message);
    }

    console.log('[inbox-webhook] POST processed', JSON.stringify(stats));
    // ALTIJD 200 — Meta retried bij non-2xx en dat is hier ongewenst.
    return res.status(200).json({ ok: true, ...stats });
  }

  // Anders: alleen GET en POST toegestaan
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
