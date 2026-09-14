// api/admin-events-backfill-8-14-sept.js
//
// ⚠ TIJDELIJK EENMALIG — verwijderen na gebruik. Backfill van gemiste
// event-aanmeldingen tussen 6 en 14 september 2026 (bron: GHL export-CSV).
// Nooit deploy'en zonder review; strikt admin-only.
//
// Draait voor elke ingesloten CSV-rij EXACT dezelfde processSignup()-flow
// als api/events-signup-inbound.js zodat:
//   1. de attendee-rij in event_attendees hetzelfde shape heeft;
//   2. de bestaande automations (cron-events-automations, elke minuut)
//      automatisch bevestiging + reminders vuren via event_automation_runs.
// Er wordt géén parallelle bevestiging vanuit deze endpoint gestuurd — de
// automation-motor doet dat zelf, identiek aan een live signup.
//
// GET  /api/admin-events-backfill-8-14-sept?dry_run=1
// POST /api/admin-events-backfill-8-14-sept   { "dry_run": false }
//
// Auth: verifyAdmin (super_admin / admin sessie). Bearer JWT vereist.
// Idempotent: bestaande (event_id, lower(email)) rij → skip, geen dup-insert.
//
// 0 incasso-writes. Geen finance/dunning/arrangement/pending-action touches.

import { verifyAdmin } from './supabase.js';
import { resolveEventByLabel } from './_lib/event-label-matcher.js';
import { processSignup } from './_lib/event-signup-processor.js';

