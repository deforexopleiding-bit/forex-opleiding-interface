// api/cron/noshow-detect.js
//
// Dagelijkse cron — detecteert nieuwe no-shows in het LMS (hlms_sessie met
// status 'no_show') en zet er een auto-signal voor in student_signals
// (type='no_show', source='auto_noshow').
//
// ── BRON: hlms_sessie in dfo-lms (NIET meer Bubble) ──────────────────────
// De mentoren werken sinds augustus 2026 in het nieuwe LMS. Deze cron keek
// nog naar Bubble, vond daar niets, en sloot elke ochtend gezond af met
// `fetched: 0` — terwijl er geen enkel no-show-signaal meer ontstond en dus
// ook geen mentor-melding. Niet leeg, maar blind.
//
// Daarom draagt de uitkomst nu `bron_status`. Een mislukte bevraging eindigt
// met ok:false en een 502 ZONDER het watermerk te verzetten; alleen bij
// `bron_status: 'gelezen'` betekent `fetched: 0` echt dat er geen nieuwe
// no-shows waren.
//
// ── DE TWEE KOPPELINGEN ──────────────────────────────────────────────────
//   student → CRM : hlms_student.bubble_user_id (299 van de 304 rijen dragen
//                   'm en die waarden zijn uniek; gemeten 7-9-2026). Die
//                   waarde gaat in student_signals.bubble_student_id, dat
//                   daardoor gewoon blijft werken.
//   mentor  → CRM : op E-MAILADRES (hlms_personeel.email ↔ team_members.email),
//                   want het LMS kent geen 'Created By' zoals Bubble. De
//                   toerekening loopt daar via mentor_id, wat eerlijker is:
//                   niet wie de rij aanmaakte, maar wiens sessie het was.
//
// AUTH: Authorization: Bearer ${CRON_SECRET}. 401 zonder.
//
// WATERMARK (app_settings.key='noshow_detect_since', value={ iso }):
//   - ontbreekt -> initialize op nu, return zonder verwerken (geen backfill).
//   - aanwezig  -> query hlms_sessie waar status='no_show' én start_tijd >
//                  watermark. Per sessie: mentor + student resolven; signal
//                  inserten met session_id zodat de unique index de dedup
//                  afdwingt. Advance watermark naar hoogste verwerkte
//                  start_tijd.
//
// Robuust: per-rij try/catch (één fout stopt de batch niet). De oude
// wees-tak voor no-shows zonder gekoppelde student is vervallen:
// hlms_sessie.student_id is nooit leeg (0 van 44 gemeten).

import { supabaseAdmin } from '../supabase.js';
import { haalNoShowsSinds, haalEersteSessiePerStudent, BRON_GELEZEN } from '../_lib/dfo-lms-sessies.js';
import { createNotification, resolveOntvangersVoorRecht } from '../_lib/notify.js';

