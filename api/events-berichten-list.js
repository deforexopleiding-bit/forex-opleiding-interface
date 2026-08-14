// api/events-berichten-list.js
//
// GET -> virtuele bericht-rijen uit alle event_automations.steps[].
//   Filter: alleen step.type IN ('send_email','send_whatsapp').
//   Bron-van-waarheid blijft `event_automations.steps` (jsonb) — dat is wat
//   de cron leest. Deze endpoint is een READ-VIEW voor de Berichten-tab.
//   Bewerken gebeurt via bestaande /api/events-automation-save (surgical
//   update van step.config in de flow).
//
// Response:
//   { items: [
//     { automation_id, automation_name, automation_enabled, step_index,
//       kanaal: 'email'|'whatsapp',
//       onderwerp?: string,      // send_email
//       body_text?: string,      // send_email
//       template_name?: string,  // send_whatsapp
//       template_language?: string
//     }, ...
//   ]}
//
// Permission: events.event.view (mirror van events-automations-list).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const asArr = (x) => Array.isArray(x) ? x : [];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.event.view'))) {
    return res.status(403).json({ error: 'Geen rechten (events.event.view)' });
  }

  try {
    const { data: rows, error } = await supabaseAdmin
      .from('event_automations')
      .select('id, name, enabled, steps')
      .order('name');
    if (error) throw error;

    const items = [];
    for (const a of asArr(rows)) {
      const steps = asArr(a.steps);
      steps.forEach((step, idx) => {
        if (!step || typeof step !== 'object') return;
        const cfg = step.config || {};
        if (step.type === 'send_email') {
          items.push({
            automation_id:   a.id,
            automation_name: a.name || '(geen naam)',
            automation_enabled: !!a.enabled,
            step_index: idx,
            kanaal: 'email',
            onderwerp: cfg.subject || '',
            body_text: cfg.body_text || '',
          });
        } else if (step.type === 'send_whatsapp') {
          items.push({
            automation_id:   a.id,
            automation_name: a.name || '(geen naam)',
            automation_enabled: !!a.enabled,
            step_index: idx,
            kanaal: 'whatsapp',
            template_name:     cfg.template_name || '',
            template_language: cfg.template_language || 'nl',
          });
        }
      });
    }

    return res.status(200).json({ items });
  } catch (e) {
    console.error('events-berichten-list mislukt:', e.message);
    return res.status(500).json({ error: e.message || 'Interne fout' });
  }
}
