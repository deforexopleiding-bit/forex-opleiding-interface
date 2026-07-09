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

import { getOpenEventsWithSpace } from './_lib/event-registration.js';
import { safeError } from './_lib/safe-error.js';

// Blok C — Aanpak A: niveau-query-param wordt geaccepteerd voor
// backward-compat (oude assessment-links) maar verder niet meer als filter
// gebruikt. Alle open Masterclass-events worden getoond.

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // Backward-compat: niveau accepteren maar niet meer valideren/filteren.
  const niveauEcho = req.query?.niveau ? String(req.query.niveau).toLowerCase() : null;

  try {
    // Blok C: niveau=null → alle events (post-migratie 029 alleen 'masterclass').
    const events = await getOpenEventsWithSpace({ niveau: null, limit: 50 });
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
    return res.status(200).json({ niveau: niveauEcho, events: out });
  } catch (e) {
    return safeError(res, 500, e);
  }
}
