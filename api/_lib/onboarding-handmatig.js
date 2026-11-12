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
// automatische afsluiting (`auto_afgerond_*`) blijft apart.
//
// STATUS (28 okt 2026, Maxim): tot nu bleef `status` op aangemeld/bezig staan
// en las alles wat op status keek de onboarding als lopend (check-in-
// doelgroep, "Moet onboarding nog afronden"). Nu zet afronden ook
// status = 'afgerond' en completed_at (= hetzelfde moment als
// handmatig_afgerond_op, zodat `wizardDoorKlantVoltooid` weet dat de klant de
// wizard niet zelf deed) — zoals de afsluiting door een sessie al deed.
// ZONDER de automations van wizard-afronding: die hangen aan rondWizardAf()
// (hier niet aangeroepen) en de catch-up in onboarding-automation-engine.js
// slaat met de hand of door een sessie afgesloten onboardings over.
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
    .select('id, status, archived_at, completed_at, auto_afgerond_op, auto_afgerond_sessie_id').eq('id', onboardingId).maybeSingle();
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
  const patch = { handmatig_afgerond_op: nu, handmatig_afgerond_door: String(door || 'onbekend').slice(0, 200), handmatig_afgerond_reden: r.slice(0, 1000) };
  // Nog aangemeld/bezig → nu ook afgerond (zie boven). Al 'afgerond' (wizard
  // voltooid) → status en het wizardmoment blijven staan.
  if (s === 'aangemeld' || s === 'bezig') {
    patch.status = 'afgerond';
    patch.completed_at = ob.completed_at || nu;
  }
  const { data: upd, error: upErr } = await db.from('onboardings')
    .update(patch)
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

// ── HEROPENEN (Maxim, 10 november 2026) ──────────────────────────────────
// Aanleiding: een onboarding die bij een offertewissel per vergissing met de
// hand afgerond werd (Laurens Rasti). Afgerond betekent bij ons: de eerste
// coachingcall is gedaan. Er was geen weg terug in de UI.
//
// ALLEEN wat MET DE HAND afgerond is. Een onboarding die een (eerste)
// afgeronde sessie afsloot, of die de ochtendronde automatisch sloot
// (`auto_afgerond_*`), heropent hier niet: daar is iets gebeurd dat deze knop
// niet ongedaan maakt.
//
// De status gaat terug zoals ze vóór het afronden was: 'bezig' als de wizard
// gestart was (`started_at`), anders 'aangemeld'. Had de KLANT de wizard zelf
// al voltooid vóór het afronden (completed_at ≠ handmatig_afgerond_op, zie
// wizardDoorKlantVoltooid), dan blijven status 'afgerond' en dat wizardmoment
// staan: dat is echte informatie, en de onboarding staat daarmee weer op
// "wizard voltooid, eerste call nog niet" — wat hij vóór het afronden was.

/**
 * Wat heropenen zou doen. PURE.
 * @returns {{ok:true, patch:object, wizardBehouden:boolean}|{ok:false, status:number, code:string, error:string}}
 */
export function besluitHeropenen(ob, { wizardDoorKlantVoltooid }) {
  const nee = (status, code, error) => ({ ok: false, status, code, error });
  if (!ob) return nee(404, 'niet_gevonden', 'Onboarding niet gevonden.');
  const s = String(ob.status || '').toLowerCase();
  if (ob.archived_at || s === 'gearchiveerd' || s === 'geannuleerd') {
    return nee(409, 'niet_actief', 'Onboarding is gearchiveerd of geannuleerd.');
  }
  if (ob.auto_afgerond_op || ob.auto_afgerond_sessie_id) {
    return nee(409, 'automatisch_afgerond', 'Deze onboarding is afgesloten door een afgeronde sessie (of automatisch), niet met de hand. Heropenen kan hier niet.');
  }
  if (!ob.handmatig_afgerond_op) {
    return nee(409, 'niet_handmatig_afgerond', 'Deze onboarding is niet met de hand afgerond: er is niets te heropenen.');
  }
  const patch = { handmatig_afgerond_op: null, handmatig_afgerond_door: null, handmatig_afgerond_reden: null };
  const wizardBehouden = wizardDoorKlantVoltooid(ob);
  if (!wizardBehouden) {
    patch.status = ob.started_at ? 'bezig' : 'aangemeld';
    patch.completed_at = null;
  }
  return { ok: true, patch, wizardBehouden };
}

