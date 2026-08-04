// api/dunning-briefs-bulk-mark-sent.js
//
// POST { brief_ids: [uuid], sent_at? } → markeer meerdere brieven in 1 keer
// als verstuurd per post. Bulk-variant van dunning-brief-mark-post.js.
//
// Idempotent: brieven die al sent_via IS NOT NULL hebben worden overgeslagen
// (geen error) — voorkomt dat een enkele already-sent brief de hele batch
// blokkeert.
//
// Request:   POST { brief_ids: [uuid, ...], sent_at?: iso-date }
// Response:  200 { ok: true, updated: <N>, skipped: <N>, skipped_ids: [uuid],
//                  sent_via: 'post', sent_at: iso }
// Errors:
//   400 MISSING_BRIEF_IDS / TOO_MANY / INVALID_UUID / INVALID_SENT_AT
//   500 DB_UPDATE_FAILED
//
// Permission: finance.incasso.manage.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BRIEFS = 200;

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

  const rawIds = Array.isArray(body.brief_ids) ? body.brief_ids : [];
  const briefIds = Array.from(new Set(rawIds.map((s) => String(s || '').trim()).filter(Boolean)));
  if (briefIds.length === 0) {
    return res.status(400).json({ error: 'brief_ids (array) verplicht', code: 'MISSING_BRIEF_IDS' });
  }
  if (briefIds.length > MAX_BRIEFS) {
    return res.status(400).json({ error: `Max ${MAX_BRIEFS} brieven per batch`, code: 'TOO_MANY' });
  }
  for (const id of briefIds) {
    if (!UUID_RE.test(id)) return res.status(400).json({ error: `Ongeldige uuid: ${id}`, code: 'INVALID_UUID' });
  }

  // sent_at optioneel — default now, mag niet in de toekomst.
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
    // 1) Fetch current status om skipping te doen. Idempotent: al-verstuurde
    // brieven blijven zoals ze zijn (behoud van originele sent_via/sent_at).
    const { data: rows, error: selErr } = await supabaseAdmin
      .from('dunning_briefs')
      .select('id, customer_id, sent_via, sent_at')
      .in('id', briefIds);
    if (selErr) throw new Error(selErr.message);
    const rowsList = rows || [];

    const toUpdate = rowsList.filter((r) => !r.sent_via).map((r) => r.id);
    const skippedIds = rowsList.filter((r) => r.sent_via).map((r) => r.id);
    // brief_ids die niet in rows staan = onbekend (bv verwijderd) — tel als skipped.
    const foundIds = new Set(rowsList.map((r) => r.id));
    for (const id of briefIds) if (!foundIds.has(id)) skippedIds.push(id);

    if (toUpdate.length === 0) {
      return res.status(200).json({
        ok: true, updated: 0, skipped: skippedIds.length, skipped_ids: skippedIds,
        sent_via: 'post', sent_at: sentAtIso,
        note: 'Alle brieven waren al gemarkeerd of niet gevonden.',
      });
    }

    const { error: updErr } = await supabaseAdmin
      .from('dunning_briefs')
      .update({
        sent_via: 'post',
        sent_at: sentAtIso,
        sent_by_user_id: user.id,
      })
      .in('id', toUpdate);
    if (updErr) {
      console.error('[dunning-briefs-bulk-mark-sent] update failed:', updErr.message);
      return res.status(500).json({ error: updErr.message, code: 'DB_UPDATE_FAILED' });
    }

    // Log-event (fail-soft).
    try {
      await supabaseAdmin.from('dunning_log').insert({
        run_id: null, step_id: null,
        event_type: 'incasso_pre_brief_bulk_marked_post',
        payload: {
          user_id: user.id,
          brief_ids: toUpdate,
          skipped_ids: skippedIds,
          sent_at: sentAtIso,
        },
      });
    } catch (_) {}

    return res.status(200).json({
      ok: true,
      updated: toUpdate.length,
      skipped: skippedIds.length,
      skipped_ids: skippedIds,
      sent_via: 'post',
      sent_at: sentAtIso,
    });
  } catch (e) {
    console.error('[dunning-briefs-bulk-mark-sent]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
