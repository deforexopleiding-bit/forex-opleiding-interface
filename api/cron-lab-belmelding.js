// api/cron-lab-belmelding.js
//
// THE LAB → DAVE BELT. Elke 5 minuten.
//
// Zet een belopdracht bovenaan Daves Opvolging-module (opvolging_taken, reden
// 'lab_bellen') zodra een lab-lead warm is — de regels staan in
// api/_lib/lab-belmelding.js en zijn daar getoetst. En de omgekeerde kant: een
// open belopdracht van een lead die intussen geboekt heeft, vervalt meteen.
//
// Schrijft ALLEEN interne taken (geen bericht naar de lead), dus er is geen
// live-schakelaar zoals bij de opvolgmails. De noodstop van de leadmotor
// (env LEADSONDERHOUD_UIT) geldt wel.
//
// Idempotent: één taak per lead per reden (partiële unieke index
// opvolging_taken_lab_bellen_uniek; een 23505 = "had hij al"), en nooit een
// tweede open belopdracht naast een eerste.

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { getDfoLmsClient } from './_lib/dfo-lms-db.js';
import { leesLabGedrag } from './_lib/lab-dossier.js';
import { alleenDaglijst } from './_lib/opvolging-lijst.js';
import { telefoonNlBe } from './_lib/phone-e164.js';
import { LAB_BEL_REDEN, leadStand, beslis, taakRij } from './_lib/lab-belmelding.js';

const VENSTER_DAGEN = 21;
const MAX_NIEUW_PER_RUN = 25;
const GEBOEKT_STATUSSEN = ['scheduled', 'completed'];

const aanUit = (v) => ['1', 'true', 'aan', 'on', 'ja'].includes(String(v ?? '').trim().toLowerCase());

const LEAD_KOLOMMEN = 'id, auth_id, email, voornaam, achternaam, telefoon, crm_lead_id, hook, toegang_tot, eerste_login_op, laatste_login_op, kwalificatie, sessie_geboekt_op, is_test, aangemaakt_op';
const SESSIE_KOLOMMEN = 'auth_id, stap, stappen, voortgang, bijgewerkt_op, afgerond:snapshot->>afgerond, afgerond_op:snapshot->>afgerondOp';

function nieuwste(sessies) {
  const m = new Map();
  for (const s of sessies || []) {
    const h = m.get(s.auth_id);
    if (!h || String(s.bijgewerkt_op) > String(h.bijgewerkt_op)) m.set(s.auth_id, s);
  }
  return m;
}

