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
import { getModuleContextByPhoneNumberId } from './_lib/module-context.js';

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
 * Returnt { inserted, messageId, type, body } — inserted=true bij nieuwe rij,
 * false bij duplicate (Meta retry). messageId is gevuld bij nieuwe insert,
 * null bij duplicate. type/body altijd ingevuld voor downstream filtering
 * (auto-suggest trigger).
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

  const { data: insertedRow, error } = await supabaseAdmin
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
    })
    .select('id')
    .single();
  if (error) {
    // UNIQUE violation op meta_wamid → Meta retry, geen écht probleem
    if (error.code === '23505') return { inserted: false, messageId: null, type, body };
    console.error('[inbox-webhook] msg insert fail wamid=' + wamid + ':', error.message);
    throw error;
  }
  return { inserted: true, messageId: insertedRow?.id || null, type, body };
}

// ── Helpers: Joost auto-suggest fire-and-forget (E1.1) ─────────────────────
//
// Triggert /api/joost-suggest in een non-awaited fetch zodat de webhook
// binnen het 200-OK budget van Meta blijft (zie comment regel 615:
// 'ALTIJD 200 — Meta retried bij non-2xx'). Op Vercel Node-runtime is er
// GEEN ctx.waitUntil() beschikbaar (geen runtime='edge' in deze codebase),
// dus we vertrouwen op het feit dat Vercel het execution-context typisch
// warm houdt zolang er open promises zijn — best-effort pattern. Bij
// lambda-cold-shutdown kan een suggestie soms wegvallen; voor MVP
// (E1.1) acceptabel.
//
// Auth: gebruikt INTERNAL_API_TOKEN env-var als X-Internal-Token header.
// joost-suggest.js herkent die en skipt de user-JWT + RBAC check; de
// suggestion wordt opgeslagen met requested_by_user_id=NULL en
// auto_triggered=true.
//
// Anti-loop: caller doet expliciete filter-checks vóór trigger (zie
// shouldAutoTrigger). Helper is best-effort en cancelt niets zelf.

// Trivial-replies die we niet automatisch laten triggeren — burst-reductie.
const TRIVIAL_REPLIES = new Set([
  'ok','okee','oke','ja','nee','top','goed','prima','thx','dank','dankje','dankjewel','klopt',
]);

/**
 * Anti-loop check: is er een outbound message in deze conversation binnen
 * de laatste N seconden? Indien ja → skip auto-suggest (klant antwoordt op
 * onze net-verzonden message). Default window 60s.
 *
 * Returns true als we WEL mogen triggeren (geen recente outbound), false
 * als we moeten skippen.
 */
async function hasNoRecentOutbound(conversationId, windowSec = 60) {
  try {
    const since = new Date(Date.now() - windowSec * 1000).toISOString();
    const { data, error } = await supabaseAdmin
      .from('whatsapp_messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('direction', 'out')
      .gte('created_at', since)
      .limit(1);
    if (error) {
      console.warn('[inbox-webhook] anti-loop check fail:', error.message);
      return true; // fail-open: trigger toch (anders nooit autosuggest bij DB-glitch)
    }
    return !(Array.isArray(data) && data.length > 0);
  } catch (e) {
    console.warn('[inbox-webhook] anti-loop check exception:', e.message);
    return true;
  }
}

/**
 * Fire-and-forget HTTP self-call naar /api/joost-suggest. NIET awaited
 * door caller — gebruikt .catch() om unhandled rejections af te vangen.
 *
 * Auth: X-Internal-Token header met process.env.INTERNAL_API_TOKEN.
 * joost-suggest.js (auth-blok regel 138-146) skipt user-JWT + RBAC bij
 * deze header-match.
 *
 * URL: VERCEL_URL > APP_BASE_URL > http://localhost:3000. VERCEL_URL
 * is automatisch geset op alle Vercel deploys (preview + production).
 */
function triggerJoostAutoSuggest({ conversationId, triggeredByMessageId }) {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) {
    console.warn('[inbox-webhook] joost auto-trigger skipped: INTERNAL_API_TOKEN ontbreekt');
    return;
  }
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : (process.env.APP_BASE_URL || 'http://localhost:3000');
  const url = `${base}/api/joost-suggest`;

  // Fire-and-forget: NIET awaited. Vercel Node-runtime houdt context warm
  // zolang er open promises zijn, maar geeft geen voltooiings-garantie na
  // res.json(). Best-effort; bij occasionally-dropped suggestion is dat
  // acceptabel voor MVP (E1.1).
  fetch(url, {
    method:  'POST',
    headers: {
      'content-type':     'application/json',
      'x-internal-token': token,
    },
    body: JSON.stringify({
      conversation_id:         conversationId,
      triggered_by_message_id: triggeredByMessageId || null,
      auto_triggered:          true,
    }),
  }).then(async (resp) => {
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.warn(`[inbox-webhook] joost auto-trigger HTTP ${resp.status}: ${txt.slice(0, 200)}`);
    }
  }).catch((e) => {
    console.warn('[inbox-webhook] joost auto-trigger fetch fail:', e && e.message);
  });
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

