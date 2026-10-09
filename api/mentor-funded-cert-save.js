// api/mentor-funded-cert-save.js
//
// POST → registreer een funded-certificaat van een student. Bonus wordt
// éénmalig geclaimd in de huidige maand (funded_month) en blijft daar staan
// óók als de mentor het bestand later vervangt.
//
// Permission: mentor.module.access.
//
// Body:
//   { student_id    : string (studentsleutel — zie api/_lib/mentorStudents.js),
//     student_name  : string (cache voor UI),
//     file_path     : string (Supabase Storage pad, MOET met `${auth.uid()}/` beginnen),
//     file_name     : string (oorspronkelijke filename voor weergave) }
//
// Veiligheid:
//   1) Path-prefix-check: file_path MOET met `${auth.uid()}/` beginnen — een
//      mentor kan zo geen pad in andermans map claimen.
//   2) Eigenaarschap-check via het LMS (sinds 9 okt 2026, was Bubble):
//      hlms_student.mentor_id van deze student moet het hlms_personeel-id
//      van de ingelogde mentor zijn (e-mailbrug team_members ↔ hlms_personeel).
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
import { isStudentVanMentor } from './_lib/mentorStudents.js';

// Studentsleutel: oud id (cijfers + 'x') of een LMS-uuid.
const STUDENT_ID_RE = /^[A-Za-z0-9_.\-x]{8,128}$/;

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

  if (!studentId || !STUDENT_ID_RE.test(studentId)) {
    return res.status(400).json({ error: 'student_id vereist' });
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
    // 2) OWNERSHIP-CHECK in het LMS: hoort deze student bij deze mentor?
    const eigen = await isStudentVanMentor(user.id, studentId);
    if (!eigen.ok) {
      const nietGevonden = /niet gevonden/.test(eigen.reden || '');
      return res.status(nietGevonden ? 404 : 403).json({ error: eigen.reden || 'Student valt niet onder jouw mentorschap' });
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
    if (e?.code === 'DFO_LMS_ONBEREIKBAAR') return res.status(503).json({ error: e.message });
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
