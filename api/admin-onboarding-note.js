// api/admin-onboarding-note.js
//
// POST — Manager/admin schrijft een notitie/instructie aan de mentor van een
// onboarding. Doet TWEE schrijfacties:
//   1) insert in onboarding_mentor_updates (kind:'note') → verschijnt in de
//      gedeelde tijdlijn (mentor-students.html toekomst-tab + onboarding-
//      overzicht detail-modal).
//   2) als de onboarding een toegewezen mentor heeft → notify via het unified
//      notifications-systeem (createNotification, type:'onboarding.admin_note')
//      → mentor ziet 'm in de sidebar-bel + krijgt een per-student-badge op
//      de mentor-onboarding tabel.
//      Geen mentor toegewezen → alleen de tijdlijn-notitie, geen melding.
//
// Permission-gate: seesAll (onboarding.admin) — identiek aan
// api/admin-future-students-list.js. Mentor (view_own) krijgt 403; die kan
// notities via de mentor-eigen update-endpoint maken.
//
// Body: { onboarding_id: uuid, note: string }.
// Note: getrimd, niet-leeg, max 2000 tekens.
//
// Response 200: { ok:true, update:{kind,note,created_at,created_by} }.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { getOnboardingScope } from './_lib/onboardingScope.js';
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

  const scopeInfo = await getOnboardingScope(req);
  if (!scopeInfo.seesAll) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.admin vereist).' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const onboardingId = typeof body.onboarding_id === 'string' ? body.onboarding_id.trim() : '';
  if (!UUID_RE.test(onboardingId)) {
    return res.status(400).json({ error: 'onboarding_id (uuid) is verplicht.' });
  }
  const noteRaw = (body.note == null) ? '' : String(body.note).trim();
  if (!noteRaw) return res.status(400).json({ error: 'note is verplicht.' });
  const note = noteRaw.slice(0, 2000);

  try {
    // 1) Onboarding lookup voor mentor_user_id (mentor-aware notificatie).
    const { data: ob, error: obErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, mentor_user_id, customer_name, status')
      .eq('id', onboardingId)
      .maybeSingle();
    if (obErr) throw new Error('onboarding lookup: ' + obErr.message);
    if (!ob) return res.status(404).json({ error: 'Onboarding niet gevonden.' });

    // 2) Schrijf tijdlijn-rij. Bij fout breken we direct — er mag GEEN
    // melding zonder bijbehorende tijdlijn-entry ontstaan.
    const { data: upd, error: upErr } = await supabaseAdmin
      .from('onboarding_mentor_updates')
      .insert({
        onboarding_id: onboardingId,
        kind:          'note',
        status:        null,
        note,
        created_by:    user.id,
      })
      .select('kind, note, created_at, created_by')
      .single();
    if (upErr) throw new Error('mentor_update insert: ' + upErr.message);

    // 3) Mentor-notificatie via unified notifications-systeem (fail-soft).
    // Alleen als er een mentor is; geen mentor → alleen tijdlijn-notitie.
    if (ob.mentor_user_id) {
      createNotification({
        toUserId:   ob.mentor_user_id,
        type:       'onboarding.admin_note',
        title:      'Notitie van management' + (ob.customer_name ? (' · ' + ob.customer_name) : ''),
        body:       note,
        linkUrl:    '/modules/mentor-onboarding.html',
        entityType: 'onboarding',
        entityId:   onboardingId,
        createdBy:  user.id,
      }).catch(() => {});
    }

    return res.status(200).json({
      ok:              true,
      update:          upd,
      mentor_notified: !!ob.mentor_user_id,
    });
  } catch (e) {
    console.error('[admin-onboarding-note]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
