// api/_lib/brieven-lms.js
//
// DE BRIEVEN VAN HET BORD SAMEN MET WANBETALERS › BRIEVEN (Maxim, 16 nov 2026).
//
// ── ÉÉN BRON ─────────────────────────────────────────────────────────────
// Het CRM maakt de brieven (dunning_briefs, generatePreBriefForCustomer) en is
// de ENIGE bron voor "verstuurd" (sent_at). Het bord in het LMS (Administratie)
// leest die stand uit zijn eigen dossier, waar dit bestand hem neerzet via de
// LMS-functie `hlms_admin_brief_crm` (service role) — net als de
// factuurstand-spiegel. Er is geen tweede administratie: het LMS-vinkje
// "Verstuurd" weigert een brief die in het CRM staat.
//
//   Brief 1 = tussenbrief    (incasso_tussen_be / _nl)
//   Brief 2 = pre-incassobrief (incasso_pre_be / _nl)
//
// ── DE KOPPELING ─────────────────────────────────────────────────────────
// dunning_briefs.lms_dossier_id + lms_brief_nr. Gezet:
//   - als Seppe op het bord "Brief N mag weg" klikt (api/lms-brieven.js),
//   - of automatisch als het CRM een brief maakt voor een klant met precies één
//     open betalingsdossier op het bord (rechtstreeks in het CRM, de engine,
//     bulk). Alleen voor brieven vanaf AUTOKOPPEL_VANAF: de oudere brieven
//     (aug/sep 2026) worden bewust NIET omgezet (beslissing Maxim).
//
// ── WANNEER ──────────────────────────────────────────────────────────────
// Meteen bij aanmaken, als verstuurd markeren (post/mail) en verwijderen; en elk
// uur de verzoening (api/cron/brieven-lms-spiegel.js) die alles opnieuw spiegelt.
// De LMS-functie is idempotent: dezelfde stand = niets, geen tijdlijnregel. Zo
// vangt de verzoening ook een sent_at die in de database terug leeg gezet werd.
//
// Fail-soft voor het CRM: een spiegel die mislukt laat het aanmaken of
// markeren NOOIT mislukken; de verzoening haalt het in.

import { supabaseAdmin } from '../supabase.js';
import { getDfoLmsClient } from './dfo-lms-db.js';

export const AUTOKOPPEL_VANAF = '2026-11-16';
export const BUCKET = 'dunning-briefs';
const CRM_PUBLIEK = (process.env.CRM_PUBLIEK_URL || 'https://crm.deforexopleiding.nl').replace(/\/$/, '');

/** Brief 1 = tussenbrief, brief 2 = pre-incassobrief, anders null (geen bordbrief). */
export function briefNrVan(templateCode) {
  const t = String(templateCode || '');
  if (t.startsWith('incasso_tussen_')) return 1;
  if (t.startsWith('incasso_pre_')) return 2;
  return null;
}

/** Het brieftype voor de generator bij brief N. */
export function briefTypeVoorNr(nr) {
  return Number(nr) === 1 ? 'tussen' : 'wik';
}

