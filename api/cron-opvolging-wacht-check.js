// api/cron-opvolging-wacht-check.js
//
// Fase 3a — de 48-uurcontrole. Draait elk uur (zie vercel.json).
//
// Een lead die de agenda doorgestuurd kreeg staat op 'wacht_inplanning' en is
// daarmee even uit Daves lijst. Twee dingen kunnen er gebeuren:
//
//   · Hij boekt zelf een moment  → status 'ingepland', met de gevonden
//     afspraak erbij zodat je kunt zien wélke.
//   · Hij doet 48 uur niets      → terug in de lijst, vandaag, met reden
//     'niet_ingepland' en een notitie die vertelt waarom hij er weer staat.
//
// Dat laatste is de hele reden dat deze cron bestaat. Zonder hem verdwijnt een
// lead die de agenda kreeg en er niets mee deed voorgoed uit beeld: hij staat
// op geen enkele lijst meer, en niemand die het merkt.
//
// De beslissing zelf staat in api/_lib/opvolging-doorrol.js, als pure functie
// met tests. Hier alleen het lezen, schrijven en tellen.
//
// Auth: Authorization: Bearer $CRON_SECRET. Methodes: GET (cron) + POST (debug).
//
// Schrijft uitsluitend in opvolging_taken en opvolging_pogingen. De
// afspraakrecords zelf worden alleen gelezen.

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import { beslisWachtInplanning, beslisWachtVerplaatsing, WACHT_UREN } from './_lib/opvolging-doorrol.js';

const ABORT_MS = 25_000;
const ZONE     = 'Europe/Amsterdam';
// Zoekvenster voor kandidaat-afspraken. Ruim genomen rond de 48 uur: een lead
// mag best een moment over twee weken kiezen, en de created_at-check hieronder
// bepaalt uiteindelijk of het er één van ná het doorsturen is.
const AGENDA_VOORUIT_DAGEN = 120;

function dagInZone(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

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
  console.log('[cron-opvolging-wacht-check] start vandaag=' + vandaag);

  const summary = {
    bekeken     : 0,
    ingepland   : 0,
    teruggezet  : 0,
    wacht_nog   : 0,
    verplaatst_bevestigd: 0,
    verplaatst_terug    : 0,
    errors      : [],
    duration_ms : 0,
  };

  try {
    const { data: taken, error: leesErr } = await supabaseAdmin
      .from('opvolging_taken')
      .select('id, naam, email, telefoon, status, agenda_doorgestuurd_at, badge_label, notitie')
      .eq('status', 'wacht_inplanning')
      .order('agenda_doorgestuurd_at', { ascending: true })
      .limit(500);
    if (leesErr) throw new Error('taken lezen: ' + leesErr.message);
    if (!taken || taken.length === 0) {
      summary.duration_ms = Date.now() - startedAt;
      console.log('[cron-opvolging-wacht-check] niets te doen');
      return res.status(200).json({ ok: true, summary });
    }

    // Eén keer de agenda ophalen voor alle taken samen. Per taak een query zou
    // bij een volle wachtrij tientallen rondjes kosten binnen een budget van
    // 30 seconden.
    const vroegste = taken.reduce((min, t) => {
      const ms = t.agenda_doorgestuurd_at ? new Date(t.agenda_doorgestuurd_at).getTime() : NaN;
      return Number.isFinite(ms) && ms < min ? ms : min;
    }, Date.now());
    const { data: afspraken, error: apErr } = await supabaseAdmin
      .from('follow_up_appointments')
      .select('id, lead_name, lead_email, lead_phone, scheduled_at, created_at, status, zoom_join_url, ghl_appointment_id')
      .gte('created_at', new Date(vroegste - 3600 * 1000).toISOString())
      .lte('scheduled_at', new Date(Date.now() + AGENDA_VOORUIT_DAGEN * 86400000).toISOString())
      .in('status', ['scheduled', 'in_progress'])
      .order('created_at', { ascending: true })
      .limit(1000);
    if (apErr) throw new Error('afspraken lezen: ' + apErr.message);

    for (const taak of taken) {
      if (Date.now() - startedAt > ABORT_MS) {
        summary.errors.push({ phase: 'time_budget', message: 'afgebroken voor het einde' });
        break;
      }
      summary.bekeken += 1;
      try {
        const besluit = beslisWachtInplanning({ taak, afspraken: afspraken || [], nu: Date.now() });

        if (besluit.actie === 'wacht') { summary.wacht_nog += 1; continue; }

        if (besluit.actie === 'ingepland') {
          const a = besluit.afspraak;
          const nu = new Date().toISOString();
          const { error } = await supabaseAdmin.from('opvolging_taken').update({
            status              : 'ingepland',
            afspraak_gevonden_at: nu,
            afspraak_ref        : {
              bron              : 'wacht-check',
              appointment_id    : a.id,
              ghl_appointment_id: a.ghl_appointment_id || null,
              zoom_join_url     : a.zoom_join_url || null,
              scheduled_at      : a.scheduled_at || null,
            },
            updated_at          : nu,
          }).eq('id', taak.id).eq('status', 'wacht_inplanning');
          if (error) throw new Error('ingepland: ' + error.message);
          summary.ingepland += 1;

          // De historiek moet laten zien dat dit vanzelf gevonden is en niet
          // door iemand aangeklikt — vandaar automatisch: true.
          await schrijfPoging(taak.id, 'ingepland', 'zelf ingepland via de agenda');
          continue;
        }

        // 'terug' — 48 uur voorbij en niets geboekt.
        const nu = new Date().toISOString();
        const notitie = notitieMetRegel(
          taak.notitie,
          `${dagInZone(Date.now())} · Agenda ${WACHT_UREN} uur geleden doorgestuurd, maar er is zelf niets ingepland. Terug in de lijst.`,
        );
        const { error } = await supabaseAdmin.from('opvolging_taken').update({
          status      : 'open',
          due         : vandaag,
          later       : false,
          reden       : 'niet_ingepland',
          badge_label : 'Agenda doorgestuurd',
          notitie,
          updated_at  : nu,
        }).eq('id', taak.id).eq('status', 'wacht_inplanning');
        if (error) throw new Error('terugzetten: ' + error.message);
        summary.teruggezet += 1;
      } catch (e) {
        summary.errors.push({ taak_id: taak.id, error: e?.message || String(e) });
        console.error('[cron-opvolging-wacht-check] taak faalde', taak.id, e?.message || e);
      }
    }

    // ── Tweede tak: wacht op verplaatsing ────────────────────────────────────
    // Dave gaf aan dat hij iemand naar een ander event verplaatst. Dat is een
    // belofte; hier zoeken we het bewijs. Zelfde vorm als hierboven, ander
    // bewijs — en juist daarom een eigen status: met één status zou een
    // gevonden afspraak een openstaande verplaatsing kunnen afsluiten.
    await verwerkVerplaatsingen(summary, startedAt, vandaag);
  } catch (e) {
    console.error('[cron-opvolging-wacht-check] fataal:', e?.message || e);
    summary.errors.push({ phase: 'fataal', error: e?.message || String(e) });
    summary.duration_ms = Date.now() - startedAt;
    return res.status(500).json({ ok: false, summary });
  }

  summary.duration_ms = Date.now() - startedAt;
  console.log('[cron-opvolging-wacht-check] klaar', JSON.stringify(summary));
  return res.status(200).json({ ok: true, summary });
}

