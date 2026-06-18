// api/events-test-attendees-cleanup.js
// POST -> verwijder alle test-attendees (is_test=true) in één klik.
//
// Use-case: nadat de automation-tester gebruikt is, ruimt deze endpoint de
// synthetische rijen op. FK CASCADE op event_attendees → event_automation_runs
// (zie docs/sql-migrations/2026-06-14-events-automations.sql:26),
// event_attendee_audit_log (2026-06-11-events-f1-foundation.sql:182) en
// event_attendee_tags (idem regel 216) verwijdert alles wat aan de
// test-attendee hangt. Een aparte runs-DELETE is dus niet nodig.
//
// Defense-in-depth: we DELETE'en ook event_automation_runs WHERE is_test=true,
// voor het zeldzame scenario dat een run-rij wees geworden is (attendee al
// los verwijderd via UI). Pure veiligheid; meestal 0 rijen.
//
// Permission: events.event.edit (zelfde als de tester).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.event.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (events.event.edit)' });
  }

  try {
    // 1) Hoofd-DELETE op event_attendees (CASCADE doet de rest).
    const { data: deletedAtts, error: delAttErr } = await supabaseAdmin
      .from('event_attendees')
      .delete()
      .eq('is_test', true)
      .select('id');
    if (delAttErr) throw new Error('attendees-delete: ' + delAttErr.message);

    // 2) Defense-in-depth: wees-runs zonder bijbehorende attendee.
    let orphanRuns = 0;
    try {
      const { data: deletedRuns, error: delRunErr } = await supabaseAdmin
        .from('event_automation_runs')
        .delete()
        .eq('is_test', true)
        .select('id');
      if (delRunErr) {
        console.warn('[events-test-attendees-cleanup] orphan-runs delete warn:', delRunErr.message);
      } else if (Array.isArray(deletedRuns)) {
        orphanRuns = deletedRuns.length;
      }
    } catch (e) {
      console.warn('[events-test-attendees-cleanup] orphan-runs exception:', e?.message || e);
    }

    return res.status(200).json({
      ok:           true,
      deleted:      Array.isArray(deletedAtts) ? deletedAtts.length : 0,
      orphan_runs:  orphanRuns,
    });
  } catch (e) {
    console.error('[events-test-attendees-cleanup]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
