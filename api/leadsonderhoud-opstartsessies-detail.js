// api/leadsonderhoud-opstartsessies-detail.js
//
// GET  ?id=<uuid>
//
// Volledige detail-view van één opstartsessie_submissions-rij + join op
// booking_sources voor label + optionele afspraak-status (scheduled_at,
// status uit follow_up_appointments).
//
// Response:
//   {
//     item: {
//       id, created_at, booking_source, bron_label,
//       naam, email, telefoon,
//       gekozen_slot, gekozen_start_at,
//       antwoorden: [{ vraag, gekozen_label, punten, afwijzer }],
//       score, drempel, resultaat, noshow_akkoord,
//       appointment_id, lead_id,
//       afspraak?: { scheduled_at, status, zoom_join_url }
//     }
//   }
//
// Auth: leads.view.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  const id = String((req.query || {}).id || '').trim();
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id ongeldig' });

  try {
    const { data: row, error } = await supabaseAdmin
      .from('opstartsessie_submissions')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!row) return res.status(404).json({ error: 'Submission niet gevonden' });

    // Bron-label (fallback = rauwe slug).
    let bronLabel = row.booking_source || '—';
    if (row.booking_source) {
      const { data: b } = await supabaseAdmin
        .from('booking_sources').select('label').eq('slug', row.booking_source).maybeSingle();
      if (b?.label) bronLabel = b.label;
    }

    // Optionele afspraak-context.
    let afspraak = null;
    if (row.appointment_id) {
      const { data: a } = await supabaseAdmin
        .from('follow_up_appointments')
        .select('scheduled_at, status, zoom_join_url, annulering_reden, annulering_reden_code')
        .eq('id', row.appointment_id)
        .maybeSingle();
      if (a) afspraak = a;
    }

    // Normaliseer antwoorden (defensief — kan jsonb-null zijn).
    const antwoorden = Array.isArray(row.antwoorden) ? row.antwoorden : [];

    return res.status(200).json({
      item: {
        id              : row.id,
        created_at      : row.created_at,
        booking_source  : row.booking_source,
        bron_label      : bronLabel,
        naam            : row.naam,
        email           : row.email,
        telefoon        : row.telefoon,
        gekozen_slot    : row.gekozen_slot,
        gekozen_start_at: row.gekozen_start_at,
        antwoorden,
        score           : row.score,
        drempel         : row.drempel,
        resultaat       : row.resultaat,
        noshow_akkoord  : !!row.noshow_akkoord,
        appointment_id  : row.appointment_id,
        lead_id         : row.lead_id,
        afspraak,
      },
    });
  } catch (e) {
    console.error('[leadsonderhoud-opstartsessies-detail]', e?.message || e);
    return res.status(500).json({ error: 'Detail laden mislukt' });
  }
}