/** YYYY-MM-DD in Brussel. Nooit toISOString().split('T') (dat is UTC). */
export function datumBrussel(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Brussels', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** De link "Open in CRM Brieven", met de naam als zoekterm. */
export function crmBrievenUrl(naam) {
  const q = naam ? `&brzoek=${encodeURIComponent(String(naam).slice(0, 80))}` : '';
  return `${CRM_PUBLIEK}/modules/klanten-v2/?v2preview=wanbetalers&v2tab=Brieven${q}`;
}

/**
 * De stand die het LMS krijgt (p_crm van hlms_admin_brief_crm). Puur.
 * @param {object} brief  dunning_briefs-rij
 * @param {Map<string,{email,naam}>} mensen  profiles op id
 */
export function standVoorLms(brief, mensen = new Map()) {
  const aan = mensen.get(brief.generated_by_user_id) || {};
  const vers = mensen.get(brief.sent_by_user_id) || {};
  return {
    brief_id: brief.id,
    template_code: brief.template_code,
    aangemaakt_op: brief.generated_at || null,
    aangemaakt_door_email: aan.email || null,
    aangemaakt_door_naam: aan.naam || null,
    verstuurd_op: brief.sent_at ? datumBrussel(brief.sent_at) : null,
    verstuurd_door_email: brief.sent_at ? (vers.email || null) : null,
    verstuurd_door_naam: brief.sent_at ? (vers.naam || null) : null,
  };
}

const BRIEF_VELDEN = 'id, customer_id, template_code, generated_at, generated_by_user_id, sent_at, sent_via, sent_by_user_id, lms_dossier_id, lms_brief_nr';

function kolomOntbreekt(err) {
  const m = String(err?.message || '');
  return err?.code === '42703' || /lms_dossier_id|lms_brief_nr/.test(m) && /does not exist|column/.test(m);
}

async function mensenVan(crm, ids) {
  const uniek = [...new Set(ids.filter(Boolean))];
  const uit = new Map();
  if (!uniek.length) return uit;
  const { data } = await crm.from('profiles').select('id, email, full_name').in('id', uniek);
  for (const p of data || []) uit.set(p.id, { email: p.email || null, naam: p.full_name || p.email || null });
  return uit;
}

/**
 * Het open betalingsdossier van een klant op het bord. Via de onboarding
 * (crm_onboarding_id / dfo_lms_student_id) en het e-mailadres (hlms_student).
 * Precies één = dat dossier; nul of meer = geen (nooit gokken).
 * @returns {{ dossier: object|null, reden: string }}
 */
export async function zoekOpenBetaaldossier({ crm, lms }, customerId) {
  const [{ data: klant }, { data: obs }] = await Promise.all([
    crm.from('customers').select('id, email').eq('id', customerId).maybeSingle(),
    crm.from('onboardings').select('id, dfo_lms_student_id').eq('customer_id', customerId),
  ]);
  const onboardingIds = (obs || []).map((o) => o.id).filter(Boolean);
  const studentIds = new Set((obs || []).map((o) => o.dfo_lms_student_id).filter(Boolean));
  const mail = String(klant?.email || '').trim().toLowerCase();
  if (mail) {
    const { data: st, error } = await lms.from('hlms_student').select('id').ilike('email', mail);
    if (error) throw new Error('hlms_student: ' + error.message);
    for (const s of st || []) studentIds.add(s.id);
  }
  if (!studentIds.size && !onboardingIds.length) return { dossier: null, reden: 'geen_student' };
  const filters = [];
  if (studentIds.size) filters.push(`student_id.in.(${[...studentIds].join(',')})`);
  if (onboardingIds.length) filters.push(`crm_onboarding_id.in.(${onboardingIds.join(',')})`);
  const { data: ds, error: dErr } = await lms.from('hlms_admin_dossier')
    .select('id, naam, fase, spoor, student_id, crm_onboarding_id, brieven')
    .is('gesloten_op', null).eq('spoor', 'betaling').or(filters.join(','));
  if (dErr) throw new Error('hlms_admin_dossier: ' + dErr.message);
  const lijst = ds || [];
  if (lijst.length === 1) return { dossier: lijst[0], reden: 'gevonden' };
  return { dossier: null, reden: lijst.length ? 'meerdere_dossiers' : 'geen_dossier' };
}

/** Roep de LMS-functie aan. Geeft de uitkomst ('gekoppeld', 'verstuurd', 'ongewijzigd', …). */
export async function spiegelNaarLms(lms, { dossierId, nr, stand, bron }) {
  const { data, error } = await lms.rpc('hlms_admin_brief_crm', { p_dossier: dossierId, p_nr: nr, p_crm: stand, p_bron: bron });
  if (error) {
    const e = new Error(error.message || 'hlms_admin_brief_crm mislukt');
    e.code = error.code;
    e.hint = error.hint;
    throw e;
  }
  return String(data || '');
}

/**
 * Koppel (indien nodig) en spiegel één brief.
 * opties: { bron: 'crm'|'lms', dossierId?, nr?, aangemaaktDoorEmail?, dry? }
 * @returns {Promise<{ status: string, dossier_id?: string, nr?: number, reden?: string }>}
 */
export async function koppelEnSpiegel(briefId, opties = {}, deps = {}) {
  const crm = deps.crm || supabaseAdmin;
  const lms = deps.lms !== undefined ? deps.lms : getDfoLmsClient();
  if (!lms) return { status: 'lms_niet_ingesteld' };
  const { data: brief, error } = await crm.from('dunning_briefs').select(BRIEF_VELDEN).eq('id', briefId).maybeSingle();
  if (error) {
    if (kolomOntbreekt(error)) return { status: 'migratie_ontbreekt' };
    throw new Error('dunning_briefs: ' + error.message);
  }
  if (!brief) return { status: 'brief_onbekend' };
  const nr = Number(opties.nr || brief.lms_brief_nr || briefNrVan(brief.template_code)) || null;
  if (!nr) return { status: 'geen_bordbrief' };

  let dossierId = opties.dossierId || brief.lms_dossier_id || null;
  let reden = null;
  if (!dossierId) {
    if (String(brief.generated_at || '').slice(0, 10) < AUTOKOPPEL_VANAF) return { status: 'te_oud' };
    const z = await zoekOpenBetaaldossier({ crm, lms }, brief.customer_id);
    if (!z.dossier) return { status: 'geen_dossier', reden: z.reden };
    dossierId = z.dossier.id;
    reden = 'automatisch';
  }
  if (opties.dry) return { status: 'zou_spiegelen', dossier_id: dossierId, nr, reden };

  if (brief.lms_dossier_id !== dossierId || brief.lms_brief_nr !== nr) {
    const { error: uErr } = await crm.from('dunning_briefs')
      .update({ lms_dossier_id: dossierId, lms_brief_nr: nr }).eq('id', brief.id);
    if (uErr) throw new Error('koppeling bewaren: ' + uErr.message);
  }
  const mensen = await mensenVan(crm, [brief.generated_by_user_id, brief.sent_by_user_id]);
  const stand = standVoorLms(brief, mensen);
  if (opties.aangemaaktDoorEmail) stand.aangemaakt_door_email = opties.aangemaaktDoorEmail;
  const status = await spiegelNaarLms(lms, { dossierId, nr, stand, bron: opties.bron === 'lms' ? 'lms' : 'crm' });
  return { status, dossier_id: dossierId, nr, reden };
}

/** Meerdere brieven na een verstuurd-markering (fail-soft, één fout stopt de rest niet). */
export async function spiegelBrieven(briefIds, deps = {}) {
  const uit = [];
  for (const id of [...new Set(briefIds || [])].slice(0, 60)) {
    try {
      uit.push({ id, ...(await koppelEnSpiegel(id, { bron: 'crm' }, deps)) });
    } catch (e) {
      console.error('[brieven-lms] spiegel', id, e?.message || e);
      uit.push({ id, status: 'mislukt', fout: e?.message || String(e) });
    }
  }
  return uit;
}

/**
 * Na een verwijdering in het CRM: de koppeling in het LMS weg. `rijen` = de
 * dunning_briefs-rijen zoals ze VÓÓR de delete waren (met lms_dossier_id).
 */
export async function spiegelVerwijderd(rijen, deps = {}) {
  const lms = deps.lms !== undefined ? deps.lms : getDfoLmsClient();
  if (!lms) return [];
  const uit = [];
  for (const r of (rijen || []).filter((x) => x.lms_dossier_id && x.lms_brief_nr)) {
    try {
      const status = await spiegelNaarLms(lms, { dossierId: r.lms_dossier_id, nr: r.lms_brief_nr, stand: { brief_id: r.id, verwijderd: true }, bron: 'crm' });
      uit.push({ id: r.id, status });
    } catch (e) {
      console.error('[brieven-lms] verwijderd', r.id, e?.message || e);
      uit.push({ id: r.id, status: 'mislukt', fout: e?.message || String(e) });
    }
  }
  return uit;
}

/**
 * De verzoening (elk uur en voor de inhaalslag). Spiegelt elke gekoppelde brief
 * opnieuw en koppelt de nieuwe (vanaf AUTOKOPPEL_VANAF) die nog los staan.
 * dry = niets schrijven, alleen de lijst.
 */
export async function verzoenBrieven({ dry = false } = {}, deps = {}) {
  const crm = deps.crm || supabaseAdmin;
  const lms = deps.lms !== undefined ? deps.lms : getDfoLmsClient();
  if (!lms) return { ok: false, code: 'lms_niet_ingesteld', items: [] };
  const { data: rijen, error } = await crm.from('dunning_briefs').select(BRIEF_VELDEN)
    .or(`lms_dossier_id.not.is.null,generated_at.gte.${AUTOKOPPEL_VANAF}`)
    .order('generated_at', { ascending: true }).limit(500);
  if (error) {
    if (kolomOntbreekt(error)) return { ok: false, code: 'migratie_ontbreekt', items: [] };
    throw new Error('dunning_briefs: ' + error.message);
  }
  const klantIds = [...new Set((rijen || []).map((r) => r.customer_id))];
  const namen = new Map();
  if (klantIds.length) {
    const { data: ks } = await crm.from('customers').select('id, first_name, last_name, company_name').in('id', klantIds);
    for (const k of ks || []) namen.set(k.id, (k.company_name || `${k.first_name || ''} ${k.last_name || ''}`).trim() || null);
  }
  const items = [];
  for (const r of rijen || []) {
    if (!briefNrVan(r.template_code) && !r.lms_brief_nr) continue;
    try {
      const u = await koppelEnSpiegel(r.id, { bron: 'crm', dry }, { crm, lms });
      items.push({ brief_id: r.id, klant: namen.get(r.customer_id) || null, template_code: r.template_code,
        verstuurd_op: r.sent_at ? datumBrussel(r.sent_at) : null, ...u });
    } catch (e) {
      console.error('[brieven-lms] verzoening', r.id, e?.message || e);
      items.push({ brief_id: r.id, klant: namen.get(r.customer_id) || null, template_code: r.template_code, status: 'mislukt', fout: e?.message || String(e) });
    }
  }
  const telling = {};
  for (const i of items) telling[i.status] = (telling[i.status] || 0) + 1;
  return { ok: true, dry, telling, items };
}
