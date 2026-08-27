// api/public-opstartsessie-book.js
//
// Publieke boek-endpoint voor de Opstartsessie-pagina op deforexopleiding.nl.
// Server-to-server via x-internal-token == OPSTARTSESSIE_SECRET (least
// privilege; dfo-website's serverless-proxy roept aan, browser NIET direct).
//
// Doet:
//   1) upsert_lead (RPC — dedup op lower(email)); bron='opstartsessie',
//      soort='opstartsessie', traject=<bron-slug uit link>.
//   2) createAppointmentForLead({ lead, scheduledAt, source }) →
//      GHL-contact-upsert + GHL-appointment aanmaken + follow_up_appointments-
//      rij inserten met booking_source + fail-soft GHL-tag "bron-<slug>".
//   3) Geen LMS-toegang, geen mail-flow hier (bestaande GHL-workflow triggert
//      Zoom-uitnodiging + confirmation zoals bij elke andere GHL-boeking).
//
// Auth:
//   x-internal-token == OPSTARTSESSIE_SECRET (verplicht)
//
// Body:
//   voornaam        string  required (1..80)
//   achternaam      string  optional
//   email           string  required (geldig)
//   telefoon        string  required (min 6 tekens, spaties/plussen ok)
//   scheduledAt     ISO8601 required — start-tijd (bv. '2026-09-05T13:00:00+02:00')
//   source          string  optional — bron-slug uit /opstartsessie/<slug>;
//                                       default 'direct' als weggelaten
//   noshow_akkoord  boolean required (moet true; €50-no-show-vinkje)
//   durationMinutes int     optional — default 20 (Opstartsessie ≈ 20 min)
//
// Response:
//   200 { ok:true, appointment_id, ghl_appointment_id, zoom_join_url, source }
//   400 { error }
//   401 { error }
//   422 { error, code:'NO_GHL_CONTACT'|'GHL_CONFIG_MISSING' }
//   502 { error, ghlStatus }
//   503 { error: 'OPSTARTSESSIE_SECRET niet geconfigureerd' }
//
// 0 incasso-writes. Raakt alleen leads + follow_up_appointments; GHL calendar/
// contacts. Geen dunning/arrangement/pending-action touches.

