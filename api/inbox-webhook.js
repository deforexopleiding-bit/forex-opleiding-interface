// api/inbox-webhook.js
// Webhook-endpoint voor Meta WhatsApp Cloud API. Twee modes:
//
//   GET  ?hub.mode=subscribe&hub.verify_token=X&hub.challenge=Y
//        Meta-subscription handshake. Echo `hub.challenge` als token klopt,
//        anders 403. Plain-text response.
//
//   POST { object, entry: [{ id, changes: [{ field, value }] }] }
//        Meta levert inbound messages + status-updates (sent/delivered/read/
//        failed). PR A1 verifieert alleen de signature, logt de payload-shape
//        en returnt 200 om Meta te tonen dat we 'm hebben ontvangen — geen
//        actual processing van de body. PR A2 implementeert: persist
//        whatsapp_messages + update whatsapp_conversations + customer match
//        op phone_number.
//
// Belangrijk: voor X-Hub-Signature-256 verificatie hebben we de RAW request
// body nodig. Vercel parsed standaard de JSON, dus disable bodyParser en
// lees de body handmatig als string.

import { verifyWebhookSubscription, verifyWebhookSignature, getConfigStatus } from './_lib/meta-whatsapp.js';

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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // ── GET: Meta subscription verify ────────────────────────────────────────
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
      // Meta-config niet compleet → laat de subscription nog niet werken,
      // maar geef 503 i.p.v. crash zodat Meta z'n setup-helper een nette
      // fout ziet.
      console.error('[inbox-webhook] GET verify config-fout:', e.message);
      res.setHeader('Content-Type', 'text/plain');
      return res.status(503).send('Webhook not configured');
    }
  }

  // ── POST: Meta inbound delivery ──────────────────────────────────────────
  if (req.method === 'POST') {
    let rawBody;
    try { rawBody = await readRawBody(req); }
    catch (e) {
      console.error('[inbox-webhook] readRawBody fout:', e.message);
      return res.status(400).json({ error: 'bad request body' });
    }

    // Signature-verificatie (verplicht zodra APP_SECRET in env staat).
    const sigHeader = req.headers['x-hub-signature-256'] || null;
    let signatureOk = false;
    try {
      signatureOk = verifyWebhookSignature(sigHeader, rawBody);
    } catch (e) {
      // Config-fout: APP_SECRET ontbreekt. Tijdens initiele setup-fase
      // accepteren we de webhook nog niet — return 503 zodat Meta retried
      // zodra setup compleet is. Niet 200 want dan markeert Meta 'm als
      // 'delivered' terwijl wij niks deden.
      console.warn('[inbox-webhook] POST signature config-fout:', e.message);
      return res.status(503).json({ error: 'webhook signature not configured' });
    }
    if (!signatureOk) {
      console.warn('[inbox-webhook] POST signature mismatch — rejected');
      return res.status(401).json({ error: 'invalid signature' });
    }

    // PR A1: log de top-level shape voor latere implementatie, return 200.
    let body = null;
    try { body = JSON.parse(rawBody.toString('utf8')); } catch {}
    const summary = {
      object:        body?.object || null,
      entry_count:   Array.isArray(body?.entry) ? body.entry.length : 0,
      first_changes: Array.isArray(body?.entry?.[0]?.changes)
                        ? body.entry[0].changes.map(c => c.field)
                        : [],
    };
    console.log('[inbox-webhook] POST ack (PR A1 noop)', JSON.stringify(summary));

    // PR A2 TODO: per entry/changes/value: parse messages[] + statuses[],
    // upsert whatsapp_conversations op phone_number, insert whatsapp_messages
    // op meta_wamid (idempotent: Meta retried bij timeout).
    return res.status(200).json({ ok: true, pr: 'A1-skeleton' });
  }

  // ── Anders: alleen GET en POST toegestaan ────────────────────────────────
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
