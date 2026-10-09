// api/public-webinar-aanmelding.js
//
// POST — aanmelding voor de eerstvolgende actieve webinar, aangeroepen door de
// website (dfo-website /api/webinar-aanmelding) NA upsert_lead. Server-naar-
// server: x-internal-token == OPSTARTSESSIE_SECRET (zelfde geheim als
// public-event-vervolg-invite).
//
// Body: { voornaam, email, telefoon (E.164), bron: 'webinar-v1'|'webinar-v2',
//         lead_id (uuid|null), toestemming (bool) }
// 200 { ok, aanmelding_id, al_aangemeld, sessie: { id, titel, starts_at, ends_at } }
// 409 { error, code: 'GEEN_SESSIE' }   — geen actieve komende webinar (alles overgeslagen / reeks uit)
// 400 { error }                        — ongeldige invoer
//
// De bevestiging (mail + WhatsApp, met datum + Zoom-link) gaat hier meteen uit
// (api/_lib/webinar.js → meldAan). Geen limiet op het aantal aanmeldingen.

import { supabaseAdmin } from './supabase.js';
import { meldAan } from './_lib/webinar.js';

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
  return { ok: true, waarden: { voornaam, email, telefoon: telefoon || null, bron: b.bron, leadId, toestemming: b.toestemming === true } };
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
    const r = await meldAan(supabaseAdmin, v.waarden);
    if (r.geenSessie) return res.status(409).json({ error: 'Er staat geen webinar gepland', code: 'GEEN_SESSIE' });
    return res.status(200).json({
      ok: true,
      aanmelding_id: r.aanmelding.id,
      al_aangemeld: r.alAangemeld,
      sessie: { id: r.sessie.id, titel: r.reeks.titel, starts_at: r.sessie.starts_at, ends_at: r.sessie.ends_at },
    });
  } catch (e) {
    console.error('[public-webinar-aanmelding] fout:', e?.message || e);
    return res.status(500).json({ error: 'Aanmelding kon niet worden opgeslagen' });
  }
}
