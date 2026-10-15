// api/lab-statistieken.js
//
// GET /api/lab-statistieken?van=YYYY-MM-DD&tot=YYYY-MM-DD&per=hook|campagne
// De testmachine voor de advertenties: per hook (of campagne) en per periode
//   leads → ingelogd → Lab gestart → Lab afgewerkt → sessie geboekt → klant
// met de conversie per stap. Plus de lijst lab-leads van die periode voor de
// tab "The Lab" in Leadsonderhoud. RBAC: leads.view.
//
// De periode gaat over de AANMELDING (Amsterdam-kalenderdagen). Wat er daarna
// gebeurde, telt mee ongeacht wanneer: een lead uit week 1 die in week 2
// boekt, is een boeking voor de hook van week 1.
//
// Testaanmeldingen (`is_test`) tellen nooit mee in de cijfers; ze staan wel in
// de lijst, met een label.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { periodeUitQuery } from './funnel-stats.js';
import { aggregeerFunnel, labStatus, leesLabGedrag, leesLmsStand } from './_lib/lab-dossier.js';
import { LAB_SLUG } from './_lib/lab-config.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) return res.status(403).json({ error: 'Geen rechten (leads.view)' });

  const q = req.query || {};
  const periode = periodeUitQuery(q);
  if (periode.fout) return res.status(400).json({ error: periode.fout });
  const per = q.per === 'campagne' ? 'campagne' : 'hook';

  const { data: aanm, error: ae } = await supabaseAdmin.from('lab_aanmeldingen')
    .select('id, aangemaakt, lead_id, email, voornaam, hook, utm_campaign, lms_auth_id, resultaat, is_test')
    .gte('aangemaakt', periode.start.toISOString()).lt('aangemaakt', periode.eindExclusief.toISOString())
    .order('aangemaakt', { ascending: false }).limit(10000);
  if (ae) {
    if (ae.code === '42P01' || ae.code === 'PGRST205') {
      return res.status(200).json({ ok: true, migratie_ontbreekt: true, periode: { van: periode.van, tot: periode.tot }, rijen: [], totaal: null, leads: [] });
    }
    console.error('[lab-statistieken] lab_aanmeldingen:', ae.message);
    return res.status(500).json({ error: 'Aanmeldingen ophalen mislukt' });
  }
  const aanmeldingen = aanm || [];
  const emails = [...new Set(aanmeldingen.map((a) => String(a.email || '').toLowerCase()).filter(Boolean))];

  // LMS-stand per e-mail.
  let lmsFout = null;
  const lmsPerEmail = new Map();
  if (emails.length) {
    try {
      const authIds = [...new Set(aanmeldingen.map((a) => a.lms_auth_id).filter(Boolean))];
      const { leads, sessiePerAuth } = await leesLmsStand({ authIds });
      const gedrag = await leesLabGedrag(leads.map((l) => l.id));
      for (const l of leads) lmsPerEmail.set(String(l.email).toLowerCase(), { labLead: l, sessie: sessiePerAuth.get(l.auth_id) || null, route: gedrag.get(l.id)?.route || null });
    } catch (e) {
      lmsFout = e?.message || 'LMS onbereikbaar';
      console.error('[lab-statistieken] LMS:', lmsFout);
    }
  }

  // Boekingen die in het CRM staan maar (nog) niet in het LMS (bv. via de
  // agendalink van bron the-lab), en klanten.
  const klanten = new Set();
  for (let i = 0; i < emails.length; i += 300) {
    const deel = emails.slice(i, i + 300);
    const [{ data: afs, error: fe }, { data: ld, error: le }] = await Promise.all([
      supabaseAdmin.from('follow_up_appointments').select('lead_email').eq('booking_source', LAB_SLUG).in('lead_email', deel),
      supabaseAdmin.from('leads').select('email, status, customer_id').in('email', deel),
    ]);
    if (fe) console.warn('[lab-statistieken] afspraken (soft):', fe.message);
    if (le) console.warn('[lab-statistieken] leads (soft):', le.message);
    for (const a of afs || []) {
      const em = String(a.lead_email || '').toLowerCase();
      const x = lmsPerEmail.get(em) || {};
      lmsPerEmail.set(em, { ...x, geboekt: true });
    }
    for (const l of ld || []) if (l.status === 'gewonnen' || l.customer_id) klanten.add(String(l.email).toLowerCase());
  }

  const { rijen, totaal, perRoute } = aggregeerFunnel(aanmeldingen, lmsPerEmail, klanten, per);

  // De lijst: één regel per e-mail, nieuwste aanmelding eerst.
  const gezien = new Set();
  const leads = [];
  for (const a of aanmeldingen) {
    const em = String(a.email || '').toLowerCase();
    if (gezien.has(em)) continue;
    gezien.add(em);
    const l = lmsPerEmail.get(em) || {};
    const status = l.geboekt && !l.labLead?.sessie_geboekt_op
      ? { code: 'geboekt', label: 'Sessie geboekt' }
      : labStatus({ labLead: l.labLead || null, sessie: l.sessie || null });
    leads.push({
      lead_id: a.lead_id, email: em, voornaam: a.voornaam, hook: a.hook, campagne: a.utm_campaign,
      aangemeld: a.aangemaakt, status, is_test: a.is_test,
      stap: l.sessie?.stap ?? null, stappen: l.sessie?.stappen ?? null, route: l.route || null,
    });
  }

  return res.status(200).json({ ok: true, per, periode: { van: periode.van, tot: periode.tot }, lms_fout: lmsFout, rijen, totaal, per_route: perRoute, leads });
}
