// api/assessment-open-events.js
// PUBLIEKE GET-endpoint: returnt upcoming open events voor een gegeven
// niveau. Wordt door modules/assessment.html aangeroepen na het routing-
// resultaat om de date-picker te vullen.
//
// Filter:
//   - status = 'published'
//   - signups_closed = false
//   - starts_at > now()
//   - niveau = ?niveau=basis|gevorderd  (verplicht)
//
// Hergebruikt de Blok 1 / F2 open-event-query: zelfde filter als
// computeUpcomingLabels in event-sync-orchestrator.js zodat de Webflow/GHL-
// kant en dit publieke endpoint nooit uit sync lopen.
//
// Per event: id, title, starts_at, capacity, confirmed_count, has_space.
//
// Response 200: { niveau, events: [...] }
// Response 400: niveau ontbreekt of ongeldig
// Response 405: GET only
// Response 500: database-fout

import {
  NIVEAU_FROM_ROUTING,
  getOpenEventsWithSpace,
} from './_lib/event-registration.js';

const ALLOWED_NIVEAUS = Object.values(NIVEAU_FROM_ROUTING); // ['gevorderd','basis']

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const niveau = req.query?.niveau ? String(req.query.niveau).toLowerCase() : null;
  if (!niveau || !ALLOWED_NIVEAUS.includes(niveau)) {
    return res.status(400).json({
      error: `niveau vereist (${ALLOWED_NIVEAUS.join('|')})`,
    });
  }

  try {
    // Fase 2a: delegeer naar getOpenEventsWithSpace helper (single source of
    // truth voor "open events met has_space"). Output-shape voor de publieke
    // assessment-flow is byte-identiek aan vóór de refactor — we strippen
    // het 'niveau'-veld uit de helper-output omdat de oorspronkelijke
    // response-shape het niet bevatte (caller weet al voor welk niveau).
    const events = await getOpenEventsWithSpace({ niveau, limit: 50 });
    const out = events.map((e) => ({
      id              : e.id,
      title           : e.title,
      starts_at       : e.starts_at,
      ends_at         : e.ends_at,
      capacity        : e.capacity,
      confirmed_count : e.confirmed_count,
      has_space       : e.has_space,
      location        : e.location,
      image_url       : e.image_url,
      spots_left      : e.spots_left,
    }));
    return res.status(200).json({ niveau, events: out });
  } catch (e) {
    console.error('[assessment-open-events]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
