// api/scan.js — strategie-scan (fase 1): ophalen, vooraf invullen, opslaan.
//
//   GET  /api/scan                 → { ok, gebruiker }            (toegangscheck)
//   GET  /api/scan?id=<uuid>       → { scan, gebruiker }
//   GET  /api/scan?afspraak=<uuid> → { bestaande_id } als er al een scan bij die
//                                    afspraak is, anders { prefill }
//   GET  /api/scan?lead=<uuid>     → { prefill }
//   POST /api/scan  { id?, afspraak_id?, lead_id?, deelnemer:{naam,email,telefoon},
//                     antwoorden, override?, dave_notitie?, status:'concept'|'afgerond' }
//                   → { scan }
//
// Toegang: strikt recht `scan.use` (Dave + admins; zie
// docs/sql-migrations/2026-10-15-scan-fase1.sql). Geen fail-open: het gaat om
// gevoelige, financiële informatie.
//
// De uitkomst wordt ALTIJD hier berekend uit de antwoorden (modules/scan/
// scan-model.js) — wat de browser als score/categorie meestuurt telt niet.
// Dave's aanpassingen (override) en notitie worden apart bewaard.

import { supabaseAdmin, createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { berekenUitkomst, normaliseerAntwoorden, normaliseerOverride } from '../modules/scan/scan-model.js';

export const SCAN_RECHT = 'scan.use';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isUuid = (x) => typeof x === 'string' && UUID_RE.test(x);
const kort = (x, max) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : null);
const ilikeVeilig = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

/** Controleert de body van een opslag. → { ok, waarden } | { ok:false, fout } */
export function valideerScan(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, fout: 'Ongeldig verzoek' };
  const d = body.deelnemer && typeof body.deelnemer === 'object' ? body.deelnemer : {};
  const naam = kort(d.naam, 120);
  if (!naam) return { ok: false, fout: 'Vul de naam van de deelnemer in' };
  const email = kort(d.email, 254);
  if (email && !EMAIL_RE.test(email)) return { ok: false, fout: 'Ongeldig e-mailadres' };
  const telefoon = kort(d.telefoon, 40);
  const status = body.status === 'afgerond' ? 'afgerond' : 'concept';
  for (const k of ['id', 'afspraak_id', 'lead_id']) {
    if (body[k] != null && body[k] !== '' && !isUuid(body[k])) return { ok: false, fout: 'Ongeldige ' + k };
  }
  return {
    ok: true,
    waarden: {
      id: body.id || null,
      afspraakId: body.afspraak_id || null,
      leadId: body.lead_id || null,
      naam, email: email ? email.toLowerCase() : null, telefoon,
      antwoorden: normaliseerAntwoorden(body.antwoorden),
      override: normaliseerOverride(body.override),
      notitie: typeof body.dave_notitie === 'string' ? body.dave_notitie.trim().slice(0, 4000) || null : null,
      status,
    },
  };
}

/** De kolommen die uit de berekende uitkomst volgen (filterbaar in het overzicht). */
export function scanKolommen(antwoorden, override) {
  const u = berekenUitkomst(antwoorden, override);
  return {
    uitkomst: u,
    readiness_score: u.readiness,
    categorie: u.categorie,
    aanbevolen_aanpak: u.aanpak,
    aanbevolen_traject: u.traject,
    doel: u.doel,
  };
}

async function lees(q, wat) {
  const { data, error } = await q;
  if (error) throw new Error(wat + ': ' + error.message);
  return data;
}

/** De lead bij een e-mailadres: alleen bij precies één (niet-verwijderde) treffer. */
async function leadVoorEmail(db, email) {
  if (!email) return null;
  const rijen = await lees(db.from('leads').select('id').ilike('email', ilikeVeilig(email)).is('verwijderd_op', null).limit(2), 'leads');
  return rijen && rijen.length === 1 ? rijen[0].id : null;
}

async function profielNaam(db, id) {
  if (!id) return null;
  const p = await lees(db.from('profiles').select('full_name, email').eq('id', id).maybeSingle(), 'profiles');
  return p ? (p.full_name || p.email || null) : null;
}

async function prefillUitAfspraak(db, afspraakId) {
  const bestaand = await lees(db.from('scans').select('id').eq('afspraak_id', afspraakId).order('aangemaakt', { ascending: false }).limit(1), 'scans');
  if (bestaand && bestaand.length) return { bestaande_id: bestaand[0].id };
  const a = await lees(db.from('follow_up_appointments').select('id, lead_name, lead_email, lead_phone, booking_source').eq('id', afspraakId).maybeSingle(), 'follow_up_appointments');
  if (!a) return null;
  const email = a.lead_email ? String(a.lead_email).trim().toLowerCase() : null;
  return {
    prefill: {
      naam: a.lead_name || '', email: email || '', telefoon: a.lead_phone || '',
      afspraak_id: a.id, lead_id: await leadVoorEmail(db, email),
    },
  };
}