// ── Helpers: template status-update (field=message_template_status_update) ─
/**
 * Verwerk een Meta template-status webhook payload (binnen change.value).
 *
 * Meta-payload shape (per docs):
 *   {
 *     event: 'APPROVED'|'REJECTED'|'FLAGGED'|'PAUSED'|'DISABLED'|'PENDING'|'APPEAL_REQUEST_ELIGIBLE',
 *     message_template_id: '<META_TEMPLATE_ID>',
 *     message_template_name: '<name>',
 *     message_template_language: 'nl',
 *     reason: '<rejection reason>'   // alleen bij REJECTED/FLAGGED
 *   }
 *
 * Match-strategie: eerst op meta_template_id (uniek), fallback op
 * (name, language). Geen match → log warning + return false (geen fail).
 *
 * Event → onze status enum (SQL CHECK whatsapp_meta_templates.status):
 *   APPROVED                  → APPROVED  (+ approved_at = now als nog NULL)
 *   REJECTED / FLAGGED        → REJECTED  (+ rejection_reason = reason)
 *   PAUSED                    → PAUSED
 *   DISABLED                  → DISABLED
 *   PENDING / APPEAL_*        → SUBMITTED (interne pre-review state)
 *   anders                    → skip + warning
 */
async function applyTemplateStatusUpdate(req, value) {
  const metaId   = value?.message_template_id ? String(value.message_template_id) : null;
  const tmplName = value?.message_template_name || null;
  const tmplLang = value?.message_template_language || null;
  const event    = value?.event || null;
  const reason   = value?.reason || null;

  if (!event || (!metaId && !tmplName)) {
    console.warn('[inbox-webhook] template_status_update incompleet', { metaId, tmplName, event });
    return false;
  }

  const map = {
    APPROVED:                  'APPROVED',
    REJECTED:                  'REJECTED',
    FLAGGED:                   'REJECTED',
    PAUSED:                    'PAUSED',
    DISABLED:                  'DISABLED',
    PENDING:                   'SUBMITTED',
    APPEAL_REQUEST_ELIGIBLE:   'SUBMITTED',
  };
  const newStatus = map[event];
  if (!newStatus) {
    console.warn('[inbox-webhook] unknown template event ' + event + ' (metaId=' + metaId + ')');
    return false;
  }

  // Match-strategie: bij voorkeur op meta_template_id (uniek), fallback op (name, language)
  let q = supabaseAdmin
    .from('whatsapp_meta_templates')
    .select('id, status, business_account_id, name, language, approved_at')
    .limit(1);
  if (metaId) {
    q = q.eq('meta_template_id', metaId);
  } else {
    q = q.eq('name', tmplName).eq('language', tmplLang);
  }
  const { data: rows, error: selErr } = await q;
  if (selErr) {
    console.error('[inbox-webhook] template select fail:', selErr.message);
    return false;
  }
  const row = Array.isArray(rows) && rows.length ? rows[0] : null;
  if (!row) {
    console.warn('[inbox-webhook] template not found', { metaId, tmplName, tmplLang });
    return false;
  }

  const nowIso = new Date().toISOString();
  const updates = {
    status:         newStatus,
    last_synced_at: nowIso,
  };
  if (newStatus === 'APPROVED' && !row.approved_at) {
    updates.approved_at = nowIso;
  }
  if (newStatus === 'REJECTED') {
    updates.rejection_reason = reason || null;
  }
  // Idempotent: meta_template_id invullen als die nog leeg was maar payload hem heeft.
  if (metaId) {
    updates.meta_template_id = metaId;
  }

  const { error: updErr } = await supabaseAdmin
    .from('whatsapp_meta_templates')
    .update(updates)
    .eq('id', row.id);
  if (updErr) {
    console.error('[inbox-webhook] template update fail id=' + row.id + ':', updErr.message);
    return false;
  }

  await logInboxAudit(req, {
    action:     'whatsapp_meta_template.webhook_status_update',
    entityType: 'whatsapp_meta_template',
    entityId:   row.id,
    afterJson:  {
      event,
      name:        row.name,
      language:    row.language,
      prev_status: row.status,
      new_status:  newStatus,
      reason:      reason || null,
      meta_template_id: metaId,
      triggered_by: 'meta_webhook',
    },
  });

  console.log('[inbox-webhook] template status updated id=' + row.id + ' ' + row.status + ' → ' + newStatus + ' (event=' + event + ')');
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
    let stats = { msgs_new: 0, msgs_dup: 0, statuses_updated: 0, template_status_updates: 0, errors: 0 };

    try {
      const entries = Array.isArray(body?.entry) ? body.entry : [];
      for (const entry of entries) {
        const changes = Array.isArray(entry?.changes) ? entry.changes : [];
        for (const change of changes) {
          // Template status-updates (apart Meta webhook field, vereist
          // aparte subscription op WABA-app niveau in Meta Developer Console).
          if (change?.field === 'message_template_status_update') {
            try {
              const ok = await applyTemplateStatusUpdate(req, change.value || {});
              if (ok) stats.template_status_updates++;
            } catch (e) {
              stats.errors++;
              console.error('[inbox-webhook] template status fail:', e.message);
            }
            continue;
          }
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
              const insRes = await insertInboundMessage(conv.id, msg);
              if (insRes.inserted) stats.msgs_new++;
              else                 stats.msgs_dup++;

              // 3. E1.1 Joost auto-suggest trigger (fire-and-forget)
              // Filters (alle moeten waar zijn):
              //   a) Nieuwe insert (geen Meta-retry)
              //   b) text-type message (skip media/system/template-button)
              //   c) body >= 5 chars + niet in TRIVIAL_REPLIES set
              //   d) conversation heeft customer_id (gekoppeld aan klant)
              //   e) module van ontvangende lijn == finance (E1.1 scope)
              //   f) joost_config.is_enabled = true voor finance
              //   g) anti-loop: geen outbound binnen 60s (klant antwoordt
              //      niet op onze eigen recent-verzonden message)
              //
              // Auth: helper gebruikt X-Internal-Token header; joost-suggest
              // skipt user-JWT + RBAC bij die header-match en zet
              // requested_by_user_id=NULL + auto_triggered=true.
              try {
                if (insRes.inserted && insRes.messageId && insRes.type === 'text' && conv.customerId) {
                  const trimmed = String(insRes.body || '').trim();
                  const lower = trimmed.toLowerCase();
                  const isTriggerable = trimmed.length >= 5 && !TRIVIAL_REPLIES.has(lower);
                  if (isTriggerable) {
                    // Module + joost_config checks server-side (1 lookup-set).
                    const moduleCtx = await getModuleContextByPhoneNumberId(supabaseAdmin, recvPhoneNumberId);
                    const resolvedModule = moduleCtx?.module || 'finance';
                    if (resolvedModule === 'finance') {
                      const { data: jcfg, error: jcfgErr } = await supabaseAdmin
                        .from('joost_config')
                        .select('module, is_enabled')
                        .eq('module', 'finance')
                        .maybeSingle();
                      if (jcfgErr) {
                        console.warn('[inbox-webhook] joost_config lookup fail:', jcfgErr.message);
                      } else if (jcfg && jcfg.is_enabled === true) {
                        const noLoop = await hasNoRecentOutbound(conv.id, 60);
                        if (noLoop) {
                          triggerJoostAutoSuggest({
                            conversationId:        conv.id,
                            triggeredByMessageId:  insRes.messageId,
                          });
                        }
                      }
                    }
                  }
                }
              } catch (eAuto) {
                // Auto-trigger mag NOOIT de webhook breken — log + door
                console.warn('[inbox-webhook] joost auto-trigger pre-check fail:', eAuto && eAuto.message);
              }
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