/** Fail-soft: de poging is de historiek, niet de actie zelf. */
async function schrijfPoging(taakId, soort, resultaat) {
  try {
    const { error } = await supabaseAdmin.from('opvolging_pogingen')
      .insert({ taak_id: taakId, soort, resultaat, automatisch: true });
    if (error) throw new Error(error.message);
  } catch (e) {
    console.warn('[cron-opvolging-wacht-check] poging (soft):', e?.message || e);
  }
}

/** Nieuwe regel bovenaan, bestaande notitie eronder. Nooit overschrijven. */
function notitieMetRegel(bestaand, regel) {
  const oud = String(bestaand || '').trim();
  return oud ? `${regel}\n\n${oud}` : regel;
}

/**
 * De taken die op 'wacht_verplaatsing' staan. Gevonden op een ander event →
 * kaart dicht; na 48 uur zonder bewijs → terug in de lijst, zodat een belofte
 * die nooit is doorgevoerd niet stil blijft liggen.
 */
async function verwerkVerplaatsingen(summary, startedAt, vandaag) {
  const { data: taken, error } = await supabaseAdmin
    .from('opvolging_taken')
    .select('id, naam, email, telefoon, status, bron_ref, notitie')
    .eq('status', 'wacht_verplaatsing')
    .limit(300);
  if (error) throw new Error('verplaatsingen lezen: ' + error.message);
  if (!taken || taken.length === 0) return;

  // Alle kandidaat-aanmeldingen in één keer: één query in plaats van één per
  // taak, want het tijdbudget van deze functie is dertig seconden.
  const { data: aanmeldingen, error: aErr } = await supabaseAdmin
    .from('event_attendees')
    .select('id, event_id, first_name, last_name, email, phone, status, registered_at')
    .eq('status', 'aangemeld')
    .eq('is_test', false)
    .limit(3000);
  if (aErr) throw new Error('aanmeldingen lezen: ' + aErr.message);

  for (const taak of taken) {
    if (Date.now() - startedAt > ABORT_MS) {
      summary.errors.push({ phase: 'time_budget', message: 'verplaatsingen afgebroken' });
      break;
    }
    try {
      const besluit = beslisWachtVerplaatsing({ taak, aanmeldingen: aanmeldingen || [], nu: Date.now() });
      if (besluit.actie === 'wacht') { summary.wacht_nog += 1; continue; }

      const nu = new Date().toISOString();
      if (besluit.actie === 'verplaatst') {
        const { error: uErr } = await supabaseAdmin.from('opvolging_taken').update({
          status         : 'gearchiveerd',
          archief_reden  : 'verplaatst naar ander event',
          gearchiveerd_at: nu,
          notitie        : notitieMetRegel(taak.notitie,
            `${vandaag} · Verplaatsing bevestigd: staat als aanmelding op een ander event.`),
          updated_at     : nu,
        }).eq('id', taak.id).eq('status', 'wacht_verplaatsing');
        if (uErr) throw new Error('bevestigen: ' + uErr.message);
        summary.verplaatst_bevestigd += 1;
        continue;
      }

      // 'terug' — 48 uur voorbij en nergens een nieuwe aanmelding gevonden.
      const { error: tErr } = await supabaseAdmin.from('opvolging_taken').update({
        status    : 'open',
        due       : vandaag,
        later     : false,
        notitie   : notitieMetRegel(taak.notitie,
          `${vandaag} · Als verplaatst aangeduid, maar na ${WACHT_UREN} uur staat deze persoon nergens als aanmelding op een ander event. Terug in de lijst.`),
        updated_at: nu,
      }).eq('id', taak.id).eq('status', 'wacht_verplaatsing');
      if (tErr) throw new Error('terugzetten: ' + tErr.message);
      summary.verplaatst_terug += 1;
    } catch (e) {
      summary.errors.push({ taak_id: taak.id, error: e?.message || String(e) });
      console.error('[cron-opvolging-wacht-check] verplaatsing faalde', taak.id, e?.message || e);
    }
  }
}
