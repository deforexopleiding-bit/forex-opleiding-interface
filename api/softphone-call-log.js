// api/softphone-call-log.js
// POST → log een uitgaand softphone-gesprek. Append-only.
//
// Permission: elke ingelogde CRM-user (via createUserClient auth-gate).
// Werknemer logt eigen calls; RLS regelt read-access (super_admin ziet alles,
// overige rollen alleen eigen rijen).
//
// Body:
//   { to_number: string (E.164), from_number?: string, line: 'nl'|'be',
//     started_at: ISO, ended_at?: ISO | null, outcome_hint?: enum,
//     customer_id?: uuid, lead_id?: uuid, meta?: object,
//     opvolging_taak_id?: uuid }   ← fase 2, optioneel; zonder deze sleutel
//                                    gedraagt het endpoint zich exact als voorheen
//
// duration_sec wordt SERVER-side berekend (client stuurt 'em niet mee).
// Fail-soft: retourneert 200 met `id` bij succes; 4xx bij validatie.
// De bel-flow mag hier NOOIT op wachten — fire-and-forget (klx-softphone
// hook doet dit al met fetch keepalive:false — geen await in de call-flow).
//
// Rate-limit: 10 POST/min/user als guard tegen storm/misbruik.
//
// Herstel-context (2026-08-27): dit bestand verdween in een rebase over 3
// parallelle commits tijdens #snapshot-B. 1:1 hersteld uit de #call-log-A-
// versie (client-hook in klx-softphone.js verwacht deze exacte body-shape).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { checkRateLimit } from './_lib/rate-limit.js';
// Fase 2 DEEL A — een gesprek telt automatisch mee als belpoging in de
// opvolgmodule. Puur additief: alles hieronder draait pas ná de bestaande
// call_log-insert en kan die niet beïnvloeden.
import { kiesTaakVoorCall, bouwCallPoging, telefoonStaart } from './_lib/opvolging-call-link.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINES = new Set(['nl','be']);
const OUTCOMES = new Set(['answered','no_answer','busy','failed','local_cancel']);
const MAX_META_BYTES = 2000;

