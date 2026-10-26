// api/trial-overzicht.js
//
// GET /api/trial-overzicht?van=YYYY-MM-DD&tot=YYYY-MM-DD&product=alle|<product>&hook=&variant=[&formaat=csv]
// formaat=csv → de bellijst als CSV (puntkomma, UTF-8 met BOM voor Excel).
// Leadsonderhoud › The Lab: het overzicht van ALLE trial-leads (minicursus,
// 7-daagse, webinar, website, The Lab). KPI's per product, de lijst per lead
// met status-chips, en de bellijst. Rekenkern: api/_lib/trial-overzicht.js.
// Alleen lezen. RBAC: leads.view.
//
// Bronnen: lab_aanmeldingen (wie, via welke belofte), dfo-lms (account,
// logins, video's, The Lab, boeking — lab-trial-stand.js), leads (telefoon,
// toestemming, klant), follow_up_appointments (booking_source 'the-lab'),
// lead_mail_voorkeuren (afgemeld), lab_opvolging (laatste motorbericht) en
// trial_belpogingen (laatste belpoging; fail-soft zonder de migratie).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { periodeUitQuery, isOntbrekendeTabel } from './funnel-stats.js';
import { leesLabStandPerEmail } from './_lib/lab-trial-stand.js';
import { bouwOverzicht, bellijstCsv } from './_lib/trial-overzicht.js';
import { LAB_SLUG } from './_lib/lab-config.js';
import { isProduct } from './_lib/trial-product.js';

async function inBlokken(lijst, maak, n = 200) {
  const uit = [];
  for (let i = 0; i < lijst.length; i += n) {
    const { data, error } = await maak(lijst.slice(i, i + n));
    if (error) throw error;
    uit.push(...(data || []));
  }
  return uit;
}

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
  const filter = {
    product: isProduct(q.product) ? String(q.product) : 'alle',
    hook: q.hook ? String(q.hook).slice(0, 40) : null,
    variant: q.variant ? String(q.variant).slice(0, 20) : null,
  };

  const { data: aanm, error: ae } = await supabaseAdmin.from('lab_aanmeldingen').select('*')
    .gte('aangemaakt', periode.start.toISOString()).lt('aangemaakt', periode.eindExclusief.toISOString())
    .order('aangemaakt', { ascending: false }).limit(10000);
  if (ae) {
    if (isOntbrekendeTabel(ae)) return res.status(200).json({ ok: true, migratie_ontbreekt: true, kpi: [], leads: [], bellijst: [] });
    console.error('[trial-overzicht] lab_aanmeldingen:', ae.message);
    return res.status(500).json({ error: 'Aanmeldingen ophalen mislukt' });
  }
  const aanmeldingen = aanm || [];
  const emails = [...new Set(aanmeldingen.map((a) => String(a.email || '').toLowerCase()).filter(Boolean))];
  const meldingen = [];

  let standPerEmail = new Map();
  try { standPerEmail = await leesLabStandPerEmail(emails); } catch (e) {
    console.error('[trial-overzicht] LMS:', e?.message || e);
    meldingen.push('Het LMS was niet bereikbaar: ingelogd, video\'s en The Lab staan daardoor op 0.');
  }

  const leadsPerEmail = new Map();
  const geboektAgenda = new Set();
  const afgemeld = new Set();
  try {
    const [ld, fa, vk] = await Promise.all([
      inBlokken(emails, (d) => supabaseAdmin.from('leads').select('id, email, voornaam, achternaam, telefoon_e164, toestemming, status, customer_id').in('email', d).is('verwijderd_op', null)),
      inBlokken(emails, (d) => supabaseAdmin.from('follow_up_appointments').select('lead_email, status').eq('booking_source', LAB_SLUG).in('lead_email', d)),
      inBlokken(emails, (d) => supabaseAdmin.from('lead_mail_voorkeuren').select('email, afgemeld').in('email', d)),
    ]);
    for (const l of ld) { const em = String(l.email || '').toLowerCase(); if (!leadsPerEmail.has(em)) leadsPerEmail.set(em, l); }
    for (const f of fa) if (!/cancel|geannuleerd/i.test(String(f.status || ''))) geboektAgenda.add(String(f.lead_email || '').toLowerCase());
    for (const v of vk) if (v.afgemeld) afgemeld.add(String(v.email || '').toLowerCase());
  } catch (e) {
    console.warn('[trial-overzicht] CRM-hulpbronnen (soft):', e?.message || e);
    meldingen.push('Telefoon/toestemming/afspraken waren niet volledig te lezen.');
  }

  // Laatste motorbericht per e-mail (de motor noteert op de eerste aanmelding
  // van zijn venster, dat is niet altijd de eerste van deze periode).
  const laatsteMotor = new Map();
  const mailVan = new Map(aanmeldingen.map((a) => [a.id, String(a.email || '').toLowerCase()]));
  try {
    const ov = await inBlokken(aanmeldingen.map((a) => a.id), (d) => supabaseAdmin.from('lab_opvolging').select('aanmelding_id, stap, kanaal, status, aangemaakt').in('aanmelding_id', d));
    for (const o of ov) {
      if (o.status !== 'verstuurd') continue;
      const em = mailVan.get(o.aanmelding_id);
      const h = em && laatsteMotor.get(em);
      if (em && (!h || String(o.aangemaakt) > String(h.op))) laatsteMotor.set(em, { stap: o.stap, kanaal: o.kanaal, op: o.aangemaakt });
    }
  } catch (e) { console.warn('[trial-overzicht] lab_opvolging (soft):', e?.message || e); }

  const laatsteBel = new Map();
  let belpogingenOk = true;
  try {
    const bp = await inBlokken(emails, (d) => supabaseAdmin.from('trial_belpogingen').select('email, aangemaakt, resultaat, notitie, door_naam').in('email', d));
    for (const b of bp) {
      const em = String(b.email || '').toLowerCase();
      const h = laatsteBel.get(em);
      if (!h || String(b.aangemaakt) > String(h.op)) laatsteBel.set(em, { op: b.aangemaakt, resultaat: b.resultaat, notitie: b.notitie, door_naam: b.door_naam });
    }
  } catch (e) {
    belpogingenOk = false;
    if (!isOntbrekendeTabel(e)) console.warn('[trial-overzicht] belpogingen (soft):', e?.message || e);
  }

  const uit = bouwOverzicht({ aanmeldingen, standPerEmail, leadsPerEmail, geboektAgenda, afgemeld, laatsteMotor, laatsteBel, filter });
  if (q.formaat === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bellijst-${periode.van}-${periode.tot}.csv"`);
    return res.status(200).send('\uFEFF' + bellijstCsv(uit.bellijst));
  }
  const hooks = [...new Set(aanmeldingen.map((a) => a.hook).filter(Boolean))].sort();
  return res.status(200).json({ ok: true, periode: { van: periode.van, tot: periode.tot }, filter, hooks, belpogingen_ok: belpogingenOk, meldingen, ...uit });
}
