// api/onboarding-assign-mentor.js
//
// ADMIN — wijs een mentor toe aan een onboarding, of ontkoppel (null).
//
// Permission: onboarding.assign_mentor.
//
// Body:
//   { onboarding_id (uuid), mentor_user_id (uuid|null) }
//
// Validaties:
//   - Onboarding moet bestaan; status != 'gearchiveerd' (anders 409).
//   - mentor_user_id === null → ontkoppelen (mentor_user_id=null, assigned_at=null).
//   - Anders moet het een actieve mentor zijn:
//     team_members.type='mentor' AND is_active=true op user_id (anders 400).
//
// Response 200: { ok:true, mentor_user_id, assigned_at }.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { bubblePatch } from './_lib/bubble.js';
import { createNotification } from './_lib/notify.js';

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
  if (!(await requirePermission(req, 'onboarding.assign_mentor'))) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.assign_mentor)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const onboardingId = typeof body.onboarding_id === 'string' ? body.onboarding_id.trim() : '';
  if (!UUID_RE.test(onboardingId)) {
    return res.status(400).json({ error: 'onboarding_id (uuid) vereist' });
  }

  // mentor_user_id mag expliciet null zijn (ontkoppelen) of een uuid.
  const rawMid = body.mentor_user_id;
  let mentorUserId = null;
  if (rawMid === null || rawMid === undefined || rawMid === '') {
    mentorUserId = null;
  } else if (typeof rawMid === 'string' && UUID_RE.test(rawMid.trim())) {
    mentorUserId = rawMid.trim();
  } else {
    return res.status(400).json({ error: 'mentor_user_id moet uuid of null zijn' });
  }

  try {
    // 1) Onboarding-staat valideren. customer_name + huidige mentor_user_id
    // worden óók gelezen — beide nodig voor de reassigned_away-notificatie
    // aan de oude mentor (Fase 3b: zie blok onderaan).
    const { data: ob, error: obErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, status, bubble_user_id, mentor_user_id, customer_name, start_date, traject:onboarding_trajecten(label)')
      .eq('id', onboardingId)
      .maybeSingle();
    if (obErr) throw new Error('onboarding lookup: ' + obErr.message);
    if (!ob)  return res.status(404).json({ error: 'Onboarding niet gevonden' });
    if (ob.status === 'gearchiveerd') {
      return res.status(409).json({ error: 'Onboarding is gearchiveerd — eerst herstellen' });
    }

    // 2) Indien set: valideer actieve mentor + haal bubble_user_id.
    let mentorBubbleUserId = null;
    if (mentorUserId) {
      const { data: tm, error: tmErr } = await supabaseAdmin
        .from('team_members')
        .select('user_id, type, is_active, bubble_user_id')
        .eq('user_id', mentorUserId)
        .eq('type', 'mentor')
        .eq('is_active', true)
        .maybeSingle();
      if (tmErr) throw new Error('team_members lookup: ' + tmErr.message);
      if (!tm)  return res.status(400).json({ error: 'mentor_user_id is geen actieve mentor' });
      mentorBubbleUserId = typeof tm.bubble_user_id === 'string' && tm.bubble_user_id.trim()
        ? tm.bubble_user_id.trim()
        : null;
    }

    // 3) Update.
    const nowIso = new Date().toISOString();
    const patch = mentorUserId
      ? { mentor_user_id: mentorUserId, assigned_at: nowIso }
      : { mentor_user_id: null,          assigned_at: null   };
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('onboardings')
      .update(patch)
      .eq('id', onboardingId)
      .select('mentor_user_id, assigned_at')
      .single();
    if (updErr) throw new Error('onboarding update: ' + updErr.message);

    // 4) Bubble-side koppelen — alleen als zowel student als mentor een
    // bubble_user_id hebben. Fail-soft: DB-koppeling staat al, een Bubble-
    // fout mag de 200 niet kapot maken; we melden het wel in de response.
    // Ontkoppelen (mentor_user_id=null) doen we hier NIET in Bubble (geen
    // harde eis); een handmatige actie of admin-tool kan dat later opruimen.
    let bubble = null;
    if (mentorUserId && mentorBubbleUserId && ob.bubble_user_id) {
      try {
        await bubblePatch('user', ob.bubble_user_id, { mentor_user: mentorBubbleUserId });
        bubble = { ok: true };
      } catch (e) {
        const msg = (e?.code || '') + ' ' + (e?.message || e);
        console.error('[onboarding-assign-mentor] bubble patch fail:', msg);
        bubble = { ok: false, error: msg.trim() };
      }
    } else if (mentorUserId) {
      // Toelichting in response zodat de admin-UI kan tonen WAAROM Bubble
      // niet bijgewerkt is (bv. mentor heeft geen bubble-koppeling, of de
      // student is nog niet geprovisioned).
      const reasons = [];
      if (!ob.bubble_user_id)     reasons.push('student-niet-geprovisioned');
      if (!mentorBubbleUserId)    reasons.push('mentor-zonder-bubble-koppeling');
      bubble = { ok: false, skipped: true, reason: reasons.join(',') };
    }

    // 5) Fase 3b — reassign-notificaties. ALLEEN wanneer er daadwerkelijk
    // gewisseld is van mentor (oldMentor != nieuwe), én er was een vorige
    // mentor: laat 'm weten dat de student is overgedragen via het unified
    // notifications-systeem. De oude mentor verliest toegang tot de
    // onboarding zelf, maar ziet de melding wél in de sidebar-bel.
    const oldMentor = ob.mentor_user_id || null;
    const newMentor = updated.mentor_user_id || null;
    if (oldMentor && oldMentor !== newMentor) {
      let newMentorName = 'geen mentor';
      if (newMentor) {
        try {
          const { data: newTm } = await supabaseAdmin
            .from('team_members')
            .select('name')
            .eq('user_id', newMentor)
            .maybeSingle();
          if (newTm?.name) newMentorName = newTm.name;
        } catch (e) {
          console.warn('[onboarding-assign-mentor] new mentor name lookup (soft):', e?.message || e);
        }
      }
      const custName = ob.customer_name || 'Een student';
      createNotification({
        toUserId:   oldMentor,
        type:       'onboarding.reassigned_away',
        title:      'Student overgedragen · ' + custName,
        body:       custName + ' is overgedragen aan ' + newMentorName + '.',
        linkUrl:    '/modules/mentor-onboarding.html',
        entityType: 'onboarding',
        entityId:   onboardingId,
        createdBy:  user.id,
      }).catch(() => {});
    }
    if (newMentor && newMentor !== oldMentor) {
      const custName = ob.customer_name || 'Een student';
      // Notify de nieuwe mentor via unified notifications-systeem (fail-soft).
      const trajectLabel = ob.traject?.label || null;
      const startDateNL  = (() => {
        if (typeof ob.start_date !== 'string') return null;
        const m = ob.start_date.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (!m) return null;
        return m[3] + '-' + m[2] + '-' + m[1];
      })();
      const bodyParts = [];
      if (trajectLabel) bodyParts.push(trajectLabel);
      if (startDateNL)  bodyParts.push('start ' + startDateNL);
      createNotification({
        toUserId:   newMentor,
        type:       'onboarding.new_student',
        title:      'Nieuwe student · ' + custName,
        body:       bodyParts.length ? bodyParts.join(' · ') : custName,
        linkUrl:    '/modules/mentor-onboarding.html',
        entityType: 'onboarding',
        entityId:   onboardingId,
        createdBy:  user.id,
      }).catch(() => {});
    }

    return res.status(200).json({
      ok            : true,
      mentor_user_id: updated.mentor_user_id,
      assigned_at   : updated.assigned_at,
      bubble        : bubble,
    });
  } catch (e) {
    console.error('[onboarding-assign-mentor]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
