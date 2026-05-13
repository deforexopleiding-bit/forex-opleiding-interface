import { supabase } from './supabase.js';

// Tijdelijk verificatie-endpoint — kan na verificatie worden verwijderd
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader  = req.headers.authorization || '';
    const querySecret = req.query?.secret         || '';
    if (authHeader !== `Bearer ${secret}` && querySecret !== secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    // Stap 1: taken_items met source_meeting_id
    const { data: tasks, error: tasksErr } = await supabase
      .from('taken_items')
      .select('id, titel, toegewezen_aan, assigned_to_type, source_meeting_id, aangemaakt')
      .not('source_meeting_id', 'is', null)
      .order('aangemaakt', { ascending: false })
      .limit(10);

    if (tasksErr) throw tasksErr;

    if (!tasks?.length) {
      return res.status(200).json({
        ok: true,
        summary: '⚠️ Geen taken met source_meeting_id gevonden',
        tasks: [],
        assignees: [],
      });
    }

    // Stap 2: taken_assignees voor deze taken
    const taskIds = tasks.map(t => t.id);
    const { data: assignees, error: asgErr } = await supabase
      .from('taken_assignees')
      .select('task_id, assignee_name, assignee_type')
      .in('task_id', taskIds)
      .order('assignee_name');

    if (asgErr) throw asgErr;

    // Groepeer assignees per taak
    const assigneesByTask = {};
    for (const a of (assignees || [])) {
      (assigneesByTask[a.task_id] ||= []).push(`${a.assignee_name} (${a.assignee_type})`);
    }

    // Combineer
    const result = tasks.map(t => ({
      id:                t.id,
      titel:             t.titel,
      toegewezen_aan:    t.toegewezen_aan,       // backwards compat kolom
      assigned_to_type:  t.assigned_to_type,
      source_meeting_id: t.source_meeting_id,
      aangemaakt:        t.aangemaakt,
      assignees_namen:   assigneesByTask[t.id] || [],
      aantal_assignees:  (assigneesByTask[t.id] || []).length,
    }));

    const totalAssignees   = (assignees || []).length;
    const multiAssignee    = result.filter(t => t.aantal_assignees > 1);
    const noAssignees      = result.filter(t => t.aantal_assignees === 0);
    const hasMeeting       = result.filter(t => t.source_meeting_id);

    return res.status(200).json({
      ok: true,
      summary: {
        taken_totaal:           result.length,
        taken_met_meeting:      hasMeeting.length,
        assignees_totaal:       totalAssignees,
        taken_multi_assignee:   multiAssignee.length,
        taken_zonder_assignees: noAssignees.length,
      },
      taken: result,
    });

  } catch (err) {
    console.error('[verify-meeting-tasks]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
