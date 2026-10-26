// api/public-webinar-aanmelding.js
//
// POST — aanmelding voor de eerstvolgende actieve webinar, aangeroepen door de
// website (dfo-website /api/webinar-aanmelding) NA upsert_lead. Server-naar-
// server: x-internal-token == OPSTARTSESSIE_SECRET (zelfde geheim als
// public-event-vervolg-invite).
//
// Body: { voornaam, email, telefoon (E.164), bron: 'webinar-v1'|'webinar-v2',
//         lead_id (uuid|null), toestemming (bool), sessie_id (uuid|null) }
//   sessie_id (2026-10-13, datumkeuze): de gekozen sessie. Moet één van de op dit
//   moment aangeboden sessies zijn (eerstvolgende 3 doorgaande); anders 409
//   SESSIE_ONGELDIG. Zonder sessie_id: de eerstvolgende (oude gedrag).
// 200 { ok, aanmelding_id, al_aangemeld, verplaatst, sessie: { id, titel, starts_at, ends_at } }
//   verplaatst = al aangemeld voor een andere datum → naar de gekozen verplaatst
//   (verse bevestiging); al_aangemeld = al aangemeld voor DEZE datum.
// 409 { error, code: 'GEEN_SESSIE' }      — geen actieve komende webinar (alles overgeslagen / reeks uit)
// 409 { error, code: 'SESSIE_ONGELDIG' }  — gekozen sessie niet (meer) aangeboden
// 400 { error }                           — ongeldige invoer
//
// De bevestiging (mail + WhatsApp, met datum + Zoom-link) gaat hier meteen uit
// (api/_lib/webinar.js → meldAan). Geen limiet op het aantal aanmeldingen.
//
// LEAD-VANGNET (2026-10-25): komt er geen lead_id mee (de website kon de lead
// niet opslaan) en bestaat er ook geen lead op dit e-mailadres, dan maakt het
// CRM de lead hier alsnog aan (upsert_lead, traject 'webinar'). Lukt ook dat
// niet, dan gaat de aanmelding door (de plek telt zwaarder) maar met een
// console.error én een alarmmail — nooit meer stil.

import { supabaseAdmin } from './supabase.js';
import { meldAan } from './_lib/webinar.js';
import { sendMail } from './_lib/email.js';
import { waitUntil } from '@vercel/functions';
import { leesBestemming } from './_lib/trial-product.js';

const ALARM_NAAR = process.env.PROVISIONING_ALARM_EMAIL || 'biemoldjeffrey@gmail.com';

