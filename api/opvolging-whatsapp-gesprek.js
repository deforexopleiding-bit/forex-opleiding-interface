// api/opvolging-whatsapp-gesprek.js
//
// GET ?taak_id=… of ?nummer=… → de laatste 50 berichten, oplopend op tijdstip.
//
// Leest uitsluitend uit opvolging_wa_berichten. Dat is het GESPREK;
// opvolging_pogingen blijft de telling en wordt hier niet aangeraakt.
//
// Waarom oplopend en niet aflopend: het paneel toont een chat, en die leest van
// boven naar beneden. De grens van 50 pakt daarom de vijftig NIEUWSTE en draait
// die daarna om — 'de eerste vijftig oplopend' zou bij een lang gesprek het
// begin tonen en het heden verzwijgen.
//
// Op `nummer` zoeken kan ook zonder taak: een call uit de agenda hoeft nog geen
// opvolgtaak te hebben, en juist bij een eerste gesprek is dat het normale
// geval. Vandaar dat het nummer de sleutel is en taak_id de kortere weg.
//
// Permission: opvolging.module.access — zelfde poort als de rest van de module.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { normaliseerNummer } from './_lib/whatsapp-brug-nummers.js';

const MAX = 50;

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

  const q = req.query || {};
  const taakId = q.taak_id ? String(q.taak_id) : null;
  let nummer = q.nummer ? normaliseerNummer(q.nummer) : null;

  if (!taakId && !nummer) {
    return res.status(400).json({ error: 'taak_id of nummer vereist' });
  }

  try {
    // Met een taak_id halen we het nummer daar vandaan: één gesprek per nummer,
    // ook als er ooit twee taken voor dezelfde persoon hebben bestaan. Anders
    // zou het gesprek uiteenvallen zodra een lead een tweede keer in de lijst
    // komt, en dat is precies wanneer de historiek het nuttigst is.
    let taak = null;
    if (taakId) {
      const { data, error } = await supabaseAdmin
        .from('opvolging_taken').select('id, naam, telefoon').eq('id', taakId).maybeSingle();
      if (error) throw new Error('taak lezen: ' + error.message);
      if (!data) return res.status(404).json({ error: 'Taak niet gevonden' });
      taak = data;
      if (!nummer) nummer = normaliseerNummer(data.telefoon);
    }

    if (!nummer) {
      // Een taak zonder telefoonnummer. Geen fout — er valt gewoon niets te
      // tonen, en dat is iets anders dan een gesprek dat leeg is.
      return res.status(200).json({
        nummer: null, taak_id: taakId, berichten: [],
        reden: 'GEEN_NUMMER',
        melding: 'Bij deze lead staat geen telefoonnummer, dus er is geen gesprek om te tonen.',
      });
    }

    const { data, error } = await supabaseAdmin
      .from('opvolging_wa_berichten')
      .select('id, nummer, taak_id, richting, tekst, media_type, bericht_id, tijdstip')
      .eq('nummer', nummer)
      .order('tijdstip', { ascending: false })
      .limit(MAX);
    if (error) {
      // De tabel bestaat nog niet: de migratie moet nog draaien. Dat is een
      // configuratiefout en geen lege chat — het paneel hoort het verschil te
      // kunnen tonen, dus zeggen we het met zoveel woorden.
      if (error.code === '42P01') {
        return res.status(503).json({
          error: 'De berichtentabel bestaat nog niet. Draai docs/sql-migrations/2026-09-05-opvolging-wa-berichten.sql.',
          code : 'TABEL_ONTBREEKT',
        });
      }
      throw new Error('berichten lezen: ' + error.message);
    }

    // De nieuwste vijftig, daarna omgedraaid zodat het van boven naar beneden
    // leest zoals een chat hoort te doen.
    const berichten = (data || []).slice().reverse();

    return res.status(200).json({
      nummer,
      taak_id  : taakId,
      naam     : taak ? taak.naam : null,
      berichten,
      // Geen historiek van vóór het gesprekspaneel: de tekst van uitgaande
      // berichten verliet de telefoon toen niet, en van inkomende staat alleen
      // een afgekapte kopie in opvolging_pogingen.resultaat. Het paneel zegt
      // dat liever hardop dan een leeg gesprek te tonen alsof er niets gezegd is.
      leeg_is_geen_stilte: berichten.length === 0,
    });
  } catch (e) {
    console.error('[opvolging-whatsapp-gesprek]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}
