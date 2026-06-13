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

import {
  verifyWebhookSubscription,
  verifyWebhookSignature,
  sendText,
  MetaNotConfiguredError,
} from './_lib/meta-whatsapp.js';
import { supabaseAdmin } from './supabase.js';
import { getClientIp } from './_lib/audit-customer.js';
import { getModuleContextByPhoneNumberId } from './_lib/module-context.js';
import { extractEmail, findCustomerByEmail } from './_lib/email-extractor.js';
import { runJoostSuggest } from './_lib/joost-suggest-core.js';
import { waitUntil } from '@vercel/functions';

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
 * Upsert whatsapp_conversations op (phone_number, phone_number_id). 2-step
 * pattern (SELECT → UPDATE/INSERT) i.p.v. ON CONFLICT — lesson learned 20 mei:
 * bij partial unique index kan ON CONFLICT niet als arbiter; veiliger pattern.
 *
 * Multi-line fix (Fase 2 stap 2b voorbereiding):
 *   Match-strategie is lijn-specifiek geworden zodat dezelfde afzender op
 *   verschillende WABA-lijnen aparte conversaties krijgt (events-lijn naast
 *   finance-lijn). Voorheen werd op phone_number-only gematcht, waardoor een
 *   events-inbound voor een nummer dat al een finance-conv had werd
 *   geappended op die finance-conv (bevestigd in prod-test +31655270212).
 *
 * Match-volgorde:
 *   - phoneNumberId aanwezig (regulier pad)   → tuple-SELECT
 *     (phone_number, phone_number_id).maybeSingle(). Uniciteit op de tuple
 *     wordt door de DB afgedwongen via migratie 2026-06-13-whatsapp-conv-
 *     unique-on-phone-and-pnid.sql (drop UNIQUE op phone_number, add UNIQUE
 *     op (phone_number, phone_number_id)).
 *   - phoneNumberId null/leeg (ongebruikelijk — payload zonder metadata) →
 *     phone-only fallback met deterministische tie-break (created_at ASC,
 *     pak oudste). Warn-log zodat dit pad zichtbaar is.
 *
 * Returnt { id, created, customerId } — created=true bij nieuwe conversation.
 */
