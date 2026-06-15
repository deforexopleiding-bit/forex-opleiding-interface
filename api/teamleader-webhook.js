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
    if (eventType === 'deal.won' && objectId) {
      // 2. Object-verificatie: TL moet de deal als 'won' bevestigen.
      let objectOk = true;
      try {
        const tok = await getActiveToken();
        if (tok) {
          const r = await tlFetch('/deals.info', { method: 'POST', body: JSON.stringify({ id: objectId }) });
          if (r.ok) {
            const d = await r.json();
            const status = d.data?.status;
            objectOk = status === 'won';
            if (!objectOk) errorText = `object-verificatie: deal status='${status}' (verwacht 'won') → afgewezen`;
          } else {
            console.warn('[tl-webhook] deals.info HTTP', r.status, '→ best-effort accepteren');
          }
        }
      } catch (e) { console.warn('[tl-webhook] deals.info exception (best-effort accepteren):', e.message); }

      if (objectOk) {
        const now = new Date().toISOString();
        const { error } = await supabaseAdmin.from('deals').update({
          tl_quotation_status: 'accepted', tl_quotation_accepted_at: now, tl_quotation_signed_at: now,
        }).eq('tl_deal_id', objectId);
        if (error) errorText = 'DB-update mislukt: ' + error.message;
        else { processedAt = now; verified = true; }
      } else {
        verified = false;
      }
    } else if (eventType === 'deal.lost' && objectId) {
      // F5.1 mentor-hook: deal verloren → openstaande bonus-entries op deze
      // deal annuleren. Lookup tl_deal_id → deals.id, dan engine-call.
      const { data: dealRow } = await supabaseAdmin
        .from('deals').select('id').eq('tl_deal_id', objectId).maybeSingle();
      if (dealRow) {
        try {
          await cancelForCancelledQuote({ quoteId: dealRow.id });
        } catch (e) {
          console.error('[tl-webhook] mentor-hook cancelForCancelledQuote:', e.message);
        }
      }
      processedAt = new Date().toISOString();
      verified = true;
    } else {
      // deal.moved e.a.: alleen loggen.
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
