// api/_lib/onboarding-handmatig.js
//
// ONBOARDING MET DE HAND AFRONDEN (Maxim, 6 oktober 2026).
//
// Waarom: sommige trajecten lopen al zonder dat het LMS een afgeronde sessie
// kent — calls in Bubble, of sessies van vóór het watermerk van de
// automatische afsluiting. Die bleven "in onboarding" staan bij hun mentor en
// in de pot. De hoofdmentor sluit ze nu af met een VERPLICHTE reden.
//
// ── EIGEN KOLOMMEN, NIET DOOR ELKAAR ────────────────────────────────────
// `handmatig_afgerond_op / _door / _reden` op `onboardings` (migratie
// docs/sql-migrations/2026-10-06-onboarding-handmatig-afgerond.sql). De
// automatische afsluiting (`auto_afgerond_*`) blijft apart. De wizardstatus
// wordt NIET aangeraakt: `status` zegt iets over de wizard, niet over de
// onboarding (zie onboarding-einde.js).
//
// ── VÓÓR DE MIGRATIE ─────────────────────────────────────────────────────
// De lezers vragen deze kolommen in een APARTE, faalzachte query
// (`vulHandmatigAan`), zodat hun eigen select niet omvalt zolang de kolommen
// er nog niet zijn. Afronden zelf geeft dan een duidelijke melding.

import { supabaseAdmin } from '../supabase.js';

export const HANDMATIG_KOLOMMEN = 'id, handmatig_afgerond_op, handmatig_afgerond_door, handmatig_afgerond_reden';

/** "De kolom bestaat nog niet" — PGRST204/42703 met handmatig_afgerond in de melding. PURE. */
export function isHandmatigKolomOntbreekt(err) {
  const code = String(err?.code || '');
  if (code !== 'PGRST204' && code !== '42703') return false;
  return /handmatig_afgerond/.test(String(err?.message || ''));
}

let _ontbreektGemeld = false;

/**
 * Vul `handmatig_afgerond_*` aan op rijen die al uit `onboardings` gelezen
 * zijn. Muteert en geeft dezelfde lijst terug. Faalzacht: lukt het niet, dan
 * blijven de velden leeg (= niet met de hand afgerond) en staat er een log.
 * @template T
 * @param {object} db
 * @param {T[]|T|null} rijen  één rij of een lijst, elk met `id`
 * @returns {Promise<T[]|T|null>}
 */
export async function vulHandmatigAan(db, rijen) {
  const lijst = Array.isArray(rijen) ? rijen : (rijen ? [rijen] : []);
  const ids = [...new Set(lijst.map((r) => r?.id).filter(Boolean))];
  if (!ids.length) return rijen;
  try {
    const kaart = new Map();
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await db.from('onboardings').select(HANDMATIG_KOLOMMEN).in('id', ids.slice(i, i + 200));
      if (error) {
        if (isHandmatigKolomOntbreekt(error)) {
          if (!_ontbreektGemeld) {
            console.warn('[onboarding-handmatig] kolommen ontbreken nog (migratie 2026-10-06-onboarding-handmatig-afgerond.sql) — niemand met de hand afgerond');
            _ontbreektGemeld = true;
          }
          return rijen;
        }
        throw new Error(error.message);
      }
      for (const r of data || []) kaart.set(r.id, r);
    }
    for (const r of lijst) {
      const h = r?.id ? kaart.get(r.id) : null;
      r.handmatig_afgerond_op = h?.handmatig_afgerond_op || null;
      r.handmatig_afgerond_door = h?.handmatig_afgerond_door || null;
      r.handmatig_afgerond_reden = h?.handmatig_afgerond_reden || null;
    }
  } catch (e) {
    console.warn('[onboarding-handmatig] niet gelezen:', e?.message || e);
  }
  return rijen;
}

/**
 * Rond een onboarding met de hand af. Idempotent: al afgerond (met de hand of
 * door een sessie) → niets veranderd.
 * @param {{onboardingId: string, reden: string, door: string, doorUserId?: string|null, db?: object}} p
 *   door: leesbaar (e-mail of naam), komt in `handmatig_afgerond_door`;
 *   doorUserId: de CRM-gebruiker als die bekend is (tijdlijn `created_by`).
 * @returns {Promise<{status: number, body: object}>}
 */
export async function rondOnboardingHandmatigAf({ onboardingId, reden, door, doorUserId = null, db = supabaseAdmin }) {
  const r = String(reden || '').trim();
  if (r.length < 5) return { status: 400, body: { error: 'Geef een reden (minstens 5 tekens).', code: 'reden_verplicht' } };
  const { data: ob, error } = await db.from('onboardings')
    .select('id, status, archived_at, auto_afgerond_op, auto_afgerond_sessie_id').eq('id', onboardingId).maybeSingle();
  if (error) return { status: 500, body: { error: 'Onboarding lezen: ' + error.message } };
  if (!ob) return { status: 404, body: { error: 'Onboarding niet gevonden.' } };
  const s = String(ob.status || '').toLowerCase();
  if (ob.archived_at || s === 'gearchiveerd' || s === 'geannuleerd') {
    return { status: 409, body: { error: 'Onboarding is gearchiveerd of geannuleerd.', code: 'niet_actief' } };
  }
  await vulHandmatigAan(db, ob);
  const { onboardingAfgesloten } = await import('./onboarding-einde.js');
  if (onboardingAfgesloten(ob)) return { status: 200, body: { ok: true, al_afgerond: true } };

  const nu = new Date().toISOString();
  const { data: upd, error: upErr } = await db.from('onboardings')
    .update({ handmatig_afgerond_op: nu, handmatig_afgerond_door: String(door || 'onbekend').slice(0, 200), handmatig_afgerond_reden: r.slice(0, 1000) })
    .eq('id', onboardingId)
    .is('handmatig_afgerond_op', null)
    .select('id');
  if (upErr) {
    if (isHandmatigKolomOntbreekt(upErr)) {
      return { status: 503, body: { error: 'Met de hand afronden kan pas na de migratie 2026-10-06-onboarding-handmatig-afgerond.sql.', code: 'migratie_ontbreekt' } };
    }
    return { status: 500, body: { error: 'Afronden: ' + upErr.message } };
  }
  if (!upd?.length) return { status: 200, body: { ok: true, al_afgerond: true } };

  // In de tijdlijn van de onboarding, met wie en waarom. Faalzacht: het
  // afronden zelf staat al vast.
  const { error: tlErr } = await db.from('onboarding_mentor_updates').insert({
    onboarding_id: onboardingId,
    kind:          'note',
    status:        null,
    note:          'Onboarding met de hand afgerond door ' + (door || 'onbekend') + '. Reden: ' + r.slice(0, 1000),
    created_by:    doorUserId,
  });
  if (tlErr) console.error('[onboarding-handmatig] tijdlijn ' + onboardingId + ': ' + tlErr.message);

  const { spiegelNaActie } = await import('./onboarding-spiegel.js');
  await spiegelNaActie(onboardingId, 'handmatig-afgerond');
  return { status: 200, body: { ok: true, afgerond_op: nu } };
}
