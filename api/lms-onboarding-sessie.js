// api/lms-onboarding-sessie.js
//
// Machine-route voor het LMS (dfo-lms): een mentor heeft net een sessie
// AFGEROND — sluit de onboarding van die student nu af, niet pas morgen om
// 07:00. Server-naar-server, GEEN CORS: het geheim mag nooit in een browser.
//
//   POST { actie: 'sessie_afgerond', student_id, sessie_id? }
//   POST { actie: 'startdatum', student_id, start_datum: 'YYYY-MM-DD', notitie? }
//
// En op ONBOARDING-id (Hoofdmentor > Onboarding in het LMS, 5 oktober 2026),
// telkens met `door_email` = wie het in het LMS deed:
//   POST { actie: 'mentor_toewijzen', onboarding_id, mentor_lms_id | null, door_email }
//   POST { actie: 'startdatum',       onboarding_id, start_datum, door_email }
//   POST { actie: 'startstatus',      onboarding_id, status | null, notitie?, door_email }
//   POST { actie: 'notitie',          onboarding_id, tekst, door_email }
//   POST { actie: 'handmatig_afronden', onboarding_id, reden, door_email }  (6 okt 2026)
//   POST { actie: 'naar_incasso',       onboarding_id, reden, door_email }       (6 okt 2026)
//   POST { actie: 'terug_activeren',    onboarding_id, start_datum, door_email } (6 okt 2026)
// Die lopen door DEZELFDE functies als de CRM-schermen
// (api/_lib/onboarding-acties.js): dezelfde controles, dezelfde meldingen aan
// mentoren, dezelfde spiegel. Annuleren en archiveren kunnen hier NIET — die
// blijven in het CRM (onomkeerbaar, en ze raken Teamleader en Bubble).
//
// De tweede actie hoort bij "Start later op" (opdracht 5 oktober 2026): de
// hoofdmentor keurt in het LMS goed, en de onboarding hier krijgt dezelfde
// startdatum. Zie api/_lib/onboarding-startdatum-lms.js.
//
// Auth: header `x-dfo-secret`. Geldig is DFO_LMS_PUSH_SECRET (het geheim dat
// CRM en LMS al delen voor de accountaanmaak) of DFO_LMS_AGENDA_SECRET (de
// agendabrug). Is geen van beide ingesteld, dan is de route dicht (503).
//
// ── WAT DE ROUTE NIET GELOOFT ────────────────────────────────────────────
// Het LMS zegt alleen OVER WIE het gaat. Of er écht een afgeronde sessie is,
// en welke de eerste was, leest deze route zelf in hlms_sessie. Een
// verkeerd of vervalst verzoek kan dus niets afsluiten wat de databank niet
// draagt — hooguit vroeger dan de cron het had gedaan.
//
// ── IDEMPOTENT EN FAALZACHT ──────────────────────────────────────────────
// Twee keer aanroepen sluit één keer af (de wacht zit in de update zelf, zie
// api/_lib/onboarding-afsluiten-na-sessie.js). De cron van 07:00 blijft
// draaien als bodem: wat hier misgaat, haalt die morgen in. Het LMS wacht
// niet op dit antwoord om de mentor verder te laten.
//
// Antwoordvorm, altijd: { ok, code, message, data } — programmeer op `code`.

import { supabaseAdmin } from './supabase.js';
import { getDfoLmsClient } from './_lib/dfo-lms-db.js';
import { geheimKlopt } from './_lib/lms-agenda-brug.js';
import { haalSessieTitels } from './_lib/dfo-lms-sessies.js';
import { createNotification, resolveOntvangersVoorRecht } from './_lib/notify.js';
import { spiegelOnboarding } from './_lib/onboarding-spiegel.js';
import {
  AFSLUITEN, besluitAfsluiting, sluitOnboardingAf, vindOnboardingVoorStudent,
} from './_lib/onboarding-afsluiten-na-sessie.js';
import {
  besluitStartdatum, datumNL, SD_WIJZIGEN, SD_TE_VROEG,
} from './_lib/onboarding-startdatum-lms.js';
import {
  wijsMentorToe, zetStartdatumOnboarding, zetStartstatus, schrijfOnboardingNotitie,
} from './_lib/onboarding-acties.js';
import { rondOnboardingHandmatigAf } from './_lib/onboarding-handmatig.js';
import { zetNaarIncasso, activeerUitIncasso } from './_lib/onboarding-incasso.js';
import { crmMentorVoorLmsId, crmGebruikerVoorEmail } from './_lib/lms-mentor-brug.js';

