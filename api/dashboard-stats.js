import { supabase } from './supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');

  try {
    // Tasks
    const { data: tasks } = await supabase
      .from('taken_items')
      .select('id,titel,prioriteit,status,deadline,aangemaakt,categorie')
      .order('aangemaakt', { ascending: false })
      .limit(100);

    const all       = tasks || [];
    const open      = all.filter(t => t.status !== 'done' && t.status !== 'afgerond');
    const urgent    = open.filter(t => t.prioriteit === 'Urgent');
    const high      = open.filter(t => t.prioriteit === 'Hoog');

    // Recent replies
    const { data: replies } = await supabase
      .from('email_replies')
      .select('email_id,email_subject,to_address,sent_at')
      .order('sent_at', { ascending: false })
      .limit(10);

    // Unresolved email actions
    const { data: actions } = await supabase
      .from('email_actions')
      .select('email_id,action,resolved_at')
      .is('resolved_at', null)
      .limit(500);

    const unansweredIds = new Set((actions || []).map(a => a.email_id));

    // Activity feed — tasks + replies merged
    const activity = [];
    open.slice(0, 5).filter(t => t.aangemaakt).forEach(t => {
      activity.push({ type: 'task', emoji: '📋', description: `Taak aangemaakt — ${t.titel || '?'}`, timestamp: t.aangemaakt });
    });
    (replies || []).forEach(r => {
      activity.push({ type: 'reply', emoji: '✉️', description: `Mail beantwoord — ${r.email_subject || r.email_id || '?'}`, timestamp: r.sent_at });
    });
    activity.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return res.status(200).json({
      tasks: {
        total:  open.length,
        urgent: urgent.length,
        high:   high.length,
        items:  open.slice(0, 8).map(t => ({ id: t.id, titel: t.titel, prioriteit: t.prioriteit, deadline: t.deadline })),
      },
      unanswered: { count: unansweredIds.size },
      recent_activity: activity.slice(0, 10),
      fetched_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[dashboard-stats]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
