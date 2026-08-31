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
    // BP2 Deel A: owner_user_id meenemen. 42703 fail-soft voor pre-BP2 schema.
    let bronnen;
    {
      const { data, error } = await supabaseAdmin
        .from('booking_sources')
        .select('id, slug, label, actief, owner_user_id')
        .order('slug');
      if (error && error.code === '42703') {
        const { data: d2, error: e2 } = await supabaseAdmin
          .from('booking_sources')
          .select('id, slug, label, actief')
          .order('slug');
        if (e2) throw e2;
        bronnen = (d2 || []).map((b) => ({ ...b, owner_user_id: null }));
      } else if (error) {
        throw error;
      } else {
        bronnen = data;
      }
    }

    // BP2 Deel A: staff-lookup voor owner_user_id → naam-mapping.
    // Alleen voor bronnen met een owner. Fail-soft: bij fout tonen we
    // de raw uuid als label ipv de rij te blokkeren.
    const ownerIds = [...new Set((bronnen || []).map((b) => b.owner_user_id).filter(Boolean))];
    let ownerMap = {};
    if (ownerIds.length > 0) {
      try {
        const { data: profs } = await supabaseAdmin
          .from('profiles')
          .select('id, full_name, email')
          .in('id', ownerIds);
        for (const p of (profs || [])) {
          ownerMap[p.id] = { id: p.id, name: p.full_name || p.email || p.id, email: p.email || null };
        }
      } catch (e) {
        console.warn('[booking-sources-list] staff-lookup (soft):', e?.message || e);
      }
    }

    // 2) Afspraak-rijen binnen venster (alleen booking_source-veld).
    //    v=2 (2026-08-27 regressie-fix): fail-soft omhulling. Als deze query
    //    om welke reden dan ook faalt (schema-drift, PostgREST cache stale,
    //    RLS-mismatch), moet de bronnen-lijst ALSNOG kunnen laden — een
    //    call-count van 0 is beter dan een hele 500 die de UI leeg maakt.
    //    Voorheen ving alleen `code === '42703'`; andere codes (PGRST100,
    //    PGRST200, PGRST202) glipten er doorheen en veroorzaakten de
    //    'Kon bronnen niet laden'-regressie.
    let appts = [];
    try {
      let q = supabaseAdmin
        .from('follow_up_appointments')
        .select('booking_source, scheduled_at, created_at')
        .not('booking_source', 'is', null);
      if (grens) q = q.gte('created_at', grens);
      const { data: r, error: e2 } = await q.limit(50000);
      if (e2) {
        console.warn('[booking-sources-list] appt-count query fail (soft):', e2.code || '?', e2.message);
      } else {
        appts = r || [];
      }
    } catch (e) {
      console.warn('[booking-sources-list] appt-count exception (soft):', e?.message || e);
    }

    const tel = new Map();
    for (const a of appts) {
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
      owner_user_id: b.owner_user_id || null,
      owner:         b.owner_user_id ? (ownerMap[b.owner_user_id] || null) : null,
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
    // v=2 (2026-08-27): verbose error voor client-side diagnose. Zonder de
    // details bleef de client hangen op 'Kon bronnen niet laden' zonder
    // richting. Nu zie je in de UI-error direct de DB-code + message.
    const code = e?.code || 'unknown';
    const msg  = e?.message || String(e);
    console.error('[booking-sources-list]', code, msg);
    return res.status(500).json({ error: 'Bronnenlijst laden mislukt', code, detail: msg });
  }
}