/** De acties die op een onboarding-id werken (en niet op een student-id). */
export const ONBOARDING_ACTIES = new Set(['mentor_toewijzen', 'startdatum', 'startstatus', 'notitie', 'handmatig_afronden', 'naar_incasso', 'terug_activeren']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function antwoord(res, status, ok, code, message, data = null) {
  return res.status(status).json({ ok, code, message, data });
}

/** Klopt het aangeboden geheim met één van de twee gedeelde geheimen? */
export function machineToegang(aangeboden, env = process.env) {
  const kandidaten = [env.DFO_LMS_PUSH_SECRET, env.DFO_LMS_AGENDA_SECRET]
    .filter((g) => typeof g === 'string' && g.length > 0);
  if (kandidaten.length === 0) return 'niet_geconfigureerd';
  const a = typeof aangeboden === 'string' ? aangeboden : '';
  return kandidaten.some((g) => geheimKlopt(a, g)) ? 'ok' : 'dicht';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const toegang = machineToegang(req.headers['x-dfo-secret']);
  if (toegang === 'niet_geconfigureerd') {
    console.error('[lms-onboarding-sessie] geen DFO_LMS_PUSH_SECRET/AGENDA_SECRET — route dicht');
    return antwoord(res, 503, false, 'niet_geconfigureerd', 'De onboardingbrug is niet geconfigureerd.');
  }
  if (toegang !== 'ok') {
    return antwoord(res, 403, false, 'machine_toegang_dicht', 'Geen toegang tot de onboardingbrug.');
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return antwoord(res, 405, false, 'methode_niet_toegestaan', 'Alleen POST is toegestaan.');
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const actie = String(body?.actie || '');
  const studentId = String(body?.student_id || '').trim();
  const onboardingId = String(body?.onboarding_id || '').trim();
  if (actie !== 'sessie_afgerond' && !ONBOARDING_ACTIES.has(actie)) {
    return antwoord(res, 400, false, 'ongeldige_actie',
      'Onbekende actie. Verwacht: sessie_afgerond, startdatum, mentor_toewijzen, startstatus, notitie, handmatig_afronden, naar_incasso of terug_activeren.');
  }
  // DE ONBOARDING-ACTIES: op onboarding-id. `startdatum` met een student-id
  // blijft de oude weg (start later op, PR6).
  if (ONBOARDING_ACTIES.has(actie) && (actie !== 'startdatum' || onboardingId)) {
    if (!UUID_RE.test(onboardingId)) {
      return antwoord(res, 400, false, 'ongeldig_verzoek', 'onboarding_id ontbreekt of is geen uuid.');
    }
    return onboardingActie(res, actie, onboardingId, body);
  }
  if (!UUID_RE.test(studentId)) {
    return antwoord(res, 400, false, 'ongeldig_verzoek', 'student_id ontbreekt of is geen uuid.');
  }

  const lms = getDfoLmsClient();
  if (!lms) {
    return antwoord(res, 503, false, 'lms_niet_geconfigureerd', 'DFO_LMS_SUPABASE_URL/KEY ontbreekt.');
  }

  if (actie === 'startdatum') return zetStartdatum(res, lms, studentId, body);

  try {
    // 1) De EERSTE afgeronde sessie van deze student — uit de databank, niet
    //    uit het verzoek.
    const { data: rijen, error: sErr } = await lms
      .from('hlms_sessie')
      .select('id, start_tijd, status, student_id')
      .eq('student_id', studentId)
      .eq('status', 'afgerond')
      .order('start_tijd', { ascending: true })
      .limit(1);
    if (sErr) throw new Error('hlms_sessie lezen: ' + sErr.message);
    const eerste = (rijen || [])[0];
    if (!eerste?.id || !eerste?.start_tijd) {
      return antwoord(res, 200, true, 'geen_afgeronde_sessie',
        'Deze student heeft (nog) geen afgeronde sessie; er is niets afgesloten.');
    }
    const titels = await haalSessieTitels({ sessieIds: [String(eerste.id)], client: lms });
    const sess = {
      id: String(eerste.id),
      start_tijd: new Date(eerste.start_tijd).toISOString(),
      titel: titels.titels?.get(String(eerste.id)) || null,
    };

    // 2) De onboarding: eerst op student-id, dan op Bubble-id.
    const { data: stu } = await lms
      .from('hlms_student').select('id, bubble_user_id').eq('id', studentId).maybeSingle();
    const { ob, via } = await vindOnboardingVoorStudent(supabaseAdmin, {
      studentId, bubbleUserId: stu?.bubble_user_id || null,
    });

    const besluit = besluitAfsluiting(ob);
    if (besluit !== AFSLUITEN) {
      // Ook dan de spiegel bijwerken: zegt het CRM "afgerond" en het LMS nog
      // "bezig", dan klopt het scherm van de mentor niet.
      if (ob?.id) await spiegelOnboarding(ob.id);
      return antwoord(res, 200, true, besluit, 'Er viel niets af te sluiten.', {
        onboarding_id: ob?.id || null, via,
      });
    }

    // 3) Afsluiten — met de wacht in de update zelf.
    const gesloten = await sluitOnboardingAf(supabaseAdmin, ob, sess);
    if (!gesloten) {
      return antwoord(res, 200, true, 'al_automatisch', 'Een andere ronde sloot hem net af.', {
        onboarding_id: ob.id, via,
      });
    }

    // 4) De spiegel meteen bij, en de hoofdmentoren een melding (faalzacht,
    //    dezelfde melding als de cron, met dezelfde ontdubbeling).
    const spiegel = await spiegelOnboarding(ob.id);
    await meldHoofdmentoren(ob, sess);

    return antwoord(res, 200, true, 'afgesloten', 'Onboarding afgesloten door de eerste afgeronde sessie.', {
      onboarding_id: ob.id, via, sessie_id: sess.id, spiegel: spiegel?.resultaat || null,
    });
  } catch (e) {
    console.error('[lms-onboarding-sessie]', e?.message || e);
    return antwoord(res, 500, false, 'fout',
      'Er ging iets mis in het CRM; de ochtendronde haalt het in.');
  }
}

/**
 * START LATER OP — de startdatum van de onboarding van deze student.
 *
 * Dezelfde ondergrens als de knop in het CRM (vandaag + 3). Een te vroege dag
 * is een 422 met `min` erbij, zodat het LMS de grens in woorden kan tonen.
 * Wat er al stond, blijft staan: dezelfde dag twee keer is `ongewijzigd`.
 */
async function zetStartdatum(res, lms, studentId, body) {
  const startDatum = String(body?.start_datum || '').trim().slice(0, 10);
  const notitie = String(body?.notitie || '').trim().slice(0, 300);
  try {
    const { data: stu } = await lms
      .from('hlms_student').select('id, bubble_user_id').eq('id', studentId).maybeSingle();
    const { ob, via } = await vindOnboardingVoorStudent(supabaseAdmin, {
      studentId, bubbleUserId: stu?.bubble_user_id || null,
    });
    const { besluit, min } = besluitStartdatum(ob, startDatum);
    if (besluit === SD_TE_VROEG) {
      return antwoord(res, 422, false, besluit,
        'Het CRM aanvaardt een startdatum pas vanaf ' + datumNL(min) + ' (minstens drie dagen vooruit).',
        { min, onboarding_id: ob?.id || null });
    }
    if (besluit !== SD_WIJZIGEN) {
      const status = besluit === 'startdatum_ongeldig' ? 400 : 200;
      return antwoord(res, status, status === 200, besluit, {
        startdatum_ongeldig: 'start_datum ontbreekt of is geen YYYY-MM-DD.',
        geen_onboarding: 'Deze student heeft in het CRM geen onboarding; er is niets gewijzigd.',
        niet_aanraken: 'De onboarding is gearchiveerd of geannuleerd; er is niets gewijzigd.',
        al_afgerond: 'De onboarding is al afgerond; de pauze in het LMS volstaat.',
        ongewijzigd: 'Die startdatum stond er al.',
      }[besluit] || 'Er is niets gewijzigd.', { onboarding_id: ob?.id || null, via });
    }

    const { error: updErr } = await supabaseAdmin
      .from('onboardings')
      .update({ start_date: startDatum })
      .eq('id', ob.id);
    if (updErr) throw new Error('start_date bijwerken: ' + updErr.message);

    // De regel op de interne tijdlijn, zoals de knop in het CRM die schrijft.
    // Faalzacht: de datum staat er, en dat is wat telt.
    try {
      const { error: tlErr } = await supabaseAdmin.from('onboarding_mentor_updates').insert({
        onboarding_id: ob.id,
        kind: 'note',
        status: null,
        note: 'Startdatum gewijzigd naar ' + datumNL(startDatum) + ' (start later op, goedgekeurd in het LMS)'
          + (notitie ? ' — ' + notitie : ''),
        created_by: null,
      });
      if (tlErr) console.warn('[lms-onboarding-sessie] tijdlijnregel mislukt: ' + tlErr.message);
    } catch (e) {
      console.warn('[lms-onboarding-sessie] tijdlijnregel mislukt: ' + (e?.message || e));
    }

    const spiegel = await spiegelOnboarding(ob.id);
    return antwoord(res, 200, true, SD_WIJZIGEN, 'Startdatum in het CRM gezet op ' + datumNL(startDatum) + '.', {
      onboarding_id: ob.id, via, start_datum: startDatum, spiegel: spiegel?.resultaat || null,
    });
  } catch (e) {
    console.error('[lms-onboarding-sessie] startdatum', e?.message || e);
    return antwoord(res, 500, false, 'fout', 'De startdatum kon in het CRM niet gezet worden.');
  }
}

/**
 * EEN ACTIE OP EEN ONBOARDING, VANUIT HET LMS. Wie het deed, gaat mee als
 * e-mailadres; het CRM zoekt de gebruiker erbij (precies één actieve match).
 * Vindt het hem niet, dan gebeurt de actie toch - op naam van niemand - en
 * zegt de tijdlijn wie het in het LMS was. Een handeling weigeren omdat een
 * profiel ontbreekt, zou de hoofdmentor laten zitten met iets wat hij niet
 * kan oplossen.
 */
async function onboardingActie(res, actie, onboardingId, body) {
  const doorEmail = typeof body?.door_email === 'string' ? body.door_email.trim().slice(0, 200) : '';
  try {
    const door = await crmGebruikerVoorEmail(doorEmail);
    const doorUserId = door?.id || null;
    const viaLms = 'via het LMS' + (doorEmail ? ' (' + doorEmail + ')' : '');

    let uitkomst;
    if (actie === 'mentor_toewijzen') {
      const lmsId = body?.mentor_lms_id;
      let mentorUserId = null;
      if (lmsId !== null && lmsId !== undefined && lmsId !== '') {
        const mentor = await crmMentorVoorLmsId(String(lmsId));
        if (!mentor) {
          return antwoord(res, 422, false, 'mentor_niet_te_vertalen',
            'Deze mentor is in het CRM niet als actieve mentor te vinden (op e-mailadres). Er is niets gewijzigd.');
        }
        mentorUserId = mentor.user_id;
      }
      uitkomst = await wijsMentorToe({ onboardingId, mentorUserId, doorUserId });
    } else if (actie === 'startdatum') {
      const startDatum = String(body?.start_datum || '').trim().slice(0, 10);
      uitkomst = await zetStartdatumOnboarding({ onboardingId, startDatum, doorUserId });
    } else if (actie === 'startstatus') {
      const status = body?.status === null || body?.status === undefined || body?.status === ''
        ? null : String(body.status).trim();
      const notitie = typeof body?.notitie === 'string' && body.notitie.trim()
        ? body.notitie.trim().slice(0, 2000) + ' — ' + viaLms
        : 'Startstatus gezet ' + viaLms;
      uitkomst = await zetStartstatus({ onboardingId, status, note: notitie, doorUserId });
    } else if (actie === 'naar_incasso') {
      const reden = typeof body?.reden === 'string' ? body.reden.trim().slice(0, 1000) : '';
      uitkomst = await zetNaarIncasso({
        onboardingId, reden, door: (door?.full_name || doorEmail || 'onbekend') + ' ' + viaLms, doorUserId,
      });
    } else if (actie === 'terug_activeren') {
      const startDatum = String(body?.start_datum || '').trim().slice(0, 10);
      uitkomst = await activeerUitIncasso({
        onboardingId, startDatum, door: (door?.full_name || doorEmail || 'onbekend') + ' ' + viaLms, doorUserId,
      });
    } else if (actie === 'handmatig_afronden') {
      const reden = typeof body?.reden === 'string' ? body.reden.trim().slice(0, 1000) : '';
      uitkomst = await rondOnboardingHandmatigAf({
        onboardingId, reden, door: (door?.full_name || doorEmail || 'onbekend') + ' ' + viaLms, doorUserId,
      });
    } else {
      const tekst = typeof body?.tekst === 'string' ? body.tekst.trim() : '';
      if (!tekst) return antwoord(res, 400, false, 'ongeldig_verzoek', 'De notitie is leeg.');
      uitkomst = await schrijfOnboardingNotitie({
        onboardingId, note: (tekst + ' — ' + viaLms).slice(0, 2000), doorUserId,
      });
    }

    const ok = uitkomst.status >= 200 && uitkomst.status < 300;
    const b = uitkomst.body || {};
    return antwoord(res, uitkomst.status, ok,
      ok ? 'gewijzigd' : (b.code || 'geweigerd'),
      ok ? 'Gewijzigd in het CRM.' : (b.error || 'Het CRM weigerde de wijziging.'),
      { ...b, door_gevonden: !!doorUserId });
  } catch (e) {
    console.error('[lms-onboarding-sessie] ' + actie, e?.message || e);
    return antwoord(res, 500, false, 'fout', 'De wijziging kon in het CRM niet uitgevoerd worden.');
  }
}

async function meldHoofdmentoren(ob, sess) {
  try {
    const hm = await resolveOntvangersVoorRecht('signals.hoofdmentor.receive');
    const titel = sess.titel ? '“' + String(sess.titel).trim() + '” van ' : 'van ';
    const wanneer = new Date(sess.start_tijd).toLocaleDateString('nl-NL',
      { day: '2-digit', month: 'short', year: 'numeric' });
    for (const ontvanger of hm.userIds || []) {
      try {
        await createNotification({
          toUserId: ontvanger,
          type: 'onboarding.auto_afgerond',
          title: 'Onboarding automatisch afgerond',
          body: (ob.customer_name || 'Een klant') + ' — afgesloten door de eerste afgeronde sessie '
            + titel + wanneer + '.',
          linkUrl: '/modules/onboarding-hub.html',
          entityType: 'onboarding',
          entityId: ob.id,
          priority: 'normal',
          dedupWithinMs: 7 * 24 * 60 * 60 * 1000,
        });
      } catch (e) {
        console.warn('[lms-onboarding-sessie] melding mislukt: ' + (e?.message || e));
      }
    }
  } catch (e) {
    console.warn('[lms-onboarding-sessie] ontvangers bepalen mislukt: ' + (e?.message || e));
  }
}
