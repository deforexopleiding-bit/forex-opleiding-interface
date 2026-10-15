// api/scan-rapport.js — strategie-scan fase 2: rapport + certificaat (PDF), mail, opslag.
//
//   GET  /api/scan-rapport?id=<uuid>&soort=rapport|certificaat
//        → de PDF, NU gegenereerd uit de opgeslagen scan (voorbeeld vóór verzenden)
//   GET  /api/scan-rapport?id=<uuid>&soort=…&opgeslagen=1
//        → { url } — tijdelijke link (1 uur) naar de VERSTUURDE PDF uit de bucket
//   POST /api/scan-rapport  { id }
//        → genereert beide PDF's, zet ze in de privé-bucket, mailt ze vanaf
//          info@ naar de deelnemer en zet de scan op 'verstuurd' → { scan }
//
// Toegang: strikt recht `scan.use` (zelfde als api/scan.js).
// Volgorde bij versturen: uploaden → mailen → scan bijwerken. Mislukt de mail,
// dan worden de net geüploade bestanden weer verwijderd en blijft de scan zoals
// hij was (geen 'verstuurd' zonder verzonden mail). Opnieuw versturen mag: dan
// komen er nieuwe bestanden bij en wijzen de refs naar de nieuwste.
// Bucket `scan-rapporten` (privé): docs/sql-migrations/2026-10-15-scan-fase2-bucket.sql.

