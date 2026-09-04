// api/cron-opvolging-doorrol.js
//
// Fase 3a — de dag afsluiten. Draait dagelijks om 23:59 (zie vercel.json).
//
// Elke taak die open staat met een `due` van vóór morgen krijgt morgen als
// nieuwe dag, en `later` gaat terug naar false.
//
// Die reset is niet cosmetisch. Wie vandaag op "later vandaag" drukt zakt naar
// de tweede ronde; zonder deze cron blijft hij daar staan, ook morgen en
// overmorgen. Dan begint hij elke dag onderaan in plaats van bovenaan, en dat
// leest als afgehandeld terwijl er nooit meer iemand naar kijkt.
//
// De beslissing zelf staat in api/_lib/opvolging-doorrol.js, als pure functie
// met tests. Hier alleen het lezen, schrijven en tellen.
//
// Auth: Authorization: Bearer $CRON_SECRET (checkCronAuth, zelfde patroon als
// cron-arrangements-breach-check). Methodes: GET (Vercel cron) + POST (debug).
//
// Schrijft uitsluitend in opvolging_taken.

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import { bepaalDoorrol } from './_lib/opvolging-doorrol.js';

const ABORT_MS  = 25_000;
const PAGINA    = 500;
const ZONE      = 'Europe/Amsterdam';

// De dag zoals Dave hem ziet, niet zoals UTC hem telt. Om 23:59 Amsterdamse
// tijd is het in UTC al de volgende dag in de winter — dan zou 'morgen'
// overmorgen worden en verdwijnt de hele lijst een dag.
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
  const morgen = dagInZone(startedAt + 24 * 3600 * 1000);
  console.log('[cron-opvolging-doorrol] start morgen=' + morgen);

  const summary = {
    morgen,
    bekeken       : 0,
    doorgerold    : 0,
    later_gereset : 0,
    errors        : [],
    duration_ms   : 0,
  };

  try {
    // Pagineren: de takenpot groeit, en één grote select die stil op de
    // PostgREST-limiet stuit zou een deel van de leads laten liggen zonder
    // dat iemand het merkt.
    let offset = 0;
    for (;;) {
      if (Date.now() - startedAt > ABORT_MS) {
        summary.errors.push({ phase: 'time_budget', message: 'afgebroken voor het einde' });
        break;
      }
      const { data: taken, error } = await supabaseAdmin
        .from('opvolging_taken')
        .select('id, status, due, later')
        .eq('status', 'open')
        .lt('due', morgen)
        .order('due', { ascending: true })
        .range(offset, offset + PAGINA - 1);
      if (error) throw new Error('lezen: ' + error.message);
      if (!taken || taken.length === 0) break;

      summary.bekeken += taken.length;
      for (const { id, patch } of bepaalDoorrol({ taken, morgen })) {
        try {
          const vorige = taken.find((t) => t.id === id);
          const { error: upErr } = await supabaseAdmin
            .from('opvolging_taken')
            .update({ ...patch, updated_at: new Date().toISOString() })
            .eq('id', id)
            .eq('status', 'open');   // niets doen als hij intussen dicht is
          if (upErr) throw new Error(upErr.message);
          summary.doorgerold += 1;
          if (vorige && vorige.later) summary.later_gereset += 1;
        } catch (e) {
          // Per taak vangen: één rij die weigert mag de rest van de lijst niet
          // laten liggen. Met de id erbij, anders is het achteraf niet te vinden.
          summary.errors.push({ taak_id: id, error: e?.message || String(e) });
          console.error('[cron-opvolging-doorrol] update faalde', id, e?.message || e);
        }
      }

      if (taken.length < PAGINA) break;
      offset += PAGINA;
    }
  } catch (e) {
    console.error('[cron-opvolging-doorrol] fataal:', e?.message || e);
    summary.errors.push({ phase: 'fataal', error: e?.message || String(e) });
    summary.duration_ms = Date.now() - startedAt;
    return res.status(500).json({ ok: false, summary });
  }

  summary.duration_ms = Date.now() - startedAt;
  console.log('[cron-opvolging-doorrol] klaar', JSON.stringify(summary));
  return res.status(200).json({ ok: true, summary });
}
