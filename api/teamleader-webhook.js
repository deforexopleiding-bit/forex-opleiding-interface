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

  // 1. Account-verificatie (primaire verdediging).
  const expectedAccount = process.env.TEAMLEADER_ACCOUNT_ID;
  if (expectedAccount) {
    if (accountId !== expectedAccount) {
      console.error('[tl-webhook] account.id mismatch (afgewezen):', accountId);
      await logEvent({ event_type: eventType, tl_object_type: objectType, tl_object_id: objectId, payload_json: payload, signature_valid: false, error: 'account.id mismatch' });
      return res.status(401).json({ error: 'account mismatch' });
    }
  } else {
    console.warn('[tl-webhook] TEAMLEADER_ACCOUNT_ID niet gezet — open mode, geen account-verificatie');
  }

  let verified = !!expectedAccount; // account-check geslaagd (of open mode = onzeker)
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