/** Het werk zelf — los van de HTTP-schil, zodat de toets het rechtstreeks kan aanroepen. */
export async function draaiBelmelding(nu = Date.now()) {
  const verslag = { gemaakt: [], vervallen: [], overgeslagen: 0, fouten: 0 };
  const lms = getDfoLmsClient();
  if (!lms) return { ...verslag, fout: 'LMS niet geconfigureerd' };

  const { data: leads, error: le } = await lms.from('hlms_lab_lead').select(LEAD_KOLOMMEN)
    .gte('aangemaakt_op', new Date(nu - VENSTER_DAGEN * 86400000).toISOString())
    .order('aangemaakt_op', { ascending: false }).limit(2000);
  if (le) throw new Error('hlms_lab_lead: ' + le.message);
  if (!leads?.length) return verslag;

  let sessies = [];
  const authIds = leads.map((l) => l.auth_id).filter(Boolean);
  for (let i = 0; i < authIds.length; i += 200) {
    const { data, error } = await lms.from('hlms_lab_sessie').select(SESSIE_KOLOMMEN).in('auth_id', authIds.slice(i, i + 200));
    if (error) throw new Error('hlms_lab_sessie: ' + error.message);
    sessies = sessies.concat(data || []);
  }
  const sessiePer = nieuwste(sessies);
  // Jouw route: de gekozen ingang (fail-soft — zonder migratie gewoon leeg).
  const gedragPer = await leesLabGedrag(leads.map((l) => l.id));

  // Geboekt in het CRM: een geplande of gehouden afspraak sinds de aanmelding.
  const emails = [...new Set(leads.map((l) => String(l.email || '').toLowerCase()).filter(Boolean))];
  const geboektSinds = new Map();
  for (let i = 0; i < emails.length; i += 200) {
    const { data, error } = await supabaseAdmin.from('follow_up_appointments')
      .select('lead_email, scheduled_at, status').in('lead_email', emails.slice(i, i + 200)).in('status', GEBOEKT_STATUSSEN);
    if (error) throw new Error('follow_up_appointments: ' + error.message);
    for (const a of data || []) {
      const em = String(a.lead_email || '').toLowerCase();
      geboektSinds.set(em, [...(geboektSinds.get(em) || []), Date.parse(a.scheduled_at)]);
    }
  }

  // Wat er al is: per lab-lead de redenen ooit, en de open taak.
  const { data: taken, error: te } = await alleenDaglijst(supabaseAdmin.from('opvolging_taken')
    .select('id, status, reden_code, bron_ref'))
    .eq('reden', LAB_BEL_REDEN)
    .gte('created_at', new Date(nu - (VENSTER_DAGEN + 7) * 86400000).toISOString())
    .limit(5000);
  if (te) throw new Error('opvolging_taken: ' + te.message);
  const perLead = new Map();
  for (const t of taken || []) {
    const id = t.bron_ref?.lab_lead_id;
    if (!id) continue;
    const p = perLead.get(id) || { gehad: new Set(), open: [] };
    if (t.reden_code) p.gehad.add(t.reden_code);
    if (t.status === 'open') p.open.push(t.id);
    perLead.set(id, p);
  }

  let nieuw = 0;
  for (const labLead of leads) {
    try {
      const sessie = sessiePer.get(labLead.auth_id) || null;
      const aangemeld = Date.parse(labLead.aangemaakt_op) - 86400000;
      const crm = (geboektSinds.get(String(labLead.email || '').toLowerCase()) || []).some((t) => t >= aangemeld);
      const s = leadStand({ labLead, sessie, geboektInCrm: crm, gedrag: gedragPer.get(labLead.id) || null });
      const bestaand = perLead.get(labLead.id) || { gehad: new Set(), open: [] };
      const besluit = beslis(s, { gehad: bestaand.gehad, heeftOpen: bestaand.open.length > 0 }, nu);
      if (!besluit) continue;

      if (besluit.actie === 'vervalt') {
        const { error } = await supabaseAdmin.from('opvolging_taken').update({
          status: 'gearchiveerd', gearchiveerd_at: new Date(nu).toISOString(),
          archief_reden: 'Sessie geboekt — belopdracht vervallen', updated_at: new Date(nu).toISOString(),
        }).in('id', bestaand.open).eq('status', 'open');
        if (error) throw new Error('vervallen: ' + error.message);
        verslag.vervallen.push(labLead.id);
        continue;
      }

      if (nieuw >= MAX_NIEUW_PER_RUN) { verslag.overgeslagen++; continue; }
      const rij = taakRij({ labLead, sessie, reden: besluit.reden, nu });
      rij.telefoon = telefoonNlBe(rij.telefoon, { bron: 'cron-lab-belmelding' });
      const { error } = await supabaseAdmin.from('opvolging_taken').insert(rij);
      if (error) {
        if (String(error.code) === '23505') continue; // had hij al — idempotent
        throw new Error('insert: ' + error.message);
      }
      nieuw++;
      verslag.gemaakt.push({ lab_lead_id: labLead.id, reden: besluit.reden, test: rij.is_test });
    } catch (e) {
      verslag.fouten++;
      if (verslag.fouten <= 3) console.error('[cron-lab-belmelding] lead mislukt', { lab_lead_id: labLead.id, fout: e?.message || e });
    }
  }
  return verslag;
}

export default async function handler(req, res) {
  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);
  if (aanUit(process.env.LEADSONDERHOUD_UIT)) return res.status(200).json({ ok: true, overgeslagen: 'noodstop (LEADSONDERHOUD_UIT)' });
  try {
    const verslag = await draaiBelmelding();
    console.log('[cron-lab-belmelding]', { gemaakt: verslag.gemaakt.length, vervallen: verslag.vervallen.length, fouten: verslag.fouten });
    return res.status(200).json({ ok: true, ...verslag });
  } catch (e) {
    console.error('[cron-lab-belmelding] mislukt:', e?.message || e);
    return res.status(500).json({ ok: false, fout: 'belmelding mislukt' });
  }
}
