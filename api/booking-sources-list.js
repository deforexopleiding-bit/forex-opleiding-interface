// api/booking-sources-list.js
//
// GET  ?periode=week|maand|alles  (default 'alles')
//
// Returnt de Bronnenlijst uit public.booking_sources gecombineerd met een
// count per bron van follow_up_appointments.booking_source binnen het
// gekozen tijdsvenster. Onbekende/typo-slugs (booking_source waarde die
// niet in booking_sources staat) worden meegeteld als "onbekend"-rijen
// zodat niets verdwijnt (typo blijft telbaar → Jeffrey ziet ze).
//
// Response:
//   {
//     items: [{ id, slug, label, actief, calls, is_registered }],
//     periode: 'week'|'maand'|'alles',
//     total_calls: int
//   }
//
// Auth: leads.view (spiegelt Leadsonderhoud → Vragenlijst-tab).
// Read-only, geen writes.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const PERIODES = new Set(['week', 'maand', 'alles']);

function periodeGrens(periode) {
  const now = new Date();
  if (periode === 'week') {
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  }
  if (periode === 'maand') {
    return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  }
  return null;
}

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

  const periodeRaw = String((req.query || {}).periode || 'alles').toLowerCase();
  const periode = PERIODES.has(periodeRaw) ? periodeRaw : 'alles';
  const grens = periodeGrens(periode);

  try {
    // 1) Bronnenlijst (werkversie).
    const { data: bronnen, error: e1 } = await supabaseAdmin
      .from('booking_sources')
      .select('id, slug, label, actief')
      .order('slug');
    if (e1) throw e1;

    // 2) Afspraak-rijen binnen venster (alleen booking_source-veld).
    let q = supabaseAdmin
      .from('follow_up_appointments')
      .select('booking_source, scheduled_at')
      .not('booking_source', 'is', null);
    if (grens) q = q.gte('created_at', grens);
    const { data: appts, error: e2 } = await q.limit(50000);
    if (e2 && e2.code !== '42703') throw e2;

    const tel = new Map();
    for (const a of (appts || [])) {
      const s = String(a.booking_source || '').trim().toLowerCase();
      if (!s) continue;
      tel.set(s, (tel.get(s) || 0) + 1);
    }

    // 3) Merge: elke geregistreerde bron + eventuele onbekende slugs.
    const bekende = new Set((bronnen || []).map((b) => b.slug));
    const items = (bronnen || []).map((b) => ({
      id: b.id,
      slug: b.slug,
      label: b.label,
      actief: !!b.actief,
      calls: tel.get(b.slug) || 0,
      is_registered: true,
    }));
    for (const [slug, calls] of tel.entries()) {
      if (bekende.has(slug)) continue;
      items.push({
        id: null, slug, label: `(onbekend) ${slug}`, actief: false,
        calls, is_registered: false,
      });
    }

    const total_calls = items.reduce((n, r) => n + r.calls, 0);

    return res.status(200).json({ items, periode, total_calls });
  } catch (e) {
    console.error('[booking-sources-list]', e?.message || e);
    return res.status(500).json({ error: 'Bronnenlijst laden mislukt' });
  }
}
