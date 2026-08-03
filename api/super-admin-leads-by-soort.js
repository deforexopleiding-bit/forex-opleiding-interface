// api/super-admin-leads-by-soort.js
//
// GET → leads-per-traject-soort voor het super_admin-dashboard.
//
// Query: ?from=YYYY-MM-DD & ?to=YYYY-MM-DD
//        (defaults: from = 1e van deze maand, to = vandaag)
//
// Response 200:
//   {
//     from, to,
//     buckets: [
//       { key: '7-daagse',   label: '7-daagse',    count, deep_link },
//       { key: 'event',      label: 'Event',       count, deep_link, source: 'follow_up_leads' },
//       { key: 'webinar',    label: 'Webinar',     count, deep_link },
//       { key: 'minicursus', label: 'Mini cursus', count, deep_link }
//     ],
//     overig: { count, deep_link }   // niet in tegel — subtiele bewaker
//   }
//
// Bucket-mapping (goedgekeurd door Jeffrey 2026-08-01, event-bucket herzien 2026-08-03):
//   - 7-daagse         → leads.soort = '7-daagse'
//   - Event-aanmeldingen → event_attendees (echte inschrijvingen — dashboard-fix
//                          #1069, was voorheen follow_up_leads.source='event' →
//                          telde sales-followup leads i.p.v. aanmeldingen)
//   - Webinar          → leads.soort = 'webinar'
//   - Mini cursus       → leads.soort = 'minicursus'
//   - Overig           → alles waar leads.soort NIET in de 3 leads-buckets valt
//                        (student, NULL, of onbekend). Event zit niet in leads-tabel
//                        dus valt hier per definitie niet onder.
//
// Periode-filter: `aangemaakt` op leads, `created_at` op follow_up_leads.
// Permission: dashboard.module.access (gelijk aan super-admin-omzet).

import { supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

function dayStr(d) {
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

async function countLeadsBySoort(soort, fromIso, toIso) {
  // head:true + count:exact — geen rows opgehaald, alleen aantal.
  const { count, error } = await supabaseAdmin
    .from('leads')
    .select('id', { head: true, count: 'exact' })
    .eq('soort', soort)
    .gte('aangemaakt', fromIso)
    .lte('aangemaakt', toIso);
  if (error) throw new Error(`leads[${soort}]: ${error.message}`);
  return count || 0;
}

async function countEventAttendees(fromIso, toIso) {
  // Telt ECHTE event-aanmeldingen (event_attendees.created_at in periode),
  // niet meer follow_up_leads met source='event' — dat waren
  // sales-followup-leads uit events, niet aanmeldingen.
  // Fix voor de dashboard-verwarring van 3 aug 2026 (getal + link wezen
  // beide naar de verkeerde entiteit).
  const { count, error } = await supabaseAdmin
    .from('event_attendees')
    .select('id', { head: true, count: 'exact' })
    .gte('created_at', fromIso)
    .lte('created_at', toIso);
  if (error) throw new Error(`event_attendees: ${error.message}`);
  return count || 0;
}

async function countOverigLeads(fromIso, toIso) {
  // Overig = leads waar soort NOT IN (3 bekende buckets in leads-tabel).
  // NULL telt ook mee (soort ontbreekt = geen traject-koppeling).
  // NB: filter met .or() voor het NULL-geval, want .not('soort', 'in', ...)
  // vangt NULL niet op — PostgreSQL semantiek.
  const known = ['7-daagse', 'webinar', 'minicursus'];
  const inList = `(${known.map(s => `"${s}"`).join(',')})`;
  const { count, error } = await supabaseAdmin
    .from('leads')
    .select('id', { head: true, count: 'exact' })
    .or(`soort.not.in.${inList},soort.is.null`)
    .gte('aangemaakt', fromIso)
    .lte('aangemaakt', toIso);
  if (error) throw new Error(`leads[overig]: ${error.message}`);
  return count || 0;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!(await requirePermission(req, 'dashboard.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (dashboard.module.access)' });
  }

  // Periode-parse: default = huidige maand.
  const now = new Date();
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const from = String(req.query.from || dayStr(defaultFrom));
  const to   = String(req.query.to   || dayStr(now));
  const fromIso = `${from}T00:00:00.000Z`;
  const toIso   = `${to}T23:59:59.999Z`;

  try {
    // 4 buckets + overig parallel (5 head-count queries totaal).
    const [c7d, cEvent, cWebinar, cMinicursus, cOverig] = await Promise.all([
      countLeadsBySoort('7-daagse', fromIso, toIso),
      countEventAttendees(fromIso, toIso),
      countLeadsBySoort('webinar', fromIso, toIso),
      countLeadsBySoort('minicursus', fromIso, toIso),
      countOverigLeads(fromIso, toIso),
    ]);

    return res.status(200).json({
      from, to,
      buckets: [
        { key: '7-daagse',   label: '7-daagse',    count: c7d,
          deep_link: `/modules/leads.html?soort=7-daagse` },
        { key: 'event',      label: 'Event-aanmeldingen', count: cEvent,
          deep_link: `/modules/events.html`,
          source: 'event_attendees' },
        { key: 'webinar',    label: 'Webinar',     count: cWebinar,
          deep_link: `/modules/leads.html?soort=webinar` },
        { key: 'minicursus', label: 'Mini cursus', count: cMinicursus,
          deep_link: `/modules/leads.html?soort=minicursus` },
      ],
      overig: {
        count: cOverig,
        // Deep-link naar leads-module zonder soort-filter — user filtert zelf verder.
        // Er is geen "?soort=__overig__"-filter in leads.html, dus we sturen naar de
        // hoofdlijst zonder filter (verwarrender voor user is uitleg toevoegen).
        deep_link: `/modules/leads.html`,
      },
    });
  } catch (e) {
    console.error('[super-admin-leads-by-soort]', e?.message || e);
    return res.status(500).json({ error: 'Leads-telling mislukt', detail: e?.message });
  }
}
