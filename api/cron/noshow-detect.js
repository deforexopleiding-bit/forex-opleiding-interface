// api/cron/noshow-detect.js
//
// Dagelijkse cron — detecteert nieuwe no-shows in Bubble en zet er een
// auto-signal voor in student_signals (type='no_show', source='auto_noshow').
//
// AUTH: Authorization: Bearer ${CRON_SECRET}. 401 zonder.
//
// WATERMARK (app_settings.key='noshow_detect_since', value={ iso }):
//   - ontbreekt -> initialize op nu, return zonder verwerken (geen backfill).
//   - aanwezig  -> query Bubble 1-1-session waar isdone+noshow én
//                  starting_date_date > watermark. Per sessie: mentor +
//                  student resolven; signal inserten met session_id zodat
//                  de unique index de dedup afdwingt. Advance watermark
//                  naar hoogste verwerkte starting_date_date.
//
// Robuust: per-rij try/catch (één fout stopt de batch niet); orphan
// no-shows (geen member_user) overgeslagen.

import { supabaseAdmin } from '../supabase.js';
import { bubbleList, bubbleGet, bubbleUserDisplay } from '../_lib/bubble.js';
import { createNotification } from '../_lib/notify.js';

const SETTING_KEY     = 'noshow_detect_since';
const FETCH_CAP       = 1000;
const SETTING_AUDIT_USER = null; // cron heeft geen user_id

// Defensieve readers voor Bubble's suffix-conventie.
function readFirst(u, keys) {
  if (!u) return undefined;
  for (const k of keys) if (u[k] !== undefined) return u[k];
  return undefined;
}
function asBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string')  return v.toLowerCase() === 'true';
  return false;
}
function isoToMs(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}
function fmtDateNl(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch (e) { return iso; }
}

