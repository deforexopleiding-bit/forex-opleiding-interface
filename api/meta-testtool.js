// api/meta-testtool.js
//
// Meta-toestemming-testtool (2026-11-02) — Leadsonderhoud › Meta-koppeling.
// Leest en bewaart app_settings.meta_toestemming_testtool (_lib/meta-testtool.js).
// Website (dfo-website lib/meta-testtool.ts) en CRM-zenders lezen hem runtime
// (~15 s cache per serverinstantie).
//
//   GET  → 200 { stand: { modus, alleen_testadressen, testadressen, test_event_code }, actief, gezet_door, gezet_op }
//          Permission: leads.view.
//   POST { modus, alleen_testadressen, testadressen, test_event_code }
//        → 200 { ok:true, stand, actief }   ·  400 { error } bij ongeldige invoer
//          Permission: leads.update.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { TESTTOOL_SLEUTEL, isActief, leesTesttool, valideerTesttool, wisTesttoolCache } from './_lib/meta-testtool.js';

function naarUit(stand) {
  return { modus: stand.modus, alleen_testadressen: stand.alleenTestadressen, testadressen: stand.testadressen, test_event_code: stand.testEventCode || '' };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET' && req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'GET of POST' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  if (req.method === 'GET') {
    if (!(await requirePermission(req, 'leads.view'))) return res.status(403).json({ error: 'Geen rechten (leads.view)' });
    try {
      const { data, error } = await supabaseAdmin.from('app_settings').select('value').eq('key', TESTTOOL_SLEUTEL).maybeSingle();
      if (error) throw error;
      const stand = leesTesttool(data?.value);
      return res.status(200).json({
        stand: naarUit(stand), actief: isActief(stand),
        gezet_door: data?.value?.gezet_door || null, gezet_op: data?.value?.gezet_op || null,
      });
    } catch (e) {
      console.error('[meta-testtool] lezen', e?.message || e);
      return res.status(500).json({ error: 'Lezen mislukt' });
    }
  }

  if (!(await requirePermission(req, 'leads.update'))) return res.status(403).json({ error: 'Geen rechten (leads.update)' });
  const v = valideerTesttool(req.body);
  if (!v.ok) return res.status(400).json({ error: v.fout });
  const value = { ...v.waarde, gezet_door: user.email || user.id, gezet_op: new Date().toISOString() };
  try {
    const { error } = await supabaseAdmin.from('app_settings').upsert({ key: TESTTOOL_SLEUTEL, value }, { onConflict: 'key' });
    if (error) throw error;
    wisTesttoolCache();
    const stand = leesTesttool(value);
    console.log('[meta-testtool] bewaard', { modus: stand.modus, alleenTestadressen: stand.alleenTestadressen, testadressen: stand.testadressen, door: value.gezet_door });
    return res.status(200).json({ ok: true, stand: naarUit(stand), actief: isActief(stand) });
  } catch (e) {
    console.error('[meta-testtool] bewaren', e?.message || e);
    return res.status(500).json({ error: 'Opslaan mislukt' });
  }
}
