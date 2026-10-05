// api/_lib/lms-mentor-brug.js
//
// DE BRUG TERUG: van het LMS naar het CRM (5 oktober 2026).
//
// De spiegel CRM → LMS vertaalt een mentor al via zijn e-mailadres
// (team_members.email → hlms_personeel.email, zie onboarding-spiegel.js).
// Voor Hoofdmentor > Onboarding in het LMS moet het ook andersom: de
// hoofdmentor kiest in het LMS een mentor (een hlms_personeel-id), en het CRM
// moet weten welke team_members.user_id dat is. Zelfde sleutel, zelfde regel:
// precies één actieve match op lower(email), anders NIETS — gokken over wie de
// mentor van een student wordt, doen we niet.

import { supabaseAdmin } from '../supabase.js';
import { getDfoLmsClient } from './dfo-lms-db.js';

function mail(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/**
 * De actieve mentoren van het CRM, met hun LMS-id erbij (of null + reden).
 * Gooit als team_members niet te lezen is; een onleesbaar LMS geeft
 * `lms_id: null` met reden `lms-onbereikbaar`.
 * @returns {Promise<Array<{user_id, name, email, lms_id, reden}>>}
 */
export async function mentorenMetLmsId() {
  const { data: tm, error } = await supabaseAdmin
    .from('team_members')
    .select('user_id, name, email, is_active, type')
    .eq('type', 'mentor')
    .eq('is_active', true);
  if (error) throw new Error('team_members lezen: ' + error.message);

  let personeel = null;
  const lms = getDfoLmsClient();
  if (lms) {
    const { data, error: pErr } = await lms.from('hlms_personeel').select('id, email, actief');
    if (!pErr) personeel = data || [];
    else console.warn('[lms-mentor-brug] hlms_personeel lezen: ' + pErr.message);
  }

  return (tm || [])
    .filter((r) => r.user_id)
    .map((r) => {
      const e = mail(r.email);
      if (!e) return { user_id: r.user_id, name: r.name || null, email: null, lms_id: null, reden: 'mentor-zonder-email' };
      if (!personeel) return { user_id: r.user_id, name: r.name || null, email: e, lms_id: null, reden: 'lms-onbereikbaar' };
      const hits = personeel.filter((p) => mail(p.email) === e && p.actief !== false);
      if (hits.length === 1) return { user_id: r.user_id, name: r.name || null, email: e, lms_id: hits[0].id, reden: null };
      return {
        user_id: r.user_id, name: r.name || null, email: e, lms_id: null,
        reden: hits.length === 0 ? 'mentor-niet-in-lms' : 'meerdere-lms-mentors',
      };
    })
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'nl'));
}

/**
 * Welke CRM-mentor hoort bij dit LMS-id? `null` als er niet precies één is.
 */
export async function crmMentorVoorLmsId(lmsId) {
  if (!lmsId) return null;
  const lijst = await mentorenMetLmsId();
  const hits = lijst.filter((m) => m.lms_id === lmsId);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Welke CRM-gebruiker (profiles.id) hoort bij dit e-mailadres? Voor "door
 * wie" op de tijdlijn. `null` als er niet precies één actieve is — dan staat
 * de handeling op naam van niemand, en zegt de notitie wie het in het LMS was.
 */
export async function crmGebruikerVoorEmail(email) {
  const e = mail(email);
  if (!e) return null;
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, email, full_name, is_active');
  if (error) {
    console.warn('[lms-mentor-brug] profiles lezen: ' + error.message);
    return null;
  }
  const hits = (data || []).filter((p) => mail(p.email) === e && p.is_active !== false);
  return hits.length === 1 ? { id: hits[0].id, naam: hits[0].full_name || null } : null;
}
