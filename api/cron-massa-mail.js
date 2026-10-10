// api/cron-massa-mail.js
//
// Massa-e-mail fase 2a — de wachtrij-worker. Elke 15 minuten één run:
//   - per campagne max `portie` mails (instelbaar per campagne, standaard 100);
//   - pauze tussen mails (app_settings.massa_mail.pauze_ms, standaard 1500 ms);
//   - daglimiet over alle campagnes (app_settings.massa_mail.dag_max, standaard 500)
//     — welkom@ verstuurt ook de afspraak-mails; die mogen niet geblokkeerd raken;
//   - stille uren 21:00–08:00 Amsterdam (app_settings.massa_mail.stille_uren);
//   - atomische claim per ontvanger, afmelding opnieuw gecheckt vlak voor verzending.
// Noodrem: env MASSA_MAIL_UIT=1 → doet niets.
// Auth: Bearer $CRON_SECRET.

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import { verwerkWachtrij } from './_lib/massa-mail.js';

const aan = (v) => ['1', 'true', 'aan', 'on', 'ja'].includes(String(v || '').trim().toLowerCase());

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);
  if (aan(process.env.MASSA_MAIL_UIT)) return res.status(200).json({ ok: true, reden: 'MASSA_MAIL_UIT' });
  const start = Date.now();
  try {
    const r = await verwerkWachtrij(supabaseAdmin, { tijdBudgetMs: 240000 });
    if (r.verstuurd || r.mislukt || r.overgeslagen) console.log('[cron-massa-mail] run:', JSON.stringify({ ...r, ms: Date.now() - start }));
    return res.status(200).json({ ok: true, ...r, duur_ms: Date.now() - start });
  } catch (e) {
    console.error('[cron-massa-mail] fout:', e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 300) });
  }
}
