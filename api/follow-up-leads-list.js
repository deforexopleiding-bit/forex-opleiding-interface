// api/follow-up-leads-list.js
//
// GET → follow_up_leads met filters + counts per view. Alleen deze tabel;
// bestaande follow-up/GHL-endpoints ongemoeid.
//
// Query:
//   ?source=retention|event|all         (default 'all')
//   ?status=<csv van de 6>              (optioneel; anders alles)
//   ?view=alle|vandaag|te_laat|open     (default 'alle')
//   ?limit=<n>                          (default 500, max 1000)
//
// Response 200: { leads: [...], counts: { alle, open, vandaag, te_laat } }
// Response 501 bij ontbrekende tabel (42P01) — migratie nodig.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const LEAD_STATUSES = ['nieuw', 'benaderd', 'niet_bereikbaar', 'terugbellen', 'verlengd', 'verloren'];
const OPEN_STATUSES = LEAD_STATUSES.filter((s) => s !== 'verlengd' && s !== 'verloren');

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (sales.tab.retentie of sales.customer.view)' });

  const q = req.query || {};
  const source = ['retention', 'event', 'all'].includes(q.source) ? q.source : 'all';
  const view   = ['alle', 'vandaag', 'te_laat', 'open'].includes(q.view) ? q.view : 'alle';
  const statusCsv = typeof q.status === 'string' ? q.status.trim() : '';
  const statusFilter = statusCsv
    ? statusCsv.split(',').map((s) => s.trim()).filter((s) => LEAD_STATUSES.includes(s))
    : null;
  let limit = Number(q.limit) || 500;
  limit = Math.max(1, Math.min(1000, Math.floor(limit)));

  // owner-filter (Fase D):
  //   ?owner=me     → owner_id = user.id
  //   ?owner=<uuid> → owner_id = <uuid>
  //   ?owner=none   → owner_id IS NULL (niet toegewezen)
  //   afwezig / all → geen filter
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ownerQ = typeof q.owner === 'string' ? q.owner.trim() : '';
  let ownerFilter = null;
  if (ownerQ === 'me') ownerFilter = { kind: 'eq', value: user.id };
  else if (ownerQ === 'none') ownerFilter = { kind: 'is_null' };
  else if (UUID_RE.test(ownerQ)) ownerFilter = { kind: 'eq', value: ownerQ };

  try {
    const todayISO = new Date().toISOString().slice(0, 10);
    const nowISO   = new Date().toISOString();

    const applyFilters = (qq) => {
      if (source !== 'all') qq = qq.eq('source', source);
      if (statusFilter && statusFilter.length) qq = qq.in('lead_status', statusFilter);
      if (view === 'vandaag') {
        qq = qq.gte('terugbel_datum', todayISO + 'T00:00:00Z').lte('terugbel_datum', todayISO + 'T23:59:59Z');
      } else if (view === 'te_laat') {
        qq = qq.lt('terugbel_datum', nowISO).not('lead_status', 'in', '(verlengd,verloren)');
      } else if (view === 'open') {
        qq = qq.not('lead_status', 'in', '(verlengd,verloren)');
      }
      if (ownerFilter?.kind === 'eq')      qq = qq.eq('owner_id', ownerFilter.value);
      else if (ownerFilter?.kind === 'is_null') qq = qq.is('owner_id', null);
      return qq;
    };

    let base = supabaseAdmin
      .from('follow_up_leads')
      .select('id, customer_id, source, lead_name, lead_email, lead_phone, lead_status, terugbel_datum, owner_id, last_contact_at, source_ref, created_at, updated_at')
      .order('terugbel_datum', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(limit);
    base = applyFilters(base);

    const { data: leads, error: leadErr } = await base;
    if (leadErr) {
      if (leadErr.code === '42P01') {
        return res.status(501).json({ error: 'Tabel follow_up_leads ontbreekt — migratie vereist', code: 'MIGRATION_REQUIRED' });
      }
      throw new Error('leads fetch: ' + leadErr.message);
    }

    // Verrijk elk lead met owner_name (profiles.full_name) via een IN-lookup.
    const ownerIds = [...new Set((leads || []).map((l) => l.owner_id).filter(Boolean))];
    const ownerNameById = {};
    if (ownerIds.length) {
      const { data: profs, error: pErr } = await supabaseAdmin
        .from('profiles').select('id, full_name').in('id', ownerIds);
      if (pErr) console.warn('[follow-up-leads-list] owners:', pErr.message);
      for (const p of (profs || [])) ownerNameById[p.id] = p.full_name || null;
    }
    const enrichedLeads = (leads || []).map((l) => ({
      ...l,
      owner_name: l.owner_id ? (ownerNameById[l.owner_id] || null) : null,
    }));

    // Counts per view — 4 goedkope head-count queries.
    const countBase = () => supabaseAdmin.from('follow_up_leads').select('id', { count: 'exact', head: true });
    const [
      { count: cAlle },
      { count: cOpen },
      { count: cVandaag },
      { count: cTeLaat },
    ] = await Promise.all([
      countBase(),
      countBase().not('lead_status', 'in', '(verlengd,verloren)'),
      countBase()
        .gte('terugbel_datum', todayISO + 'T00:00:00Z')
        .lte('terugbel_datum', todayISO + 'T23:59:59Z'),
      countBase().lt('terugbel_datum', nowISO).not('lead_status', 'in', '(verlengd,verloren)'),
    ]);

    return res.status(200).json({
      leads: enrichedLeads,
      counts: {
        alle    : cAlle || 0,
        open    : cOpen || 0,
        vandaag : cVandaag || 0,
        te_laat : cTeLaat || 0,
      },
      allowed_statuses: LEAD_STATUSES,
    });
  } catch (e) {
    console.error('[follow-up-leads-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