// De CSV-rijen (bron: 262c65f5-…-csv, hierin ingesloten zodat de endpoint
// geen file-upload nodig heeft). Test-rij jeffreybiemold@gmail.com bewust
// weggelaten. Volgorde: submissiondate desc → asc irrelevant voor idempotency.
const ROWS = [
  { first: 'Jimco',     last: 'Schepens',          phone: '+32494796317', email: 'jimboycoast@hotmail.com',       label: 'Woensdag 23 september 2026 | 18:00 - 21:00 | Masterclass', submitted: '2026-09-14T04:54:00Z' },
  { first: 'Tony',      last: 'Cherrette',         phone: '+32475567803', email: 'info@tslprojects.be',           label: 'Zaterdag 19 september 2026 | 12:00 - 15:00 | Masterclass', submitted: '2026-09-13T22:54:00Z' },
  { first: 'Micah',     last: 'Van Meckeren',      phone: '+32472771752', email: 'xennazed666@gmail.com',         label: 'Zaterdag 26 september 2026 | 10:00 - 13:00 | Masterclass', submitted: '2026-09-12T10:42:00Z' },
  { first: 'Gabryel',   last: 'Moura Da Silva',    phone: '+32472335111', email: 'gabryel.mds2005@gmail.com',     label: 'Woensdag 23 september 2026 | 18:00 - 21:00 | Masterclass', submitted: '2026-09-12T09:23:00Z' },
  { first: 'Omar',      last: 'Adamu',             phone: '+32472028222', email: 'adamuomar6688@gmail.com',       label: 'Zaterdag 26 september 2026 | 10:00 - 13:00 | Masterclass', submitted: '2026-09-12T09:04:00Z' },
  // "albattnijiahmed@gmail.col" — typo in de bron-CSV, laten we ongewijzigd.
  { first: 'Ahmed',     last: 'Albattniji',        phone: '+32487795566', email: 'albattnijiahmed@gmail.col',     label: 'Zaterdag 19 september 2026 | 12:00 - 15:00 | Masterclass', submitted: '2026-09-10T14:24:00Z' },
  { first: 'Zakaria',   last: 'Bazar',             phone: '+32456992183', email: 'zakariajolie3@gmail.com',       label: 'Zaterdag 19 september 2026 | 12:00 - 15:00 | Masterclass', submitted: '2026-09-09T18:38:00Z' },
  { first: 'Anne',      last: 'Janssens',          phone: '+32474885993', email: 'diabolo1_8@hotmail.com',        label: 'Zaterdag 19 september 2026 | 12:00 - 15:00 | Masterclass', submitted: '2026-09-09T02:26:00Z' },
  { first: 'Stefaan',   last: 'De Prest',          phone: '+32495994224', email: 'stefaan.deprest@executus.be',   label: 'Zaterdag 26 september 2026 | 10:00 - 13:00 | Masterclass', submitted: '2026-09-08T18:12:00Z' },
  { first: 'Mariya',    last: 'Koteva',            phone: '+32471050364', email: 'mariya.koteva@gmail.com',       label: 'Zaterdag 19 september 2026 | 12:00 - 15:00 | Masterclass', submitted: '2026-09-08T17:39:00Z' },
  { first: 'Elias',     last: 'Vieren',            phone: '+32470085329', email: 'elias.vieren@icloud.com',       label: 'Zaterdag 19 september 2026 | 12:00 - 15:00 | Masterclass', submitted: '2026-09-08T13:02:00Z' },
  { first: 'Pres',      last: 'Uwadiae',           phone: '+32465682643', email: 'presley.uwadiae05@gmail.com',   label: 'Zaterdag 19 september 2026 | 12:00 - 15:00 | Masterclass', submitted: '2026-09-07T23:52:00Z' },
  { first: 'Florjan',   last: 'Xani',              phone: '+32456219984', email: 'florian.xaniibe@icloud.com',    label: 'Woensdag 23 september 2026 | 18:00 - 21:00 | Masterclass', submitted: '2026-09-07T13:08:00Z' },
  { first: 'Ilian',     last: 'Letaief',           phone: '+32493446583', email: 'ilianletaief@outlook.com',      label: 'Zaterdag 26 september 2026 | 10:00 - 13:00 | Masterclass', submitted: '2026-09-07T11:15:00Z' },
  { first: 'Ella',      last: 'Depp',              phone: '+32474346799', email: 'ellalouise.dep.eng@gmail.com',  label: 'Zaterdag 19 september 2026 | 12:00 - 15:00 | Masterclass', submitted: '2026-09-07T10:30:00Z' },
  { first: 'Jens',      last: 'Van Lysebettens',   phone: '+32479791884', email: 'info@studio-j.be',              label: 'Woensdag 23 september 2026 | 18:00 - 21:00 | Masterclass', submitted: '2026-09-07T08:00:00Z' },
  { first: 'Elias',     last: 'Mesolaras',         phone: '+32489256898', email: 'eliasmesolaras@outlook.com',    label: 'Zaterdag 26 september 2026 | 10:00 - 13:00 | Masterclass', submitted: '2026-09-07T06:21:00Z' },
  { first: 'Makbule',   last: 'Aydemir',           phone: '+32472558241', email: 'mvkbuleaydemir@gmail.com',      label: 'Woensdag 23 september 2026 | 18:00 - 21:00 | Masterclass', submitted: '2026-09-07T05:08:00Z' },
  { first: 'Shannon',   last: 'Bardoel',           phone: '+32472258503', email: 'shannon.bardoel@icloud.com',    label: 'Woensdag 23 september 2026 | 18:00 - 21:00 | Masterclass', submitted: '2026-09-07T00:10:00Z' },
  { first: 'MARTIN',    last: 'ELOCOBE',           phone: '+32470273548', email: 'elocobemart@gmail.com',         label: 'Woensdag 23 september 2026 | 18:00 - 21:00 | Masterclass', submitted: '2026-09-06T19:53:00Z' },
  { first: 'Alain',     last: 'Nzisabira',         phone: '+32497786606', email: 'alainnzisabira234@gmail.com',   label: 'Woensdag 23 september 2026 | 18:00 - 21:00 | Masterclass', submitted: '2026-09-06T14:39:00Z' },
  // Said Hachemi = 2 events = 2 aanmeldingen (bewust apart per event_id).
  { first: 'Said',      last: 'Hachemi',           phone: '+32487105728', email: 'hachemim389@gmail.com',         label: 'Woensdag 23 september 2026 | 18:00 - 21:00 | Masterclass', submitted: '2026-09-06T09:52:00Z' },
  { first: 'Said',      last: 'Hachemi',           phone: '+32487105728', email: 'hachemim389@gmail.com',         label: 'Zaterdag 26 september 2026 | 10:00 - 13:00 | Masterclass', submitted: '2026-09-06T04:59:00Z' },
];