export const BRONNEN = Object.freeze(['webinar-v1', 'webinar-v2']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pure validatie → { ok, waarden } of { ok:false, fout }. */
export function valideer(body) {
  const b = body && typeof body === 'object' ? body : {};
  const email = String(b.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, fout: 'Ongeldig e-mailadres' };
  const voornaam = String(b.voornaam || '').trim().slice(0, 80);
  if (!voornaam) return { ok: false, fout: 'Voornaam ontbreekt' };
  const telefoon = String(b.telefoon || '').trim();
  if (telefoon && !/^\+\d{8,15}$/.test(telefoon)) return { ok: false, fout: 'Telefoon moet E.164 zijn (+31…)' };
  if (!BRONNEN.includes(b.bron)) return { ok: false, fout: 'Onbekende bron' };
  const leadId = b.lead_id && UUID_RE.test(String(b.lead_id)) ? String(b.lead_id) : null;
  let sessieId = null;
  if (b.sessie_id !== undefined && b.sessie_id !== null && b.sessie_id !== '') {
    if (!UUID_RE.test(String(b.sessie_id))) return { ok: false, fout: 'Ongeldige sessie' };
    sessieId = String(b.sessie_id).toLowerCase();
  }
  return { ok: true, waarden: { voornaam, email, telefoon: telefoon || null, bron: b.bron, leadId, toestemming: b.toestemming === true, sessieId } };
}

/**
 * Zorgt dat er een lead is voor deze aanmelding. Geeft het lead-id terug, of
 * null als zelfs het vangnet faalt (dan is er gealarmeerd).
 */
export async function zorgVoorLead(sb, w, alarm = stuurLeadAlarm) {
  if (w.leadId) return w.leadId;
  console.error('[public-webinar-aanmelding] LEAD-VANGNET: website gaf geen lead_id', { bron: w.bron });
  try {
    const { data: l, error: lErr } = await sb.from('leads').select('id').ilike('email', w.email).is('verwijderd_op', null).limit(1);
    if (lErr) throw new Error('lead zoeken: ' + lErr.message);
    if (l?.[0]?.id) return l[0].id;
    const { data, error } = await sb.rpc('upsert_lead', {
      p: {
        voornaam: w.voornaam, achternaam: null, email: w.email,
        telefoon: w.telefoon || null, telefoon_e164: w.telefoon || null,
        toestemming: w.toestemming === true, toestemming_op: w.toestemming ? new Date().toISOString() : null,
        bron: w.bron, soort: 'onbekend', traject: 'webinar',
        kwalificatie: null, score: null, drempel: null, afwijzer: false, antwoorden: [],
      },
    });
    if (error) throw new Error('upsert_lead: ' + error.message);
    const rij = Array.isArray(data) ? data[0] : data;
    if (!rij?.id) throw new Error('upsert_lead gaf geen id');
    console.warn('[public-webinar-aanmelding] LEAD-VANGNET: lead alsnog aangemaakt in het CRM', { lead_id: rij.id, bron: w.bron });
    return rij.id;
  } catch (e) {
    console.error('[public-webinar-aanmelding] LEAD-VANGNET MISLUKT — aanmelding zonder lead', { bron: w.bron, fout: e?.message || String(e) });
    await alarm(w, e?.message || String(e));
    return null;
  }
}

async function stuurLeadAlarm(w, fout) {
  try {
    const r = await sendMail({
      to: ALARM_NAAR,
      subject: '⚠ Webinar-aanmelding zonder lead',
      html: `<p>Een webinar-aanmelding (${String(w.bron)}) kon NIET als lead worden opgeslagen, ook niet via het vangnet in het CRM.</p>`
        + `<p>De aanmelding zelf staat wel in de webinarmodule (e-mail: ${String(w.email).replace(/[<>&]/g, '')}).</p>`
        + `<p>Fout: <code>${String(fout).replace(/[<>&]/g, '')}</code></p>`,
    });
    if (!r?.sent) console.error('[public-webinar-aanmelding] alarmmail niet verstuurd:', r?.reason || r?.error || 'onbekend');
  } catch (e) {
    console.error('[public-webinar-aanmelding] alarmmail exception:', e?.message || e);
  }
}

/** Laat een belofte afmaken nadat het antwoord weg is (Vercel waitUntil). */
function naAntwoord(belofte) {
  try { waitUntil(belofte); } catch (e) { console.warn('[public-webinar-aanmelding] waitUntil (soft):', e?.message || e); }
  return belofte;
}

/** De Lab-trial bij een webinar-aanmelding. Gooit nooit. */
export async function trialVoorWebinar(w) {
  try {
    if (await leesBestemming(supabaseAdmin, 'webinar') !== 'lab') return { overgeslagen: 'bestemming_oud' };
    // Lazy: de Lab-keten (LMS, mail, WhatsApp) alleen laden als ze nodig is.
    const { geefLabTrial } = await import('./_lib/lab-trial.js');
    return await geefLabTrial({
      product: 'webinar', bron: w.bron, email: w.email, voornaam: w.voornaam,
      telefoon: w.telefoon, toestemming: w.toestemming, leadId: w.leadId || null,
    });
  } catch (e) {
    console.error('[public-webinar-aanmelding] lab-trial mislukt:', e?.message || e);
    return { ok: false };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const verwacht = process.env.OPSTARTSESSIE_SECRET || null;
  if (!verwacht) return res.status(503).json({ error: 'OPSTARTSESSIE_SECRET niet geconfigureerd' });
  if ((req.headers['x-internal-token'] || null) !== verwacht) {
    return res.status(401).json({ error: 'Unauthorized (x-internal-token vereist)' });
  }

  const v = valideer(req.body);
  if (!v.ok) return res.status(400).json({ error: v.fout });

  try {
    const leadId = await zorgVoorLead(supabaseAdmin, v.waarden);
    const r = await meldAan(supabaseAdmin, { ...v.waarden, leadId });
    if (r.geenSessie) return res.status(409).json({ error: 'Er staat geen webinar gepland', code: 'GEEN_SESSIE' });
    if (r.ongeldigeSessie) return res.status(409).json({ error: 'Deze sessie wordt niet (meer) aangeboden', code: 'SESSIE_ONGELDIG' });
    // "Eén login voor alle funnels": een nieuwe webinar-aanmelding krijgt ook
    // een trial in het echte LMS. Na het antwoord, zodat de website niet wacht.
    if (!r.alAangemeld && !r.verplaatst) naAntwoord(trialVoorWebinar({ ...v.waarden, leadId }));
    return res.status(200).json({
      ok: true,
      aanmelding_id: r.aanmelding.id,
      al_aangemeld: r.alAangemeld,
      verplaatst: r.verplaatst === true,
      sessie: { id: r.sessie.id, titel: r.reeks.titel, starts_at: r.sessie.starts_at, ends_at: r.sessie.ends_at },
    });
  } catch (e) {
    console.error('[public-webinar-aanmelding] fout:', e?.message || e);
    return res.status(500).json({ error: 'Aanmelding kon niet worden opgeslagen' });
  }
}
