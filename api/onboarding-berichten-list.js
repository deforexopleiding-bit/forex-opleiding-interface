// api/onboarding-berichten-list.js
//
// GET -> virtuele bericht-rijen uit alle onboarding_automations.steps[].
// Zelfde patroon als api/events-berichten-list.js. Read-view voor de
// Berichten-tab; bewerken via bestaande /api/onboarding-automation-save
// (surgical update van step.config).
//
// Response shape identiek aan events-berichten-list.js.
// Permission: onboarding.automation.view.

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
  if (!(await requirePermission(req, 'onboarding.automation.view'))) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.automation.view)' });
  }

  try {
    const { data: rows, error } = await supabaseAdmin
      .from('onboarding_automations')
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
            body: cfg.body || '',
          });
        } else if (step.type === 'send_whatsapp') {
          items.push({
            automation_id:   a.id,
            automation_name: a.name || '(geen naam)',
            automation_enabled: !!a.enabled,
            step_index: idx,
            kanaal: 'whatsapp',
            template_name: cfg.template_name || '',
            language:      cfg.language || 'nl',
          });
        }
      });
    }

    return res.status(200).json({ items });
  } catch (e) {
    console.error('onboarding-berichten-list mislukt:', e.message);
    return res.status(500).json({ error: e.message || 'Interne fout' });
  }
}
