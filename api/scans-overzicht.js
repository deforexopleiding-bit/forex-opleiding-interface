// api/scans-overzicht.js — strategie-scan fase 3: Dave's werkplek (overzicht).
//
//   GET    /api/scans-overzicht              → { scans:[…], assessoren:[…] }
//            per scan: deelnemer, datum, assessor, status, score, categorie,
//            aanpak, traject, rapport-refs en de klant-status (automatisch uit
//            de deals of handmatig — api/_lib/scan-klant.js). Filteren/sorteren
//            doet de view (paar honderd rijen per jaar).
//   GET    /api/scans-overzicht?leads=<zoek> → { leads:[…] } (max 10) voor "Nieuwe scan"
//   GET    /api/scans-overzicht?dashboard=1&van=YYYY-MM-DD&tot=YYYY-MM-DD&groep=week|maand
//            → dashboard-cijfers (fase 4, api/_lib/scan-dashboard.js)
//   POST   /api/scans-overzicht  { actie:'klant_status', id, klant_status: 'klant'|'in_gesprek'|'geen_klant'|null }
//            → handmatige klant-status zetten (null = terug naar automatisch)
//   DELETE /api/scans-overzicht?id=<uuid>  → scan + bijbehorende PDF's weg
//
// Toegang: strikt recht `scan.use` (zelfde als api/scan.js).

