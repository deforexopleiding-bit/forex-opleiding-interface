// api/lms-onboarding-sessie.js
//
// Machine-route voor het LMS (dfo-lms): een mentor heeft net een sessie
// AFGEROND — sluit de onboarding van die student nu af, niet pas morgen om
// 07:00. Server-naar-server, GEEN CORS: het geheim mag nooit in een browser.
//
//   POST { actie: 'sessie_afgerond', student_id, sessie_id? }
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
  if (actie !== 'sessie_afgerond') {
    return antwoord(res, 400, false, 'ongeldige_actie', 'Onbekende actie. Verwacht: sessie_afgerond.');
  }
  if (!UUID_RE.test(studentId)) {
    return antwoord(res, 400, false, 'ongeldig_verzoek', 'student_id ontbreekt of is geen uuid.');
  }

  const lms = getDfoLmsClient();
  if (!lms) {
    return antwoord(res, 503, false, 'lms_niet_geconfigureerd', 'DFO_LMS_SUPABASE_URL/KEY ontbreekt.');
  }

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
