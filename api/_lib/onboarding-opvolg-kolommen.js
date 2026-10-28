// api/_lib/onboarding-opvolg-kolommen.js
//
// DE KOLOMMEN VAN DE OPVOLGFLOW (28 okt 2026) — faalzacht gelezen, zodat het
// overzicht niet omvalt zolang 2026-10-28-onboarding-opvolgflow.sql nog niet
// gedraaid is. Plus het ECHTE moment van de welkomstmail.
//
// ── DE WELKOMSTMAIL STOND NERGENS IN onboardings ─────────────────────────
// Gemeten 28 okt: `invite_sent_at` is leeg bij ELKE onboarding van de laatste
// 120 dagen. De welkomstmail met de startcode vertrekt via de automation
// "Welkomstmail (direct na aanmelden)" (trigger on_onboarding_created) en
// staat alleen in onboarding_automation_run_log. Gevolg: het LMS-bord kreeg
// `uitnodiging_op = null` en de regel "stil" (welkomstmail ≥ 10 dagen, niets
// geopend) viel nooit. Hier lezen we de eerste GELUKTE send_email van die
// automation; invite_sent_at blijft voorgaan als hij ooit gevuld wordt.

export const OPVOLG_KOLOMMEN = 'id, auto_afgerond_reden, geen_herinneringen_op, geen_herinneringen_door';

function kolomOntbreekt(err) {
  const code = String(err?.code || '');
  return (code === '42703' || code === 'PGRST204') && /auto_afgerond_reden|geen_herinneringen/.test(String(err?.message || ''));
}

let _gemeld = false;

/**
 * Vul auto_afgerond_reden + geen_herinneringen_op/_door aan op rijen die al
 * gelezen zijn. Zonder migratie: null (en één waarschuwing per proces).
 */
export async function vulOpvolgAan(db, rijen) {
  const lijst = Array.isArray(rijen) ? rijen : (rijen ? [rijen] : []);
  const ids = [...new Set(lijst.map((r) => r?.id).filter(Boolean))];
  for (const r of lijst) {
    if (r && !('auto_afgerond_reden' in r)) r.auto_afgerond_reden = null;
    if (r && !('geen_herinneringen_op' in r)) r.geen_herinneringen_op = null;
    if (r && !('geen_herinneringen_door' in r)) r.geen_herinneringen_door = null;
  }
  if (!ids.length) return rijen;
  try {
    const kaart = new Map();
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await db.from('onboardings').select(OPVOLG_KOLOMMEN).in('id', ids.slice(i, i + 200));
      if (error) {
        if (kolomOntbreekt(error)) {
          if (!_gemeld) {
            _gemeld = true;
            console.warn('[onboarding-opvolg] kolommen ontbreken — migratie 2026-10-28-onboarding-opvolgflow.sql nog niet gedraaid');
          }
          return rijen;
        }
        throw new Error(error.message);
      }
      for (const x of data || []) kaart.set(x.id, x);
    }
    for (const r of lijst) {
      const x = r && kaart.get(r.id);
      if (x) Object.assign(r, { auto_afgerond_reden: x.auto_afgerond_reden, geen_herinneringen_op: x.geen_herinneringen_op, geen_herinneringen_door: x.geen_herinneringen_door });
    }
  } catch (e) {
    console.warn('[onboarding-opvolg] lezen (faalzacht):', e?.message || e);
  }
  return rijen;
}

/**
 * Per onboarding het moment van de eerste GELUKTE welkomstmail (automation
 * met trigger on_onboarding_created, stap send_email met ok=true). Testruns
 * tellen niet. Faalzacht: bij een fout een lege map.
 * @returns {Promise<Map<string,string>>}
 */
export async function welkomstmailMomenten(db, onboardingIds) {
  const kaart = new Map();
  const ids = [...new Set((onboardingIds || []).filter(Boolean))];
  if (!ids.length) return kaart;
  try {
    const { data: autos, error: aErr } = await db.from('onboarding_automations').select('id').eq('trigger_type', 'on_onboarding_created');
    if (aErr) throw new Error(aErr.message);
    const autoIds = (autos || []).map((a) => a.id);
    if (!autoIds.length) return kaart;
    for (let i = 0; i < ids.length; i += 200) {
      const { data: runs, error: rErr } = await db.from('onboarding_automation_runs')
        .select('id, onboarding_id, is_test').in('automation_id', autoIds).in('onboarding_id', ids.slice(i, i + 200));
      if (rErr) throw new Error(rErr.message);
      const echte = (runs || []).filter((r) => !r.is_test);
      const obVanRun = new Map(echte.map((r) => [r.id, r.onboarding_id]));
      const runIds = [...obVanRun.keys()];
      for (let j = 0; j < runIds.length; j += 200) {
        const { data: logs, error: lErr } = await db.from('onboarding_automation_run_log')
          .select('run_id, executed_at, result').eq('step_type', 'send_email').in('run_id', runIds.slice(j, j + 200));
        if (lErr) throw new Error(lErr.message);
        for (const l of logs || []) {
          if (l?.result?.ok !== true || !l.executed_at) continue;
          const ob = obVanRun.get(l.run_id);
          const al = kaart.get(ob);
          if (!al || Date.parse(l.executed_at) < Date.parse(al)) kaart.set(ob, l.executed_at);
        }
      }
    }
  } catch (e) {
    console.warn('[onboarding-opvolg] welkomstmail (faalzacht):', e?.message || e);
    return new Map();
  }
  return kaart;
}
