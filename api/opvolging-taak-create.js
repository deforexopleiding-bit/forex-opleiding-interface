// api/opvolging-taak-create.js
//
// Fase 3a — een taak aanmaken vanuit het afronden van een call.
//
// Tot nu toe ontstonden taken alleen bij het afronden van een event (Punt B in
// api/_lib/events-complete-core.js). Een call die vraagt om een vervolg had
// nergens heen; dit endpoint sluit dat gat.
//
// POST { bron_ref, naam, email?, telefoon?, reden, due?, notitie?, badge_label? }
//   reden 'wil_nog_beslissen' → due verplicht, notitie verplicht
//   reden 'no_show_call'      → due = vandaag als hij niet meegegeven is
//
// Schrijft uitsluitend in opvolging_taken en opvolging_pogingen. De
// afspraakrecords en /api/follow-up-appointment-outcome blijven ongemoeid: wat
// er met de afspraak zelf gebeurt is een andere administratie en die verandert
// hier niet.
//
// Idempotent op bron_ref.appointment_id: twee keer afronden levert geen tweede
// kaart op, maar werkt de bestaande bij. Dubbel klikken is geen fout van de
// gebruiker die hem een dubbele bellijst mag opleveren.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { bepaalStartPoging } from './_lib/opvolging-taak-poging.js';

const REDENEN  = new Set(['wil_nog_beslissen', 'no_show_call', 'afgemeld', 'no_show_event', 'niet_ingepland']);
const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;
const ZONE     = 'Europe/Amsterdam';

const dagInZone = (ms) => new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(ms));

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const allowed = await requirePermission(req, 'opvolging.module.access');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (opvolging.module.access)' });

  const b = req.body || {};
  const naam = String(b.naam || '').trim();
  if (!naam) return res.status(400).json({ error: 'naam ontbreekt' });

  const reden = String(b.reden || '').trim();
  if (!REDENEN.has(reden)) return res.status(400).json({ error: 'onbekende reden' });

  const notitie = b.notitie != null ? String(b.notitie).trim().slice(0, 2000) : '';
  // Bij 'wil nog beslissen' is de notitie het enige dat de volgende beller
  // vertelt waaróm er nog getwijfeld wordt. Zonder die zin is de taak een naam
  // en een datum, en begint het gesprek weer bij nul.
  if (reden === 'wil_nog_beslissen' && !notitie) {
    return res.status(400).json({ error: 'notitie is verplicht bij wil_nog_beslissen' });
  }

  const vandaag = dagInZone(Date.now());
  let due = b.due != null ? String(b.due).trim() : '';
  if (due && !DATUM_RE.test(due)) return res.status(400).json({ error: 'due moet YYYY-MM-DD zijn' });
  if (reden === 'wil_nog_beslissen' && !due) {
    return res.status(400).json({ error: 'due is verplicht bij wil_nog_beslissen' });
  }
  if (!due) due = vandaag;

  const bronRef = (b.bron_ref && typeof b.bron_ref === 'object' && !Array.isArray(b.bron_ref)) ? b.bron_ref : {};
  const appointmentId = bronRef.appointment_id ? String(bronRef.appointment_id) : null;

  try {
    // Bestaat er al een open kaart voor deze afspraak? Dan bijwerken in plaats
    // van een tweede maken. Gearchiveerde kaarten zijn geschiedenis en tellen
    // hier niet mee — die blokkeren een nieuwe niet.
    let bestaandeId = null;
    if (appointmentId) {
      const { data, error } = await supabaseAdmin
        .from('opvolging_taken')
        .select('id')
        .neq('status', 'gearchiveerd')
        .filter('bron_ref->>appointment_id', 'eq', appointmentId)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) throw new Error('zoeken: ' + error.message);
      if (data && data[0]) bestaandeId = data[0].id;
    }

    const velden = {
      naam,
      email      : b.email ? String(b.email).trim() : null,
      telefoon   : b.telefoon ? String(b.telefoon).trim() : null,
      reden,
      bron       : 'call',
      bron_ref   : { ...bronRef, source: 'opvolging-call' },
      badge_label: b.badge_label ? String(b.badge_label).slice(0, 200) : null,
      due,
      later      : false,
      status     : 'open',
      notitie    : notitie || null,
      eigenaar_id: null,   // RLS is is_crm_staff(); zonder eigenaar is de kaart van het team
    };

    let taakId = bestaandeId;
    if (bestaandeId) {
      const { error } = await supabaseAdmin.from('opvolging_taken')
        .update({ ...velden, updated_at: new Date().toISOString() })
        .eq('id', bestaandeId);
      if (error) throw new Error('bijwerken: ' + error.message);
    } else {
      const { data, error } = await supabaseAdmin.from('opvolging_taken')
        .insert(velden).select('id').single();
      if (error) throw new Error('aanmaken: ' + error.message);
      taakId = data.id;
    }

    // Krijgt deze taak meteen een belpoging mee? De regel staat in
    // _lib/opvolging-taak-poging.js — hier, en niet alleen in het scherm, zodat
    // een oud tabblad hem niet kan omzeilen. Kort: 'wil nog beslissen' wel (dat
    // gesprek is gevoerd), een no-show niet (er is niet gebeld).
    // Fail-soft: de taak is de actie, de poging is de historiek.
    const startPoging = bepaalStartPoging({ taakId, reden, resultaat: b.poging_resultaat });
    if (startPoging) {
      try {
        const { error } = await supabaseAdmin.from('opvolging_pogingen').insert(startPoging);
        if (error) throw new Error(error.message);
      } catch (e) {
        console.warn('[opvolging-taak-create] poging (soft):', e?.message || e);
      }
    }

    return res.status(200).json({ success: true, taak_id: taakId, hergebruikt: !!bestaandeId });
  } catch (e) {
    console.error('[opvolging-taak-create]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Onbekende fout' });
  }
}
