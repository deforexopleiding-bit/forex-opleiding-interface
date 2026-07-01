// api/admin-onboarding-start-date.js
//
// POST — Pas de startdatum van een onboarding aan. Schrijft een tijdlijn-rij
// in onboarding_mentor_updates EN — als er een mentor toegewezen is — een
// mentor_notification (kind:'start_date_changed').
//
// Body: { onboarding_id: uuid, start_date: string (YYYY-MM-DD) }.
//
// Permission: seesAll (onboarding.admin). Mentor → 403.
//
// Response 200: { ok:true, start_date, update:{kind,note,created_at,created_by},
//                 notification_id?: uuid|null }.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { getOnboardingScope } from './_lib/onboardingScope.js';
import { createNotification } from './_lib/notify.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// YYYY-MM-DD (Postgres date kolom). Voor losse ISO-timestamps slicen we
// hieronder de eerste 10 chars indien client iets als '2026-09-01T00:00:00Z'
// meestuurt.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function fmtDateNL(ymd) {
  if (!ymd) return '—';
  try {
    const d = new Date(ymd + 'T00:00:00Z');
    return d.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return ymd; }
}

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
  let raw = typeof body.start_date === 'string' ? body.start_date.trim() : '';
  if (raw.length > 10) raw = raw.slice(0, 10);
  if (!DATE_RE.test(raw)) {
    return res.status(400).json({ error: 'start_date (YYYY-MM-DD) is verplicht.' });
  }
  // Sanity-check: parseable Date + within reasonable range (1900..2100).
  const parsed = new Date(raw + 'T00:00:00Z');
  if (Number.isNaN(parsed.getTime()) || parsed.getUTCFullYear() < 1900 || parsed.getUTCFullYear() > 2100) {
    return res.status(400).json({ error: 'start_date buiten verwacht bereik.' });
  }

  try {
    const { data: ob, error: obErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, mentor_user_id, start_date, customer_name')
      .eq('id', onboardingId)
      .maybeSingle();
    if (obErr) throw new Error('onboarding lookup: ' + obErr.message);
    if (!ob)  return res.status(404).json({ error: 'Onboarding niet gevonden.' });

    const { data: upd, error: updErr } = await supabaseAdmin
      .from('onboardings')
      .update({ start_date: raw })
      .eq('id', onboardingId)
      .select('start_date')
      .single();
    if (updErr) throw new Error('start_date update: ' + updErr.message);

    const noteText = 'Startdatum gewijzigd naar ' + fmtDateNL(raw);
    const { data: tlrow, error: tlErr } = await supabaseAdmin
      .from('onboarding_mentor_updates')
      .insert({
        onboarding_id: onboardingId,
        kind:          'note',
        status:        null,
        note:          noteText,
        created_by:    user.id,
      })
      .select('kind, note, created_at, created_by')
      .single();
    if (tlErr) throw new Error('mentor_update insert: ' + tlErr.message);

    let notification_id = null;
    if (ob.mentor_user_id) {
      try {
        const { data: notif, error: nErr } = await supabaseAdmin
          .from('mentor_notifications')
          .insert({
            mentor_user_id: ob.mentor_user_id,
            onboarding_id:  onboardingId,
            kind:           'start_date_changed',
            title:          'Startdatum gewijzigd',
            body:           'Nieuwe startdatum: ' + fmtDateNL(raw),
            created_by:     user.id,
          })
          .select('id')
          .single();
        if (nErr) {
          console.warn('[admin-onboarding-start-date] notification insert (soft):', nErr.message);
        } else {
          notification_id = notif?.id || null;
        }
      } catch (e) {
        console.warn('[admin-onboarding-start-date] notification exception (soft):', e?.message || e);
      }
      // Dual-write naar unified notifications-tabel (fail-soft).
      createNotification({
        toUserId:   ob.mentor_user_id,
        type:       'onboarding.start_date_changed',
        title:      'Startdatum gewijzigd' + (ob.customer_name ? (' · ' + ob.customer_name) : ''),
        body:       'Nieuwe startdatum: ' + fmtDateNL(raw),
        linkUrl:    '/modules/mentor-onboarding.html',
        entityType: 'onboarding',
        entityId:   onboardingId,
        createdBy:  user.id,
      }).catch(() => {});
    }

    return res.status(200).json({
      ok:              true,
      start_date:      upd.start_date,
      update:          tlrow,
      notification_id: notification_id,
    });
  } catch (e) {
    console.error('[admin-onboarding-start-date]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