const CREATED_VIA = 'ghl_inbound_backfill';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'GET (dry-run) of POST (uitvoeren)' });
  }

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });

  const dryRun = req.method === 'GET'
    ? String(req.query?.dry_run || '1') !== '0'
    : !!(req.body && req.body.dry_run === true);

  const summary = {
    dry_run       : dryRun,
    total         : ROWS.length,
    per_event     : {},          // event-id → { title, aangemaakt, overgeslagen }
    aangemaakt    : 0,
    overgeslagen  : 0,           // duplicate email+event_id
    no_match      : 0,
    error         : 0,
    resultaten    : [],          // per-rij audit
  };

  for (const row of ROWS) {
    const rowResult = {
      naam: `${row.first} ${row.last}`.trim(),
      email: row.email,
      label: row.label,
      submitted: row.submitted,
    };

    // Label → event (identieke resolver als events-signup-inbound).
    let lookup;
    try {
      lookup = await resolveEventByLabel(row.label);
    } catch (e) {
      rowResult.status = 'error';
      rowResult.error = 'label-resolve: ' + (e?.message || String(e));
      summary.error += 1;
      summary.resultaten.push(rowResult);
      continue;
    }

    if (!lookup.matches || lookup.matches.length === 0) {
      rowResult.status = 'no_match';
      rowResult.resolve_reason = lookup.reason;
      summary.no_match += 1;
      summary.resultaten.push(rowResult);
      continue;
    }

    const chosenEvent = lookup.matches[0];
    const isAmbiguous = lookup.matches.length > 1;
    rowResult.event_id = chosenEvent.id;
    rowResult.event_title = chosenEvent.title;

    if (dryRun) {
      // Alleen tellen wat er ZOU gebeuren — geen writes.
      rowResult.status = 'dry_run';
      summary.resultaten.push(rowResult);
      continue;
    }

    try {
      const processed = await processSignup({
        event: chosenEvent,
        isAmbiguous,
        matches: lookup.matches,
        payload: {
          first_name    : row.first,
          last_name     : row.last,
          email         : row.email.trim().toLowerCase(),
          phone         : row.phone,
          registered_at : row.submitted,
        },
        // Ambiguïteit is bij deze 3 unieke events niet aan de orde,
        // maar we gebruiken hetzelfde pad zodat toekomstige runs
        // met andere data identiek gedrag krijgen.
        ghlContactId       : null,
        ghlFormSubmissionId: null,
        createdVia         : CREATED_VIA,
        source             : 'ghl',
      });

      rowResult.status       = processed.deduplicated ? 'overgeslagen' : 'aangemaakt';
      rowResult.attendee_id  = processed.attendee_id;
      rowResult.dedup_note   = processed.dedup_note;
      rowResult.confirmed    = processed.confirmed_count;
      rowResult.gastenlijst  = processed.gastenlijst_label;

      if (processed.deduplicated) summary.overgeslagen += 1;
      else                        summary.aangemaakt   += 1;

      const bucket = summary.per_event[chosenEvent.id] || {
        title: chosenEvent.title, aangemaakt: 0, overgeslagen: 0,
      };
      if (processed.deduplicated) bucket.overgeslagen += 1;
      else                        bucket.aangemaakt   += 1;
      summary.per_event[chosenEvent.id] = bucket;
    } catch (e) {
      rowResult.status = 'error';
      rowResult.error = e?.message || String(e);
      summary.error += 1;
    }
    summary.resultaten.push(rowResult);
  }

  summary.note_bevestiging = dryRun
    ? 'DRY-RUN — geen writes. Nieuwe attendees zouden binnen ~1 min door cron-events-automations automatisch bevestiging + reminders krijgen via event_automation_runs.'
    : `${summary.aangemaakt} attendees aangemaakt. Bevestiging + reminders worden binnen ~1 min door cron-events-automations verstuurd via de bestaande event_automations op deze events (identiek aan een live inbound-signup).`;

  return res.status(200).json(summary);
}
