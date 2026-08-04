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
import { periodRange } from './_lib/nl-period.js';

function dayStr(d) {
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

async function countLeadsBySoort(soort, fromIso, toIso) {
  // head:true + count:exact — geen rows opgehaald, alleen aantal.
  // NB (herkomst-migratie): het traject-type staat sinds Feature 2 in
  // leads.traject (leads.soort = herkomst). CASE-INSENSITIVE matchen omdat
  // trajectwaarden gemengd zijn (bv. 'Membership'). ilike zonder %/_ = exacte,
  // hoofdletter-ongevoelige match; de bucket-sleutels bevatten geen wildcards.
  const { count, error } = await supabaseAdmin
    .from('leads')
    .select('id', { head: true, count: 'exact' })
    .ilike('traject', soort)
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
  // Overig = leads waar traject NOT IN (3 bekende buckets) OF traject leeg is.
  // NULL telt ook mee (geen traject-koppeling). Sinds Feature 2 leest dit
  // leads.traject i.p.v. leads.soort, CASE-INSENSITIVE (not.ilike), consistent
  // met countLeadsBySoort. Nested and(...) binnen or(...) voor het NULL-geval.
  const { count, error } = await supabaseAdmin
    .from('leads')
    .select('id', { head: true, count: 'exact' })
    .or('traject.is.null,and(traject.not.ilike.7-daagse,traject.not.ilike.webinar,traject.not.ilike.minicursus)')
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
  // 2026-08-04: accepteer `?period=dag|week|maand|jaar` en gebruik dan
  // NL-tijdzone-aware boundaries via nl-period.js (spiegel super-admin-
  // omzet.js). Backward-compat: from/to blijven werken voor custom ranges.
  const now = new Date();
  const periodParam = typeof req.query?.period === 'string' ? req.query.period.trim().toLowerCase() : null;
  let from, to, fromIso, toIso;
  if (periodParam && ['dag','week','maand','jaar'].includes(periodParam)) {
    const r = periodRange(periodParam, now);
    from    = r.label;
    to      = dayStr(new Date(r.endExclusive.getTime() - 1000));
    fromIso = r.start.toISOString();
    toIso   = r.endExclusive.toISOString();
  } else {
    const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
    from    = String(req.query.from || dayStr(defaultFrom));
    to      = String(req.query.to   || dayStr(now));
    fromIso = `${from}T00:00:00.000Z`;
    toIso   = `${to}T23:59:59.999Z`;
  }

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
