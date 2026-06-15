// api/event-choice-prefill.js
//
// PUBLIEK read-only GET-endpoint. Input: ?t=<choice_token>.
// Token is de authenticatie (zelfde model als event-choice-get).
//
// BEWUST PII-RETURN — let op:
//   Dit endpoint geeft naam + e-mail + telefoon terug van de aanmelder.
//   Dat is een bewuste afwijking van event-choice-get (privacy-safe; alleen
//   first_name), uitsluitend t.b.v. PREFILL van de vragenlijst zodat de
//   deelnemer z'n al bekende contactgegevens niet nogmaals hoeft te typen.
//   De tokenbezit-gate (UUID + IP-rate-limit) is de enige toegangslaag — er
//   is geen sessie en geen extra check. Wijzig event-choice-get NIET; die
//   blijft privacy-safe voor de keuzepagina.
//
// Rate-limit + foutafhandeling: 1-op-1 gespiegeld van event-choice-get
// (zelfde event_choice_lookup_log, dezelfde hashIp, dezelfde 400/404/429/500-
// shapes, zonder details te lekken bij onbekend/ongeldig token).
//
// Response 200:
//   { prefill: { first_name, last_name, email, phone } }   // null waar leeg
// Response 400: t (uuid) ontbreekt of ongeldig formaat
// Response 404: token onbekend
// Response 405: GET only
// Response 429: rate-limit hit
// Response 500: database-fout

import { supabaseAdmin } from './supabase.js';
import { extractClientIp, hashIp } from './_lib/assessment-validation.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RATE_LIMIT_MAX_PER_MINUTE = 30;

async function isIpRateLimited(ipHash) {
  if (!ipHash) return false;
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count, error } = await supabaseAdmin
    .from('event_choice_lookup_log')
    .select('id', { count: 'exact', head: true })
    .eq('ip_hash', ipHash)
    .gte('lookup_at', since);
  if (error) {
    // Soft-fail open — zelfde keuze als event-choice-get.
    console.error('[event-choice-prefill] rate-limit query:', error.message);
    return false;
  }
  return typeof count === 'number' && count >= RATE_LIMIT_MAX_PER_MINUTE;
}

async function logLookup(ipHash) {
  if (!ipHash) return;
  try {
    await supabaseAdmin
      .from('event_choice_lookup_log')
      .insert({ ip_hash: ipHash });
  } catch (e) {
    console.error('[event-choice-prefill] log insert:', e?.message || e);
  }
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // 1) Token parsen + valideren.
  const token = req.query?.t ? String(req.query.t).trim() : null;
  if (!token || !UUID_RE.test(token)) {
    return res.status(400).json({ error: 'Token vereist.' });
  }

  // 2) IP-rate-limit.
  const ip = extractClientIp(req);
  const ipHash = hashIp(ip);
  if (await isIpRateLimited(ipHash)) {
    return res.status(429).json({ error: 'Te veel verzoeken. Probeer het later opnieuw.' });
  }

  try {
    // 3) Token → attendee. NB: hier WEL PII selecteren — endpoint-doel.
    const { data: attendee, error: attErr } = await supabaseAdmin
      .from('event_attendees')
      .select('first_name, last_name, email, phone')
      .eq('choice_token', token)
      .maybeSingle();
    if (attErr) {
      console.error('[event-choice-prefill] attendee fetch:', attErr.message);
      await logLookup(ipHash);
      return res.status(500).json({ error: 'Kon gegevens niet ophalen.' });
    }
    if (!attendee) {
      await logLookup(ipHash);
      return res.status(404).json({ error: 'Link niet geldig.' });
    }

    await logLookup(ipHash);

    return res.status(200).json({
      prefill: {
        first_name: attendee.first_name || null,
        last_name : attendee.last_name  || null,
        email     : attendee.email      || null,
        phone     : attendee.phone      || null,
      },
    });
  } catch (e) {
    console.error('[event-choice-prefill] fatal:', e?.message || e);
    await logLookup(ipHash);
    return res.status(500).json({ error: 'Kon gegevens niet ophalen.' });
  }
}
