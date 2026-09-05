// api/cron-opvolging-aanmeldingen.js
//
// Masterclass-aanmeldingen in Daves takenlijst. Draait elk kwartier.
//
// De instroom hangt aan de DEELNEMERRIJ met status 'aangemeld', niet aan een
// inschrijf-endpoint. Er zijn drie manieren waarop zo'n rij ontstaat — het
// GHL-formulier, de Webflow-vragenlijst, en een verplaatsing via
// api/events-attendee-move.js — en die laatste maakt een nieuwe rij op het
// doel-event. Wie aan het inschrijfmoment hangt, mist precies die mensen.
//
// Twee momenten, één kaart:
//   A — de aanmelding zelf, zodat Dave binnen 24 uur belt.
//   B — vier dagen voor het event wordt dezelfde kaart weer wakker.
// Daartussen slaapt hij doordat `due` in de toekomst staat.
//
// En de kaart sluit zichzelf: zodra de deelnemer in de eventmodule op
// 'switched_to_other_event' of 'geannuleerd' komt te staan, gaat de taak dicht
// met een notitie. Dat is betrouwbaarder dan een bevestigingsvenster, want dat
// wordt weggeklikt.
//
// De beslissing zelf staat in api/_lib/opvolging-aanmelding.js, als pure
// functie met tests. Hier alleen het lezen, schrijven en tellen.
//
// Auth: Authorization: Bearer $CRON_SECRET. Methodes: GET (cron) + POST (debug).
// Schrijft uitsluitend in opvolging_taken. event_attendees wordt alleen gelezen.

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import { bepaalTaakActie, WAKKER_DAGEN_VOOR_EVENT, dagInZone, dagPlus } from './_lib/opvolging-aanmelding.js';