const SETTING_KEY     = 'noshow_detect_since';
const FETCH_CAP       = 1000;
const SETTING_AUDIT_USER = null; // cron heeft geen user_id

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
    // BRON expliciet in de uitkomst. Zonder dit is 'fetched: 0' niet te
    // onderscheiden van een mislukte bevraging — precies waardoor deze cron
    // maandenlang gezond leek terwijl er geen enkel signaal meer ontstond.
    bron: 'hlms_sessie', bron_status: null,
    fetched: 0, inserted: 0, skipped: 0,
    // Hoeveel van de signalen gingen over de EERSTE sessie van een student.
    eerste_call: 0, eerste_bepaling_mislukt: 0,
    // Hoofdmentoren die bericht kregen over een gemiste eerste call, en
    // hoe vaak er NIEMAND te vinden was. Dat laatste mag nooit stil zijn.
    hoofdmentor_ontvangers: 0, eerste_call_zonder_ontvanger: 0,
    zonder_bubble_koppeling: 0, zonder_mentor_koppeling: 0,
    errors: [],
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

    // ── BRON: hlms_sessie met status 'no_show' ───────────────────────────
    // Voorheen Bubble-'1-1-session' met isdone+noshow. De mentoren werken
    // sinds augustus 2026 in het LMS, dus die bron liep leeg en er ontstond
    // geen enkel signaal meer — terwijl de cron elke ochtend gezond afsloot.
    const bron = await haalNoShowsSinds({ sindsIso: watermark, limiet: FETCH_CAP });
    result.bron_status              = bron.bron_status;
    result.zonder_bubble_koppeling  = bron.zonder_bubble_koppeling;
    result.zonder_mentor_koppeling  = bron.zonder_mentor;

    // MISLUKTE BEVRAGING IS GEEN LEGE UITKOMST. Stoppen zonder het watermerk
    // te verzetten, zodat een storing niet stilzwijgend no-shows overslaat.
    if (bron.bron_status !== BRON_GELEZEN) {
      result.ok = false;
      result.error = 'no-shows niet gelezen (' + bron.bron_status + '): '
        + (bron.fout || 'reden onbekend');
      console.error('[noshow-detect]', result.error);
      return res.status(502).json(result);
    }

    const rows = bron.sessies;
    result.fetched = rows.length;

    if (rows.length === 0) {
      // De bron IS gelezen: er zijn echt geen nieuwe no-shows. Watermerk
      // blijft staan (geen advance zonder data).
      result.watermark_after = watermark;
      return res.status(200).json(result);
    }

    // Mentoren één keer ophalen: de brug tussen LMS en CRM loopt via het
    // e-mailadres (hlms_personeel.email ↔ team_members.email). Bewust geen
    // .ilike() per rij: `_` en `%` zijn jokertekens in een LIKE-patroon en
    // `_` is geldig in een e-mailadres. Vergelijken doen we in JS.
    const mentorByEmail = new Map();
    try {
      const { data: tms, error: tmErr } = await supabaseAdmin
        .from('team_members')
        .select('user_id, email, is_active')
        .eq('is_active', true);
      if (tmErr) throw new Error(tmErr.message);
      for (const t of (tms || [])) {
        const e = String(t?.email || '').trim().toLowerCase();
        if (e && t.user_id && !mentorByEmail.has(e)) mentorByEmail.set(e, t.user_id);
      }
    } catch (e) {
      const msg = 'team_members lezen mislukt: ' + (e?.message || e);
      console.error('[noshow-detect]', msg);
      result.ok = false;
      result.error = msg;
      return res.status(502).json(result);
    }

    // Was dit de EERSTE sessie van deze student? Dan krijgt het signaal een
    // eigen type. De reden is een andere: bij een gemiste eerste call moet er
    // iemand kort op zitten om te voorkomen dat het een wanbetaler wordt.
    //
    // Bewust GEEN tweede signaal naast het gewone: er staat een unique index
    // op student_signals.session_id, dus twee signalen voor dezelfde sessie
    // kan sowieso niet — en het zou de mentor ook twee keer laten rinkelen
    // voor één gebeurtenis. Eén signaal, met een type dat het onderscheid
    // draagt, is zowel juister als routeerbaar zodra de rol 'hoofdmentor'
    // bestaat.
    const eerste = await haalEersteSessiePerStudent({
      studentIds: rows.map((r) => r.student_id).filter(Boolean),
    });
    const eersteBekend = eerste.bron_status === BRON_GELEZEN;
    if (!eersteBekend) {
      // Niet blokkeren: liever een gewoon no-show-signaal dan geen signaal.
      // Wel zichtbaar tellen, want dan mist er een onderscheid dat we wilden.
      console.warn('[noshow-detect] eerste-sessie niet te bepalen ('
        + eerste.bron_status + '): ' + (eerste.fout || 'reden onbekend'));
    }

    // ── ONTVANGERS VAN HET EERSTE-CALL-SIGNAAL ────────────────────────────
    // Een gemiste EERSTE call gaat NIET naar de mentor van die sessie maar
    // naar de hoofdmentor. Die rol bestaat nog niet in het LMS, en
    // `profiles.role` is enkelvoudig — iemand 'hoofdmentor' maken zou zijn
    // huidige rol wegnemen. Daarom adresseren we op een RECHT: geef het aan
    // een rol zodra die er is, of nu aan de betrokken personen. Zie
    // resolveOntvangersVoorRecht() in api/_lib/notify.js.
    const HOOFDMENTOR_RECHT = 'signals.hoofdmentor.receive';
    const hoofdmentoren = await resolveOntvangersVoorRecht(HOOFDMENTOR_RECHT);
    result.hoofdmentor_ontvangers = hoofdmentoren.userIds.length;
    if (!hoofdmentoren.ok || hoofdmentoren.userIds.length === 0) {
      console.warn('[noshow-detect] NIEMAND heeft het recht ' + HOOFDMENTOR_RECHT
        + (hoofdmentoren.error ? (' (' + hoofdmentoren.error + ')') : '')
        + ' — een gemiste eerste call levert dan wel een signaal op, maar geen bericht.');
    }

    // Verwerken — hoogste verwerkte start_tijd bijhouden voor de advance.
    let highestMs = isoToMs(watermark) || 0;

    for (const row of rows) {
      try {
        const sessionId    = row.id;
        const sd           = row.start_tijd || null;
        const sdMs         = isoToMs(sd);
        const memberUser   = row.bubble_user_id;   // de brug naar het CRM
        const studentEmail = row.email || null;
        const studentName  = [row.voornaam, row.achternaam].filter(Boolean).join(' ').trim() || null;

        const eersteVanStudent = eersteBekend
          ? (eerste.perStudent.get(String(row.student_id)) || null)
          : null;
        const isEersteCall = !!(eersteVanStudent && eersteVanStudent.id === sessionId);
        if (!eersteBekend) result.eerste_bepaling_mislukt++;

        const mentorUserId = mentorByEmail.get(row.mentor_email) || null;
        if (!mentorUserId) {
          // Mentor bestaat in het LMS maar niet als actief teamlid in het
          // CRM. Zonder mentor kan het signaal niet ingevuld worden.
          console.warn('[noshow-detect] geen CRM-mentor voor', row.mentor_email);
          result.zonder_mentor_koppeling++;
          result.skipped++;
          continue;
        }

        // Insert. Unique index op session_id vangt dubbele inserts af; bij
        // 23505 (unique-violation) loggen we niet als error want het is
        // gewoon dedup-gedrag bij een herhaalde run.
        const insertRow = {
          bubble_student_id : memberUser,
          student_name      : studentName,
          student_email     : studentEmail,
          // Eigen type voor een gemiste EERSTE call — zie de toelichting
          // hierboven. De routering naar de hoofdmentor kan hierop gezet
          // worden zodra die rol bestaat.
          type              : isEersteCall ? 'eerste_call_no_show' : 'no_show',
          source            : 'auto_noshow',
          status            : 'open',
          mentor_user_id    : mentorUserId,
          session_id        : sessionId,
          toelichting       : (isEersteCall ? 'EERSTE call gemist' : 'No-show')
            + (sd ? (' op ' + fmtDateNl(sd)) : '')
            + (isEersteCall ? ' — kort opvolgen, voorkom dat dit een wanbetaler wordt.' : ''),
        };
        if (isEersteCall) result.eerste_call++;
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
          if (insRow?.id) {
            // WIE er bericht krijgt hangt af van WELKE no-show dit is.
            //
            // Gemiste EERSTE call → de hoofdmentor, niet de mentor van de
            // sessie. Er moet iemand kort op zitten om te voorkomen dat dit
            // een wanbetaler wordt, en dat is een andere verantwoordelijkheid
            // dan het opvolgen van een gewone no-show.
            //
            // Geen terugval op de sessie-mentor als er geen hoofdmentor
            // gevonden wordt: dan zou het bericht alsnog belanden waar het
            // uitdrukkelijk NIET heen mag. Het signaal zelf staat er wel, en
            // is zichtbaar voor iedereen met students.all.view.
            const ontvangers = isEersteCall
              ? hoofdmentoren.userIds
              : (mentorUserId ? [mentorUserId] : []);

            if (isEersteCall && ontvangers.length === 0) {
              result.eerste_call_zonder_ontvanger++;
              console.error('[noshow-detect] gemiste eerste call zonder ontvanger — '
                + 'signaal ' + insRow.id + ' staat er wel, maar er ging geen bericht uit');
            }

            for (const ontvanger of ontvangers) {
              try {
                await createNotification({
                  toUserId:      ontvanger,
                  type:          isEersteCall ? 'student.eerste_call_no_show' : 'student.noshow_review',
                  title:         isEersteCall ? 'EERSTE call gemist — kort opvolgen' : 'No-show — geef reden',
                  body:          isEersteCall
                    ? ((studentName || 'Student') + ' miste de eerste call. Kort opvolgen om te voorkomen dat dit een wanbetaler wordt.')
                    : ((studentName || 'Student') + ' — geef de reden voor de no-show op'),
                  // WAAR de ontvanger heen moet verschilt per soort.
                  // De No-shows-tab van de mentor toont alleen type='no_show'
                  // en alleen de eigen studenten — een gemiste eerste call
                  // staat daar dus niet in, en de hoofdmentor is niet per se
                  // de mentor van die student. Die gaat naar Aandachtspunten,
                  // waar het signaal wél staat en afgehandeld kan worden.
                  linkUrl:       isEersteCall
                    ? '/modules/students-overview.html?tab=signals'
                    : '/modules/mentor-students.html?tab=noshows',
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
        }

        if (sdMs != null && sdMs > highestMs) highestMs = sdMs;
      } catch (e) {
        const sid = String(row?.id || '');
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