import { supabaseAdmin, createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { sendMail } from './mailer.js';
import { renderMailShell, platteTekstMail, escMailHtml } from './_lib/mail-shell.js';
import { maakRapportPdf, maakCertificaatPdf, veiligeNaam } from './_lib/scan-pdf.js';
import { berekenUitkomst } from '../modules/scan/scan-model.js';

export const SCAN_RECHT = 'scan.use';
export const BUCKET = 'scan-rapporten';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOORTEN = ['rapport', 'certificaat'];

const voornaam = (naam) => String(naam || '').trim().split(/\s+/)[0] || '';

/** De mail bij het rapport (vanaf info@). Geen prijzen, geen beloftes. */
export function rapportMail({ naam, assessor }) {
  const vn = voornaam(naam);
  const titel = 'Jouw persoonlijke strategie-scan';
  const alineas = [
    `Hoi ${vn || 'daar'},`,
    `Bedankt dat je met ${assessor} de strategie-scan hebt doorlopen. In de bijlage vind je je persoonlijke rapport: je readiness-score, je profiel per onderdeel en ons advies over de aanpak en het traject dat bij je past.`,
    'Ook zit je certificaat "Strategie-scan voltooid" erbij.',
    'Heb je vragen over je rapport? Beantwoord gerust deze mail.',
    `Met vriendelijke groet,\n${assessor}\nDe Forex Opleiding`,
  ];
  const voetnoot = 'Dit rapport is een persoonlijke analyse op basis van je eigen antwoorden en vormt geen financieel advies. Traden brengt risico op verlies met zich mee.';
  return {
    subject: 'Jouw persoonlijke strategie-scan rapport',
    html: renderMailShell({
      titel,
      inhoud_html: alineas.map((a) => '<p style="margin:0 0 12px">' + escMailHtml(a).replace(/\n/g, '<br>') + '</p>').join(''),
      voetnoot: escMailHtml(voetnoot),
    }),
    text: platteTekstMail({ titel, inhoud_tekst: alineas.join('\n\n'), voetnoot }),
  };
}

async function lees(q, wat) {
  const { data, error } = await q;
  if (error) throw new Error(wat + ': ' + error.message);
  return data;
}

async function profielNaam(db, id) {
  if (!id) return null;
  const p = await lees(db.from('profiles').select('full_name').eq('id', id).maybeSingle(), 'profiles');
  return p?.full_name || null;
}

/** Wat de PDF's nodig hebben, uit een opgeslagen scan (uitkomst opnieuw berekend). */
async function pdfInvoer(db, scan) {
  const assessorVol = await profielNaam(db, scan.assessor_id);
  const assessor = voornaam(assessorVol) || 'Dave';
  const uitkomst = berekenUitkomst(scan.antwoorden || {}, scan.override || {});
  return { naam: scan.deelnemer_naam, uitkomst, assessor, datum: scan.afgerond_op || scan.aangemaakt || new Date() };
}

export function maakHandler(deps = {}) {
  const {
    db = supabaseAdmin,
    userVan = async (req) => {
      const { data } = await createUserClient(req).auth.getUser();
      return data?.user || null;
    },
    magHet = (req) => requirePermission(req, SCAN_RECHT),
    mail = sendMail,
    rapportPdf = maakRapportPdf,
    certificaatPdf = maakCertificaatPdf,
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
    if (!(await magHet(req))) return res.status(403).json({ error: 'Geen toegang tot de scan (' + SCAN_RECHT + ')', code: 'GEEN_TOEGANG' });

    const id = req.method === 'GET' ? req.query?.id : req.body?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return res.status(400).json({ error: 'Ongeldige id' });

    try {
      const scan = await lees(db.from('scans').select('*').eq('id', id).maybeSingle(), 'scans');
      if (!scan) return res.status(404).json({ error: 'Scan niet gevonden' });

      if (req.method === 'GET') {
        const soort = req.query?.soort;
        if (!SOORTEN.includes(soort)) return res.status(400).json({ error: 'Kies rapport of certificaat' });
        if (req.query?.opgeslagen) {
          const ref = soort === 'rapport' ? scan.rapport_pdf_ref : scan.certificaat_pdf_ref;
          if (!ref) return res.status(404).json({ error: 'Nog niet verstuurd — er is geen opgeslagen PDF' });
          const { data, error } = await db.storage.from(BUCKET).createSignedUrl(ref, 3600);
          if (error || !data?.signedUrl) throw new Error('signed url: ' + (error?.message || 'leeg'));
          return res.status(200).json({ url: data.signedUrl });
        }
        const inv = await pdfInvoer(db, scan);
        const pdf = soort === 'rapport'
          ? await rapportPdf(inv)
          : await certificaatPdf({ naam: inv.naam, doel: inv.uitkomst.doel, assessor: inv.assessor, datum: inv.datum });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="' + (soort === 'rapport' ? 'Strategie-scan rapport' : 'Certificaat strategie-scan') + ' - ' + veiligeNaam(scan.deelnemer_naam) + '.pdf"');
        res.setHeader('Content-Length', String(pdf.length));
        return res.status(200).end(pdf);
      }

      // POST: versturen.
      if (scan.status === 'concept') return res.status(409).json({ error: 'Rond de scan eerst af', code: 'NIET_AFGEROND' });
      if (!scan.deelnemer_email) return res.status(422).json({ error: 'De deelnemer heeft geen e-mailadres', code: 'GEEN_EMAIL' });

      const inv = await pdfInvoer(db, scan);
      const [rapport, certificaat] = await Promise.all([
        rapportPdf(inv),
        certificaatPdf({ naam: inv.naam, doel: inv.uitkomst.doel, assessor: inv.assessor, datum: inv.datum }),
      ]);

      const t = nu().toISOString();
      const stempel = t.replace(/[:.]/g, '-');
      const paden = { rapport: `${scan.id}/${stempel}-rapport.pdf`, certificaat: `${scan.id}/${stempel}-certificaat.pdf` };
      const opslag = db.storage.from(BUCKET);
      const geupload = [];
      const ruimOp = async () => {
        if (!geupload.length) return;
        try { await opslag.remove(geupload); } catch (e) { console.error('[scan-rapport] opruimen mislukt:', e?.message || e); }
      };
      for (const [soort, buf] of [['rapport', rapport], ['certificaat', certificaat]]) {
        const { error } = await opslag.upload(paden[soort], buf, { contentType: 'application/pdf', cacheControl: '3600', upsert: false });
        if (error) { await ruimOp(); throw new Error('upload ' + soort + ': ' + error.message); }
        geupload.push(paden[soort]);
      }

      const m = rapportMail({ naam: scan.deelnemer_naam, assessor: inv.assessor });
      const naamDeel = veiligeNaam(scan.deelnemer_naam);
      const r = await mail({
        to: scan.deelnemer_email,
        subject: m.subject, html: m.html, text: m.text,
        attachments: [
          { filename: 'Strategie-scan rapport - ' + naamDeel + '.pdf', content: rapport, contentType: 'application/pdf' },
          { filename: 'Certificaat strategie-scan - ' + naamDeel + '.pdf', content: certificaat, contentType: 'application/pdf' },
        ],
      });
      if (!r || !r.success) {
        console.error('[scan-rapport] mail mislukt:', r?.error || 'onbekend');
        await ruimOp();
        return res.status(502).json({ error: 'Het rapport kon niet gemaild worden. Probeer het opnieuw.', code: 'MAIL_MISLUKT' });
      }

      const upd = {
        status: 'verstuurd', verstuurd_op: t, gewijzigd: t,
        rapport_pdf_ref: paden.rapport, certificaat_pdf_ref: paden.certificaat,
        uitkomst: inv.uitkomst,
      };
      const { data: rij, error: uErr } = await db.from('scans').update(upd).eq('id', scan.id).select('*');
      if (uErr) {
        // De mail IS verstuurd; alleen de administratie liep mis.
        console.error('[scan-rapport] verstuurd, maar scan bijwerken mislukt:', uErr.message);
        return res.status(500).json({ error: 'Rapport is verstuurd, maar de status kon niet worden opgeslagen.', code: 'VERSTUURD_NIET_OPGESLAGEN' });
      }
      return res.status(200).json({ scan: (rij && rij[0]) || { ...scan, ...upd } });
    } catch (e) {
      console.error('[scan-rapport] fout:', e?.message || e);
      return res.status(500).json({ error: 'Er ging iets mis met het rapport' });
    }
  };
}

export default maakHandler();
