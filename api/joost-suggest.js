// api/joost-suggest.js
// POST -> genereer een Joost-suggestie voor een WhatsApp-conversatie.
//
// HTTP-laag (auth + RBAC + body-parse). Suggest-logica zit in
// api/_lib/joost-suggest-core.js zodat de webhook 'm direct in-process kan
// aanroepen zonder zelf-HTTP-fetch (Fase 2 stap 1 — fix voor 'fetch failed').
//
// Twee auth-paden blijven byte-identiek met de oude handler:
//   (a) X-Internal-Token header == process.env.INTERNAL_API_TOKEN
//       → system-pad (legacy: oude webhook-self-call). RBAC geskipt;
//         suggestion krijgt requested_by_user_id=NULL en auto_triggered uit
//         body. Wordt ná Fase 2 stap 1 niet meer gebruikt vanuit webhook
//         (in-process call), maar blijft beschikbaar voor toekomstige
//         service-to-service callers.
//   (b) Bearer-JWT + finance.joost.use permission-check (handmatige
//       'Vraag Joost'-knop in finance-inbox UI). Suggestion krijgt
//       requested_by_user_id=user.id, auto_triggered=false.
//
// Permission: finance.joost.use (strict — geen fallback; admin krijgt automatisch
// via super_admin in user_has_permission).
//
// Body:
//   {
//     conversation_id:           uuid (verplicht),
//     triggered_by_message_id:   uuid (optioneel — meestal de laatste inbound),
//     auto_triggered:            boolean (optioneel; default false) — markeert
//                                rij als E1.1 webhook-triggered i.p.v. handmatige
//                                'Vraag Joost'-klik. Wordt opgeslagen op
//                                joost_suggestions.auto_triggered.
//   }
//
// Error responses:
//   400  conversation_id ontbreekt / ongeldige uuid
//   401  geen sessie (alleen bij user-call zonder geldige Bearer + zonder
//        geldige X-Internal-Token)
//   403  geen finance.joost.use rechten
//   404  conversation niet gevonden
//   429  rate-limit (vorige suggestie < 30s oud) of Anthropic 429
//   500  onverwachte fout (DB-fail, etc.)
//   502  Anthropic API-fout (network / 5xx / lege response)
//   503  ANTHROPIC_API_KEY niet geconfigureerd OF Joost gedeactiveerd voor module
//
// Response 200:
//   {
//     suggestion: {
//       id, suggested_reply, detected_intent, confidence, reasoning, created_at
//     }
//   }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';
import { runJoostSuggest } from './_lib/joost-suggest-core.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // ---- Auth ----
  const internalTokenHeader = req.headers['x-internal-token'] || req.headers['X-Internal-Token'] || null;
  const expectedInternalToken = process.env.INTERNAL_API_TOKEN || null;
  const isInternalCall = !!(
    internalTokenHeader &&
    expectedInternalToken &&
    typeof internalTokenHeader === 'string' &&
    internalTokenHeader === expectedInternalToken
  );

  let user = null;
  if (!isInternalCall) {
    const userClient = createUserClient(req);
    const { data: { user: u }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !u) return res.status(401).json({ error: 'Niet geauthenticeerd' });
    user = u;

    if (!(await requirePermission(req, 'finance.joost.use'))) {
      return res.status(403).json({ error: 'Geen rechten (finance.joost.use)' });
    }
  }

  // ---- Body parsen + UUID-validatie ----
  const body = req.body || {};
  const convId = typeof body.conversation_id === 'string' ? body.conversation_id.trim() : '';
  if (!convId) return res.status(400).json({ error: 'conversation_id vereist' });
  if (!isUuid(convId)) return res.status(400).json({ error: 'conversation_id moet geldige uuid zijn' });

  const triggeredById = typeof body.triggered_by_message_id === 'string'
    ? body.triggered_by_message_id.trim()
    : null;
  if (triggeredById && !isUuid(triggeredById)) {
    return res.status(400).json({ error: 'triggered_by_message_id moet geldige uuid zijn' });
  }

  const autoTriggered = body.auto_triggered === true;

  // ---- Core call ----
  try {
    const result = await runJoostSuggest({
      supabase:             supabaseAdmin,
      conversationId:       convId,
      triggeredByMessageId: triggeredById,
      autoTriggered,
      requestedByUserId:    user ? user.id : null,
      clientIp:             getClientIp(req),
    });
    return res.status(result.status).json(result.body);
  } catch (e) {
    console.error('[joost-suggest]', e && e.message);
    return res.status(500).json({ error: e && e.message ? e.message : 'Interne fout' });
  }
}
