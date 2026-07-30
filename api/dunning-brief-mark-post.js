// api/dunning-brief-mark-post.js
// POST → markeer een dunning_briefs-rij als verstuurd per post.
//
// FASE 6 blok 4 — voor het "downloaden voor post"-scenario. Nadat de
// gebruiker de PDF heeft geprint en verstuurd via reguliere post, klikt 'ie
// "Markeer verstuurd per post" → we zetten sent_via='post' + sent_at.
//
// Request: POST { brief_id: uuid, sent_at?: iso-date (default = now) }
// Response 200: { ok: true, sent_at, sent_via: 'post' }
// Errors:
//   400 MISSING_BRIEF_ID / INVALID_SENT_AT / ALREADY_SENT
//   404 NOT_FOUND
//   500 DB_UPDATE_FAILED
//
// Permission: finance.incasso.manage.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!(await requirePermission(req, 'finance.incasso.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.incasso.manage)' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const briefId = body.brief_id ? String(body.brief_id).trim() : '';
  if (!briefId || !UUID_RE.test(briefId)) {
    return res.status(400).json({ error: 'brief_id (uuid) vereist', code: 'MISSING_BRIEF_ID' });
  }

  // sent_at optioneel; default = now. Als user meegeeft: valideer + niet in de toekomst.
  let sentAtIso;
  if (body.sent_at) {
    const dt = new Date(String(body.sent_at));
    if (Number.isNaN(dt.getTime())) {
      return res.status(400).json({ error: 'sent_at is geen geldige ISO-datum', code: 'INVALID_SENT_AT' });
    }
    if (dt.getTime() > Date.now() + 60_000) {
      return res.status(400).json({ error: 'sent_at mag niet in de toekomst liggen', code: 'INVALID_SENT_AT' });
    }
    sentAtIso = dt.toISOString();
  } else {
    sentAtIso = new Date().toISOString();
  }

  try {
    // Guard: alleen markeren als nog niet verstuurd (voorkom overschrijven van email-status).
    const { data: brief, error: brErr } = await supabaseAdmin
      .from('dunning_briefs')
      .select('id, customer_id, sent_via, sent_at')
      .eq('id', briefId)
      .maybeSingle();
    if (brErr) throw new Error(brErr.message);
    if (!brief) return res.status(404).json({ error: 'Brief niet gevonden', code: 'NOT_FOUND' });
    if (brief.sent_via) {
      return res.status(400).json({
        error: `Al eerder gemarkeerd als '${brief.sent_via}' op ${brief.sent_at}.`,
        code: 'ALREADY_SENT',
      });
    }

    const { error: updErr } = await supabaseAdmin
      .from('dunning_briefs')
      .update({
        sent_via: 'post',
        sent_at: sentAtIso,
        sent_by_user_id: user.id,
      })
      .eq('id', briefId);
    if (updErr) {
      console.error('[dunning-brief-mark-post] update failed:', updErr.message);
      return res.status(500).json({ error: updErr.message, code: 'DB_UPDATE_FAILED' });
    }

    // Log-event.
    try {
      await supabaseAdmin.from('dunning_log').insert({
        run_id: null, step_id: null,
        event_type: 'incasso_pre_brief_marked_post',
        payload: { customer_id: brief.customer_id, brief_id: briefId, sent_at: sentAtIso },
      });
    } catch (_) {}

    return res.status(200).json({ ok: true, sent_via: 'post', sent_at: sentAtIso });
  } catch (e) {
    console.error('[dunning-brief-mark-post]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