/**
 * Heropen een met de hand afgeronde onboarding. Reden verplicht. Schrijft een
 * audit_log-regel (wie, wanneer, reden, before/after), een tijdlijnregel, en
 * spiegelt meteen. Idempotent: al heropend (niet meer met de hand afgerond) →
 * 409 niet_handmatig_afgerond, er verandert niets.
 * @param {{onboardingId:string, reden:string, door:string, doorUserId?:string|null, db?:object, spiegel?:Function}} p
 * @returns {Promise<{status:number, body:object}>}
 */
export async function heropenOnboardingHandmatig({ onboardingId, reden, door, doorUserId = null, db = supabaseAdmin, spiegel = null }) {
  const r = String(reden || '').trim();
  if (r.length < 5) return { status: 400, body: { error: 'Geef een reden (minstens 5 tekens).', code: 'reden_verplicht' } };
  const { data: ob, error } = await db.from('onboardings')
    .select('id, status, archived_at, completed_at, started_at, auto_afgerond_op, auto_afgerond_sessie_id')
    .eq('id', onboardingId).maybeSingle();
  if (error) return { status: 500, body: { error: 'Onboarding lezen: ' + error.message } };
  if (!ob) return { status: 404, body: { error: 'Onboarding niet gevonden.', code: 'niet_gevonden' } };
  await vulHandmatigAan(db, ob);
  const { wizardDoorKlantVoltooid } = await import('./onboarding-einde.js');
  const b = besluitHeropenen(ob, { wizardDoorKlantVoltooid });
  if (!b.ok) return { status: b.status, body: { error: b.error, code: b.code } };

  const voor = {
    status: ob.status || null, completed_at: ob.completed_at || null,
    handmatig_afgerond_op: ob.handmatig_afgerond_op || null,
    handmatig_afgerond_door: ob.handmatig_afgerond_door || null,
    handmatig_afgerond_reden: ob.handmatig_afgerond_reden || null,
  };
  // Voorwaardelijk: alleen als hij NU nog met de hand afgerond is (twee kliks
  // tegelijk heropenen één keer).
  const { data: upd, error: upErr } = await db.from('onboardings')
    .update(b.patch)
    .eq('id', onboardingId)
    .not('handmatig_afgerond_op', 'is', null)
    .select('id');
  if (upErr) {
    if (isHandmatigKolomOntbreekt(upErr)) {
      return { status: 503, body: { error: 'Heropenen kan pas na de migratie 2026-10-06-onboarding-handmatig-afgerond.sql.', code: 'migratie_ontbreekt' } };
    }
    return { status: 500, body: { error: 'Heropenen: ' + upErr.message } };
  }
  if (!upd?.length) return { status: 409, body: { error: 'Deze onboarding werd intussen al heropend.', code: 'niet_handmatig_afgerond' } };
  const na = { ...voor, ...b.patch };

  const wie = String(door || 'onbekend').slice(0, 200);
  try {
    const { error: aErr } = await db.from('audit_log').insert({
      user_id: doorUserId || null,
      action: 'onboarding.heropend',
      entity_type: 'onboarding',
      entity_id: onboardingId,
      before_json: voor,
      after_json: na,
      reason_text: ('Heropend door ' + wie + '. Reden: ' + r).slice(0, 1000),
    });
    if (aErr) console.error('[onboarding-handmatig] audit heropenen ' + onboardingId + ': ' + aErr.message);
  } catch (e) { console.error('[onboarding-handmatig] audit heropenen ' + onboardingId + ': ' + (e?.message || e)); }
  const { error: tlErr } = await db.from('onboarding_mentor_updates').insert({
    onboarding_id: onboardingId,
    kind: 'note',
    status: null,
    note: ('Onboarding heropend door ' + wie + ' (was met de hand afgerond). Reden: ' + r).slice(0, 2000),
    created_by: doorUserId,
  });
  if (tlErr) console.error('[onboarding-handmatig] tijdlijn heropenen ' + onboardingId + ': ' + tlErr.message);

  const spiegelFn = spiegel || (await import('./onboarding-spiegel.js')).spiegelNaActie;
  await spiegelFn(onboardingId, 'onboarding-heropend');
  return { status: 200, body: { ok: true, heropend: true, status: na.status, wizard_behouden: b.wizardBehouden } };
}
