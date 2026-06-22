// api/onboarding-archive.js
//
// ADMIN — archiveer of herstel een onboarding. Archive bevriest de rij
// (status='gearchiveerd'); restore zet hem terug op de meest passende
// lifecycle-status afhankelijk van eerder bereikte mijlpalen.
//
// Permission: onboarding.admin.
//
// Body:
//   { onboarding_id (uuid), action: 'archive' | 'restore' }
//
// Restore-logica:
//   - completed_at gezet  → status = 'afgerond'
//   - else started_at gezet → status = 'bezig'
//   - else                  → status = 'aangemeld'
//   archived_at wordt op null gezet.
//
// Response 200: { ok:true, status }.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ACTIONS = new Set(['archive', 'restore']);

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
  if (!(await requirePermission(req, 'onboarding.admin'))) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.admin)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const onboardingId = typeof body.onboarding_id === 'string' ? body.onboarding_id.trim() : '';
  if (!UUID_RE.test(onboardingId)) {
    return res.status(400).json({ error: 'onboarding_id (uuid) vereist' });
  }
  const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : '';
  if (!VALID_ACTIONS.has(action)) {
    return res.status(400).json({ error: "action moet 'archive' of 'restore' zijn" });
  }

  try {
    const { data: ob, error: obErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, status, started_at, completed_at')
      .eq('id', onboardingId)
      .maybeSingle();
    if (obErr) throw new Error('onboarding lookup: ' + obErr.message);
    if (!ob)  return res.status(404).json({ error: 'Onboarding niet gevonden' });

    const nowIso = new Date().toISOString();
    let patch;
    let newStatus;

    if (action === 'archive') {
      if (ob.status === 'gearchiveerd') {
        return res.status(409).json({ error: 'Onboarding is al gearchiveerd' });
      }
      newStatus = 'gearchiveerd';
      patch = { status: newStatus, archived_at: nowIso };
    } else {
      if (ob.status !== 'gearchiveerd') {
        return res.status(409).json({ error: 'Onboarding is niet gearchiveerd' });
      }
      if (ob.completed_at)    newStatus = 'afgerond';
      else if (ob.started_at) newStatus = 'bezig';
      else                    newStatus = 'aangemeld';
      patch = { status: newStatus, archived_at: null };
    }

    const { error: updErr } = await supabaseAdmin
      .from('onboardings')
      .update(patch)
      .eq('id', onboardingId);
    if (updErr) throw new Error('onboarding update: ' + updErr.message);

    return res.status(200).json({ ok: true, status: newStatus });
  } catch (e) {
    console.error('[onboarding-archive]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