async function prefillUitLead(db, leadId) {
  const l = await lees(db.from('leads').select('id, naam, voornaam, achternaam, email, telefoon').eq('id', leadId).maybeSingle(), 'leads');
  if (!l) return null;
  const naam = l.naam || [l.voornaam, l.achternaam].filter(Boolean).join(' ');
  return { prefill: { naam: naam || '', email: l.email || '', telefoon: l.telefoon || '', lead_id: l.id, afspraak_id: null } };
}

export function maakHandler(deps = {}) {
  const {
    db = supabaseAdmin,
    userVan = async (req) => {
      const { data } = await createUserClient(req).auth.getUser();
      return data?.user || null;
    },
    magHet = (req) => requirePermission(req, SCAN_RECHT),
    nu = () => new Date(),
  } = deps;

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Methode niet toegestaan' });
    }

    let user = null;
    try { user = await userVan(req); } catch { user = null; }
    if (!user) return res.status(401).json({ error: 'Niet ingelogd' });
    if (!(await magHet(req))) {
      return res.status(403).json({ error: 'Geen toegang tot de scan (' + SCAN_RECHT + ')', code: 'GEEN_TOEGANG' });
    }

    try {
      if (req.method === 'GET') {
        const q = req.query || {};
        const gebruiker = { naam: await profielNaam(db, user.id) };
        if (q.id != null) {
          if (!isUuid(q.id)) return res.status(400).json({ error: 'Ongeldige id' });
          const scan = await lees(db.from('scans').select('*').eq('id', q.id).maybeSingle(), 'scans');
          if (!scan) return res.status(404).json({ error: 'Scan niet gevonden' });
          return res.status(200).json({ scan: { ...scan, assessor_naam: await profielNaam(db, scan.assessor_id) }, gebruiker });
        }
        if (q.afspraak != null) {
          if (!isUuid(q.afspraak)) return res.status(400).json({ error: 'Ongeldige afspraak' });
          const r = await prefillUitAfspraak(db, q.afspraak);
          if (!r) return res.status(404).json({ error: 'Afspraak niet gevonden' });
          return res.status(200).json({ ...r, gebruiker });
        }
        if (q.lead != null) {
          if (!isUuid(q.lead)) return res.status(400).json({ error: 'Ongeldige lead' });
          const r = await prefillUitLead(db, q.lead);
          if (!r) return res.status(404).json({ error: 'Lead niet gevonden' });
          return res.status(200).json({ ...r, gebruiker });
        }
        return res.status(200).json({ ok: true, gebruiker });
      }

      // POST: opslaan (nieuw of bestaand).
      const v = valideerScan(req.body);
      if (!v.ok) return res.status(400).json({ error: v.fout });
      const w = v.waarden;
      const t = nu().toISOString();

      let bestaand = null;
      if (w.id) {
        bestaand = await lees(db.from('scans').select('id, status, lead_id, afspraak_id, afgerond_op').eq('id', w.id).maybeSingle(), 'scans');
        if (!bestaand) return res.status(404).json({ error: 'Scan niet gevonden' });
      }

      // Lead koppelen: expliciet meegegeven (moet bestaan), anders via het e-mailadres.
      let leadId = w.leadId || bestaand?.lead_id || null;
      if (w.leadId) {
        const l = await lees(db.from('leads').select('id').eq('id', w.leadId).maybeSingle(), 'leads');
        if (!l) return res.status(400).json({ error: 'Onbekende lead' });
      }
      if (!leadId) leadId = await leadVoorEmail(db, w.email);

      const afspraakId = w.afspraakId || bestaand?.afspraak_id || null;
      if (w.afspraakId && w.afspraakId !== bestaand?.afspraak_id) {
        const a = await lees(db.from('follow_up_appointments').select('id').eq('id', w.afspraakId).maybeSingle(), 'follow_up_appointments');
        if (!a) return res.status(400).json({ error: 'Onbekende afspraak' });
      }

      // Een verstuurd rapport blijft 'verstuurd' (opnieuw versturen = fase 2/3).
      const status = bestaand?.status === 'verstuurd' ? 'verstuurd' : w.status;
      const rij = {
        lead_id: leadId,
        afspraak_id: afspraakId,
        status,
        deelnemer_naam: w.naam,
        deelnemer_email: w.email,
        deelnemer_telefoon: w.telefoon,
        antwoorden: w.antwoorden,
        override: w.override,
        dave_notitie: w.notitie,
        ...scanKolommen(w.antwoorden, w.override),
        gewijzigd: t,
      };
      if (status === 'afgerond' && !bestaand?.afgerond_op) rij.afgerond_op = t;

      let scan;
      if (bestaand) {
        const r = await lees(db.from('scans').update(rij).eq('id', bestaand.id).select('*'), 'scans bijwerken');
        scan = r && r[0];
      } else {
        rij.assessor_id = user.id;
        rij.aangemaakt_door = user.id;
        rij.aangemaakt = t;
        scan = await lees(db.from('scans').insert(rij).select('*').single(), 'scans opslaan');
      }
      if (!scan) throw new Error('scan niet teruggekregen');
      return res.status(200).json({ scan });
    } catch (e) {
      console.error('[scan] fout:', e?.message || e);
      return res.status(500).json({ error: 'Er ging iets mis bij het opslaan of ophalen' });
    }
  };
}

export default maakHandler();