// Bel-log accepteert elke telefoon-notatie die de SIP-flow accepteerde.
// Normaliseer met line-context; best-effort. Onparseerbaar → return raw
// zodat de rij toch geschreven wordt. Geen exception, geen 400: dit is
// een LOG, geen SEND — data-verlies is erger dan een minder-net formaat.
function _normalizeToE164(raw, line) {
  if (!raw) return null;
  const s = String(raw).trim().replace(/\s+/g, '').replace(/[-()]/g, '');
  if (!s) return null;
  if (s.startsWith('+'))  return s;                        // al E.164
  if (s.startsWith('00')) return '+' + s.slice(2);         // 00-prefix
  if (s.startsWith('0')) {
    if (line === 'nl') return '+31' + s.slice(1);
    if (line === 'be') return '+32' + s.slice(1);
  }
  return s;   // short-code / extension / onbekend → raw, geen 400
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const rl = await checkRateLimit({ req, bucket: 'softphone-call-log', maxHits: 10, withinSeconds: 60 });
  if (rl.limited) return res.status(429).json({ error: 'Rate limited' });

  const body = req.body || {};

  // Line eerst — _normalizeToE164 heeft 'em nodig voor 0-prefix mapping.
  const line = String(body.line || '').trim().toLowerCase();
  if (!LINES.has(line)) return res.status(400).json({ error: "line moet 'nl' of 'be' zijn" });

  const rawTo = String(body.to_number || '').trim();
  if (!rawTo) return res.status(400).json({ error: 'to_number vereist' });
  const to_number = _normalizeToE164(rawTo, line);
  if (!to_number) return res.status(400).json({ error: 'to_number kon niet worden geparsed' });
  if (!to_number.startsWith('+')) {
    console.warn('[softphone-call-log] to_number niet-E.164 na normalisatie, opgeslagen als raw:', to_number.slice(0, 20));
  }

  const rawFrom = body.from_number ? String(body.from_number).trim() : null;
  const from_number = rawFrom ? _normalizeToE164(rawFrom, line) : null;

  const started_at = body.started_at ? new Date(body.started_at) : null;
  if (!started_at || isNaN(started_at.getTime())) return res.status(400).json({ error: 'started_at (ISO) vereist' });
  const ended_at = body.ended_at ? new Date(body.ended_at) : null;
  if (body.ended_at && (!ended_at || isNaN(ended_at.getTime()))) return res.status(400).json({ error: 'ended_at ongeldig' });
  const outcome_hint = body.outcome_hint ? String(body.outcome_hint).trim() : null;
  if (outcome_hint && !OUTCOMES.has(outcome_hint)) return res.status(400).json({ error: 'outcome_hint ongeldig' });
  const customer_id = body.customer_id ? String(body.customer_id).trim() : null;
  if (customer_id && !UUID_RE.test(customer_id)) return res.status(400).json({ error: 'customer_id ongeldig' });
  const lead_id = body.lead_id ? String(body.lead_id).trim() : null;
  if (lead_id && !UUID_RE.test(lead_id)) return res.status(400).json({ error: 'lead_id ongeldig' });
  // Optioneel. Ontbreekt 'ie, dan verandert er hieronder niets aan de bestaande
  // weg — de call_log-rij wordt geschreven zoals altijd en de koppelpoging
  // hieronder valt terug op matchen-op-nummer.
  const opvolging_taak_id = body.opvolging_taak_id ? String(body.opvolging_taak_id).trim() : null;
  if (opvolging_taak_id && !UUID_RE.test(opvolging_taak_id)) {
    return res.status(400).json({ error: 'opvolging_taak_id ongeldig' });
  }
  let meta = null;
  if (body.meta && typeof body.meta === 'object') {
    const s = JSON.stringify(body.meta);
    if (s.length > MAX_META_BYTES) return res.status(400).json({ error: `meta > ${MAX_META_BYTES} bytes` });
    meta = body.meta;
  }

  const duration_sec = (ended_at && started_at)
    ? Math.max(0, Math.round((ended_at.getTime() - started_at.getTime()) / 1000))
    : null;

  try {
    const { data, error } = await supabaseAdmin.from('call_log').insert({
      user_id: user.id, customer_id, lead_id,
      to_number, from_number, line,
      started_at: started_at.toISOString(),
      ended_at: ended_at ? ended_at.toISOString() : null,
      duration_sec, outcome_hint, source: 'klx_softphone',
      meta,
    }).select('id').single();
    if (error) throw new Error('call_log insert: ' + error.message);
    // Fase 2 DEEL A — belpoging in de opvolgmodule. Fail-soft en apart van de
    // insert hierboven: het gesprek is al gelogd, en een mislukte koppeling mag
    // dat nooit ongedaan maken of de response vertragen tot een fout.
    const gekoppeld = await koppelAanOpvolgtaak({
      opvolgingTaakId: opvolging_taak_id,
      toNumber:        to_number,
      startedAt:       started_at.toISOString(),
      outcomeHint:     outcome_hint,
      durationSec:     duration_sec,
      callLogId:       data.id,
    });
    return res.status(200).json({ ok: true, id: data.id, opvolging_poging: gekoppeld });
  } catch (e) {
    console.error('[softphone-call-log]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}

/**
 * Fase 2 DEEL A — schrijf dit gesprek als belpoging bij een opvolgtaak.
 *
 * Twee wegen, in deze volgorde:
 *   1. De Bellen-knop in de opvolgmodule stuurt de taak-id mee. Zeker weten.
 *   2. Anders: matchen op genormaliseerd telefoonnummer aan de meest recente
 *      open taak, en alleen als het gesprek binnen de laatste twee uur begon.
 *      Lukt dat niet eenduidig, dan gebeurt er niets — dat is de bedoeling.
 *
 * Gooit nooit. Geeft { taak_id, poging_id } terug bij succes, anders null.
 * De caller heeft de call_log-rij dan al geschreven; deze functie is er
 * bovenop en mag die nooit in gevaar brengen.
 */
async function koppelAanOpvolgtaak({ opvolgingTaakId, toNumber, startedAt, outcomeHint, durationSec, callLogId }) {
  try {
    // Al gekoppeld? De client post idempotent, maar een retry na een
    // netwerkfout kan dezelfde call twee keer aanbieden. Eén gesprek is één
    // poging — anders telt de dekking in Afgerond te hoog en klopt het oordeel
    // over hoeveel moeite er gedaan is niet meer.
    if (callLogId) {
      const { data: bestaand } = await supabaseAdmin
        .from('opvolging_pogingen').select('id').eq('call_log_id', String(callLogId)).limit(1);
      if (bestaand && bestaand[0]) return { taak_id: null, poging_id: bestaand[0].id, hergebruikt: true };
    }

    let taakId = null;
    if (opvolgingTaakId) {
      // Alleen accepteren als de taak bestaat en nog open staat. Een id uit een
      // oud tabblad mag geen poging op een afgeronde taak plakken.
      const { data: taak } = await supabaseAdmin
        .from('opvolging_taken').select('id, status').eq('id', opvolgingTaakId).maybeSingle();
      if (taak && taak.status !== 'gearchiveerd') taakId = taak.id;
    }

    if (!taakId) {
      // Kandidaten voorfilteren op de laatste negen cijfers zodat we niet de
      // hele tabel ophalen; de definitieve keuze maakt kiesTaakVoorCall.
      const staart = telefoonStaart(toNumber);
      if (!staart) return null;
      const { data: kandidaten } = await supabaseAdmin
        .from('opvolging_taken')
        .select('id, telefoon, status, updated_at, created_at')
        .neq('status', 'gearchiveerd')
        .like('telefoon', `%${staart}`)
        .order('updated_at', { ascending: false })
        .limit(25);
      const gekozen = kiesTaakVoorCall({ taken: kandidaten || [], toNumber, startedAt });
      if (!gekozen) return null;
      taakId = gekozen.id;
    }

    const rij = bouwCallPoging({ taakId, outcomeHint, durationSec, callLogId });
    if (!rij) return null;
    const { data: poging, error: pErr } = await supabaseAdmin
      .from('opvolging_pogingen').insert(rij).select('id').maybeSingle();
    if (pErr) throw new Error(pErr.message);

    await supabaseAdmin.from('opvolging_taken')
      .update({ updated_at: new Date().toISOString() }).eq('id', taakId);

    return { taak_id: taakId, poging_id: poging?.id || null };
  } catch (e) {
    console.warn('[softphone-call-log] opvolging-koppeling (soft):', e?.message || e);
    return null;
  }
}
