// api/_lib/onboarding-afronden.js
//
// DE AFRONDING VAN DE ONBOARDING-WIZARD — één plek voor de neveneffecten.
//
// Er zijn twee wegen naar "afgerond": de klassieke wizard
// (api/onboarding-complete.js, ?t=<token>) en de nieuwe portal op de website
// (api/onboarding-portal.js, action "complete"). Beide moeten EXACT hetzelfde
// doen, anders krijgt een mentor bij de ene klant wel een melding en bij de
// andere niet. Daarom staan de neveneffecten hier en roepen beide paden dit aan
// na hun eigen validatie:
//
//   1. status 'afgerond' + completed_at + updated_at   (awaited; faalt → fout)
//   2. automations met trigger 'on_wizard_completed'    (fire-and-forget; de
//      cron-poll vangt missers op)
//   3. melding aan de mentor ('onboarding.intake_done') (fail-soft)
//   4. spiegel naar het LMS                              (awaited, faalzacht)
//
// Volgorde en gedrag zijn woordelijk overgenomen uit onboarding-complete.js
// zoals die tot 27 oktober 2026 was.

import { supabaseAdmin } from '../supabase.js';
import { createNotification } from './notify.js';
import { enrollForTrigger } from './onboarding-automation-engine.js';
import { spiegelNaActie } from './onboarding-spiegel.js';

const STANDAARD = {
  db: () => supabaseAdmin,
  enroll: enrollForTrigger,
  notify: createNotification,
  spiegel: (id, bron) => spiegelNaActie(id, bron),
};

/**
 * Zet een (gevalideerde) onboarding op afgerond en voer de neveneffecten uit.
 *
 * @param {{id: string, mentor_user_id?: string|null, customer_name?: string|null}} ob
 * @param {{bron: string, nu?: Date, deps?: object}} opties
 *   bron = naam van het aanroepende endpoint (voor logs en de spiegel).
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
export async function rondWizardAf(ob, { bron, nu = new Date(), deps = {} } = {}) {
  const d = { ...STANDAARD, ...deps };
  const db = typeof d.db === 'function' ? d.db() : d.db;
  const tag = '[' + (bron || 'onboarding-afronden') + ']';

  const nowIso = nu.toISOString();
  const { error: updErr } = await db
    .from('onboardings')
    .update({ status: 'afgerond', completed_at: nowIso, updated_at: nowIso })
    .eq('id', ob.id);
  if (updErr) {
    console.error(tag + ' update:', updErr.message);
    return { ok: false, error: 'Afronden mislukt.' };
  }

  // Automations — NIET awaited zodat een automation-fout de klant nooit
  // vertraagt. Cron-poll vangt eventuele missers op.
  Promise.resolve(
    d.enroll({ onboardingId: ob.id, triggerType: 'on_wizard_completed' }),
  ).catch((e) => {
    console.error(tag + ' automation enroll fail:', e?.message || e);
  });

  // Melding aan de mentor — alleen bij de echte overgang naar 'afgerond'
  // (de aanroeper geeft bij al-afgerond eerder een idempotente 200 terug).
  if (ob.mentor_user_id) {
    Promise.resolve(d.notify({
      toUserId:   ob.mentor_user_id,
      type:       'onboarding.intake_done',
      title:      'Intake afgerond' + (ob.customer_name ? (' · ' + ob.customer_name) : ''),
      body:       ob.customer_name || null,
      linkUrl:    '/modules/mentor-onboarding.html',
      entityType: 'onboarding',
      entityId:   ob.id,
    })).catch(() => {});
  }

  // Spiegel naar het LMS — faalzacht, na de geslaagde hoofdactie.
  await d.spiegel(ob.id, bron || 'onboarding-complete');

  return { ok: true };
}