async function readWatermark() {
  const { data, error } = await supabaseAdmin
    .from('app_settings').select('value').eq('key', SETTING_KEY).maybeSingle();
  if (error) throw new Error('watermark read: ' + error.message);
  if (!data) return null;
  // value kan { iso: '...' } of een string-iso zijn — accepteer beide.
  const v = data.value;
  if (v && typeof v === 'object' && typeof v.iso === 'string') return v.iso;
  if (typeof v === 'string') return v;
  return null;
}
async function writeWatermark(iso) {
  // Upsert via 2-staps SELECT->UPDATE/INSERT (zelfde patroon als
  // app-settings.js, zonder de super_admin gate die voor user-PUT geldt).
  const row = { key: SETTING_KEY, value: { iso }, updated_by_user_id: SETTING_AUDIT_USER };
  const { data: existing } = await supabaseAdmin
    .from('app_settings').select('key').eq('key', SETTING_KEY).maybeSingle();
  if (existing) {
    const { error } = await supabaseAdmin.from('app_settings').update(row).eq('key', SETTING_KEY);
    if (error) throw new Error('watermark update: ' + error.message);
  } else {
    const { error } = await supabaseAdmin.from('app_settings').insert(row);
    if (error) throw new Error('watermark insert: ' + error.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  // AUTH — identiek aan de andere crons.
  const secret = process.env.CRON_SECRET || null;
  const auth   = req.headers['authorization'] || '';
  if (!secret || auth !== ('Bearer ' + secret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const result = {
    ok: true, initialized: false, watermark_before: null, watermark_after: null,
    fetched: 0, inserted: 0, skipped: 0, orphans: 0, errors: [],
  };

  try {
    const watermark = await readWatermark();
    result.watermark_before = watermark;

    // INITIALISATIE — eerste run: zet watermark op nu en stop. Geen backfill
    // van historische no-shows; we tellen alleen vanaf nu.
    if (!watermark) {
      const nowIso = new Date().toISOString();
      await writeWatermark(nowIso);
      result.initialized = true;
      result.watermark_after = nowIso;
      return res.status(200).json(result);
    }

    // Bubble fetch — server-side filter op isdone + noshow + starting_date > watermark.
    // greater-than op date-constraint is strikt in Bubble; we sturen direct de iso door.
    const constraints = [
      { key: 'isdone_boolean',     constraint_type: 'equals',       value: 'true' },
      { key: 'noshow_boolean',     constraint_type: 'equals',       value: 'true' },
      { key: 'starting_date_date', constraint_type: 'greater than', value: watermark },
    ];
    let rows = [];
    try {
      const { results } = await bubbleList('1-1-session', constraints, { limit: FETCH_CAP });
      rows = Array.isArray(results) ? results : [];
    } catch (e) {
      console.error('[noshow-detect] bubble fetch failed:', e?.message || e);
      return res.status(502).json({ ok: false, error: 'bubble fetch failed: ' + (e?.message || e), result });
    }
    result.fetched = rows.length;

    if (rows.length === 0) {
      // Geen nieuwe no-shows — watermark blijft staan (geen advance zonder data).
      result.watermark_after = watermark;
      return res.status(200).json(result);
    }

    // Verwerken — track hoogste verwerkte starting_date_date voor de
    // advance achteraf.
    let highestMs = isoToMs(watermark) || 0;

    for (const row of rows) {
      try {
        const sd        = readFirst(row, ['starting_date_date', 'starting date']) || null;
        const sdMs      = isoToMs(sd);
        const sessionId = String(row?._id || '').trim();
        const done      = asBool(readFirst(row, ['isdone_boolean', 'isDone']));
        const noshow    = asBool(readFirst(row, ['noshow_boolean', 'NoShow']));
        const createdBy = readFirst(row, ['Created By', 'created_by']);
        const memberRaw = readFirst(row, ['member_user']);

        if (!sessionId || !done || !noshow) { result.skipped++; continue; }
        if (!memberRaw || String(memberRaw).trim() === '') {
          result.orphans++; continue;
        }
        if (!createdBy || String(createdBy).trim() === '') {
          // Geen mentor-attributie mogelijk — sla over (zonder mentor kan
          // de signal niet ingevuld worden).
          result.skipped++; continue;
        }
        const memberUser = String(memberRaw).trim();
        const cbBubbleId = String(createdBy).trim();

        // Mentor resolven via team_members (active row wint).
        const { data: tms } = await supabaseAdmin
          .from('team_members')
          .select('user_id, is_active')
          .eq('bubble_user_id', cbBubbleId);
        let mentorUserId = null;
        if (Array.isArray(tms) && tms.length > 0) {
          const active = tms.find((t) => t.is_active !== false);
          mentorUserId = (active || tms[0]).user_id || null;
        }
        if (!mentorUserId) {
          // Geen DB-koppeling voor deze mentor — sla over.
          result.skipped++; continue;
        }

        // Student name/email resolven via bubbleGet. Per-rij try/catch:
        // een 404 of netwerk-probleem voor één student stopt de batch niet.
        let studentName = null, studentEmail = null;
        try {
          const stu = await bubbleGet('user', memberUser);
          if (stu) {
            const disp = bubbleUserDisplay(stu);
            studentName  = disp.name || null;
            studentEmail = disp.email ? String(disp.email).trim().toLowerCase() : null;
          }
        } catch (e) {
          console.warn('[noshow-detect] bubble student fetch failed for', memberUser, ':', e?.message || e);
        }

        // Insert. Unique index op session_id vangt dubbele inserts af; bij
        // 23505 (unique-violation) loggen we niet als error want het is
        // gewoon dedup-gedrag bij een herhaalde run.
        const insertRow = {
          bubble_student_id : memberUser,
          student_name      : studentName,
          student_email     : studentEmail,
          type              : 'no_show',
          source            : 'auto_noshow',
          status            : 'open',
          mentor_user_id    : mentorUserId,
          session_id        : sessionId,
          toelichting       : sd ? ('No-show op ' + fmtDateNl(sd)) : 'No-show',
        };
        const { data: insRow, error: insErr } = await supabaseAdmin
          .from('student_signals').insert(insertRow).select('id').maybeSingle();
        if (insErr) {
          if (insErr.code === '23505') {
            // Bestaat al via session_id-unique — geen fout.
            result.skipped++;
          } else {
            result.errors.push({ session_id: sessionId, error: insErr.message });
            continue;
          }
        } else {
          result.inserted++;
          // Bel-notificatie voor de mentor — fail-soft. 24u dedup op signal-id
          // is niet zinvol (deze insertie IS het triggerpoint); we dedupen op
          // (type, entity_id) binnen 24u zodat een handmatige her-run
          // dezelfde bel niet nog eens laat rinkelen.
          if (mentorUserId && insRow?.id) {
            try {
              await createNotification({
                toUserId:      mentorUserId,
                type:          'student.noshow_review',
                title:         'No-show — geef reden',
                body:          (studentName || 'Student') + ' — geef de reden voor de no-show op',
                linkUrl:       '/modules/mentor-students.html?tab=noshows',
                entityType:    'student_signal',
                entityId:      insRow.id,
                priority:      'high',
                dedupWithinMs: 24 * 60 * 60 * 1000,
              });
            } catch (nErr) {
              console.warn('[noshow-detect] notify fail-soft:', nErr?.message || nErr);
            }
          }
        }

        if (sdMs != null && sdMs > highestMs) highestMs = sdMs;
      } catch (e) {
        const sid = String(row?._id || '');
        console.error('[noshow-detect] row fail', sid, e?.message || e);
        result.errors.push({ session_id: sid, error: e?.message || String(e) });
      }
    }

    // Advance watermark naar hoogste verwerkte starting_date (alleen als
    // we überhaupt iets verwerkt hebben dat boven de oude watermark uitkomt).
    const oldMs = isoToMs(watermark) || 0;
    if (highestMs > oldMs) {
      const nextIso = new Date(highestMs).toISOString();
      try {
        await writeWatermark(nextIso);
        result.watermark_after = nextIso;
      } catch (e) {
        result.errors.push({ error: 'watermark advance failed: ' + (e?.message || e) });
        result.watermark_after = watermark;
      }
    } else {
      result.watermark_after = watermark;
    }

    return res.status(200).json(result);
  } catch (e) {
    console.error('[noshow-detect]', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || 'Interne fout', result });
  }
}
