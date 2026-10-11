// api/massa-campagne.js
//
// Massa-e-mail fase 2a — campagnes.
//
// GET                 → { campagnes:[…] }                    (laatste 50, met tellers)
// GET ?wa_templates=1 → { ok, templates:[…], waba_id, nummer, wa_portie }  (2b: goedgekeurde
//                       MARKETING-templates van de lead-WABA, na de health-check-guard)
// GET ?id=<uuid>      → { campagne, mislukt:[…] }             (detail + mislukte items)
// GET ?lead_id=<uuid> → { historie:[{campagne_id, naam, status, verzonden_op}] }
// POST { actie:'preview', …campagne }  → exact aantal + voorbeeldmail (niets opgeslagen)
// POST { actie:'start', …campagne, bevestig_aantal } → campagne + wachtrij
// POST { actie:'pauzeer'|'hervat'|'annuleer', id }
// POST { actie:'verwerk_nu', id }       → één portie nu (zelfde worker als de cron)
//
// campagne = { naam, kanaal:'email'|'whatsapp'|'beide', soort, onderwerp, html, portie,
//              sjabloon_id, wa_template, wa_taal, wa_param2, filter, lead_ids:[…] }
// RBAC: GET leads.view, POST leads.update. Fouten → { error, code }.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { maakCampagne, verwerkWachtrij, herteltCampagne, tellingPerKanaal, massaWaTemplates, leesWaInstellingen, MassaFout, tabelOntbreekt, MIGRATIE } from './_lib/massa-mail.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// select('*') + html eruit: de wa_*-kolommen bestaan pas na de 2b-migratie.
const zonderHtml = (c) => { if (!c) return c; const { html, ...rest } = c; return rest; };
const migratieNodig = (res) => res.status(409).json({ error: `De massa-tabellen bestaan nog niet — draai ${MIGRATIE}.`, code: 'MIGRATIE_NODIG' });

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  try {
    if (req.method === 'GET') {
      if (!(await requirePermission(req, 'leads.view'))) return res.status(403).json({ error: 'Geen rechten (leads.view)' });
      const id = String(req.query?.id || '');
      const leadId = String(req.query?.lead_id || '');
      if (req.query?.wa_templates) {
        const t = await massaWaTemplates();
        if (!t.ok) return res.status(200).json({ ok: false, reden: t.reden, melding: t.melding, templates: [] });
        const inst = await leesWaInstellingen(supabaseAdmin);
        return res.status(200).json({ ...t, wa_portie: inst.portie, wa_dag_max: inst.dag_max });
      }
      if (leadId) {
        if (!UUID_RE.test(leadId)) return res.status(400).json({ error: 'lead_id ongeldig' });
        const { data, error } = await supabaseAdmin.from('massa_items')
          .select('campagne_id, kanaal, status, reden, verzonden_op, massa_campagnes(naam)')
          .eq('lead_id', leadId).order('aangemaakt_op', { ascending: false }).limit(50);
        if (error) { if (tabelOntbreekt(error)) return res.status(200).json({ historie: [], tabel_ontbreekt: true }); throw error; }
        return res.status(200).json({
          historie: (data || []).map((r) => ({ campagne_id: r.campagne_id, naam: r.massa_campagnes?.naam || null, kanaal: r.kanaal || 'email', status: r.status, reden: r.reden, verzonden_op: r.verzonden_op })),
        });
      }
      if (id) {
        if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id ongeldig' });
        const { data: c, error } = await supabaseAdmin.from('massa_campagnes').select('*').eq('id', id).maybeSingle();
        if (error) { if (tabelOntbreekt(error)) return migratieNodig(res); throw error; }
        if (!c) return res.status(404).json({ error: 'Campagne niet gevonden' });
        const stand = await herteltCampagne(supabaseAdmin, id);
        const perKanaal = await tellingPerKanaal(supabaseAdmin, id);
        const { data: mislukt } = await supabaseAdmin.from('massa_items').select('email, kanaal, fout, reden, status')
          .eq('campagne_id', id).in('status', ['failed']).limit(50);
        return res.status(200).json({ campagne: { ...zonderHtml(c), ...{ aantal_verstuurd: stand.sent, aantal_mislukt: stand.failed, aantal_overgeslagen: stand.skipped }, in_wachtrij: stand.queued, bezig: stand.sending, status: stand.klaar ? 'klaar' : c.status, per_kanaal: perKanaal }, mislukt: mislukt || [] });
      }
      const { data, error } = await supabaseAdmin.from('massa_campagnes').select('*').order('aangemaakt_op', { ascending: false }).limit(50);
      if (error) { if (tabelOntbreekt(error)) return res.status(200).json({ campagnes: [], tabel_ontbreekt: true }); throw error; }
      return res.status(200).json({ campagnes: (data || []).map(zonderHtml) });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'GET of POST' });
    if (!(await requirePermission(req, 'leads.update'))) return res.status(403).json({ error: 'Geen rechten (leads.update)' });
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const actie = String(b.actie || '');

    if (actie === 'preview' || actie === 'start') {
      const r = await maakCampagne(supabaseAdmin, b, { start: actie === 'start', userId: user.id });
      return res.status(200).json({ ok: true, ...r });
    }

    const id = String(b.id || '');
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id ongeldig' });
    const { data: c, error: cErr } = await supabaseAdmin.from('massa_campagnes').select('id, status').eq('id', id).maybeSingle();
    if (cErr) { if (tabelOntbreekt(cErr)) return migratieNodig(res); throw cErr; }
    if (!c) return res.status(404).json({ error: 'Campagne niet gevonden' });

    if (actie === 'pauzeer' || actie === 'hervat') {
      const van = actie === 'pauzeer' ? ['wachtrij', 'bezig'] : ['gepauzeerd'];
      if (!van.includes(c.status)) return res.status(409).json({ error: `Kan niet ${actie === 'pauzeer' ? 'pauzeren' : 'hervatten'} vanuit "${c.status}".`, code: 'STATUS' });
      const { error } = await supabaseAdmin.from('massa_campagnes').update({ status: actie === 'pauzeer' ? 'gepauzeerd' : 'bezig' }).eq('id', id);
      if (error) throw error;
      return res.status(200).json({ ok: true, status: actie === 'pauzeer' ? 'gepauzeerd' : 'bezig' });
    }
    if (actie === 'annuleer') {
      if (['klaar', 'geannuleerd'].includes(c.status)) return res.status(409).json({ error: `Campagne is al "${c.status}".`, code: 'STATUS' });
      const { error } = await supabaseAdmin.from('massa_campagnes').update({ status: 'geannuleerd', klaar_op: new Date().toISOString() }).eq('id', id);
      if (error) throw error;
      const { error: iErr } = await supabaseAdmin.from('massa_items').update({ status: 'skipped', reden: 'geannuleerd' }).eq('campagne_id', id).eq('status', 'queued');
      if (iErr) console.error('[massa-campagne] wachtrij leegmaken mislukt:', { campagne: id, fout: iErr.message });
      await herteltCampagne(supabaseAdmin, id);
      return res.status(200).json({ ok: true, status: 'geannuleerd' });
    }
    if (actie === 'verwerk_nu') {
      if (!['wachtrij', 'bezig'].includes(c.status)) return res.status(409).json({ error: `Campagne is "${c.status}".`, code: 'STATUS' });
      const r = await verwerkWachtrij(supabaseAdmin, { campagneId: id, handmatig: true, tijdBudgetMs: 240000 });
      return res.status(200).json({ ok: true, ...r });
    }
    return res.status(400).json({ error: 'Onbekende actie' });
  } catch (e) {
    if (e instanceof MassaFout) return res.status(e.status).json({ error: e.message, code: e.code, ...(e.samenvatting ? { samenvatting: e.samenvatting } : {}) });
    console.error('[massa-campagne] fout:', e?.message || e);
    return res.status(500).json({ error: 'Massabericht mislukt: ' + String(e?.message || 'onbekend').slice(0, 200) });
  }
}