import { supabaseAdmin } from './supabase.js';
import { createAppointmentForLead, mapGhlError } from './_lib/create-appointment-from-lead.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_RE  = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Basale E.164-normalisatie voor NL/BE input (kopie van _lib/lms-provisioning.js
// helper — hier standalone gehouden zodat dependency minimaal blijft).
function telefoonE164(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits;
  // NL/BE aannemen op basis van 0-prefix.
  const rest = digits.replace(/^0+/, '');
  if (rest.length >= 9 && rest.length <= 12) return '+31' + rest;
  return digits;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // Auth
  const tokenHeader = req.headers['x-internal-token'] || null;
  const verwacht    = process.env.OPSTARTSESSIE_SECRET || null;
  if (!verwacht) return res.status(503).json({ error: 'OPSTARTSESSIE_SECRET niet geconfigureerd' });
  if (!tokenHeader || tokenHeader !== verwacht) {
    return res.status(401).json({ error: 'Unauthorized (x-internal-token vereist)' });
  }

  // Body-validatie
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const voornaam   = String(body.voornaam   || '').trim().slice(0, 80);
  const achternaam = body.achternaam ? String(body.achternaam).trim().slice(0, 120) : null;
  const email      = String(body.email      || '').trim().toLowerCase().slice(0, 200);
  const telefoon   = String(body.telefoon   || '').trim().slice(0, 40);
  const scheduledAt = String(body.scheduledAt || '').trim();
  const noshowOk   = body.noshow_akkoord === true;
  const durationMinutes = Number.isFinite(Number(body.durationMinutes))
    ? Math.max(15, Math.min(60, Number(body.durationMinutes)))
    : 20;

  // Source-slug — default 'direct' als weggelaten. Onbekende typo's worden
  // door create-appointment-from-lead genormaliseerd + geaccepteerd
  // (typo blijft telbaar in de stats).
  let source = body.source ? String(body.source).trim().toLowerCase() : 'direct';
  if (!SLUG_RE.test(source)) source = 'direct';

  // Optionele koppeling naar een pre-existent opstartsessie_submissions-rij
  // (DEEL 3): de proxy legt de vragenlijst-antwoorden + resultaat vast via
  // /api/public-opstartsessie-submit vóór de boek-stap, en stuurt dat id
  // hier mee zodat we noshow_akkoord/appointment_id/lead_id op DIE rij
  // kunnen zetten (single-source-of-truth voor de backoffice-tab).
  // Ongeldig id (typo) → stille skip; boeking gaat door zonder linkage.
  const submissionId = (typeof body.submission_id === 'string' && UUID_RE.test(body.submission_id.trim()))
    ? body.submission_id.trim() : null;

  if (voornaam.length < 1)             return res.status(400).json({ error: 'voornaam vereist' });
  if (!EMAIL_RE.test(email))           return res.status(400).json({ error: 'geldig e-mailadres vereist' });
  if (telefoon.replace(/\D/g,'').length < 6) return res.status(400).json({ error: 'geldig telefoonnummer vereist' });
  if (!scheduledAt)                    return res.status(400).json({ error: 'scheduledAt vereist' });
  if (isNaN(new Date(scheduledAt).getTime())) return res.status(400).json({ error: 'scheduledAt ongeldig (verwacht ISO8601)' });
  if (!noshowOk)                       return res.status(400).json({ error: 'no-show-akkoord (noshow_akkoord=true) vereist' });

  // 1) Lead upserten via bestaande RPC (dedup op lower(email)).
  let leadId;
  try {
    const { data: lead, error: lErr } = await supabaseAdmin.rpc('upsert_lead', {
      p: {
        voornaam, achternaam, email, telefoon,
        telefoon_e164: telefoonE164(telefoon),
        bron   : 'opstartsessie',
        soort  : 'opstartsessie',
        traject: source,
      },
    });
    if (lErr) throw new Error('upsert_lead: ' + lErr.message);
    leadId = lead?.id;
    if (!leadId) throw new Error('upsert_lead gaf geen lead-id');
  } catch (e) {
    console.error('[public-opstartsessie-book] lead upsert:', e?.message || e);
    return res.status(500).json({ error: 'Lead aanmaken mislukt' });
  }

  // 2) Lead-row ophalen voor createAppointmentForLead (naam + email + telefoon).
  let leadRow;
  try {
    const { data, error } = await supabaseAdmin
      .from('leads')
      .select('id, voornaam, achternaam, email, telefoon, customer_id, source_ref')
      .eq('id', leadId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(500).json({ error: 'Lead niet gevonden na upsert' });
    // createAppointmentForLead verwacht lead_name/email/phone-shape.
    leadRow = {
      ...data,
      lead_name : [data.voornaam, data.achternaam].filter(Boolean).join(' ') || voornaam,
      lead_email: data.email    || email,
      lead_phone: data.telefoon || telefoon,
    };
  } catch (e) {
    console.error('[public-opstartsessie-book] lead fetch:', e?.message || e);
    return res.status(500).json({ error: 'Kon lead niet ophalen' });
  }

  // 3) Afspraak aanmaken (GHL contact-upsert + appointment + follow_up-row +
  //    booking_source + fail-soft GHL-tag).
  try {
    const result = await createAppointmentForLead({
      lead: leadRow, scheduledAt, durationMinutes, source,
    });

    // DEEL 3: link naar de submission-rij (fail-soft). Zet noshow_akkoord=
    // true (impliciet — de client heeft 'em al gevalideerd) + appointment_id +
    // lead_id. Alleen op de meegegeven submission-id + defensief scoped op
    // resultaat='toegelaten' (afgewezen submissions mogen nooit een booking
    // krijgen, ook niet bij een spoof-caller die het id kent). Faalt de
    // update → log, maar de boeking is al gelukt en booking_source zit in
    // follow_up_appointments; blocking zou de user onnodig een 500 geven.
    if (submissionId && result?.appointment_id) {
      try {
        const { error: linkErr } = await supabaseAdmin
          .from('opstartsessie_submissions')
          .update({
            noshow_akkoord : true,
            appointment_id : result.appointment_id,
            lead_id        : leadId || null,
          })
          .eq('id', submissionId)
          .eq('resultaat', 'toegelaten');
        if (linkErr) console.warn('[public-opstartsessie-book] submission-link (soft):', linkErr.message);
      } catch (e) {
        console.warn('[public-opstartsessie-book] submission-link exception (soft):', e?.message || e);
      }
    }

    return res.status(200).json({
      ok: true,
      appointment_id     : result.appointment_id,
      ghl_appointment_id : result.ghl_appointment_id,
      zoom_join_url      : result.zoom_join_url,
      source             : result.booking_source || source,
      submission_id      : submissionId,
    });
  } catch (e) {
    if (e?.code === 'BAD_INPUT')          return res.status(400).json({ error: e.message || 'Ongeldige invoer' });
    if (e?.code === 'NO_GHL_CONTACT')     return res.status(422).json({ code: 'NO_GHL_CONTACT', error: 'GHL-contact kon niet worden aangemaakt' });
    if (e?.code === 'GHL_CONFIG_MISSING') return res.status(422).json({ code: 'GHL_CONFIG_MISSING', error: 'GHL-configuratie ontbreekt op de server' });
    if (e?.code === 'GHL_API') {
      const nl = mapGhlError(e.ghlStatus, e.ghlBody);
      return res.status(502).json({ error: nl || 'GHL API-fout', ghlStatus: e.ghlStatus || null });
    }
    console.error('[public-opstartsessie-book] onbekende fout:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Onbekende fout' });
  }
}
