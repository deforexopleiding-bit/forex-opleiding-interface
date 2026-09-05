// api/opvolging-aanmelding-actie.js
//
// De drie uitgangen van een aanmeldkaart, plus de knop die de deelnemer meteen
// in de eventmodule op geannuleerd zet.
//
// POST { taak_id, actie, notitie? }
//   'gesprek_gehad'       — notitie verplicht. Er is echt contact geweest, dus
//                           de kaart is klaar.
//   'geen_interesse'      — archiveren. Antwoord bevat vraag_annuleren=true.
//   'verplaatst'          — naar 'wacht_verplaatsing'; de 48-uurcontrole zoekt
//                           daarna het bewijs op. Ook hier vraag_annuleren.
//   'annuleer_in_event'   — zet event_attendees.status op 'geannuleerd'.
//
// Waarom dat laatste hier zit en niet in de eventmodule: Dave moet er niet
// voor naar een ander scherm. Het bevestigingsvenster in de opvolgmodule zegt
// dat het nodig is én doet het meteen. Het venster blijft de melding tonen,
// want een popup wordt weggeklikt en dan is de knop niet ingedrukt — daarom
// staat de 48-uurcontrole er als vangnet naast.
//
// Schrijft in opvolging_taken en opvolging_pogingen, en bij die ene actie in
// event_attendees.status. Geen bestaand endpoint gewijzigd.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const ACTIES = new Set(['gesprek_gehad', 'geen_interesse', 'verplaatst', 'annuleer_in_event']);
const ZONE = 'Europe/Amsterdam';
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
  if (!b.taak_id) return res.status(400).json({ error: 'taak_id ontbreekt' });
  const actie = String(b.actie || '');
  if (!ACTIES.has(actie)) return res.status(400).json({ error: 'onbekende actie' });

  const notitie = b.notitie != null ? String(b.notitie).trim().slice(0, 2000) : '';
  // Zonder die zin is 'gesprek gehad' een vinkje zonder inhoud, en dan weet de
  // volgende die deze lead oppakt nog steeds niets.
  if (actie === 'gesprek_gehad' && !notitie) {
    return res.status(400).json({ error: 'notitie is verplicht bij een gesprek' });
  }

  try {
    const { data: taak, error: leesErr } = await supabaseAdmin
      .from('opvolging_taken').select('*').eq('id', b.taak_id).maybeSingle();
    if (leesErr) throw new Error(leesErr.message);
    if (!taak) return res.status(404).json({ error: 'Taak niet gevonden' });

    const nu = new Date().toISOString();
    const vandaag = dagInZone(Date.now());
    const attendeeId = taak.bron_ref && taak.bron_ref.attendee_id;

    // ── De knop: zet de deelnemer in de eventmodule op geannuleerd ───────────
    if (actie === 'annuleer_in_event') {
      if (!attendeeId) return res.status(400).json({ error: 'Deze taak hangt niet aan een deelnemer.' });
      const { error } = await supabaseAdmin
        .from('event_attendees')
        .update({ status: 'geannuleerd' })
        .eq('id', attendeeId)
        .in('status', ['aangemeld', 'wachtlijst']);
      if (error) throw new Error('annuleren: ' + error.message);
      await schrijfNotitie(taak, `${vandaag} · In de eventmodule op geannuleerd gezet vanuit de opvolgmodule.`);
      return res.status(200).json({ success: true, geannuleerd: true });
    }

    // ── Gesprek gehad ────────────────────────────────────────────────────────
    if (actie === 'gesprek_gehad') {
      // De poging eerst: die is het bewijs dat er contact was, en daar hangt
      // 'klaar voor vandaag' aan. Resultaat begint met 'gesproken' zodat
      // isEchtContact() 'm herkent.
      await schrijfPoging(taak.id, 'call', `gesproken: ${notitie}`.slice(0, 200));
      const { error } = await supabaseAdmin.from('opvolging_taken').update({
        status         : 'gearchiveerd',
        archief_reden  : 'gesprek gehad',
        gearchiveerd_at: nu,
        notitie        : voegRegelToe(taak.notitie, `${vandaag} · ${notitie}`),
        updated_at     : nu,
      }).eq('id', taak.id);
      if (error) throw new Error(error.message);
      return res.status(200).json({ success: true });
    }

    // ── Archiveren: geen interesse ───────────────────────────────────────────
    if (actie === 'geen_interesse') {
      const { error } = await supabaseAdmin.from('opvolging_taken').update({
        status         : 'gearchiveerd',
        archief_reden  : 'geen interesse of per ongeluk aangemeld',
        gearchiveerd_at: nu,
        notitie        : notitie ? voegRegelToe(taak.notitie, `${vandaag} · ${notitie}`) : taak.notitie,
        updated_at     : nu,
      }).eq('id', taak.id);
      if (error) throw new Error(error.message);
      // De UI toont hierop het bevestigingsvenster met de annuleerknop.
      return res.status(200).json({ success: true, vraag_annuleren: !!attendeeId });
    }

    // ── Archiveren: verplaatst naar een ander event ──────────────────────────
    // Niet meteen dicht: eerst wachten op bewijs. Staat deze persoon binnen 48
    // uur nergens als aanmelding op een ander event, dan komt de kaart terug.
    // Het moment van melden staat in bron_ref, niet in agenda_doorgestuurd_at —
    // die kolom betekent iets anders en zou de 48-uurcontrole in de war sturen.
    const { error } = await supabaseAdmin.from('opvolging_taken').update({
      status    : 'wacht_verplaatsing',
      bron_ref  : { ...(taak.bron_ref || {}), verplaatst_gemeld_at: nu },
      notitie   : voegRegelToe(taak.notitie,
        `${vandaag} · Aangeduid als verplaatst naar een ander event.` +
        (notitie ? ` ${notitie}` : '')),
      updated_at: nu,
    }).eq('id', taak.id);
    if (error) throw new Error(error.message);
    return res.status(200).json({ success: true, vraag_annuleren: !!attendeeId });
  } catch (e) {
    console.error('[opvolging-aanmelding-actie]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Onbekende fout' });
  }
}

/** Fail-soft: de poging is de historiek, niet de actie zelf. */
async function schrijfPoging(taakId, soort, resultaat) {
  try {
    const { error } = await supabaseAdmin.from('opvolging_pogingen')
      .insert({ taak_id: taakId, soort, resultaat, automatisch: false });
    if (error) throw new Error(error.message);
  } catch (e) {
    console.warn('[opvolging-aanmelding-actie] poging (soft):', e?.message || e);
  }
}

async function schrijfNotitie(taak, regel) {
  try {
    await supabaseAdmin.from('opvolging_taken')
      .update({ notitie: voegRegelToe(taak.notitie, regel), updated_at: new Date().toISOString() })
      .eq('id', taak.id);
  } catch (e) {
    console.warn('[opvolging-aanmelding-actie] notitie (soft):', e?.message || e);
  }
}

/** Nieuwe regel bovenaan, bestaande notitie eronder. Nooit overschrijven. */
function voegRegelToe(bestaand, regel) {
  const oud = String(bestaand || '').trim();
  return oud ? `${regel}\n\n${oud}` : regel;
}
