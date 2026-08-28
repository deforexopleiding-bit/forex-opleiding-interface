// api/toegang-aanvraag-start.js
//
// DEEL B — Aanvraag starten (WhatsApp-gate voor 7-daagse + mini-cursus).
// Aangeroepen door dfo-website ná de quiz-kwalificatie IPV de directe
// LMS-provisioning. Registreert de aanvraag in public.toegang_aanvragen
// status='wachtend'. De CRM-motor (cron-toegang-aanvragen) neemt het
// over: 2min-bevestiging + 2u/24u/48u reminders + vervallen + dag-6.
//
// Auth: x-internal-token == TOEGANG_AANVRAAG_SECRET (server-to-server,
//       zelfde patroon als LEAD_MELDING_SECRET en OPSTARTSESSIE_SECRET).
//
// Body:
//   voornaam       string  required (1..80)
//   email          string  required (geldig)
//   telefoon       string  required (E.164, min 8 tekens)
//   soort          enum    required ('7-daagse' | 'minicursus')
//   bron           string  optional — funnel-slug (bv. '7-daagse-v1')
//   call_geboekt   boolean optional (default false)
//
// Response:
//   200 { ok:true, aanvraag_id }
//   400 { error }              validatie
//   401 { error }              secret-mismatch
//   409 { error, aanvraag_id } duplicaat: al een 'wachtend' voor deze
//                               email+soort (idempotent — retourneert
//                               bestaande id zodat de website niet crasht
//                               bij een dubbele submit)
//   503 { error }              TOEGANG_AANVRAAG_SECRET ontbreekt
//
// 0 incasso-writes. Raakt alleen public.toegang_aanvragen.

import { supabaseAdmin } from './supabase.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SOORT_OK = new Set(['7-daagse', 'minicursus']);

function schoon(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : null;
}

// Basale E.164-normalisatie (NL/BE default). Idem als public-opstartsessie-book.
function telefoonE164(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits;
  const rest = digits.replace(/^0+/, '');
  if (rest.length >= 9 && rest.length <= 12) return '+31' + rest;
  return digits;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // Auth
  const tokenHeader = req.headers['x-internal-token'] || null;
  const verwacht    = process.env.TOEGANG_AANVRAAG_SECRET || null;
  if (!verwacht) return res.status(503).json({ error: 'TOEGANG_AANVRAAG_SECRET niet geconfigureerd' });
  if (!tokenHeader || tokenHeader !== verwacht) {
    return res.status(401).json({ error: 'Unauthorized (x-internal-token vereist)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const voornaam = schoon(body.voornaam, 80);
  const email    = String(body.email || '').trim().toLowerCase().slice(0, 200);
  const telRaw   = schoon(body.telefoon, 40);
  const telefoon = telefoonE164(telRaw);
  const soort    = schoon(body.soort, 20);
  const bron     = schoon(body.bron, 64);
  const callGeboekt = body.call_geboekt === true;

  if (!voornaam || voornaam.length < 1)  return res.status(400).json({ error: 'voornaam vereist' });
  if (!EMAIL_RE.test(email))              return res.status(400).json({ error: 'geldig e-mailadres vereist' });
  if (!telefoon || telefoon.replace(/\D/g, '').length < 8) return res.status(400).json({ error: 'geldig telefoonnummer (E.164) vereist' });
  if (!SOORT_OK.has(soort))               return res.status(400).json({ error: "soort moet '7-daagse' of 'minicursus' zijn" });

  try {
    // Idempotency-guard: bestaat er al een 'wachtend' aanvraag voor deze
    // email+soort? Zo ja: retourneer die id (voorkomt duplicate wachtrij bij
    // dubbele submit vanuit de website).
    const { data: bestaand } = await supabaseAdmin
      .from('toegang_aanvragen')
      .select('id, status')
      .eq('email', email)
      .eq('soort', soort)
      .in('status', ['wachtend', 'gereageerd'])   // niet 'vervallen' — nieuwe aanvraag toegestaan
      .order('created_at', { ascending: false })
      .limit(1);
    if (bestaand && bestaand.length > 0) {
      return res.status(409).json({
        ok: false,
        already: true,
        aanvraag_id: bestaand[0].id,
        status: bestaand[0].status,
        error: 'Er bestaat al een actieve aanvraag voor deze email+soort',
      });
    }

    const { data, error } = await supabaseAdmin
      .from('toegang_aanvragen')
      .insert({
        voornaam, email, telefoon, soort, bron,
        call_geboekt: callGeboekt,
        status: 'wachtend',
      })
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data?.id) return res.status(500).json({ error: 'Insert gaf geen id' });
    return res.status(200).json({ ok: true, aanvraag_id: data.id });
  } catch (e) {
    console.error('[toegang-aanvraag-start]', e?.message || e);
    return res.status(500).json({ error: 'Aanvraag opslaan mislukt' });
  }
}
