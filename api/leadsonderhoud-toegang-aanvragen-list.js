// api/leadsonderhoud-toegang-aanvragen-list.js
//
// DEEL E — read-endpoint voor Leadsonderhoud → Toegang-aanvragen-tab.
// GET  ?status=alle|wachtend|gereageerd|vervallen  (default 'alle')
//      ?soort=alle|7-daagse|minicursus              (default 'alle')
//      ?periode=week|maand|alles                     (default 'alles')
//      ?limit=25                                     (max 200)
//
// Auth: leads.view (spiegelt Opstartsessies-tab).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getSetterScope, filterBySetterScope } from './_lib/setter-scope.js';

const STATUS_OK = new Set(['alle', 'wachtend', 'gereageerd', 'vervallen']);
const SOORT_OK  = new Set(['alle', '7-daagse', 'minicursus']);
const PERIODE_OK = new Set(['week', 'maand', 'alles']);

function periodeGrens(p) {
  const now = Date.now();
  if (p === 'week')  return new Date(now - 7  * 86400000).toISOString();
  if (p === 'maand') return new Date(now - 30 * 86400000).toISOString();
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

  const q = req.query || {};
  const status  = STATUS_OK.has(String(q.status || 'alle').toLowerCase())  ? String(q.status).toLowerCase()  : 'alle';
  const soort   = SOORT_OK.has(String(q.soort  || 'alle').toLowerCase())   ? String(q.soort).toLowerCase()   : 'alle';
  const periode = PERIODE_OK.has(String(q.periode || 'alles').toLowerCase()) ? String(q.periode).toLowerCase() : 'alles';
  const limit   = Math.min(200, Math.max(1, Number(q.limit) || 25));
  const grens   = periodeGrens(periode);

  try {
    let qry = supabaseAdmin
      .from('toegang_aanvragen')
      .select('id, created_at, soort, bron, voornaam, email, telefoon, call_geboekt, status, bevestiging_sent_at, reminder_2u_at, reminder_24u_at, reminder_48u_at, reacted_at, provisioned_at, provisioned_error, vervallen_at, dag6_sent_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .limit(limit);
    if (grens)          qry = qry.gte('created_at', grens);
    if (status !== 'alle') qry = qry.eq('status', status);
    if (soort  !== 'alle') qry = qry.eq('soort',  soort);
    const { data, error, count } = await qry;
    if (error) throw error;

    // BP2 setter-scope: appointmentsetter ziet alleen toegang-aanvragen
    // die matchen op haar boekingen. Manager/admin: pass.
    const scope = await getSetterScope(user.id, supabaseAdmin);
    let filtered = data || [];
    if (scope.isScoped) {
      filtered = filterBySetterScope(filtered, scope, { email: 'email', phone: 'telefoon' });
    }

    const items = (filtered || []).map((r) => ({
      id: r.id,
      created_at: r.created_at,
      soort: r.soort,
      bron: r.bron,
      voornaam: r.voornaam,
      email: r.email,
      telefoon: r.telefoon,
      call_geboekt: !!r.call_geboekt,
      status: r.status,
      bevestiging_sent: !!r.bevestiging_sent_at,
      reminder_2u_sent: !!r.reminder_2u_at,
      reminder_24u_sent: !!r.reminder_24u_at,
      reminder_48u_sent: !!r.reminder_48u_at,
      reacted_at: r.reacted_at,
      provisioned_at: r.provisioned_at,
      provisioned_error: r.provisioned_error,
      vervallen_at: r.vervallen_at,
      dag6_sent: !!r.dag6_sent_at,
    }));

    return res.status(200).json({
      items, status, soort, periode,
      total: count || items.length,
    });
  } catch (e) {
    console.error('[leadsonderhoud-toegang-aanvragen-list]', e?.message || e);
    return res.status(500).json({ error: 'Toegang-aanvragen laden mislukt', detail: e?.message });
  }
}
