// api/mentor-payout-generate.js
//
// Payout fase 1 — Genereer-concept rapport (bulk of single).
//
// POST → bouwt voor een (of alle) mentor(s) een snapshot van de verdiensten in
// een bepaalde maand. De daadwerkelijke berekening + upsert zit in de gedeelde
// core api/_lib/payout-generate-core.js zodat ook de adjustment-save/-delete
// endpoints exact dezelfde logica gebruiken.
//
// Permission: mentor.payout.manage (super_admin / admin / manager).
//
// Body (JSON):
//   { period_month: 'YYYY-MM' | 'YYYY-MM-DD',
//     mentor_user_id?: uuid (zonder = bulk over alle actieve mentors) }
//
// Response 200:
//   { ok, period_month, mentors: [ ...core-output, ... ] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { createNotification } from './_lib/notify.js';
import {
  computeAndUpsertConcept,
  normalizeMonthStart,
} from './_lib/payout-generate-core.js';

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
  if (!(await requirePermission(req, 'mentor.payout.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.payout.manage)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const monthStart = normalizeMonthStart(body.period_month);
  if (!monthStart) {
    return res.status(400).json({ error: 'period_month moet YYYY-MM (of YYYY-MM-DD) zijn' });
  }

  const requestedMentorId = typeof body.mentor_user_id === 'string'
    ? body.mentor_user_id.trim()
    : '';
  if (requestedMentorId && !UUID_RE.test(requestedMentorId)) {
    return res.status(400).json({ error: 'mentor_user_id (uuid) ongeldig' });
  }

  try {
    let mentorUserIds;
    if (requestedMentorId) {
      mentorUserIds = [requestedMentorId];
    } else {
      const { data: rows, error: tmErr } = await supabaseAdmin
        .from('team_members')
        .select('user_id, type, is_active')
        .eq('type', 'mentor')
        .eq('is_active', true)
        .not('user_id', 'is', null);
      if (tmErr) throw new Error('mentor-lijst fetch: ' + tmErr.message);
      mentorUserIds = Array.from(new Set((rows || []).map((r) => r.user_id).filter(Boolean)));
    }

    if (mentorUserIds.length === 0) {
      return res.status(200).json({
        ok          : true,
        period_month: monthStart,
        mentors     : [],
        warning     : 'Geen actieve mentors gevonden',
      });
    }

    // Sequentieel: Bubble + Supabase niet overbelasten, leesbare logs.
    const results = [];
    for (const mid of mentorUserIds) {
      try {
        const r = await computeAndUpsertConcept({
          mentorUserId: mid,
          monthStart,
          actorId     : user.id,
        });
        results.push(r);
      } catch (e) {
        console.error(`[mentor-payout-generate] mentor ${mid}: ${e?.message || e}`);
        results.push({
          mentor_user_id: mid,
          error         : e?.message || String(e),
        });
      }
    }

    // Fail-soft dual-write naar unified notifications-tabel: één melding
    // per succesvol gegenereerde payout-rij (skipt errors + rijen zonder
    // payout_id). helper vangt alle fouten zelf af.
    for (const r of results) {
      if (r && r.mentor_user_id && r.payout_id && !r.error) {
        createNotification({
          toUserId:   r.mentor_user_id,
          type:       'payout.report_ready',
          title:      'Uitbetalingsrapport staat klaar',
          body:       monthStart || null,
          linkUrl:    '/modules/mentor-dashboard.html',
          entityType: 'payout',
          entityId:   r.payout_id,
          createdBy:  user.id,
        }).catch(() => {});
      }
    }

    return res.status(200).json({
      ok          : true,
      period_month: monthStart,
      mentors     : results,
    });
  } catch (e) {
    console.error('[mentor-payout-generate]', e?.message || e);
    if (e?.code === 'BUBBLE_CONFIG_MISSING') {
      return res.status(503).json({ error: 'Bubble-koppeling niet geconfigureerd (env)' });
    }
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