const ABORT_MS = 25_000;
// Ruim genomen: alles wat nog moet komen plus wat net geweest is, zodat een
// verplaatsing of annulering vlak na het event de kaart nog sluit.
const VENSTER_VOORUIT_DAGEN = 120;
const VENSTER_TERUG_DAGEN   = 3;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const startedAt = Date.now();
  const vandaag = dagInZone(startedAt);
  console.log('[cron-opvolging-aanmeldingen] start vandaag=' + vandaag);

  const summary = {
    vandaag,
    events_bekeken   : 0,
    deelnemers        : 0,
    aangemaakt        : 0,
    wakker_gemaakt    : 0,
    gesloten_verplaatst: 0,
    gesloten_geannuleerd: 0,
    errors            : [],
    duration_ms       : 0,
  };

  try {
    // ── Welke events tellen mee? ─────────────────────────────────────────────
    // Bewust GEEN filter op niveau of titel. `event_niveau_options` kent alleen
    // 'basis' en 'gevorderd'; er is geen slug die masterclasses afbakent. Op de
    // titel filteren zou op een gok neerkomen, en een gok die te streng is laat
    // mensen stil buiten de lijst vallen. Liever iedereen erin dan iemand eruit.
    const van = dagPlus(vandaag, -VENSTER_TERUG_DAGEN);
    const tot = dagPlus(vandaag, VENSTER_VOORUIT_DAGEN);
    const { data: events, error: evErr } = await supabaseAdmin
      .from('events')
      .select('id, title, location, starts_at, status')
      .gte('starts_at', `${van}T00:00:00Z`)
      .lte('starts_at', `${tot}T23:59:59Z`)
      .neq('status', 'archived')
      .order('starts_at', { ascending: true })
      .limit(300);
    if (evErr) throw new Error('events lezen: ' + evErr.message);
    if (!events || events.length === 0) {
      summary.duration_ms = Date.now() - startedAt;
      console.log('[cron-opvolging-aanmeldingen] geen events in het venster');
      return res.status(200).json({ ok: true, summary });
    }
    summary.events_bekeken = events.length;
    const perEvent = new Map(events.map((e) => [e.id, e]));

    // ── De deelnemers ────────────────────────────────────────────────────────
    // Ook de niet-actieve statussen ophalen: die zijn nodig om een lopende
    // kaart te kunnen sluiten. is_test blijft eruit, net als overal.
    const { data: att, error: attErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id, event_id, first_name, last_name, email, phone, status, registered_at, switched_from_event_id, customer_id')
      .in('event_id', [...perEvent.keys()])
      .eq('is_test', false)
      .limit(3000);
    if (attErr) throw new Error('deelnemers lezen: ' + attErr.message);
    const deelnemers = att || [];
    summary.deelnemers = deelnemers.length;
    if (deelnemers.length === 0) {
      summary.duration_ms = Date.now() - startedAt;
      return res.status(200).json({ ok: true, summary });
    }

    // ── Bestaande kaarten, in één keer ───────────────────────────────────────
    const { data: taken, error: tErr } = await supabaseAdmin
      .from('opvolging_taken')
      .select('id, status, due, bron_ref, notitie')
      .eq('bron', 'event')
      .limit(5000);
    if (tErr) throw new Error('taken lezen: ' + tErr.message);
    const taakPerAttendee = new Map();
    for (const t of (taken || [])) {
      const aid = t.bron_ref && t.bron_ref.attendee_id;
      if (aid && !taakPerAttendee.has(aid)) taakPerAttendee.set(aid, t);
    }

    // Titels van bron-events, voor de badge bij een verplaatsing.
    const bronIds = [...new Set(deelnemers.map((d) => d.switched_from_event_id).filter(Boolean))];
    const bronTitel = new Map();
    if (bronIds.length) {
      const { data: bron } = await supabaseAdmin
        .from('events').select('id, title, starts_at').in('id', bronIds).limit(300);
      for (const b of (bron || [])) bronTitel.set(b.id, b);
    }

    for (const d of deelnemers) {
      if (Date.now() - startedAt > ABORT_MS) {
        summary.errors.push({ phase: 'time_budget', message: 'afgebroken voor het einde' });
        break;
      }
      try {
        const event = perEvent.get(d.event_id);
        const taak = taakPerAttendee.get(d.id) || null;
        const besluit = bepaalTaakActie({ attendee: d, event, taak, nu: Date.now() });

        if (besluit.actie === 'niets') continue;

        if (besluit.actie === 'aanmaken') {
          const naam = [d.first_name, d.last_name].filter(Boolean).map((s) => String(s).trim()).filter(Boolean).join(' ')
            || d.email || '(onbekend)';
          const bron = d.switched_from_event_id ? bronTitel.get(d.switched_from_event_id) : null;
          const { error } = await supabaseAdmin.from('opvolging_taken').insert({
            naam,
            email      : d.email || null,
            telefoon   : d.phone || null,
            reden      : 'aanmelding',
            bron       : 'event',
            bron_ref   : {
              event_id     : event.id,
              attendee_id  : d.id,
              soort        : 'aanmelding',
              event_dag    : besluit.event_dag,
              event_titel  : event.title || null,
              event_plaats : event.location || null,
              event_start  : event.starts_at || null,
              ...(d.switched_from_event_id
                ? { verplaatst_van_event_id: d.switched_from_event_id,
                    verplaatst_van_titel   : bron ? bron.title : null }
                : {}),
            },
            badge_label: besluit.badge_label,
            due        : besluit.due,
            later      : false,
            status     : 'open',
            eigenaar_id: null,
          });
          if (error) throw new Error('aanmaken: ' + error.message);
          summary.aangemaakt += 1;
          continue;
        }

        if (besluit.actie === 'wakker_maken') {
          const { error } = await supabaseAdmin.from('opvolging_taken')
            .update({ due: besluit.due, later: false, updated_at: new Date().toISOString() })
            .eq('id', besluit.taak_id).eq('status', 'open');
          if (error) throw new Error('wakker maken: ' + error.message);
          summary.wakker_gemaakt += 1;
          continue;
        }

        // ── De kaart sluit zichzelf ──────────────────────────────────────────
        const verplaatst = besluit.actie === 'sluiten_verplaatst';
        const regel = verplaatst
          ? `${vandaag} · In de eventmodule verplaatst naar een ander event. Deze kaart is daarmee klaar; voor het nieuwe event komt er vanzelf een nieuwe.`
          : `${vandaag} · In de eventmodule op geannuleerd gezet. Deze kaart is daarmee klaar.`;
        const { error } = await supabaseAdmin.from('opvolging_taken').update({
          status         : 'gearchiveerd',
          archief_reden  : verplaatst ? 'verplaatst naar ander event' : 'geannuleerd in de eventmodule',
          gearchiveerd_at: new Date().toISOString(),
          notitie        : notitieMetRegel(taak && taak.notitie, regel),
          updated_at     : new Date().toISOString(),
        }).eq('id', besluit.taak_id).neq('status', 'gearchiveerd');
        if (error) throw new Error('sluiten: ' + error.message);
        if (verplaatst) summary.gesloten_verplaatst += 1; else summary.gesloten_geannuleerd += 1;
      } catch (e) {
        summary.errors.push({ attendee_id: d.id, error: e?.message || String(e) });
        console.error('[cron-opvolging-aanmeldingen] deelnemer faalde', d.id, e?.message || e);
      }
    }
  } catch (e) {
    console.error('[cron-opvolging-aanmeldingen] fataal:', e?.message || e);
    summary.errors.push({ phase: 'fataal', error: e?.message || String(e) });
    summary.duration_ms = Date.now() - startedAt;
    return res.status(500).json({ ok: false, summary });
  }

  summary.duration_ms = Date.now() - startedAt;
  summary.wakker_dagen_voor_event = WAKKER_DAGEN_VOOR_EVENT;
  console.log('[cron-opvolging-aanmeldingen] klaar', JSON.stringify(summary));
  return res.status(200).json({ ok: true, summary });
}

/** Nieuwe regel bovenaan, bestaande notitie eronder. Nooit overschrijven. */
function notitieMetRegel(bestaand, regel) {
  const oud = String(bestaand || '').trim();
  return oud ? `${regel}\n\n${oud}` : regel;
}
