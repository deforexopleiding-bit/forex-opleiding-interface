// api/events-afgewezen.js
// GET → de afgewezen event-aanmelders van een periode, met de reden per persoon.
// Voor Events › Inschrijvingen › Afgewezen en de klik op "X afgewezen" in de
// dashboardtegel Event-aanmeldingen.
//
// Alleen lezen. Sessie-JWT + RBAC events.attendee.view (wie deelnemers mag zien).
//
// Wie erin staat = exact wie de tegel telt (afgewezenEventMails in
// _lib/aanmeldingen-per-funnel.js); rekenkern in _lib/event-afgewezen.js.
// Hetzelfde venster als de tegel: zelfde period/from/to-parameters als
// /api/leads-per-traject-count, hier met de huidige maand als standaard.
//
// Query:
//   ?period=today|week|month|all   (standaard month, NL-tijd)
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD  (t/m, NL-tijd; gaat boven period)
//
// Response 200:
//   { rows: [{ id, email, naam, telefoon, whatsapp, op, bron, bron_label,
//              event:{id,title,starts_at}|null, knockouts:[{vraag,antwoord}],
//              onder_drempel, score, drempel, pogingen, eerdere:[…] }],
//     samenvatting: { totaal, knockouts:[{label,aantal}], onder_drempel,
//                     alleen_drempel, per_bron:[{label,aantal}] },
//     periode: { period, van, tot }, bronfouten: [] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { periodRange, nlDayStart, nlDayEndExclusive } from './_lib/nl-period.js';
import { bouwAfgewezenLijst, vatSamen } from './_lib/event-afgewezen.js';

const PAGINA = 1000;
const MAX_PAGINAS = 50;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** period/from/to → { period, range|null }. Ongeldig → huidige maand. */
export function leesVenster(q = {}, nu = new Date()) {
  const from = String(q.from || '').trim();
  const to = String(q.to || '').trim();
  if (ISO_DATE_RE.test(from) && ISO_DATE_RE.test(to)) {
    const start = nlDayStart(new Date(from + 'T12:00:00Z'));
    const endExclusive = nlDayEndExclusive(new Date(to + 'T12:00:00Z'));
    if (endExclusive > start) return { period: 'custom', range: { start, endExclusive } };
  }
  const p = String(q.period || 'month').toLowerCase();
  if (p === 'all') return { period: 'all', range: null };
  if (p === 'today') return { period: 'today', range: periodRange('dag', nu) };
  if (p === 'week') return { period: 'week', range: periodRange('week', nu) };
  return { period: 'month', range: periodRange('maand', nu) };
}

async function leesAlles(maakQuery, label, fouten) {
  const uit = [];
  for (let p = 0; p < MAX_PAGINAS; p += 1) {
    const { data, error } = await maakQuery().range(p * PAGINA, p * PAGINA + PAGINA - 1);
    if (error) {
      console.error('[events-afgewezen] ' + label + ':', error.message);
      fouten.push(label);
      const e = new Error(error.message);
      e.code = error.code;
      throw e;
    }
    uit.push(...(data || []));
    if (!data || data.length < PAGINA) return uit;
  }
  console.warn('[events-afgewezen] ' + label + ': afgekapt op ' + PAGINA * MAX_PAGINAS + ' rijen');
  return uit;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.attendee.view'))) {
    return res.status(403).json({ error: 'Geen rechten (events.attendee.view)' });
  }

  const { period, range } = leesVenster(req.query || {});
  const venster = (q) => (range ? q.gte('created_at', range.start.toISOString()).lt('created_at', range.endExclusive.toISOString()) : q);
  const fouten = [];

  try {
    const KOLOMMEN = 'id,created_at,event_id,naam,email,telefoon,score,drempel,resultaat,antwoorden';
    const inzendingenMet = (kol) => leesAlles(
      () => venster(supabaseAdmin.from('event_kwalificatie_submissions').select(kol)).order('id', { ascending: true }),
      'event_kwalificatie_submissions', fouten,
    );
    const [eventInzendingen, eventAanmeldingen] = await Promise.all([
      // Kolom bron bestaat sinds 23 okt 2026; zonder migratie: zonder bron.
      inzendingenMet(KOLOMMEN + ',bron').catch((e) => {
        if (e.code !== '42703' && e.code !== 'PGRST204') throw e;
        fouten.pop();
        return inzendingenMet(KOLOMMEN);
      }),
      leesAlles(() => venster(supabaseAdmin.from('event_attendees').select('email,status,is_test')).order('id', { ascending: true }),
        'event_attendees', fouten),
    ]);

    const eventIds = [...new Set(eventInzendingen.filter((s) => s.resultaat === 'afgewezen').map((s) => s.event_id).filter(Boolean))];
    let events = [];
    if (eventIds.length) {
      const { data, error } = await supabaseAdmin.from('events').select('id,title,starts_at').in('id', eventIds);
      if (error) { console.error('[events-afgewezen] events:', error.message); fouten.push('events'); }
      else events = data || [];
    }

    const rows = bouwAfgewezenLijst({ eventAanmeldingen, eventInzendingen, events });
    return res.status(200).json({
      rows,
      samenvatting: vatSamen(rows),
      periode: {
        period,
        van: range ? range.start.toISOString() : null,
        tot: range ? range.endExclusive.toISOString() : null,
      },
      bronfouten: fouten,
    });
  } catch (e) {
    console.error('[events-afgewezen] fout:', e?.message || e);
    return res.status(500).json({ error: 'Afgewezen aanmeldingen ophalen mislukt' });
  }
}
