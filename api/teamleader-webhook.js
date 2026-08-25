// api/teamleader-webhook.js
// Anonieme receiver voor TL-webhook-events. TL Focus ondersteunt GEEN webhook-
// signatures (geen X-Hook-Signature, geen secret bij webhooks.register), dus
// verifiëren we anders:
//   1. account.id in de payload moet ons TL-account-UUID zijn
//      (TEAMLEADER_ACCOUNT_ID). Mismatch → 401, geen DB-mutatie.
//   2. Voor kritieke events (deal.won) extra object-verificatie via deals.info:
//      TL moet status='won' bevestigen (anti-spoof / anti-stale). Best-effort:
//      faalt de TL-call, dan loggen we en accepteren we toch.
// Zonder TEAMLEADER_ACCOUNT_ID → open mode (alleen loggen, met warning).
//
// TL kent GEEN quotation.* events → "offerte getekend" loopt via deal.won.
// Geeft ALTIJD 200 terug na ontvangst (anders TL retry-storm) — behalve bij
// een account-mismatch (401), dan willen we de afzender juist afwijzen.

import crypto from 'crypto';
import { supabaseAdmin } from './supabase.js';
import { cancelForCancelledQuote } from './_lib/mentor-ledger-engine.js';
import { tlFetch, getActiveToken } from './_lib/teamleader-token.js';
import { createNotification } from './_lib/notify.js';

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function logEvent(row) {
  try { await supabaseAdmin.from('teamleader_webhook_events').insert(row); }
  catch (e) { console.error('[tl-webhook] log-insert mislukt:', e.message); }
}

/**
 * Verifieer via deals.info dat de deal status='won' heeft en update dan onze
 * deals-rij. Aangeroepen voor ZOWEL 'deal.won' als 'deal.moved' (TL vuurt bij
 * tekenen vaak alleen deal.moved). deals.info is de autoriteit: alleen bij
 * status='won' zetten we tl_quotation_status='accepted'.
 *
 * Best-effort accepteren bij TL-onbereikbaarheid (backward-compat met de oude
 * deal.won-flow) — DB-update is idempotent (al 'accepted' → onschadelijk).
 *
 * @returns {Promise<{ updated: boolean, processedAt?: string, error?: string, tlStatus?: string|null }>}
 */
