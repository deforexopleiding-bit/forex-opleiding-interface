// api/mentor-funded-cert-save.js
//
// POST → registreer een funded-certificaat van een student. Bonus wordt
// éénmalig geclaimd in de huidige maand (funded_month) en blijft daar staan
// óók als de mentor het bestand later vervangt.
//
// Permission: mentor.module.access.
//
// Body:
//   { student_id    : string (bubble-ID),
//     student_name  : string (cache voor UI),
//     file_path     : string (Supabase Storage pad, MOET met `${auth.uid()}/` beginnen),
//     file_name     : string (oorspronkelijke filename voor weergave) }
//
// Veiligheid:
//   1) Path-prefix-check: file_path MOET met `${auth.uid()}/` beginnen — een
//      mentor kan zo geen pad in andermans map claimen.
//   2) Eigenaarschap-check via bubble: studentUser.mentor_user moet gelijk
//      zijn aan de bubble_user_id van de ingelogde mentor (zelfde patroon
//      als mentor-student-detail.js).
//
// UPSERT op (mentor_user_id, student_id):
//   INSERT: funded_month = date_trunc('month', now())::date,
//           claimed_at   = now(), last_uploaded_at = now(),
//           created_by   = auth.uid().
//   ON CONFLICT: alleen file_path / file_name / last_uploaded_at / student_name
//   updaten. funded_month + claimed_at NOOIT wijzigen — de bonus blijft
//   1× in de claim-maand.
//
// Response 200: { ok:true, newly_claimed:bool, funded_month, file_path }.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { bubbleGet } from './_lib/bubble.js';

const BUBBLE_ID_RE = /^[A-Za-z0-9_.\-x]{8,128}$/;

function readFirst(u, keys) {
  if (!u) return undefined;
  for (const k of keys) {
    if (u[k] !== undefined) return u[k];
  }
  return undefined;
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
  if (!(await requirePermission(req, 'mentor.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const studentId   = typeof body.student_id   === 'string' ? body.student_id.trim()   : '';
  const studentName = typeof body.student_name === 'string' ? body.student_name.trim() : '';
  const filePath    = typeof body.file_path    === 'string' ? body.file_path.trim()    : '';
  const fileName    = typeof body.file_name    === 'string' ? body.file_name.trim()    : '';

  if (!studentId || !BUBBLE_ID_RE.test(studentId)) {
    return res.status(400).json({ error: 'student_id (bubble-id) vereist' });
  }
  if (!studentName) return res.status(400).json({ error: 'student_name vereist' });
  if (!filePath)    return res.status(400).json({ error: 'file_path vereist' });
  if (!fileName)    return res.status(400).json({ error: 'file_name vereist' });

  // 1) Path-prefix-check: file_path moet met `${auth.uid()}/` beginnen.
  //    Geen `..` toestaan + uid-prefix dwingt af dat mentor alleen z'n eigen
  //    map kan claimen via dit endpoint.
  if (filePath.includes('..') || !filePath.startsWith(user.id + '/')) {
    return res.status(403).json({ error: 'file_path moet met je eigen mentor-id beginnen' });
  }

  try {
    // 2) Resolve bubble_user_id voor eigenaarschap-check.
    const { data: tm, error: tmErr } = await supabaseAdmin
      .from('team_members')
      .select('bubble_user_id, is_active')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .maybeSingle();
    if (tmErr) throw new Error('team_members lookup: ' + tmErr.message);
    if (!tm?.bubble_user_id) {
      return res.status(403).json({ error: 'Mentor heeft geen bubble-koppeling' });
    }

    // OWNERSHIP-CHECK: bubbleGet('user', student_id) en valideer mentor.
    const studentUser = await bubbleGet('user', studentId);
    if (!studentUser) return res.status(404).json({ error: 'Student niet gevonden' });
    const ownerMentor = String(readFirst(studentUser, ['mentor_user', 'mentor']) || '').trim();
    if (!ownerMentor || ownerMentor !== tm.bubble_user_id) {
      return res.status(403).json({ error: 'Student valt niet onder jouw mentorschap' });
    }

    // 3) UPSERT. Eerst proberen we te INSERT'en met returning='representation'
    //    om newly_claimed te bepalen. Bij conflict → ON CONFLICT UPDATE met
    //    beperkt veld-set (funded_month en claimed_at NIET in update).
    //
    //    PostgREST onConflict + ignoreDuplicates kan dit met UPSERT, maar
    //    we willen specifiek weten of het rij nieuw was. Aanpak: SELECT
    //    bestaande rij eerst; daarna UPDATE óf INSERT.
    const { data: existing, error: selErr } = await supabaseAdmin
      .from('mentor_funded_certificates')
      .select('id, funded_month, file_path')
      .eq('mentor_user_id', user.id)
      .eq('student_id', studentId)
      .maybeSingle();
    if (selErr) throw new Error('cert lookup: ' + selErr.message);

    const nowIso = new Date().toISOString();
    if (existing) {
      // UPDATE — funded_month en claimed_at ongemoeid laten.
      const { error: updErr } = await supabaseAdmin
        .from('mentor_funded_certificates')
        .update({
          student_name     : studentName,
          file_path        : filePath,
          file_name        : fileName,
          last_uploaded_at : nowIso,
        })
        .eq('id', existing.id);
      if (updErr) throw new Error('cert update: ' + updErr.message);

      return res.status(200).json({
        ok            : true,
        newly_claimed : false,
        funded_month  : existing.funded_month,
        file_path     : filePath,
      });
    }

    // INSERT — eerste claim. funded_month = date_trunc('month', now())::date.
    // We berekenen dit server-side in UTC zodat de timezone consistent is.
    const now = new Date();
    const y = now.getUTCFullYear();
    const mo = String(now.getUTCMonth() + 1).padStart(2, '0');
    const fundedMonth = `${y}-${mo}-01`;

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('mentor_funded_certificates')
      .insert({
        mentor_user_id   : user.id,
        student_id       : studentId,
        student_name     : studentName,
        file_path        : filePath,
        file_name        : fileName,
        funded_month     : fundedMonth,
        claimed_at       : nowIso,
        last_uploaded_at : nowIso,
        created_by       : user.id,
      })
      .select('funded_month, file_path')
      .single();
    if (insErr) throw new Error('cert insert: ' + insErr.message);

    return res.status(200).json({
      ok            : true,
      newly_claimed : true,
      funded_month  : inserted.funded_month,
      file_path     : inserted.file_path,
    });
  } catch (e) {
    console.error('[mentor-funded-cert-save]', e?.message || e);
    if (e?.code === 'BUBBLE_CONFIG_MISSING') {
      return res.status(503).json({ error: 'Bubble-koppeling niet geconfigureerd (env)' });
    }
    if (e?.code === 'BUBBLE_NETWORK' || (typeof e?.code === 'string' && e.code.startsWith('BUBBLE_HTTP_'))) {
      return res.status(502).json({ error: e.message });
    }
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
