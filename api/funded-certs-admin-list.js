// api/funded-certs-admin-list.js
//
// GET → admin-lijst van ALLE funded-certificaten met mentor-naam (uit
// team_members), studentnaam, funded_month, last_uploaded_at en een
// SIGNED download-URL (1u geldig). Sorteer nieuwste upload eerst.
//
// Permission: mentor.funded.admin.
//
// Query:
//   ?mentor_user_id=<uuid>   (optioneel — filter op één mentor)
//
// Response 200:
//   { ok, certs: [ {
//       id, mentor_user_id, mentor_name, mentor_email,
//       student_id, student_name, funded_month,
//       file_name, file_path, last_uploaded_at,
//       download_url   // signed URL, 3600s geldig
//   } ] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE       = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORAGE_BUCKET = 'funded-certificates';
const SIGNED_TTL_S   = 3600;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'mentor.funded.admin'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.funded.admin)' });
  }

  const filterMentorId = typeof req.query?.mentor_user_id === 'string'
    ? req.query.mentor_user_id.trim() : '';
  if (filterMentorId && !UUID_RE.test(filterMentorId)) {
    return res.status(400).json({ error: 'mentor_user_id (uuid) ongeldig' });
  }

  try {
    let q = supabaseAdmin
      .from('mentor_funded_certificates')
      .select('id, mentor_user_id, student_id, student_name, funded_month, file_name, file_path, last_uploaded_at')
      .order('last_uploaded_at', { ascending: false })
      .limit(500);
    if (filterMentorId) q = q.eq('mentor_user_id', filterMentorId);
    const { data: certs, error: certErr } = await q;
    if (certErr) throw new Error('certs fetch: ' + certErr.message);

    const rows = certs || [];

    // Mentor naam/email per uniek mentor_user_id ophalen (zelfde patroon als
    // mentor-payouts-admin-list: aparte lookup omdat team_members geen FK
    // heeft naar deze tabel).
    const mentorIds = Array.from(new Set(rows.map((r) => r.mentor_user_id).filter(Boolean)));
    const nameMap  = new Map();
    const emailMap = new Map();
    if (mentorIds.length > 0) {
      const { data: tmRows, error: tmErr } = await supabaseAdmin
        .from('team_members')
        .select('user_id, name, email')
        .in('user_id', mentorIds);
      if (tmErr) throw new Error('team_members fetch: ' + tmErr.message);
      for (const r of (tmRows || [])) {
        if (r.user_id) {
          if (r.name)  nameMap.set(r.user_id, r.name);
          if (r.email) emailMap.set(r.user_id, r.email);
        }
      }
    }

    // Signed URLs per rij ophalen. Sequentieel om de Storage-roundtrips te
    // begrenzen — 500 is hard limit op de query. Fout op één signed URL
    // mag de hele lijst niet sloppen → fail-soft per rij.
    const out = [];
    for (const r of rows) {
      let downloadUrl = null;
      try {
        const { data: signed, error: sigErr } = await supabaseAdmin
          .storage
          .from(STORAGE_BUCKET)
          .createSignedUrl(r.file_path, SIGNED_TTL_S);
        if (sigErr) {
          console.warn('[funded-certs-admin-list] signed URL faalde voor', r.file_path, sigErr.message);
        } else {
          downloadUrl = signed?.signedUrl || null;
        }
      } catch (e) {
        console.warn('[funded-certs-admin-list] signed URL exception voor', r.file_path, e?.message || e);
      }
      out.push({
        id              : r.id,
        mentor_user_id  : r.mentor_user_id,
        mentor_name     : nameMap.get(r.mentor_user_id)  || null,
        mentor_email    : emailMap.get(r.mentor_user_id) || null,
        student_id      : r.student_id,
        student_name    : r.student_name || null,
        funded_month    : r.funded_month,
        file_name       : r.file_name || null,
        file_path       : r.file_path,
        last_uploaded_at: r.last_uploaded_at,
        download_url    : downloadUrl,
      });
    }

    return res.status(200).json({ ok: true, certs: out });
  } catch (e) {
    console.error('[funded-certs-admin-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