async function handleDealWon(objectId) {
  let objectOk = true;
  let tlStatus = null;
  try {
    const tok = await getActiveToken();
    if (tok) {
      const r = await tlFetch('/deals.info', { method: 'POST', body: JSON.stringify({ id: objectId }) });
      if (r.ok) {
        const d = await r.json();
        tlStatus = d.data?.status || null;
        objectOk = tlStatus === 'won';
      } else {
        console.warn('[tl-webhook] deals.info HTTP', r.status, '→ best-effort accepteren');
      }
    }
  } catch (e) {
    console.warn('[tl-webhook] deals.info exception (best-effort accepteren):', e.message);
  }

  if (!objectOk) {
    return {
      updated: false,
      error:   `object-verificatie: deal status='${tlStatus}' (verwacht 'won') → afgewezen`,
      tlStatus,
    };
  }

  const now = new Date().toISOString();
  const { error: updErr } = await supabaseAdmin.from('deals').update({
    tl_quotation_status: 'accepted', tl_quotation_accepted_at: now, tl_quotation_signed_at: now,
  }).eq('tl_deal_id', objectId);
  if (updErr) {
    return { updated: false, error: 'DB-update mislukt: ' + updErr.message, tlStatus };
  }

  // Fail-soft dual-write: notify sales-eigenaar dat offerte geaccepteerd is.
  try {
    const { data: dealRow } = await supabaseAdmin
      .from('deals')
      .select('id, sales_user_id, customer_name, quote_reference')
      .eq('tl_deal_id', objectId)
      .maybeSingle();
    if (dealRow && dealRow.sales_user_id) {
      const bodyParts = [];
      if (dealRow.customer_name)    bodyParts.push(dealRow.customer_name);
      if (dealRow.quote_reference)  bodyParts.push(dealRow.quote_reference);
      createNotification({
        toUserId:   dealRow.sales_user_id,
        type:       'sales.deal_accepted',
        title:      'Offerte geaccepteerd',
        body:       bodyParts.length ? bodyParts.join(' · ') : null,
        linkUrl:    '/modules/sales.html',
        entityType: 'deal',
        entityId:   dealRow.id,
      }).catch(() => {});
    }
  } catch (_) { /* fail-soft */ }

  return { updated: true, processedAt: now, tlStatus };
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let payload = {};
  try { const raw = await readRawBody(req); payload = raw ? JSON.parse(raw) : {}; } catch { payload = {}; }

  const eventType  = payload.type || payload.event || null;
  const objectType = payload.subject?.type || payload.data?.type || null;
  const objectId   = payload.subject?.id || payload.data?.id || payload.id || null;
  const accountId  = payload.account?.id || null;

  // [K-01 fix 2026-08-25] TL webhook verzwaren.
  // (a) HMAC — als TEAMLEADER_WEBHOOK_SECRET gezet is: primaire verdediging
  //     via HMAC-SHA256 over de raw body, headers X-TL-Signature / X-Webhook-
  //     Signature / X-Hub-Signature-256 (auto-detectie welke TL gebruikt).
  //     Constant-time compare. Bij mismatch → 401.
  // (b) Account-check — nu constant-time via crypto.timingSafeEqual, en
  //     FAIL-CLOSED als de env-var niet gezet is (voorheen: open mode).
  //     ACTIE JEFFREY vóór deploy: bevestig TEAMLEADER_ACCOUNT_ID staat in
  //     alle Vercel-envs, anders breken live deal.won/deal.lost events.
  // (c) Replay-dedup — dubbel-event met identieke (event_type, tl_object_id,
  //     timestamp) wordt geskipped via een 5-min-window scan in
  //     teamleader_webhook_events. Idempotent-safe voor legitieme retries.
  //
  // HMAC helper — probeer meerdere headers omdat TL Focus historisch ambigu is.
  // Als de env-var niet gezet is, blijft account-check de enige laag.
  const expectedHmacSecret = process.env.TEAMLEADER_WEBHOOK_SECRET || null;
  if (expectedHmacSecret) {
    const rawForHmac = payload && Object.keys(payload).length ? JSON.stringify(payload) : ''; // best-effort; TL body is JSON
    const sigCandidates = [
      req.headers['x-tl-signature'],
      req.headers['x-teamleader-signature'],
      req.headers['x-webhook-signature'],
      req.headers['x-hub-signature-256'],
    ].filter(Boolean).map(String);
    const digest = crypto.createHmac('sha256', expectedHmacSecret).update(rawForHmac).digest('hex');
    const digestPrefixed = 'sha256=' + digest;
    let hmacOk = false;
    for (const cand of sigCandidates) {
      try {
        const trimmed = cand.startsWith('sha256=') ? cand : cand;
        const a = Buffer.from(trimmed, 'utf8');
        const b = Buffer.from(trimmed.startsWith('sha256=') ? digestPrefixed : digest, 'utf8');
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) { hmacOk = true; break; }
      } catch (_) { /* try next */ }
    }
    if (!hmacOk) {
      console.error('[tl-webhook] HMAC-signature mismatch (afgewezen)');
      await logEvent({ event_type: eventType, tl_object_type: objectType, tl_object_id: objectId, payload_json: payload, signature_valid: false, error: 'HMAC signature mismatch' });
      return res.status(401).json({ error: 'signature mismatch' });
    }
  }

  // 1. Account-verificatie (primaire verdediging). FAIL-CLOSED bij ontbrekende env.
  const expectedAccount = process.env.TEAMLEADER_ACCOUNT_ID;
  if (!expectedAccount) {
    console.error('[tl-webhook] TEAMLEADER_ACCOUNT_ID env-var ontbreekt — endpoint disabled');
    return res.status(503).json({ error: 'webhook niet geconfigureerd' });
  }
  {
    const aBuf = Buffer.from(String(accountId || ''), 'utf8');
    const bBuf = Buffer.from(expectedAccount, 'utf8');
    let accountOk = false;
    try { accountOk = (aBuf.length === bBuf.length) && crypto.timingSafeEqual(aBuf, bBuf); }
    catch (_) { accountOk = false; }
    if (!accountOk) {
      console.error('[tl-webhook] account.id mismatch (afgewezen):', accountId);
      await logEvent({ event_type: eventType, tl_object_type: objectType, tl_object_id: objectId, payload_json: payload, signature_valid: false, error: 'account.id mismatch' });
      return res.status(401).json({ error: 'account mismatch' });
    }
  }

  // 2. Replay-dedup: skip identieke event binnen 5min-window. Idempotent-safe
  //    voor legitieme TL-retries (retry heeft zelfde signature, wij loggen 200
  //    zonder side-effect zodat TL stopt met retryen).
  if (eventType && objectId) {
    const dedupWindow = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    try {
      const { data: dup } = await supabaseAdmin
        .from('teamleader_webhook_events')
        .select('id')
        .eq('event_type', eventType)
        .eq('tl_object_id', objectId)
        .eq('signature_valid', true)
        .gte('created_at', dedupWindow)
        .limit(1)
        .maybeSingle();
      if (dup) {
        console.log('[tl-webhook] dedup skip:', eventType, objectId);
        return res.status(200).json({ ok: true, dedup: true });
      }
    } catch (_) { /* dedup fail-soft */ }
  }

  let verified = true; // account + optionele HMAC gepasseerd
  let processedAt = null;
  let errorText = null;

  try {
    if ((eventType === 'deal.won' || eventType === 'deal.moved') && objectId) {
      // TL vuurt bij tekenen vaak alleen 'deal.moved' (naar de won-fase), niet
      // 'deal.won'. Behandel beide identiek: deals.info is autoriteit — alleen
      // bij status='won' zetten we onze deal op 'accepted'. Bij een gewone
      // fase-move (status!='won') doet handleDealWon niks; we loggen alleen.
      // Idempotent — al 'accepted' → her-update onschadelijk.
      const res = await handleDealWon(objectId);
      if (res.updated) {
        processedAt = res.processedAt;
        verified    = true;
      } else if (res.error) {
        errorText = res.error;
        // Non-won phase (deal.moved naar iets anders) is een normaal geval,
        // geen failure — accepteer het event maar zonder DB-update. Bij een
        // echte fout (DB-error) blijft verified=false.
        if (eventType === 'deal.moved' && res.tlStatus && res.tlStatus !== 'won') {
          processedAt = new Date().toISOString();
        } else {
          verified = false;
        }
      }
    } else if (eventType === 'deal.lost' && objectId) {
      // F5.1 mentor-hook: deal verloren → openstaande bonus-entries op deze
      // deal annuleren. Lookup tl_deal_id → deals.id, dan engine-call.
      const { data: dealRow } = await supabaseAdmin
        .from('deals').select('id, sales_user_id, customer_name, quote_reference').eq('tl_deal_id', objectId).maybeSingle();
      if (dealRow) {
        try {
          await cancelForCancelledQuote({ quoteId: dealRow.id });
        } catch (e) {
          console.error('[tl-webhook] mentor-hook cancelForCancelledQuote:', e.message);
        }
        // Sales-bonus clawback: deal verloren → actieve bonus voiden. Was 'ie al
        // 'paid', dan clawback_pending + finance-notificatie (in de helper).
        // Fail-soft: mag de webhook-verwerking nooit breken.
        try {
          const { voidActiveBonusForDeal } = await import('./_lib/sales-bonus.js');
          await voidActiveBonusForDeal(dealRow.id, { reason: 'deal geannuleerd (deal.lost)', source: 'tl-webhook' });
        } catch (e) {
          console.error('[tl-webhook] sales-bonus clawback (deal.lost):', e.message);
        }
        // Fail-soft dual-write: notify sales-eigenaar dat offerte geweigerd is.
        if (dealRow.sales_user_id) {
          const bodyParts = [];
          if (dealRow.customer_name)   bodyParts.push(dealRow.customer_name);
          if (dealRow.quote_reference) bodyParts.push(dealRow.quote_reference);
          createNotification({
            toUserId:   dealRow.sales_user_id,
            type:       'sales.deal_declined',
            title:      'Offerte geweigerd',
            body:       bodyParts.length ? bodyParts.join(' · ') : null,
            linkUrl:    '/modules/sales.html',
            entityType: 'deal',
            entityId:   dealRow.id,
          }).catch(() => {});
        }
      }
      processedAt = new Date().toISOString();
      verified = true;
    } else {
      // Overige events (bv. deal.updated): alleen loggen. deal.moved wordt
      // hierboven expliciet afgehandeld naast deal.won.
      processedAt = new Date().toISOString();
    }
  } catch (e) {
    errorText = e.message;
    console.error('[tl-webhook] exception:', e.message);
  }

  await logEvent({
    event_type: eventType, tl_object_type: objectType, tl_object_id: objectId,
    payload_json: payload, signature_valid: verified, processed_at: processedAt, error: errorText,
  });

  return res.status(200).json({ received: true });
}