async function upsertConversation(req, { phoneE164Plus, displayName, inboundTimestamp, previewText, phoneNumberId }) {
  // 1. Bestaande conversation ophalen (lijn-specifiek of phone-only fallback)
  let existing = null;
  let selErr   = null;
  if (phoneNumberId) {
    const r = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, customer_id, unread_count, phone_number_id')
      .eq('phone_number',    phoneE164Plus)
      .eq('phone_number_id', phoneNumberId)
      .maybeSingle();
    existing = r.data || null;
    selErr   = r.error || null;
  } else {
    console.warn(
      '[inbox-webhook] upsertConversation: geen pnId, phone-only fallback voor ' +
      phoneE164Plus
    );
    const r = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, customer_id, unread_count, phone_number_id')
      .eq('phone_number', phoneE164Plus)
      .order('created_at', { ascending: true })
      .limit(1);
    existing = (r.data && r.data[0]) || null;
    selErr   = r.error || null;
  }
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
    // phone_number_id: veilige heal. Met de tuple-SELECT hierboven is een
    // match al lijn-specifiek — de oude "eerste lijn leidend"-preservation
    // is daarmee overbodig en zou multi-line correctness juist breken. We
    // healen alleen legacy rijen die nooit een pnId hebben gekregen
    // (bv. via de phone-only fallback hierboven of pre-fix historie).
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
    // Race condition: andere webhook insertte intussen. Re-select met dezelfde
    // tuple-strategie als de initiële SELECT — anders mist de re-select de
    // race-result post-migratie (UNIQUE op (phone_number, phone_number_id)).
    if (insErr.code === '23505') {
      let again = null;
      if (phoneNumberId) {
        const r = await supabaseAdmin
          .from('whatsapp_conversations')
          .select('id, customer_id')
          .eq('phone_number',    phoneE164Plus)
          .eq('phone_number_id', phoneNumberId)
          .maybeSingle();
        again = r.data || null;
      } else {
        const r = await supabaseAdmin
          .from('whatsapp_conversations')
          .select('id, customer_id')
          .eq('phone_number', phoneE164Plus)
          .order('created_at', { ascending: true })
          .limit(1);
        again = (r.data && r.data[0]) || null;
      }
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
 * Reactieve Joost-suggest trigger: in-process aanroep van runJoostSuggest
 * (geen HTTP-self-call meer; zie Fase 2 stap 1 / commit 743d145).
 *
 * Fase 2 stap 1b — waitUntil() gebruik:
 *   Een unawaited .then().catch() overleeft het einde van de HTTP-respons
 *   NIET op Vercel Node-runtime. Empirisch bevestigd ná stap 1: webhook
 *   returnde 200 schoon, geen "fetch failed", maar 0 joost_suggestions-rij.
 *   De Anthropic-call (~3-5s) + insert raakten halverwege bevroren omdat de
 *   lambda freezed direct ná res.status(200).json(...).
 *
 *   waitUntil() uit @vercel/functions registreert een promise als
 *   "background work" zodat de runtime de lambda LEVEND houdt tot het werk
 *   klaar is, óók ná de respons. De caller awaited NIET — de Meta-webhook
 *   reageert direct met 200, terwijl Joost' werk in de achtergrond
 *   voltooit binnen de function-maxDuration (Pro: 60s default).
 *
 *   Geen INTERNAL_API_TOKEN / VERCEL_URL nodig voor het suggest-pad zelf.
 *
 * E2.1 autonomous chain (out-of-scope voor Fase 2 stap 1):
 *   Als `autonomyEnabled=true` (feature-flag e2_reactive_autonomy, default
 *   UIT op finance), na een succesvolle suggestion-insert: HTTP self-call
 *   naar /api/joost-send-autonomous met INTERNAL_API_TOKEN. Zelfde
 *   fragiliteit als oude self-call (out-of-scope; gated OFF default).
 *   De HTTP-fetch zit nu binnen waitUntil-scope zodat tenminste de poging
 *   overleeft.
 *
 * Observabiliteit:
 *   - console.log entry  '[inbox-webhook] reactive suggest start ...'
 *   - console.log done   '[inbox-webhook] reactive suggest done id=...'
 *   - console.warn skip  '[inbox-webhook] reactive suggest skipped: ...'
 *   - console.warn fail  '[inbox-webhook] reactive suggest threw: ...'
 */
function triggerJoostAutoSuggest({ conversationId, triggeredByMessageId, autonomyEnabled, clientIp, module }) {
  const modLabel = module || '?';
  console.log(
    '[inbox-webhook] reactive suggest start module=' + modLabel +
    ' conv=' + conversationId +
    ' autonomy=' + (autonomyEnabled ? 'on' : 'off')
  );

  // waitUntil registreert het werk bij de Vercel-runtime zodat de lambda
  // niet bevroren wordt voordat runJoostSuggest klaar is.
  waitUntil(
    runJoostSuggest({
      supabase:             supabaseAdmin,
      conversationId,
      triggeredByMessageId: triggeredByMessageId || null,
      autoTriggered:        true,
      requestedByUserId:    null,
      clientIp:             clientIp || null,
    }).then((result) => {
      if (result.status !== 200) {
        console.warn(
          '[inbox-webhook] reactive suggest skipped: status=' + result.status +
          ' module=' + modLabel +
          ' conv=' + conversationId +
          ' body=' + JSON.stringify(result.body || {}).slice(0, 200)
        );
        return;
      }
      const suggestionId = result.body?.suggestion?.id || null;
      const intent       = result.body?.suggestion?.detected_intent || null;
      console.log(
        '[inbox-webhook] reactive suggest done id=' + (suggestionId || '<no-id>') +
        ' module=' + modLabel +
        ' conv=' + conversationId +
        ' intent=' + (intent || '?')
      );

      if (!autonomyEnabled) return;
      if (!suggestionId) {
        console.warn(
          '[inbox-webhook] reactive suggest skipped autonomy chain: geen suggestion.id ' +
          'module=' + modLabel + ' conv=' + conversationId
        );
        return;
      }

      // ── E2.1 autonomous chain — nog HTTP self-call (Fase 2 stap 2 scope) ──
      const token = process.env.INTERNAL_API_TOKEN;
      if (!token) {
        console.warn(
          '[inbox-webhook] reactive suggest skipped autonomy chain: ' +
          'INTERNAL_API_TOKEN ontbreekt module=' + modLabel
        );
        return;
      }
      const base = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : (process.env.APP_BASE_URL || 'http://localhost:3000');
      const autonomousUrl = `${base}/api/joost-send-autonomous`;
      return fetch(autonomousUrl, {
        method:  'POST',
        headers: {
          'content-type':     'application/json',
          'x-internal-token': token,
        },
        body: JSON.stringify({ suggestion_id: suggestionId }),
      }).then(async (resp2) => {
        if (!resp2.ok) {
          const txt = await resp2.text().catch(() => '');
          console.warn(
            '[inbox-webhook] reactive suggest autonomy chain HTTP ' + resp2.status +
            ' module=' + modLabel + ': ' + txt.slice(0, 200)
          );
        } else {
          console.log(
            '[inbox-webhook] reactive suggest autonomy chain HTTP 200 ' +
            'module=' + modLabel + ' suggestion=' + suggestionId
          );
        }
      }).catch((e2) => {
        console.warn(
          '[inbox-webhook] reactive suggest autonomy chain fetch fail ' +
          'module=' + modLabel + ': ' + (e2 && e2.message)
        );
      });
    }).catch((e) => {
      console.warn(
        '[inbox-webhook] reactive suggest threw module=' + modLabel +
        ' conv=' + conversationId + ': ' + (e && e.message)
      );
    })
  );
}

// ── Helpers: Joost autonomous intake-flow (E2 intake) ─────────────────────
//
// Wanneer een nieuwe inbound message binnenkomt op een conversation ZONDER
// gekoppelde klant (customer_id IS NULL), kan Joost zelfstandig om een
// e-mailadres vragen om de klant te identificeren. Pattern:
//
//   eerste inbound    → Joost vraagt "met welk e-mailadres ben je bij ons
//                       bekend?" (intake_status = 'asked').
//   klant antwoordt   → extractEmail() probeert mail te vinden in body.
//     mail + 1 match  → koppel conversation aan klant, Joost bevestigt.
//                       (intake_status = 'matched')
//     geen mail       → Joost vraagt opnieuw (intake_status blijft 'asked').
//     mail, geen hit  → MANUAL_FOLLOWUP-taak aangemaakt voor mens.
//                       (intake_status = 'failed_no_match')
//   matched/failed_*  → skip intake-logic; normale auto-suggest pipeline.
//
// Feature-flag: joost_config.feature_flags.e2_autonomous_intake (per-module,
// default false). Module-resolve gaat via getModuleContextByPhoneNumberId.
// Alleen actief op finance-module in E2.0.
//
// VASTE TEKSTEN (geen LLM-call) — voorspelbaar en goedkoop. De LLM komt pas
// in beeld zodra de klant gekoppeld is en de normale Joost-suggest flow draait.

const JOOST_INTAKE_ASK_TEXT =
  'Hi, om je goed te kunnen helpen — met welk e-mailadres ben je bij ons bekend?';
const JOOST_INTAKE_RETRY_TEXT =
  'Sorry, ik heb geen e-mailadres in je bericht herkend. Kun je het nogmaals opgeven?';
const JOOST_INTAKE_MATCHED_TEXT =
  'Top, ik heb je gevonden! Hoe kan ik je helpen?';
const JOOST_INTAKE_FAILED_TEXT =
  'Bedankt, een collega kijkt ernaar.';

/**
 * Verstuur een vaste Joost intake-tekst via Meta WhatsApp + persist als
 * outbound whatsapp_messages-rij + update conversation.last_message_at.
 *
 * NIET awaited — fail-soft: bij een fout log + return false zodat de webhook
 * binnen het 200-OK budget blijft.
 *
 * @returns {Promise<boolean>} true bij succes, false bij fail.
 */
async function sendJoostIntakeReply(req, { conv, text, phoneNumberId }) {
  if (!conv?.id || !conv?.phone_number || !text) return false;
  try {
    let metaResult;
    try {
      metaResult = await sendText({
        to:             conv.phone_number,
        body:           text,
        phoneNumberId:  phoneNumberId || undefined,
      });
    } catch (metaErr) {
      if (metaErr instanceof MetaNotConfiguredError) {
        console.warn('[inbox-webhook] joost intake send skipped: Meta niet geconfigureerd', metaErr.missing);
      } else {
        console.error('[inbox-webhook] joost intake Meta send fail:', metaErr && metaErr.message);
      }
      return false;
    }
    const wamid = metaResult && metaResult.wamid ? String(metaResult.wamid) : null;
    const nowIso = new Date().toISOString();

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('whatsapp_messages')
      .insert({
        conversation_id:    conv.id,
        direction:          'out',
        meta_wamid:         wamid,
        body:               text,
        template_name:      null,
        template_variables: null,
        status:             'queued',
        sent_at:            nowIso,
        sent_by_user_id:    null, // system-call vanuit webhook (Joost intake)
      })
      .select('id')
      .single();
    if (insErr) {
      console.error('[inbox-webhook] joost intake msg insert fail:', insErr.message);
      return false;
    }

    // Update conversation preview + last_message_at zodat UI direct refresht.
    const preview = text.slice(0, 120);
    const { error: convUpdErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .update({ last_message_at: nowIso, last_message_preview: preview })
      .eq('id', conv.id);
    if (convUpdErr) {
      console.error('[inbox-webhook] joost intake conv update fail:', convUpdErr.message);
    }

    await logInboxAudit(req, {
      action:     'joost.intake.message_sent',
      entityType: 'whatsapp_conversation',
      entityId:   conv.id,
      afterJson:  {
        message_id: inserted?.id || null,
        meta_wamid: wamid,
        text_preview: preview,
      },
    });
    return true;
  } catch (e) {
    console.error('[inbox-webhook] sendJoostIntakeReply exception:', e && e.message);
    return false;
  }
}

/**
 * Hoofd-handler voor de Joost intake-flow. Returns true als de flow het
 * bericht heeft afgehandeld (caller moet auto-suggest skippen), false anders.
 *
 * Pre-conditions die caller MOET checken:
 *   - msg is inbound + text-type
 *   - conv.customerId is NULL (geen phone-match)
 *   - module-resolve gaf 'finance'
 *   - joost_config.is_enabled = true
 *   - feature_flags.e2_autonomous_intake = true
 *
 * Stateflow op joost_conversation_state.intake_status:
 *   NULL              → vraag mail, set 'asked'.
 *   'asked'           → parse mail uit body; match of vraag opnieuw of fail.
 *   'matched'         → skip (return false → laat auto-suggest draaien).
 *   'failed_no_*'     → skip (return false → laat auto-suggest draaien).
 *
 * @returns {Promise<boolean>} true = intake-flow handelde dit bericht af.
 */
async function handleJoostIntakeFlow(req, { conv, messageBody, phoneNumberId }) {
  if (!conv?.id) return false;

  // 1) Huidige intake_status ophalen.
  let stateRow = null;
  try {
    const { data, error } = await supabaseAdmin
      .from('joost_conversation_state')
      .select('conversation_id, intake_status, intake_asked_at')
      .eq('conversation_id', conv.id)
      .maybeSingle();
    if (error) {
      console.error('[inbox-webhook] joost intake state select fail:', error.message);
      return false;
    }
    stateRow = data || null;
  } catch (e) {
    console.error('[inbox-webhook] joost intake state select exception:', e && e.message);
    return false;
  }

  const intakeStatus = stateRow?.intake_status || null;

  // Matched of failed_*: intake-flow heeft hier niets meer te doen; normale
  // auto-suggest pipeline mag draaien.
  if (intakeStatus === 'matched' || intakeStatus === 'failed_no_match' || intakeStatus === 'failed_no_response') {
    return false;
  }

  // ── Geval A: NULL → eerste vraag stellen ─────────────────────────────
  if (!intakeStatus) {
    const nowIso = new Date().toISOString();
    const sent = await sendJoostIntakeReply(req, {
      conv,
      text: JOOST_INTAKE_ASK_TEXT,
      phoneNumberId,
    });
    if (!sent) return false; // bij send-fail: niet markeren, opnieuw proberen op volgende inbound

    // UPSERT joost_conversation_state met intake_status = asked.
    // 2-step pattern (insert → bij 23505 update) consistent met
    // joost-send-autonomous.js (race-veilig).
    const insertPayload = {
      conversation_id: conv.id,
      intake_status:   'asked',
      intake_asked_at: nowIso,
    };
    const { error: insErr } = await supabaseAdmin
      .from('joost_conversation_state')
      .insert(insertPayload);
    if (insErr) {
      if (insErr.code === '23505') {
        // Race: andere call insertte intussen. Update als intake_status nog NULL.
        await supabaseAdmin
          .from('joost_conversation_state')
          .update({ intake_status: 'asked', intake_asked_at: nowIso })
          .eq('conversation_id', conv.id)
          .is('intake_status', null);
      } else {
        console.error('[inbox-webhook] joost intake state insert fail:', insErr.message);
      }
    }

    await logInboxAudit(req, {
      action:     'joost.intake.asked',
      entityType: 'whatsapp_conversation',
      entityId:   conv.id,
      afterJson:  { intake_status: 'asked', intake_asked_at: nowIso },
    });
    return true;
  }

  // ── Geval B: 'asked' → verwacht email in body ────────────────────────
  if (intakeStatus === 'asked') {
    const email = extractEmail(messageBody);

    // B.1: Geen email herkend → vraag opnieuw. intake_status blijft 'asked'.
    if (!email) {
      await sendJoostIntakeReply(req, {
        conv,
        text: JOOST_INTAKE_RETRY_TEXT,
        phoneNumberId,
      });
      await logInboxAudit(req, {
        action:     'joost.intake.retry',
        entityType: 'whatsapp_conversation',
        entityId:   conv.id,
        afterJson:  { reason: 'no_email_in_body' },
      });
      return true;
    }

    // B.2: Email + klant gevonden → koppel + bevestig.
    const customer = await findCustomerByEmail(supabaseAdmin, email);
    if (customer && customer.id) {
      // Koppel conversation aan klant. Defensieve check: alleen UPDATE als
      // customer_id NOG NULL is (idempotent + race-veilig).
      const { error: linkErr } = await supabaseAdmin
        .from('whatsapp_conversations')
        .update({ customer_id: customer.id })
        .eq('id', conv.id)
        .is('customer_id', null);
      if (linkErr) {
        console.error('[inbox-webhook] joost intake link fail:', linkErr.message);
        // Fail-soft: ga door met sturen van bevestiging; staat blijft 'asked'
        // zodat een handmatige link of retry mogelijk blijft.
        return false;
      }

      // Optioneel: phone toevoegen aan klant als die nog NULL is (consistent met
      // inbox-link-conversation-to-customer add_phone_to_customer=true pattern).
      // Dubbele guard: in-memory + .is('phone', null) op UPDATE.
      if (!customer.phone && conv.phone_number) {
        const { error: phErr } = await supabaseAdmin
          .from('customers')
          .update({ phone: conv.phone_number })
          .eq('id', customer.id)
          .is('phone', null);
        if (phErr) {
          // Fail-soft — link is wel geslaagd. Log + door.
          console.error('[inbox-webhook] joost intake phone-add fail:', phErr.message);
        }
      }

      // UPDATE intake_status = matched. (state-rij bestaat al sinds geval A.)
      const { error: updErr } = await supabaseAdmin
        .from('joost_conversation_state')
        .update({ intake_status: 'matched' })
        .eq('conversation_id', conv.id);
      if (updErr) {
        console.error('[inbox-webhook] joost intake state matched-update fail:', updErr.message);
      }

      await sendJoostIntakeReply(req, {
        conv,
        text: JOOST_INTAKE_MATCHED_TEXT,
        phoneNumberId,
      });

      await logInboxAudit(req, {
        action:     'joost.intake.matched',
        entityType: 'whatsapp_conversation',
        entityId:   conv.id,
        afterJson:  {
          customer_id:   customer.id,
          matched_email: email,
          match_reason:  'email_via_joost_intake',
          phone_added:   !customer.phone && !!conv.phone_number,
        },
      });
      // Conversation is nu gekoppeld; verdere auto-suggest mag bij VOLGENDE
      // inbound triggeren. Voor DEZE message returnen we true zodat we niet
      // direct nog een auto-suggest oproepen bovenop de matched-bevestiging.
      return true;
    }

    // B.3: Email herkend maar 0 of >1 match → MANUAL_FOLLOWUP-taak.
    const insertRow = {
      customer_id:    null,
      arrangement_id: null,
      invoice_id:     null,
      action_type:    'MANUAL_FOLLOWUP',
      status:         'PENDING',
      payload: {
        reason:          'Intake-mismatch',
        claimed_email:   email,
        conversation_id: conv.id,
        source:          'joost',
        rationale:       'Klant gaf e-mailadres dat niet (uniek) matched in customers — handmatige verificatie nodig.',
      },
    };
    const { error: paErr } = await supabaseAdmin
      .from('pending_actions')
      .insert(insertRow);
    if (paErr) {
      console.error('[inbox-webhook] joost intake MANUAL_FOLLOWUP insert fail:', paErr.message);
      // Bij DB-fail: probeer geen verdere stappen + laat status 'asked' staan
      // zodat een herkansing mogelijk blijft.
      return false;
    }

    // UPDATE intake_status = failed_no_match.
    const { error: updErr } = await supabaseAdmin
      .from('joost_conversation_state')
      .update({ intake_status: 'failed_no_match' })
      .eq('conversation_id', conv.id);
    if (updErr) {
      console.error('[inbox-webhook] joost intake state failed-update fail:', updErr.message);
    }

    await sendJoostIntakeReply(req, {
      conv,
      text: JOOST_INTAKE_FAILED_TEXT,
      phoneNumberId,
    });

    await logInboxAudit(req, {
      action:     'joost.intake.failed_no_match',
      entityType: 'whatsapp_conversation',
      entityId:   conv.id,
      afterJson:  {
        claimed_email: email,
        reason:        'no_unique_customer_match',
      },
    });
    return true;
  }

  // Onbekende intake_status: skip + log warning (defensieve fallback).
  console.warn('[inbox-webhook] joost intake unknown status:', intakeStatus, 'conv=', conv.id);
  return false;
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

              // 3. Joost-flows: intake + auto-suggest (fire-and-forget achtig)
              //
              // Twee paden, mutually exclusive op deze message:
              //   (i)  Intake (E2 autonomous intake) — runt als conv.customerId
              //        IS NULL én feature_flags.e2_autonomous_intake = true.
              //        Joost vraagt om e-mailadres, parsed het antwoord en
              //        koppelt of escaleert. Vaste teksten, geen LLM.
              //   (ii) Auto-suggest (E1.1) — runt als conv.customerId IS NOT NULL
              //        (klant gekoppeld) én aan de overige filters voldoet.
              //        LLM-aangedreven Joost-suggestie + optionele E2.1 chain.
              //
              // Gedeelde filters:
              //   a) Nieuwe insert (geen Meta-retry)
              //   b) text-type message
              //   c) module van ontvangende lijn == finance (huidige scope)
              //   d) joost_config.is_enabled = true voor finance
              //
              // Auto-suggest extra filters:
              //   e) joost_config.feature_flags.reactive_suggest_enabled = true
              //      (per-module gate, Fase 2 stap 1; default UIT op finance)
              //   f) body >= 5 chars + niet in TRIVIAL_REPLIES set
              //   g) anti-loop: geen outbound binnen 60s
              //
              // Aanroep: auto-suggest doet sinds Fase 2 stap 1 een IN-PROCESS
              // call van runJoostSuggest (api/_lib/joost-suggest-core.js).
              // Geen HTTP-self-call meer, dus geen VERCEL_URL / INTERNAL_API_TOKEN
              // afhankelijkheid voor dit pad. Intake-flow gebruikt sendText
              // direct + schrijft eigen outbound message-rij (geen extra hop).
              try {
                if (insRes.inserted && insRes.messageId && insRes.type === 'text') {
                  // Module + joost_config: éénmalige lookup voor beide paden.
                  const moduleCtx = await getModuleContextByPhoneNumberId(supabaseAdmin, recvPhoneNumberId);
                  // FASE 0 Joost-gate-hardening: GEEN silent-failover.
                  // Een null/onbekende/non-finance/inactive module -> Joost
                  // wordt NOOIT getriggerd. Conversation blijft persisted in
                  // whatsapp_conversations (upsert hierboven), maar is
                  // 'unrouted' voor inbox-views (inbox-conversations-list
                  // filtert hardcoded op finance phone_number_id).
                  if (!moduleCtx) {
                    console.warn(
                      '[inbox-webhook] inbound van ongekoppeld nummer phone_number_id=' +
                      String(recvPhoneNumberId || '<missing>') +
                      ' - conversation persisted als unrouted, Joost-trigger geskipt'
                    );
                  }
                  const isFinanceLijn = !!(moduleCtx
                    && moduleCtx.module === 'finance'
                    && moduleCtx.is_active === true);
                  if (isFinanceLijn) {
                    const { data: jcfg, error: jcfgErr } = await supabaseAdmin
                      .from('joost_config')
                      .select('module, is_enabled, feature_flags')
                      .eq('module', 'finance')
                      .maybeSingle();
                    if (jcfgErr) {
                      console.warn('[inbox-webhook] joost_config lookup fail:', jcfgErr.message);
                    } else if (jcfg && jcfg.is_enabled === true) {
                      const flags = (jcfg.feature_flags && typeof jcfg.feature_flags === 'object')
                        ? jcfg.feature_flags : {};
                      const intakeEnabled = flags.e2_autonomous_intake === true;

                      // Pad (i) Intake-flow: alleen als customer_id ontbreekt
                      // én feature-flag aanstaat. Outbound phone_number_id =
                      // conv.phone_number_id (al opgeslagen bij upsert) of
                      // module-context fallback. Bij undefined valt sendText
                      // terug op env-var (META_WHATSAPP_PHONE_NUMBER_ID).
                      let intakeHandled = false;
                      if (!conv.customerId && intakeEnabled) {
                        const outboundPnId = recvPhoneNumberId || moduleCtx?.phone_number_id || undefined;
                        // Bouw lokaal conv-object met fields die intake-flow nodig
                        // heeft (id + phone_number) — webhook-upsert returnt geen
                        // phone_number maar we kennen 'm uit phoneE164Plus.
                        intakeHandled = await handleJoostIntakeFlow(req, {
                          conv:           { id: conv.id, phone_number: phoneE164Plus },
                          messageBody:    insRes.body || '',
                          phoneNumberId:  outboundPnId,
                        });
                      }

                      // Pad (ii) Auto-suggest: alleen als intake-flow NIET
                      // heeft afgehandeld én klant gekoppeld is.
                      if (!intakeHandled && conv.customerId) {
                        // Per-module reactive-suggest gate (Fase 2 stap 1).
                        // joost_config.feature_flags.reactive_suggest_enabled
                        // bepaalt per module of de reactieve in-process suggest
                        // vuurt na een inbound. Default UIT op finance zodat
                        // observable gedrag identiek blijft aan de gebroken
                        // HTTP-self-call-toestand (= geen suggesties). Admin
                        // flipt 'm aan op de finance-rij (of straks events-rij
                        // voor Simone) om reactieve drafts te activeren.
                        const reactiveEnabled = flags.reactive_suggest_enabled === true;
                        if (reactiveEnabled) {
                          const trimmed = String(insRes.body || '').trim();
                          const lower = trimmed.toLowerCase();
                          const isTriggerable = trimmed.length >= 5 && !TRIVIAL_REPLIES.has(lower);
                          if (isTriggerable) {
                            const noLoop = await hasNoRecentOutbound(conv.id, 60);
                            if (noLoop) {
                              // E2.1 reactive-autonomy gate: alleen chain naar
                              // /api/joost-send-autonomous als feature-flag
                              // e2_reactive_autonomy aanstaat. joost-send-autonomous
                              // doet zelf nogmaals de check (defense-in-depth).
                              const autonomyEnabled = flags.e2_reactive_autonomy === true;
                              triggerJoostAutoSuggest({
                                conversationId:        conv.id,
                                triggeredByMessageId:  insRes.messageId,
                                autonomyEnabled,
                                clientIp:              getClientIp(req),
                                module:                jcfg.module || moduleCtx?.module || null,
                              });
                            }
                          }
                        }
                      }
                    }
                  }
                }
              } catch (eAuto) {
                // Auto-trigger / intake mag NOOIT de webhook breken — log + door
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