import { supabaseAdmin, createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { bepaalKlant, laadKlantContext, KLANT_STATUSSEN } from './_lib/scan-klant.js';
import { berekenScanDashboard } from './_lib/scan-dashboard.js';

export const SCAN_RECHT = 'scan.use';
const BUCKET = 'scan-rapporten';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX = 2000;
const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;

const LIJST_KOLOMMEN = 'id, lead_id, afspraak_id, assessor_id, status, deelnemer_naam, deelnemer_email, deelnemer_telefoon, '
  + 'readiness_score, categorie, aanbevolen_aanpak, aanbevolen_traject, doel, rapport_pdf_ref, certificaat_pdf_ref, '
  + 'afgerond_op, verstuurd_op, aangemaakt, gewijzigd';

async function lees(q, wat) {
  const { data, error } = await q;
  if (error) throw Object.assign(new Error(wat + ': ' + error.message), { code: error.code });
  return data;
}

/** Zoekterm veilig voor een PostgREST or()-filter (geen komma's/haakjes/wildcards). */
export function zoekTerm(s) {
  return String(s || '').replace(/[,()%*\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** Klant-kolommen zijn er pas na de fase-3-migratie: zonder → null (alles automatisch). */
async function leesScans(db) {
  try {
    return await lees(db.from('scans').select(LIJST_KOLOMMEN + ', klant_status_handmatig, klant_status_op')
      .order('aangemaakt', { ascending: false }).limit(MAX), 'scans');
  } catch (e) {
    if (e.code !== '42703') throw e;
    return (await lees(db.from('scans').select(LIJST_KOLOMMEN).order('aangemaakt', { ascending: false }).limit(MAX), 'scans'))
      .map((s) => ({ ...s, klant_status_handmatig: null, klant_status_op: null, _migratie_nodig: true }));
  }
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
    if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST, DELETE');
      return res.status(405).json({ error: 'Methode niet toegestaan' });
    }
    let user = null;
    try { user = await userVan(req); } catch { user = null; }
    if (!user) return res.status(401).json({ error: 'Niet ingelogd' });
    if (!(await magHet(req))) return res.status(403).json({ error: 'Geen toegang tot de scans (' + SCAN_RECHT + ')', code: 'GEEN_TOEGANG' });

    try {
      if (req.method === 'GET') {
        const q = req.query || {};
        if (q.leads != null) {
          const t = zoekTerm(q.leads);
          if (t.length < 2) return res.status(200).json({ leads: [] });
          const rijen = await lees(db.from('leads').select('id, naam, voornaam, achternaam, email, telefoon')
            .or(`naam.ilike.%${t}%,email.ilike.%${t}%`).is('verwijderd_op', null).limit(10), 'leads');
          return res.status(200).json({ leads: (rijen || []).map((l) => ({
            id: l.id, naam: l.naam || [l.voornaam, l.achternaam].filter(Boolean).join(' ') || '', email: l.email || '', telefoon: l.telefoon || '',
          })) });
        }

        const scans = await leesScans(db);
        const ctx = await laadKlantContext(db, scans);
        if (q.dashboard != null) {
          const datum = (x) => (typeof x === 'string' && DATUM_RE.test(x) ? x : null);
          const van = datum(q.van); const tot = datum(q.tot);
          if ((q.van && !van) || (q.tot && !tot) || (van && tot && van > tot)) return res.status(400).json({ error: 'Ongeldige periode' });
          const groep = q.groep === 'week' || q.groep === 'maand' ? q.groep : null;
          const metKlant = scans.map((s) => ({ ...s, klant: bepaalKlant(s, ctx) }));
          return res.status(200).json({
            migratie_nodig: scans.some((s) => s._migratie_nodig),
            ...berekenScanDashboard(metKlant, { van, tot, groep, nu: nu() }),
          });
        }
        const assessorIds = [...new Set(scans.map((s) => s.assessor_id).filter(Boolean))];
        const profielen = assessorIds.length
          ? await lees(db.from('profiles').select('id, full_name, email').in('id', assessorIds), 'profiles') : [];
        const naam = new Map((profielen || []).map((p) => [p.id, p.full_name || p.email || 'Onbekend']));
        return res.status(200).json({
          migratie_nodig: scans.some((s) => s._migratie_nodig),
          scans: scans.map((s) => {
            const { _migratie_nodig, ...rest } = s;
            return { ...rest, assessor_naam: naam.get(s.assessor_id) || null, klant: bepaalKlant(s, ctx) };
          }),
          assessoren: assessorIds.map((id) => ({ id, naam: naam.get(id) || 'Onbekend' })).sort((a, b) => a.naam.localeCompare(b.naam)),
        });
      }

      if (req.method === 'POST') {
        const b = req.body || {};
        if (b.actie !== 'klant_status') return res.status(400).json({ error: 'Onbekende actie' });
        if (typeof b.id !== 'string' || !UUID_RE.test(b.id)) return res.status(400).json({ error: 'Ongeldige id' });
        const waarde = b.klant_status == null || b.klant_status === '' ? null : b.klant_status;
        if (waarde !== null && !KLANT_STATUSSEN.includes(waarde)) return res.status(400).json({ error: 'Ongeldige klant-status' });
        const t = nu().toISOString();
        const { data, error } = await db.from('scans')
          .update({ klant_status_handmatig: waarde, klant_status_door: waarde ? user.id : null, klant_status_op: waarde ? t : null, gewijzigd: t })
          .eq('id', b.id).select('id, klant_status_handmatig, klant_status_op');
        if (error) {
          if (error.code === '42703') return res.status(409).json({ error: 'Draai eerst de migratie docs/sql-migrations/2026-10-15-scan-fase3.sql', code: 'MIGRATIE_NODIG' });
          throw new Error('scans bijwerken: ' + error.message);
        }
        if (!data || !data.length) return res.status(404).json({ error: 'Scan niet gevonden' });
        return res.status(200).json({ scan: data[0] });
      }

      // DELETE
      const id = req.query?.id;
      if (typeof id !== 'string' || !UUID_RE.test(id)) return res.status(400).json({ error: 'Ongeldige id' });
      const scan = await lees(db.from('scans').select('id').eq('id', id).maybeSingle(), 'scans');
      if (!scan) return res.status(404).json({ error: 'Scan niet gevonden' });
      // Eerst de rij, dan de PDF's (alle versies onder <id>/). Mislukt het
      // weghalen van de rij, dan blijven de bestanden staan (rapport blijft
      // bekijkbaar); het opruimen van bestanden daarna is best-effort.
      const { error: dErr } = await db.from('scans').delete().eq('id', id);
      if (dErr) throw new Error('scan verwijderen: ' + dErr.message);
      try {
        const { data: bestanden } = await db.storage.from(BUCKET).list(id, { limit: 100 });
        const paden = (bestanden || []).map((f) => id + '/' + f.name);
        if (paden.length) {
          const { error } = await db.storage.from(BUCKET).remove(paden);
          if (error) console.error('[scans-overzicht] PDF\'s verwijderen mislukt:', error.message);
        }
      } catch (e) { console.error('[scans-overzicht] PDF\'s opruimen mislukt:', e?.message || e); }
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error('[scans-overzicht] fout:', e?.message || e);
      return res.status(500).json({ error: 'Er ging iets mis met het scan-overzicht' });
    }
  };
}

export default maakHandler();
