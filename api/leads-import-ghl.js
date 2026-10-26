// api/leads-import-ghl.js
//
// POST { csv, soort: 'mail'|'telefoon', bevestig? } → GHL-contacten importeren
// als leads (bron 'Import' / 'Import-telefoon'), in weekbatches voor de
// webinar-uitnodigingen. Regels en opbouw: api/_lib/ghl-import.js.
//
//   bevestig false/leeg → PROEFRUN: aantallen nieuw / al bestaand / ongeldig per
//                         batch, plus de lijst bestaande adressen (om te beslissen
//                         of die ook mee moeten). Er wordt NIETS geschreven.
//   bevestig true       → dezelfde controle opnieuw (de server vertrouwt de client
//                         niet) en dan invoegen in brokken van 500. Idempotent:
//                         opnieuw draaien slaat al geïmporteerde adressen over.
//
// Bestaande leads worden NOOIT overschreven. Er gaat niets naar Meta.
// Recht: admin/manager (verifyAdmin). Vereist migratie 2026-10-26-leads-ghl-import.sql.

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { leesGhlCsv, maakImportPlan } from './_lib/ghl-import.js';

const MAX_CSV = 3_500_000;
const BROK = 500;
// maxDuration 300 s staat in vercel.json; ruim binnen die grens stoppen.
const BUDGET_MS = 240_000;

async function bestaandeLeads(db) {
  const emails = new Set();
  const telefoons = new Set();
  for (let van = 0; van < 200000; van += 1000) {
    const { data, error } = await db.from('leads').select('email, telefoon_e164')
      .order('id', { ascending: true }).range(van, van + 999);
    if (error) throw new Error('leads lezen: ' + error.message);
    for (const l of data || []) {
      const e = String(l.email || '').trim().toLowerCase();
      if (e) emails.add(e);
      if (l.telefoon_e164) telefoons.add(String(l.telefoon_e164));
    }
    if (!data || data.length < 1000) break;
  }
  const { data: oud, error: oErr } = await db.from('leads').select('aangemaakt')
    .not('aangemaakt', 'is', null).order('aangemaakt', { ascending: true }).limit(1);
  if (oErr) throw new Error('oudste lead: ' + oErr.message);
  return { emails, telefoons, oudste: oud?.[0]?.aangemaakt || null };
}

/** Eén brok invoegen; bij een conflict rij voor rij (dan telt het als al bestaand). */
async function voegIn(db, rijen) {
  const { error } = await db.from('leads').insert(rijen);
  if (!error) return { ingevoegd: rijen.length, conflict: 0, fout: null };
  const code = String(error.code || '');
  if (code === '42703' || code === 'PGRST204') return { ingevoegd: 0, conflict: 0, fout: 'Migratie 2026-10-26-leads-ghl-import.sql is nog niet gedraaid (' + error.message + ').', stop: true };
  if (code === '23502') return { ingevoegd: 0, conflict: 0, fout: 'Een verplicht veld ontbreekt (' + error.message + '). Bij de telefoon-only-import: leads.email is verplicht in de database.', stop: true };
  if (code !== '23505') return { ingevoegd: 0, conflict: 0, fout: error.message, stop: true };
  let ingevoegd = 0; let conflict = 0;
  for (const r of rijen) {
    const { error: e1 } = await db.from('leads').insert(r);
    if (!e1) ingevoegd += 1;
    else if (String(e1.code) === '23505') conflict += 1;
    else return { ingevoegd, conflict, fout: e1.message, stop: true };
  }
  return { ingevoegd, conflict, fout: null };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Alleen voor admin/manager' });

  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const csv = String(b.csv || '');
  const soort = b.soort === 'telefoon' ? 'telefoon' : 'mail';
  if (!csv.trim()) return res.status(400).json({ error: 'Geen CSV meegestuurd' });
  if (csv.length > MAX_CSV) return res.status(413).json({ error: 'Bestand te groot (max ~3,5 MB)' });

  const { rijen, fout } = leesGhlCsv(csv, soort);
  if (fout) return res.status(400).json({ error: fout });

  try {
    const start = Date.now();
    const db = supabaseAdmin;
    const bestaand = await bestaandeLeads(db);
    const plan = maakImportPlan(rijen, {
      bestaandeEmails: bestaand.emails, bestaandeTelefoons: bestaand.telefoons, oudsteAangemaakt: bestaand.oudste, soort,
    });
    const samenvatting = {
      soort,
      rijen: rijen.length,
      nieuw: plan.nieuw.length,
      bestaand: plan.bestaand.length,
      ongeldig: plan.ongeldig.length,
      dubbel_in_bestand: plan.dubbel_in_bestand,
      telefoon_ongeldig: plan.telefoon_ongeldig,
      per_batch: plan.per_batch,
      sorteer_van: plan.sorteer_van,
      sorteer_tot: plan.sorteer_tot,
      oudste_bestaande_lead: bestaand.oudste,
      ongeldig_voorbeelden: plan.ongeldig.slice(0, 50),
    };
    if (b.bevestig !== true) {
      // Proefrun: ook de bestaande adressen, zodat Jeffrey kan beslissen of die mee moeten.
      return res.status(200).json({ proefrun: true, ...samenvatting, bestaand_lijst: plan.bestaand.slice(0, 15000) });
    }

    let ingevoegd = 0; let conflict = 0; let gestopt = null; let rest = 0;
    for (let i = 0; i < plan.nieuw.length; i += BROK) {
      if (Date.now() - start > BUDGET_MS) { rest = plan.nieuw.length - i; break; }
      const r = await voegIn(db, plan.nieuw.slice(i, i + BROK));
      ingevoegd += r.ingevoegd; conflict += r.conflict;
      if (r.fout) {
        console.error('[leads-import-ghl] invoegen gestopt', { soort, na: ingevoegd, fout: r.fout });
        gestopt = r.fout;
        rest = plan.nieuw.length - i - r.ingevoegd - r.conflict;
        break;
      }
    }
    console.log('[leads-import-ghl]', { soort, door: admin.profile?.email || admin.user?.id, ingevoegd, conflict, bestaand: plan.bestaand.length, ongeldig: plan.ongeldig.length, rest });
    return res.status(gestopt ? 500 : 200).json({
      proefrun: false, ...samenvatting,
      ingevoegd, conflict_bij_invoegen: conflict, nog_te_doen: rest,
      ...(gestopt ? { error: gestopt } : {}),
      ...(rest && !gestopt ? { melding: 'Tijdslimiet bereikt: draai de import nog eens met hetzelfde bestand, de rest volgt (al geïmporteerde adressen worden overgeslagen).' } : {}),
    });
  } catch (e) {
    console.error('[leads-import-ghl]', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
