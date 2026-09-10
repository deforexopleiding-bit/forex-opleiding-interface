// api/cron-opvolging-doorrol.js
//
// Fase 3a — de achterstand naar vandaag halen. Draait dagelijks (zie
// vercel.json), en het maakt niet meer uit hoe laat.
//
// Elke taak die open staat met een `due` VOOR de huidige Amsterdamse datum
// krijgt die datum, en `later` gaat terug naar false.
//
// ── WAAROM 'VANDAAG' EN NIET 'MORGEN' ────────────────────────────────────
// Dit stond eerder op morgen, en dat kostte elke nacht een dag. De cron staat
// in vercel.json op `59 23 * * *`, Vercel draait crons in UTC, en 23:59 UTC is
// 01:59 in Amsterdam — het is dan al de volgende dag. 'Morgen' werd daarmee
// overmorgen, en elke openstaande kaart sloeg precies een dag over. Gemeten op
// 8 september: de vijf leads van de dag ervoor stonden op de 9e, dus op de 8e
// nergens, met updated_at 07-09T23:59 als bewijs dat de cron ze wel degelijk
// had aangeraakt.
//
// De schema-tijd verzetten repareert dat niet duurzaam: Nederland schuift twee
// keer per jaar, dus wat in de zomer klopt is in de winter weer mis. Redeneren
// in vandaag haalt de klok uit de vergelijking — en het belangrijkste: slaat er
// een nacht over, dan haalt de volgende run alles alsnog naar voren in plaats
// van kaarten voorgoed in het verleden te laten hangen.
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
import { bepaalDoorrol, doorrolDag } from './_lib/opvolging-doorrol.js';

const ABORT_MS  = 25_000;
const PAGINA    = 500;

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
  // GEEN ETMAAL ERBIJ. Dat was de fout: op het moment dat deze cron draait is
  // het in Amsterdam al de nieuwe dag, en dan wijst 'morgen' een dag te ver.
  // De som staat in de lib, met een test eronder.
  const vandaag = doorrolDag(startedAt);
  console.log('[cron-opvolging-doorrol] start vandaag=' + vandaag);

  const summary = {
    vandaag,
    bekeken       : 0,
    doorgerold    : 0,
    later_gereset : 0,
    gearchiveerd  : 0,
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
        // reden_code + bron_ref: de nabelkaarten van cron-opvolging-zoom-nabel
        // rollen niet door maar worden gearchiveerd zodra hun call voorbij is.
        // Zie isVoorbijeNabelkaart in de lib.
        .select('id, status, due, later, reden_code, bron_ref')
        .eq('status', 'open')
        .lt('due', vandaag)
        .order('due', { ascending: true })
        .range(offset, offset + PAGINA - 1);
      if (error) throw new Error('lezen: ' + error.message);
      if (!taken || taken.length === 0) break;

      summary.bekeken += taken.length;
      for (const { id, patch } of bepaalDoorrol({ taken, vandaag })) {
        try {
          const vorige = taken.find((t) => t.id === id);
          const { error: upErr } = await supabaseAdmin
            .from('opvolging_taken')
            .update({ ...patch, updated_at: new Date().toISOString() })
            .eq('id', id)
            .eq('status', 'open');   // niets doen als hij intussen dicht is
          if (upErr) throw new Error(upErr.message);
          if (patch.status === 'gearchiveerd') {
            summary.gearchiveerd += 1;
          } else {
            summary.doorgerold += 1;
            if (vorige && vorige.later) summary.later_gereset += 1;
          }
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
