// api/opvolging-wacht-check-nu.js
//
// GET ?taak_id= → heeft deze lead intussen zelf ingepland?
//
// Voor het venster 'live wachten' na 'Agenda doorsturen': Dave heeft de lead
// nog aan de lijn ("ik heb je net de link gestuurd, zie je hem?") en ziet het
// moment waarop hij inplant. Het scherm vraagt dit elke 15 s zolang het venster
// open is.
//
// Twee bronnen, in deze volgorde:
//   1. follow_up_appointments — dezelfde match als de cron
//      (beslisWachtInplanning / hoortBijLead, niet gekopieerd).
//   2. Niets gevonden → het GHL-contact (resolveGhlContactId) en zijn
//      afspraken rechtstreeks bij GHL; een afspraak aangemaakt ná
//      agenda_doorgestuurd_at telt. De poll-cron zet hem daarna vanzelf in
//      follow_up_appointments (elke 15 min) — hier wordt geen afspraakrij
//      geschreven, om niet naast de upsert van die cron een tweede schrijver
//      van dezelfde rij te zetten.
//
// Gevonden → precies de update van de cron: status ingepland,
// afspraak_gevonden_at, afspraak_ref, poging 'ingepland' (automatisch).
//
// RATE-LIMIT: max één GHL-vraag per taak per 10 s (per serverinstantie).
//
// Response 200: { status, afspraak?: { scheduled_at, bron }, ghl?: 'overgeslagen'|'niets'|'fout' }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { beslisWachtInplanning } from './_lib/opvolging-doorrol.js';
import { kiesGhlAfspraak } from './_lib/opvolging-agenda-doorsturen.js';
import { resolveGhlContactId } from './_lib/create-appointment-from-lead.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-04-15';
const GHL_MIN_MS = 10_000;
const laatsteGhl = new Map();

/** Mag er nu een GHL-vraag voor deze taak? Puur op een Map, getest. */
export function magGhlVragen(taakId, nuMs, kaart = laatsteGhl) {
  const vorige = kaart.get(taakId);
  if (Number.isFinite(vorige) && nuMs - vorige < GHL_MIN_MS) return false;
  kaart.set(taakId, nuMs);
  return true;
}

async function ghlAfsprakenVan(contactId) {
  const token = process.env.GHL_PIT_TOKEN || process.env.GHL_API_KEY;
  if (!token) throw new Error('GHL-token ontbreekt');
  const r = await fetch(`${GHL_BASE}/contacts/${encodeURIComponent(contactId)}/appointments`, {
    headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error('GHL ' + r.status);
  const d = await r.json().catch(() => ({}));
  return d.events || d.appointments || [];
}

async function markeerIngepland(taak, ref) {
  const nu = new Date().toISOString();
  const { data, error } = await supabaseAdmin.from('opvolging_taken').update({
    status: 'ingepland', afspraak_gevonden_at: nu, afspraak_ref: ref, updated_at: nu,
  }).eq('id', taak.id).eq('status', 'wacht_inplanning').select('id').maybeSingle();
  if (error) throw new Error('ingepland: ' + error.message);
  if (!data) return false;   // intussen al door de cron of een ander tabblad
  try {
    const { error: pErr } = await supabaseAdmin.from('opvolging_pogingen')
      .insert({ taak_id: taak.id, soort: 'ingepland', resultaat: 'zelf ingepland via de agenda', automatisch: true });
    if (pErr) throw new Error(pErr.message);
  } catch (e) {
    console.warn('[opvolging-wacht-check-nu] poging (soft):', e?.message || e);
  }
  return true;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'opvolging.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (opvolging.module.access)' });
  }

  const taakId = String((req.query || {}).taak_id || '');
  if (!taakId) return res.status(400).json({ error: 'taak_id ontbreekt' });

  try {
    const { data: taak, error } = await supabaseAdmin
      .from('opvolging_taken').select('*').eq('id', taakId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!taak) return res.status(404).json({ error: 'Deze taak bestaat niet (meer).' });

    if (taak.status === 'ingepland') {
      return res.status(200).json({ status: 'ingepland', afspraak: { scheduled_at: taak.afspraak_ref?.scheduled_at || null, bron: taak.afspraak_ref?.bron || null } });
    }
    if (taak.status !== 'wacht_inplanning') return res.status(200).json({ status: taak.status });

    // 1 · Onze eigen afsprakentabel, met de beslissing van de cron.
    const gestuurd = Date.parse(taak.agenda_doorgestuurd_at || '');
    const { data: afspraken, error: aErr } = await supabaseAdmin
      .from('follow_up_appointments')
      .select('id, lead_name, lead_email, lead_phone, scheduled_at, created_at, status, zoom_join_url, ghl_appointment_id')
      .gte('created_at', new Date((Number.isFinite(gestuurd) ? gestuurd : Date.now()) - 3600000).toISOString())
      .in('status', ['scheduled', 'in_progress'])
      .limit(500);
    if (aErr) throw new Error('afspraken: ' + aErr.message);
    const besluit = beslisWachtInplanning({ taak, afspraken: afspraken || [], nu: Date.now() });
    if (besluit.actie === 'ingepland') {
      const a = besluit.afspraak;
      const ref = {
        bron: 'wacht-check-nu', appointment_id: a.id, ghl_appointment_id: a.ghl_appointment_id || null,
        zoom_join_url: a.zoom_join_url || null, scheduled_at: a.scheduled_at || null,
      };
      await markeerIngepland(taak, ref);
      return res.status(200).json({ status: 'ingepland', afspraak: { scheduled_at: ref.scheduled_at, bron: 'agenda' } });
    }

    // 2 · GHL rechtstreeks, met rate-limit.
    if (!magGhlVragen(taak.id, Date.now())) return res.status(200).json({ status: 'wacht_inplanning', ghl: 'overgeslagen' });
    try {
      const contactId = await resolveGhlContactId({
        id: taak.id, customer_id: null,
        lead_name: taak.naam, lead_email: taak.email, lead_phone: taak.telefoon,
        source_ref: taak.bron_ref || {},
      });
      if (!contactId) return res.status(200).json({ status: 'wacht_inplanning', ghl: 'niets' });
      const gekozen = kiesGhlAfspraak(await ghlAfsprakenVan(contactId), taak.agenda_doorgestuurd_at);
      if (!gekozen) return res.status(200).json({ status: 'wacht_inplanning', ghl: 'niets' });
      const ref = { bron: 'wacht-check-nu-ghl', appointment_id: null, ...gekozen, zoom_join_url: null };
      await markeerIngepland(taak, ref);
      return res.status(200).json({ status: 'ingepland', afspraak: { scheduled_at: gekozen.scheduled_at, bron: 'ghl' } });
    } catch (e) {
      console.warn('[opvolging-wacht-check-nu] GHL (soft):', e?.message || e);
      return res.status(200).json({ status: 'wacht_inplanning', ghl: 'fout' });
    }
  } catch (e) {
    console.error('[opvolging-wacht-check-nu]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}
