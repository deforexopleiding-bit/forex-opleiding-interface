// api/follow-up-cockpit-agenda.js
//
// GET — chronologische lijst van geplande momenten voor de sales-cockpit
// Afspraken-tab. Alleen leads met terugbel_datum ingevuld, niet-gesnoozed
// en niet-afgesloten (verlengd/verloren).
//
// Query:
//   ?owner=me|all   (default 'all')
//   ?kind=zoom|bel|all (default 'all')
//   ?limit=<n>      (default 500, max 1000)
//
// Response:
//   { items: [{ id, lead_name, lead_phone, lead_email, terugbel_datum,
//               lead_kind ('zoom'|'bel'), lead_status, owner_id, owner_name,
//               source, is_hot }] }
// 42P01/42703 → 501 MIGRATION_REQUIRED.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  const q     = req.query || {};
  const owner = ['me', 'all'].includes(q.owner) ? q.owner : 'all';
  const kind  = ['zoom', 'bel', 'all'].includes(q.kind) ? q.kind : 'all';
  let limit   = Number(q.limit) || 500;
  limit = Math.max(1, Math.min(1000, Math.floor(limit)));

  try {
    const nowIso = new Date().toISOString();
    const RICH_COLS = 'id, source, lead_name, lead_email, lead_phone, lead_status, terugbel_datum, owner_id, is_hot, snoozed_until, lead_kind';
    const CORE_COLS = 'id, source, lead_name, lead_email, lead_phone, lead_status, terugbel_datum, owner_id';

    const build = (cols) => {
      let qq = supabaseAdmin.from('follow_up_leads')
        .select(cols)
        .not('terugbel_datum', 'is', null)
        .not('lead_status', 'in', '(verlengd,verloren)')
        .order('terugbel_datum', { ascending: true })
        .limit(limit);
      if (owner === 'me') qq = qq.eq('owner_id', user.id);
      return qq;
    };

    let rows = [];
    let hasRich = true;
    {
      let qq = build(RICH_COLS);
      // Snoozed uitsluiten alleen zinvol als kolom bestaat.
      qq = qq.or('snoozed_until.is.null,snoozed_until.lte.' + nowIso);
      if (kind === 'zoom') qq = qq.eq('lead_kind', 'zoom');
      else if (kind === 'bel') qq = qq.or('lead_kind.is.null,lead_kind.eq.call');
      const { data, error } = await qq;
      if (error && error.code === '42703') {
        hasRich = false;
        const { data: d2, error: e2 } = await build(CORE_COLS);
        if (e2) {
          if (e2.code === '42P01') return res.status(501).json({ error: 'Tabel follow_up_leads ontbreekt', code: 'MIGRATION_REQUIRED' });
          throw new Error(e2.message);
        }
        rows = d2 || [];
      } else if (error) {
        if (error.code === '42P01') return res.status(501).json({ error: 'Tabel follow_up_leads ontbreekt', code: 'MIGRATION_REQUIRED' });
        throw new Error(error.message);
      } else {
        rows = data || [];
      }
    }

    // Owner-naam lookup.
    const ownerIds = [...new Set(rows.map((r) => r.owner_id).filter(Boolean))];
    const ownerNameById = {};
    if (ownerIds.length) {
      const { data: profs } = await supabaseAdmin
        .from('profiles').select('id, full_name').in('id', ownerIds);
      for (const p of (profs || [])) ownerNameById[p.id] = p.full_name;
    }

    const items = rows.map((r) => {
      const isZoom = hasRich ? (String(r.lead_kind || 'call') === 'zoom') : false;
      return {
        id             : r.id,
        source         : r.source,
        lead_name      : r.lead_name,
        lead_phone     : r.lead_phone,
        lead_email     : r.lead_email,
        terugbel_datum : r.terugbel_datum,
        lead_status    : r.lead_status,
        owner_id       : r.owner_id,
        owner_name     : r.owner_id ? (ownerNameById[r.owner_id] || null) : null,
        lead_kind      : isZoom ? 'zoom' : 'bel',
        is_hot         : hasRich ? (r.is_hot === true) : false,
      };
    });

    return res.status(200).json({ items });
  } catch (e) {
    console.error('[follow-up-cockpit-agenda]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
