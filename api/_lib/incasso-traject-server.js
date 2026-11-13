// api/_lib/incasso-traject-server.js
//
// IO voor het incasso-overzicht (zie api/_lib/incasso-traject.js voor de
// regels). Twee ingangen, beide via api/lms-incasso.js:
//   laadIncassoOverzicht(deps)        → alle rijen per fase + cijfers
//   voerIncassoActieUit(deps, invoer) → één actie, met de #1957-status als enige
//                                       status (zetStatus) en het traject voor
//                                       de rest.
//
// NOOIT: Teamleader wijzigen, een mail/brief/WhatsApp sturen, een rij
// verwijderen van iemand anders. Facturen en abonnementen blijven in het CRM;
// het overzicht geeft een knop naar de juiste klant.
//
// Fail-soft: zonder tabel incasso_trajecten toont het overzicht enkel "Nog te
// bepalen" en weigert elke actie met 503 TRAJECTEN_NIET_ACTIEF.

import {
  FASE_LABEL, FASES, CHECKLIST, CHECKLIST_LABEL, GESLOTEN_ALS, GESLOTEN_LABEL, BRON_LABEL, OPVOLG_DAGEN,
  faseVan, aanmaningenLopen, checklistStand, openstaand, isMinderjarig, volgendeCheck, logRegel,
  cijfersPerFase, vandaagBrussel, plusDagen, magActie,
} from './incasso-traject.js';
import { laadIncassoRijen, huidigeStatus, STATUS_LABEL } from './klant-incassostatus.js';

export const CRM_PUBLIEK = (process.env.CRM_PUBLIC_URL || 'https://forex-opleiding-interface.vercel.app').replace(/\/+$/, '');
const AFGESLOTEN_VENSTER_DAGEN = 60;
const DOSSIER_TERMINAAL = ['betaald', 'afgeschreven', 'oninbaar', 'geretourneerd'];
const GHL_PARALLEL = 4;

export const klantUrl = (customerId) => `${CRM_PUBLIEK}/modules/klanten-v2/?id=${encodeURIComponent(customerId)}&tab=incasso#klanten`;
export const MAANDLIJST_URL = `${CRM_PUBLIEK}/modules/finance.html?tab=wanbetalers`;

const fout = (status, code, message, extra = {}) => ({ status, body: { ok: false, code, message, ...extra } });
const goed = (message, data = null) => ({ status: 200, body: { ok: true, code: 'ok', message, data } });

function tabelOntbreekt(err) {
  const code = String(err?.code || '');
  const msg = String(err?.message || '');
  return ['42P01', 'PGRST205'].includes(code) || (/incasso_trajecten/.test(msg) && /does not exist|could not find|schema cache/i.test(msg));
}

const naamVan = (c) => {
  if (!c) return null;
  if (c.is_company && c.company_name) return c.company_name;
  return [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.company_name || c.email || null;
};

// ── Lezen ─────────────────────────────────────────────────────────────────

/** Open trajecten + de recent gesloten. `{ ok, rijen }`; ok=false = tabel ontbreekt. */
export async function laadTrajecten(crm, { vandaag } = {}) {
  const sinds = plusDagen(vandaag || vandaagBrussel(), -AFGESLOTEN_VENSTER_DAGEN);
  const { data, error } = await crm.from('incasso_trajecten').select('*')
    .or(`gesloten_op.is.null,gesloten_op.gte.${sinds}`);
  if (error) {
    if (tabelOntbreekt(error)) return { ok: false, rijen: [] };
    throw new Error('incasso_trajecten lezen: ' + error.message);
  }
  return { ok: true, rijen: data || [] };
}

/**
 * Iedereen die vandaag al een spoor van incasso heeft (de kandidaten voor
 * "Nog te bepalen"). Per klant: [{ bron, op, tekst }]. Fail-soft per bron.
 */
export async function laadSporen({ crm, lms }) {
  const sporen = new Map(); // customer_id → [{ bron, op, tekst, lms_student_id?, onboarding_id? }]
  const extra = new Map();  // customer_id → { lms_student_id, onboarding_id }
  const voeg = (cid, bron, op, tekst, meer = {}) => {
    if (!cid) return;
    if (!sporen.has(cid)) sporen.set(cid, []);
    sporen.get(cid).push({ bron, label: BRON_LABEL[bron] || bron, op: op ? String(op).slice(0, 10) : null, tekst: tekst ? String(tekst).slice(0, 200) : null });
    const e = extra.get(cid) || {};
    if (meer.lms_student_id && !e.lms_student_id) e.lms_student_id = meer.lms_student_id;
    if (meer.onboarding_id && !e.onboarding_id) e.onboarding_id = meer.onboarding_id;
    extra.set(cid, e);
  };

  // 1) Onboarding op incasso (en niet terug).
  try {
    const { data, error } = await crm.from('onboardings')
      .select('id, customer_id, incasso_op, incasso_terug_op, incasso_reden, dfo_lms_student_id, is_test')
      .not('incasso_op', 'is', null);
    if (error) throw error;
    for (const o of data || []) {
      if (o.is_test) continue;
      if (o.incasso_terug_op && String(o.incasso_terug_op) >= String(o.incasso_op)) continue;
      voeg(o.customer_id, 'onboarding', o.incasso_op, o.incasso_reden, { lms_student_id: o.dfo_lms_student_id, onboarding_id: o.id });
    }
  } catch (e) { console.warn('[incasso-overzicht] onboardings:', e?.message || e); }

  // 2) Incassodossiers die nog lopen.
  try {
    const { data, error } = await crm.from('dunning_incasso_dossiers').select('id, customer_id, status, opened_at');
    if (error) throw error;
    for (const d of data || []) {
      if (DOSSIER_TERMINAAL.includes(String(d.status || '').toLowerCase())) continue;
      voeg(d.customer_id, 'dossier', d.opened_at, `Dossier ${d.status || 'open'}`);
    }
  } catch (e) { console.warn('[incasso-overzicht] dossiers:', e?.message || e); }

  // 3) Wanbetalers-pipeline op fase incasso.
  try {
    const { data, error } = await crm.from('dunning_pipeline_customers').select('customer_id, stage_changed_at').eq('stage_slug', 'incasso');
    if (error) throw error;
    for (const p of data || []) voeg(p.customer_id, 'pipeline', p.stage_changed_at, null);
  } catch (e) { console.warn('[incasso-overzicht] pipeline:', e?.message || e); }

  // 4) Het spoor incasso-opvolging in het LMS (open kaarten).
  if (lms) {
    try {
      const { data, error } = await lms.from('hlms_signaal')
        .select('student_id, crm_onboarding_id, aangemaakt_op, gesloten_op')
        .eq('soort', 'incasso_opvolging').is('gesloten_op', null);
      if (error) throw error;
      const kaarten = data || [];
      const onbIds = [...new Set(kaarten.map((k) => k.crm_onboarding_id).filter(Boolean))];
      const stuIds = [...new Set(kaarten.filter((k) => !k.crm_onboarding_id).map((k) => k.student_id).filter(Boolean))];
      const onbKlant = new Map();
      if (onbIds.length) {
        const { data: obs } = await crm.from('onboardings').select('id, customer_id').in('id', onbIds);
        for (const o of obs || []) onbKlant.set(o.id, o.customer_id);
      }
      const stuMail = new Map();
      if (stuIds.length) {
        const { data: st } = await lms.from('hlms_student').select('id, email').in('id', stuIds);
        for (const s of st || []) if (s.email) stuMail.set(s.id, String(s.email).trim().toLowerCase());
      }
      const mails = [...new Set(stuMail.values())];
      const mailKlant = new Map();
      if (mails.length) {
        const { data: cs } = await crm.from('customers').select('id, email').in('email', mails);
        const tel = new Map();
        for (const c of cs || []) {
          const m = String(c.email || '').trim().toLowerCase();
          tel.set(m, (tel.get(m) || 0) + 1);
          mailKlant.set(m, c.id);
        }
        // Enkel een UNIEKE match koppelt (nooit "kies de eerste").
        for (const [m, n] of tel) if (n > 1) mailKlant.delete(m);
      }
      for (const k of kaarten) {
        const cid = k.crm_onboarding_id ? onbKlant.get(k.crm_onboarding_id) : mailKlant.get(stuMail.get(k.student_id));
        voeg(cid, 'signaal', k.aangemaakt_op, null, { lms_student_id: k.student_id, onboarding_id: k.crm_onboarding_id });
      }
    } catch (e) { console.warn('[incasso-overzicht] LMS-signalen:', e?.message || e); }
  }
  return { sporen, extra };
}

async function laadKlantData(crm, ids) {
  const leeg = { klanten: new Map(), deals: new Map(), regels: new Map(), facturen: new Map() };
  if (!ids.length) return leeg;
  const { data: klanten } = await crm.from('customers')
    .select('id, first_name, last_name, company_name, is_company, email, date_of_birth, ghl_contact_id, is_test').in('id', ids);
  for (const c of klanten || []) leeg.klanten.set(c.id, c);
  const { data: deals } = await crm.from('deals')
    .select('id, customer_id, total_amount, discount_percentage, sale_type, tl_quotation_status, tl_quotation_accepted_at, tl_quotation_declined_at, archived_at')
    .in('customer_id', ids);
  const dealIds = [];
  for (const d of deals || []) {
    if (!leeg.deals.has(d.customer_id)) leeg.deals.set(d.customer_id, []);
    leeg.deals.get(d.customer_id).push(d);
    dealIds.push(d.id);
  }
  if (dealIds.length) {
    const { data: regels } = await crm.from('deal_line_items').select('deal_id, quantity, unit_price, vat_percentage, price_includes_vat').in('deal_id', dealIds);
    for (const r of regels || []) {
      if (!leeg.regels.has(r.deal_id)) leeg.regels.set(r.deal_id, []);
      leeg.regels.get(r.deal_id).push(r);
    }
  }
  const { data: facturen } = await crm.from('invoices')
    .select('id, customer_id, invoice_number, status, amount_total, amount_paid, credited_amount, is_test').in('customer_id', ids);
  for (const f of facturen || []) {
    if (!leeg.facturen.has(f.customer_id)) leeg.facturen.set(f.customer_id, []);
    leeg.facturen.get(f.customer_id).push(f);
  }
  return leeg;
}

async function inGroepjes(lijst, n, fn) {
  const uit = [];
  for (let i = 0; i < lijst.length; i += n) uit.push(...(await Promise.all(lijst.slice(i, i + n).map(fn))));
  return uit;
}

/**
 * Het hele overzicht. deps: { crm, lms, ghl?: (contactId) => Promise, nu?, metGhl? }
 * @returns {{ rijen, cijfers, bureaus, migratie, ghl }}
 */
export async function laadIncassoOverzicht(deps) {
  const { crm, lms = null, nu = new Date(), metGhl = true } = deps;
  const vandaag = vandaagBrussel(nu);
  const tr = await laadTrajecten(crm, { vandaag });
  const { sporen, extra } = await laadSporen({ crm, lms });

  // Klanten met een #1957-status zonder traject (bv. met de hand gezet).
  const { data: statusRijen } = await crm.from('mentor_commissie_incasso').select('customer_id').is('opgeheven_op', null).is('deal_id', null);
  const metStatus = new Set((statusRijen || []).map((r) => r.customer_id));

  const trajectPerKlant = new Map();
  for (const t of tr.rijen) {
    const al = trajectPerKlant.get(t.customer_id);
    // Het open traject wint; anders het laatst gesloten.
    if (!al || (!t.gesloten_op && al.gesloten_op) || (al.gesloten_op && t.gesloten_op && t.gesloten_op > al.gesloten_op)) trajectPerKlant.set(t.customer_id, t);
  }
  const ids = [...new Set([...trajectPerKlant.keys(), ...sporen.keys(), ...metStatus])];
  const st = await laadIncassoRijen(crm, ids, { alleenActief: true });
  const data = await laadKlantData(crm, ids);

  const rijen = [];
  for (const cid of ids) {
    const klant = data.klanten.get(cid);
    if (!klant || klant.is_test) continue;
    const traject = trajectPerKlant.get(cid) || null;
    const status = huidigeStatus(st.rijen.filter((r) => r.customer_id === cid), cid);
    // Zonder traject: enkel tonen als er een spoor is of een lopende status.
    // Een gesloten traject is beslist: een oud spoor zet hem niet terug in Nog te bepalen.
    if (!traject && !sporen.has(cid) && !['bij_incasso', 'incasso_regeling'].includes(status.status)) continue;
    const fase = faseVan({ traject, status: status.status });
    const e = extra.get(cid) || {};
    const minderjarig = isMinderjarig(klant.date_of_birth, vandaag);
    rijen.push({
      customer_id: cid,
      traject_id: traject?.id || null,
      naam: naamVan(klant) || traject?.naam || 'Onbekend',
      email: klant.email || null,
      fase,
      fase_label: FASE_LABEL[fase],
      status: { status: status.status, label: status.label, sinds: status.sinds || null, incasso_sinds: status.incasso_sinds || null },
      aanmaningen_lopen: aanmaningenLopen(fase),
      minderjarig,
      herkomst: traject?.herkomst || null,
      voorgesteld_door: traject?.voorgesteld_door || null,
      voorgesteld_op: traject?.voorgesteld_op || null,
      voorstel_notitie: traject?.voorstel_notitie || null,
      geselecteerd_door: traject?.geselecteerd_door || null,
      geselecteerd_op: traject?.geselecteerd_op || null,
      bronnen: sporen.get(cid) || [],
      checklist: traject?.checklist || {},
      checklist_stand: checklistStand(traject?.checklist || {}),
      bureau_id: traject?.bureau_id || null,
      overgedragen_bedrag: traject?.overgedragen_bedrag != null ? Number(traject.overgedragen_bedrag) : null,
      overgedragen_op: traject?.overgedragen_op || null,
      volgende_check: volgendeCheck(traject, fase),
      gesloten_op: traject?.gesloten_op || null,
      gesloten_als: traject?.gesloten_als || (status.status === 'afgesloten' ? status.afgesloten_als || null : null),
      gesloten_reden: traject?.gesloten_reden || null,
      logboek: Array.isArray(traject?.logboek) ? traject.logboek.slice(-20) : [],
      lms_student_id: traject?.lms_student_id || e.lms_student_id || null,
      onboarding_id: traject?.onboarding_id || e.onboarding_id || null,
      afwijking: traject && !traject.gesloten_op && traject.geselecteerd_op && status.status === 'actief'
        ? 'Doorgezet, maar de incassostatus in het CRM staat op actief.' : null,
      crm_url: klantUrl(cid),
      ghl_contact_id: klant.ghl_contact_id || null,
      geld: openstaand({ deals: data.deals.get(cid) || [], regelsPerDeal: data.regels, facturen: data.facturen.get(cid) || [] }),
    });
  }

  // GoHighLevel: enkel voor open fases, fail-soft per klant.
  const ghlStand = { gelezen: 0, niet: 0, reden: null };
  if (metGhl && deps.ghl) {
    const open = rijen.filter((r) => r.fase !== 'afgesloten' && r.ghl_contact_id);
    await inGroepjes(open, GHL_PARALLEL, async (r) => {
      const g = await deps.ghl(r.ghl_contact_id);
      if (g?.ok) {
        r.geld = openstaand({ deals: data.deals.get(r.customer_id) || [], regelsPerDeal: data.regels, facturen: data.facturen.get(r.customer_id) || [], ghlBetaald: g.bedrag });
        ghlStand.gelezen += 1;
      } else {
        r.ghl_reden = g?.reden || 'ghl_onbekend';
        ghlStand.niet += 1;
        ghlStand.reden = ghlStand.reden || r.ghl_reden;
      }
    });
  }
  for (const r of rijen) delete r.ghl_contact_id;

  rijen.sort((a, b) => FASES.indexOf(a.fase) - FASES.indexOf(b.fase) || a.naam.localeCompare(b.naam, 'nl'));

  let bureaus = [];
  try {
    const { data: bs } = await crm.from('dunning_incasso_bureaus').select('id, name, country, is_active').eq('is_active', true);
    bureaus = (bs || []).map((b) => ({ id: b.id, naam: b.name, land: b.country || null }));
  } catch (e) { console.warn('[incasso-overzicht] bureaus:', e?.message || e); }

  return {
    vandaag,
    rijen,
    cijfers: cijfersPerFase(rijen, vandaag),
    bureaus,
    migratie: { trajecten: tr.ok, status_kolommen: st.statusKolommen },
    ghl: ghlStand,
    maandlijst_url: MAANDLIJST_URL,
    labels: { fase: FASE_LABEL, checklist: CHECKLIST_LABEL, gesloten: GESLOTEN_LABEL, status: STATUS_LABEL },
  };
}

// ── Schrijven ─────────────────────────────────────────────────────────────

async function profielId(crm, email) {
  if (!email) return null;
  try {
    const { data } = await crm.from('profiles').select('id').ilike('email', String(email).trim()).limit(1);
    return data?.[0]?.id || null;
  } catch { return null; }
}

async function openTraject(crm, customerId) {
  const { data, error } = await crm.from('incasso_trajecten').select('*').eq('customer_id', customerId).is('gesloten_op', null).maybeSingle();
  if (error) {
    if (tabelOntbreekt(error)) return { ontbreekt: true, traject: null };
    throw new Error('traject lezen: ' + error.message);
  }
  return { ontbreekt: false, traject: data || null };
}

async function klantStand(deps, customerId) {
  const { crm } = deps;
  const { data: klant } = await crm.from('customers').select('id, first_name, last_name, company_name, is_company, email, date_of_birth, is_test').eq('id', customerId).maybeSingle();
  const st = await laadIncassoRijen(crm, [customerId], { alleenActief: true });
  return { klant, status: huidigeStatus(st.rijen, customerId), statusKolommen: st.statusKolommen };
}

/**
 * De #1957-status wijzigen, met dezelfde gevolgen als api/klant-incassostatus.js:
 * daarna de factuurmotor (commissie, forward-only) en een auditregel.
 */
async function wijzigStatus(deps, { customerId, status, afgeslotenAls = null, sinds, reden, actorId }) {
  const out = await deps.zetStatus(deps.crm, { customerId, status, afgeslotenAls, sinds, reden, actorId, bron: 'handmatig' });
  if (deps.motor) {
    try { await deps.motor({ customerId }); } catch (e) { console.error('[incasso-traject] factuurmotor:', e?.message || e); }
  }
  try {
    await deps.crm.from('audit_log').insert({
      user_id: actorId, action: 'customer.incassostatus', entity_type: 'customer', entity_id: customerId,
      after_json: { status, afgesloten_als: afgeslotenAls, sinds, via: 'lms-incasso' }, reason_text: String(reden || '').slice(0, 500),
    });
  } catch (e) { console.error('[incasso-traject] audit:', e?.message || e); }
  return out;
}

async function pipeline(deps, customerId, fase, reden, door) {
  if (!deps.setStage) return;
  try {
    if (deps.ensurePipeline) await deps.ensurePipeline(customerId);
    await deps.setStage(customerId, fase, reden, door);
  } catch (e) { console.warn('[incasso-traject] pipeline:', e?.message || e); }
}

async function bewaar(crm, id, wijziging) {
  const { error } = await crm.from('incasso_trajecten').update({ ...wijziging, bijgewerkt_op: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error('traject bewaren: ' + error.message);
}

const metLog = (traject, regel) => [...(Array.isArray(traject?.logboek) ? traject.logboek : []), regel].slice(-200);

async function zoekKlant(crm, invoer) {
  if (invoer.customer_id) return String(invoer.customer_id);
  if (invoer.crm_onboarding_id) {
    const { data } = await crm.from('onboardings').select('customer_id').eq('id', invoer.crm_onboarding_id).maybeSingle();
    if (data?.customer_id) return data.customer_id;
  }
  const mail = String(invoer.email || '').trim().toLowerCase();
  if (mail) {
    const { data } = await crm.from('customers').select('id').ilike('email', mail).limit(2);
    if ((data || []).length === 1) return data[0].id;
  }
  return null;
}

/**
 * Eén actie. invoer = { actie, actor: { email, naam, rollen[] }, ...velden }.
 * deps = { crm, zetStatus, motor?, setStage?, ensurePipeline?, nu? }
 * @returns {{ status: number, body: object }}
 */
export async function voerIncassoActieUit(deps, invoer = {}) {
  const { crm } = deps;
  const nu = deps.nu || new Date();
  const vandaag = vandaagBrussel(nu);
  const actie = String(invoer.actie || '');
  const actor = invoer.actor || {};
  const rollen = Array.isArray(actor.rollen) ? actor.rollen : [];
  const door = String(actor.naam || actor.email || 'onbekend').slice(0, 200);
  if (!magActie(rollen, actie)) return fout(403, 'geen_recht', 'Dit mag je rol niet.');
  const notitie = String(invoer.notitie || '').trim().slice(0, 1000);
  const datum = /^\d{4}-\d{2}-\d{2}$/.test(String(invoer.datum || '')) ? String(invoer.datum) : vandaag;
  //  Doorschuiven kijkt vooruit; elke andere datum is een moment dat al voorbij is.
  if (actie !== 'doorschuiven' && datum > vandaag) return fout(400, 'datum_toekomst', 'Een datum in de toekomst kan niet.');

  const customerId = await zoekKlant(crm, invoer);
  if (!customerId) return fout(404, 'klant_onbekend', 'Deze student is niet als klant gevonden in het CRM.');
  const { klant, status } = await klantStand(deps, customerId);
  if (!klant) return fout(404, 'klant_onbekend', 'Klant niet gevonden.');
  const minderjarig = isMinderjarig(klant.date_of_birth, vandaag) || invoer.minderjarig === true;
  const open = await openTraject(crm, customerId);
  if (open.ontbreekt) return fout(503, 'trajecten_niet_actief', 'De migratie 2026-11-03-incasso-trajecten.sql is nog niet gedraaid.');
  let traject = open.traject;
  const fase = faseVan({ traject, status: status.status });
  const actorId = await profielId(crm, actor.email);
  const regel = (tekst, soort = actie) => logRegel({ door, tekst, soort, nu });

  //  STATUS ZONDER TRAJECT (gemeten 9 nov: 22 klanten, met de hand gezet in
  //  klanten-v2 vóór dit overzicht bestond). De status is de beslissing; het
  //  traject ontstaat bij de eerste opvolgactie, zonder de status te raken.
  const OPVOLG = ['vink', 'gecheckt', 'notitie', 'doorschuiven', 'regeling', 'afsluiten', 'corrigeer'];
  //  Corrigeren heropent liever een (te vroeg) gesloten traject dan een nieuw te maken.
  const heeftOud = actie === 'corrigeer' && !traject
    ? ((await crm.from('incasso_trajecten').select('id').eq('customer_id', customerId).limit(1)).data || []).length > 0
    : false;
  if (!traject && !heeftOud && status.status !== 'actief' && OPVOLG.includes(actie)) {
    const { data: nieuw, error } = await crm.from('incasso_trajecten').insert({
      customer_id: customerId, onboarding_id: invoer.crm_onboarding_id || null, lms_student_id: invoer.lms_student_id || null,
      naam: String(invoer.naam || '').slice(0, 200) || null, herkomst: 'bestaand', voorgesteld_door: 'Incassostatus in het CRM',
      geselecteerd_op: status.gezet_op || null,
      logboek: [regel(`Traject aangemaakt bij de eerste actie (status: ${status.label}).`, 'bestaand')],
    }).select('*').single();
    if (error && error.code !== '23505') return fout(500, 'interne_fout', 'Het traject kon niet aangemaakt worden.');
    traject = nieuw || (await openTraject(crm, customerId)).traject;
  }

  try {
    switch (actie) {
      // ── Fase 1: voorstellen (Seppe na brief 2, of de onboarding) ───────────
      case 'voorstel': {
        if (minderjarig) return fout(422, 'minderjarig', 'Minderjarig: geen incasso. Deactiveer het abonnement en crediteer de factuur.');
        if (traject) return goed('Staat al in het incasso-overzicht.', { al: true, traject_id: traject.id, fase });
        if (status.status !== 'actief') return fout(409, 'al_in_incasso', `Staat al op "${status.label}" in het CRM. Kies de fase in Nog te bepalen.`);
        const herkomst = ['brief_2', 'onboarding', 'handmatig'].includes(invoer.herkomst) ? invoer.herkomst : 'handmatig';
        const { data, error } = await crm.from('incasso_trajecten').insert({
          customer_id: customerId, onboarding_id: invoer.crm_onboarding_id || null, lms_student_id: invoer.lms_student_id || null,
          naam: String(invoer.naam || '').slice(0, 200) || null, herkomst, voorgesteld_door: door, voorstel_notitie: notitie || null,
          logboek: [regel(`Voorgesteld voor incasso${herkomst === 'brief_2' ? ' na brief 2' : ''}${notitie ? `: ${notitie}` : ''}`)],
        }).select('id').single();
        if (error) {
          if (error.code === '23505') return goed('Staat al in het incasso-overzicht.', { al: true });
          throw new Error(error.message);
        }
        return goed('Voorgesteld. Maxim of de hoofdmentor beslist.', { traject_id: data.id, fase: 'mag_naar_incasso' });
      }

      // ── Nog te bepalen: Maxim kiest per persoon de fase ────────────────────
      case 'kies_fase': {
        if (traject) return fout(409, 'al_bepaald', 'Deze klant heeft al een fase.');
        const doel = String(invoer.fase || '');
        if (!['mag_naar_incasso', 'doorgezet', 'bij_incasso', 'regeling', 'afgesloten'].includes(doel)) return fout(400, 'fase', 'Kies een fase.');
        if (notitie.length < 3) return fout(400, 'notitie', 'Schrijf kort waarom.');
        if (minderjarig && doel !== 'afgesloten') return fout(422, 'minderjarig', 'Minderjarig: geen incasso. Kies Afgesloten.');
        const als = doel === 'afgesloten' ? String(invoer.als || '') : null;
        if (doel === 'afgesloten' && !GESLOTEN_ALS.includes(als)) return fout(400, 'als', 'Kies: betaald, oninbaar, teruggekomen of niet naar incasso.');
        const bedrag = invoer.bedrag != null && invoer.bedrag !== '' ? Number(invoer.bedrag) : null;
        if (bedrag != null && !(bedrag >= 0)) return fout(400, 'bedrag', 'Geef een geldig bedrag.');

        const rij = {
          customer_id: customerId, onboarding_id: invoer.crm_onboarding_id || null, lms_student_id: invoer.lms_student_id || null,
          naam: String(invoer.naam || '').slice(0, 200) || null, herkomst: 'bestaand', voorgesteld_door: 'Bestaand dossier',
          voorstel_notitie: notitie, logboek: [regel(`Fase gekozen: ${FASE_LABEL[doel]}${als ? ` (${GESLOTEN_LABEL[als]})` : ''}. ${notitie}`, 'kies_fase')],
        };
        if (doel !== 'mag_naar_incasso') Object.assign(rij, { geselecteerd_door: door, geselecteerd_op: nu.toISOString() });
        if (doel === 'bij_incasso') {
          Object.assign(rij, {
            checklist: { dossier_verstuurd: { op: datum, door, bestaand: true } },
            bureau_id: invoer.bureau_id || null, overgedragen_op: datum, overgedragen_bedrag: bedrag,
            volgende_check: vandaag,
          });
        }
        if (doel === 'afgesloten') Object.assign(rij, { gesloten_op: nu.toISOString(), gesloten_als: als, gesloten_door: door, gesloten_reden: notitie });
        const { data: nieuw, error } = await crm.from('incasso_trajecten').insert(rij).select('id').single();
        if (error) {
          if (error.code === '23505') return fout(409, 'al_bepaald', 'Deze klant heeft al een fase.');
          throw new Error(error.message);
        }
        // De status volgt de gekozen fase (enkel als ze verschilt).
        const wil = { mag_naar_incasso: 'actief', doorgezet: 'bij_incasso', bij_incasso: 'bij_incasso', regeling: 'incasso_regeling' }[doel]
          || (als === 'betaald' || als === 'oninbaar' ? 'afgesloten' : 'actief');
        const moet = wil !== status.status || (wil === 'afgesloten' && status.afgesloten_als !== als);
        if (moet) {
          try {
            await wijzigStatus(deps, { customerId, status: wil, afgeslotenAls: wil === 'afgesloten' ? als : null, sinds: datum, reden: `Incasso-overzicht: ${FASE_LABEL[doel]}. ${notitie}`, actorId });
          } catch (e) {
            //  Herstel: het traject dat we net maakten weer weg (eigen rij, zelfde verzoek).
            await crm.from('incasso_trajecten').delete().eq('id', nieuw.id);
            throw e;
          }
        }
        if (doel === 'regeling') await pipeline(deps, customerId, 'regeling', 'Incasso-overzicht: regeling', door);
        if (doel === 'doorgezet' || doel === 'bij_incasso') await pipeline(deps, customerId, 'incasso', `Incasso-overzicht: ${FASE_LABEL[doel]}`, door);
        if (als === 'betaald') await pipeline(deps, customerId, 'opgelost', 'Incasso-overzicht: betaald', door);
        if (als === 'oninbaar') await pipeline(deps, customerId, 'afschrijven', 'Incasso-overzicht: oninbaar', door);
        return goed(`Fase: ${FASE_LABEL[doel]}.`, { traject_id: nieuw.id, fase: doel });
      }

      // ── Fase 1 → 2: selecteren ─────────────────────────────────────────────
      case 'doorzetten': {
        //  Het bord (5 nov): al doorgezet = niets opnieuw (idempotent).
        if (fase === 'doorgezet' || fase === 'bij_incasso') return goed('Staat al bij incasso.', { al: true, fase });
        if (minderjarig) return fout(422, 'minderjarig', 'Minderjarig: geen incasso.');
        //  Zonder traject (het voorstel kwam niet aan, of de klant stond nog
        //  nergens): het traject ontstaat hier, in één keer doorgezet.
        if (fase !== 'mag_naar_incasso' && !(fase === 'te_bepalen' && !traject)) {
          return fout(409, 'fase', `Kan alleen vanuit Mag naar incasso (nu: ${FASE_LABEL[fase]}).`);
        }
        let t = traject;
        if (!t) {
          const { data: nieuw, error } = await crm.from('incasso_trajecten').insert({
            customer_id: customerId, onboarding_id: invoer.crm_onboarding_id || null, lms_student_id: invoer.lms_student_id || null,
            naam: String(invoer.naam || '').slice(0, 200) || null, herkomst: 'brief_2', voorgesteld_door: door,
            logboek: [regel('Voorgesteld en meteen doorgezet vanaf het bord', 'voorstel')],
          }).select('*').single();
          if (error) throw new Error(error.message);
          t = nieuw;
        }
        if (status.status !== 'bij_incasso') {
          try {
            await wijzigStatus(deps, { customerId, status: 'bij_incasso', sinds: vandaag, reden: `Doorgezet naar incasso${notitie ? `: ${notitie}` : ''}`, actorId });
          } catch (e) {
            if (!traject) await crm.from('incasso_trajecten').delete().eq('id', t.id);
            throw e;
          }
        }
        const volgende = plusDagen(vandaag, OPVOLG_DAGEN);
        await bewaar(crm, t.id, { geselecteerd_door: door, geselecteerd_op: nu.toISOString(), volgende_check: volgende, logboek: metLog(t, regel(`Doorgezet. Aanmaningen staan stil.${notitie ? ` ${notitie}` : ''}`)) });
        await pipeline(deps, customerId, 'incasso', 'Incasso-overzicht: doorgezet', door);
        return goed('Doorgezet. De aanmaningen staan stil.', { fase: 'doorgezet', volgende_check: volgende });
      }
      case 'doorschuiven': {
        if (!traject) return fout(409, 'geen_traject', 'Kies eerst een fase.');
        if (!(datum > vandaag)) return fout(400, 'datum', 'Kies een datum na vandaag.');
        await bewaar(crm, traject.id, { volgende_check: datum, logboek: metLog(traject, regel(`Terug op de lijst op ${datum}.${notitie ? ` ${notitie}` : ''}`)) });
        return goed('Bewaard.', { volgende_check: datum });
      }
      case 'niet_naar_incasso': {
        if (fase !== 'mag_naar_incasso') return fout(409, 'fase', 'Kan alleen vanuit Mag naar incasso.');
        if (notitie.length < 3) return fout(400, 'notitie', 'Schrijf kort waarom niet.');
        await bewaar(crm, traject.id, { gesloten_op: nu.toISOString(), gesloten_als: 'niet_naar_incasso', gesloten_door: door, gesloten_reden: notitie, logboek: metLog(traject, regel(`Niet naar incasso: ${notitie}`)) });
        return goed('Niet naar incasso. De aanmaningen lopen gewoon verder.', { fase: 'afgesloten' });
      }

      // ── Fase 2: afvinklijst ────────────────────────────────────────────────
      case 'vink': {
        if (fase !== 'doorgezet') return fout(409, 'fase', 'Afvinken kan alleen in Doorgezet.');
        const item = String(invoer.item || '');
        if (!CHECKLIST.includes(item)) return fout(400, 'item', 'Onbekend vinkje.');
        const aan = invoer.aan !== false;
        const lijst = { ...(traject.checklist || {}) };
        const wijziging = {};
        if (aan) {
          if (item === 'bureau_gekozen') {
            const bid = String(invoer.bureau_id || '');
            const { data: b } = bid ? await crm.from('dunning_incasso_bureaus').select('id, name, is_active').eq('id', bid).maybeSingle() : { data: null };
            if (!b || b.is_active === false) return fout(400, 'bureau', 'Kies een bureau.');
            wijziging.bureau_id = b.id;
          }
          if (item === 'dossier_verstuurd') {
            if (!checklistStand(lijst).dossierMag) return fout(409, 'eerst_de_rest', 'Vink eerst de andere stappen af.');
            const bedrag = Number(invoer.bedrag);
            if (!(bedrag > 0)) return fout(400, 'bedrag', 'Geef het bedrag dat naar het bureau gaat.');
            Object.assign(wijziging, { overgedragen_bedrag: Math.round(bedrag * 100) / 100, overgedragen_op: datum, volgende_check: plusDagen(datum, OPVOLG_DAGEN) });
          }
          lijst[item] = { op: datum, door };
        } else {
          delete lijst[item];
        }
        wijziging.checklist = lijst;
        wijziging.logboek = metLog(traject, regel(`${CHECKLIST_LABEL[item]}${aan ? '' : ' (uitgevinkt)'}${notitie ? `: ${notitie}` : ''}`));
        await bewaar(crm, traject.id, wijziging);
        return goed(item === 'dossier_verstuurd' && aan ? 'Bij incasso. Volgende check over 14 dagen.' : 'Bewaard.', { fase: item === 'dossier_verstuurd' && aan ? 'bij_incasso' : 'doorgezet' });
      }

      // ── Fase 3: om de 14 dagen nakijken ────────────────────────────────────
      case 'gecheckt': {
        if (fase !== 'bij_incasso') return fout(409, 'fase', 'Nakijken kan alleen in Bij incasso.');
        const volgende = plusDagen(vandaag, OPVOLG_DAGEN);
        await bewaar(crm, traject.id, { volgende_check: volgende, logboek: metLog(traject, regel(`Nagekeken bij het bureau.${notitie ? ` ${notitie}` : ''}`)) });
        return goed('Nagekeken. Volgende check over 14 dagen.', { volgende_check: volgende });
      }
      case 'notitie': {
        if (!traject) return fout(409, 'geen_traject', 'Kies eerst een fase.');
        if (notitie.length < 3) return fout(400, 'notitie', 'Schrijf een notitie.');
        await bewaar(crm, traject.id, { logboek: metLog(traject, regel(notitie)) });
        return goed('Bewaard.');
      }

      // ── Fase 4: regeling ───────────────────────────────────────────────────
      case 'regeling': {
        if (!['doorgezet', 'bij_incasso'].includes(fase)) return fout(409, 'fase', 'Een regeling kan vanuit Doorgezet of Bij incasso.');
        await wijzigStatus(deps, { customerId, status: 'incasso_regeling', sinds: vandaag, reden: `Regeling na incasso${notitie ? `: ${notitie}` : ''}`, actorId });
        await bewaar(crm, traject.id, { volgende_check: null, logboek: metLog(traject, regel(`Regeling.${notitie ? ` ${notitie}` : ''}`)) });
        await pipeline(deps, customerId, 'regeling', 'Incasso-overzicht: regeling', door);
        return goed('Regeling. Crediteer de bureaufactuur en voer het incasso-abonnement in het CRM in.', { fase: 'regeling' });
      }

      // ── Status corrigeren (13 nov 2026): een verkeerde klik terugzetten ───
      //  Kies de juiste fase, met reden. Er wordt niets gewist: de vorige
      //  status blijft als historiek staan (zetStatus), het logboek krijgt
      //  een regel "Status gecorrigeerd: X → Y", en de afvinklijst volgt de
      //  fase (Bij incasso = dossier verstuurd; terug naar Doorgezet of Mag
      //  naar incasso = dat vinkje weg, het logboek houdt bij dat het er was).
      case 'corrigeer': {
        const doel = String(invoer.fase || '');
        if (!['mag_naar_incasso', 'doorgezet', 'bij_incasso', 'regeling', 'afgesloten'].includes(doel)) return fout(400, 'fase', 'Kies de juiste fase.');
        if (notitie.length < 5) return fout(400, 'notitie', 'Schrijf kort waarom je corrigeert.');
        const als = doel === 'afgesloten' ? String(invoer.als || '') : null;
        if (doel === 'afgesloten' && !GESLOTEN_ALS.includes(als)) return fout(400, 'als', 'Kies: betaald, oninbaar, teruggekomen of niet naar incasso.');
        if (minderjarig && doel !== 'afgesloten') return fout(422, 'minderjarig', 'Minderjarig: geen incasso. Kies Afgesloten.');
        //  Het open traject, of het laatste gesloten (een te vroeg afgesloten dossier).
        let t = traject;
        if (!t) {
          const { data } = await crm.from('incasso_trajecten').select('*').eq('customer_id', customerId).order('aangemaakt_op', { ascending: false }).limit(1);
          t = data?.[0] || null;
        }
        if (!t) return fout(409, 'geen_traject', 'Deze klant heeft nog geen fase: kies ze in Nog te bepalen.');
        const van = faseVan({ traject: t, status: status.status });
        if (van === doel && (doel !== 'afgesloten' || t.gesloten_als === als)) return fout(409, 'zelfde_fase', `Staat al op "${FASE_LABEL[doel]}".`);

        const checklist = { ...(t.checklist && typeof t.checklist === 'object' ? t.checklist : {}) };
        if (doel === 'bij_incasso' && !checklist.dossier_verstuurd) checklist.dossier_verstuurd = { op: datum, door, correctie: true };
        if ((doel === 'doorgezet' || doel === 'mag_naar_incasso') && checklist.dossier_verstuurd) delete checklist.dossier_verstuurd;
        const tekst = `Status gecorrigeerd: ${FASE_LABEL[van]} → ${FASE_LABEL[doel]}${als ? ` (${GESLOTEN_LABEL[als]})` : ''}. ${notitie}`;
        const wijziging = { checklist, logboek: metLog(t, regel(tekst, 'correctie')) };
        if (doel === 'afgesloten') Object.assign(wijziging, { gesloten_op: nu.toISOString(), gesloten_als: als, gesloten_door: door, gesloten_reden: notitie, volgende_check: null });
        else Object.assign(wijziging, { gesloten_op: null, gesloten_als: null, gesloten_door: null, gesloten_reden: null });
        if (doel === 'bij_incasso' || doel === 'doorgezet') wijziging.volgende_check = t.volgende_check && t.volgende_check >= vandaag ? t.volgende_check : plusDagen(vandaag, OPVOLG_DAGEN);
        if (doel === 'regeling') wijziging.volgende_check = null;

        //  De status volgt de fase. Terug naar bij incasso = vanaf het begin van
        //  de incassoketen (de tussenstap was een vergissing); anders vandaag.
        const wil = { mag_naar_incasso: 'actief', doorgezet: 'bij_incasso', bij_incasso: 'bij_incasso', regeling: 'incasso_regeling' }[doel]
          || (als === 'betaald' || als === 'oninbaar' ? 'afgesloten' : 'actief');
        const moet = wil !== status.status || (wil === 'afgesloten' && status.afgesloten_als !== als);
        const sinds = invoer.datum ? datum : (wil === 'bij_incasso' && status.incasso_sinds ? status.incasso_sinds : vandaag);
        const oud = { checklist: t.checklist, logboek: t.logboek, gesloten_op: t.gesloten_op, gesloten_als: t.gesloten_als, gesloten_door: t.gesloten_door, gesloten_reden: t.gesloten_reden, volgende_check: t.volgende_check };
        await bewaar(crm, t.id, wijziging);
        if (moet) {
          try {
            await wijzigStatus(deps, { customerId, status: wil, afgeslotenAls: wil === 'afgesloten' ? als : null, sinds, reden: `Status gecorrigeerd naar ${FASE_LABEL[doel]}: ${notitie}`, actorId });
          } catch (e) {
            //  Herstel: het traject zoals het was (eigen rij, zelfde verzoek).
            await bewaar(crm, t.id, oud);
            throw e;
          }
        }
        const pijp = { doorgezet: 'incasso', bij_incasso: 'incasso', regeling: 'regeling' }[doel]
          || (als === 'betaald' ? 'opgelost' : als === 'oninbaar' ? 'afschrijven' : null);
        if (pijp) await pipeline(deps, customerId, pijp, `Incasso-overzicht: gecorrigeerd naar ${FASE_LABEL[doel]}`, door);
        return goed(`Gecorrigeerd: ${FASE_LABEL[doel]}.`, { fase: doel });
      }

      // ── Afgesloten ─────────────────────────────────────────────────────────
      case 'afsluiten': {
        const als = String(invoer.als || '');
        //  Het bord (5 nov): Betaald kan al in Mag naar incasso. De status blijft
        //  dan actief (er was nog geen incasso); enkel het traject sluit.
        if (fase === 'mag_naar_incasso' && als === 'betaald') {
          if (notitie.length < 3) return fout(400, 'notitie', 'Schrijf kort wat er gebeurde.');
          await bewaar(crm, traject.id, { gesloten_op: nu.toISOString(), gesloten_als: 'betaald', gesloten_door: door, gesloten_reden: notitie, logboek: metLog(traject, regel(`Afgesloten: Betaald. ${notitie}`)) });
          return goed('Afgesloten: Betaald.', { fase: 'afgesloten' });
        }
        if (!['doorgezet', 'bij_incasso', 'regeling'].includes(fase)) return fout(409, 'fase', 'Afsluiten kan vanaf Doorgezet.');
        if (!['betaald', 'oninbaar', 'teruggekomen'].includes(als)) return fout(400, 'als', 'Kies: betaald, oninbaar of teruggekomen.');
        if (notitie.length < 3) return fout(400, 'notitie', 'Schrijf kort wat er gebeurde.');
        if (als === 'teruggekomen') {
          if (status.status !== 'actief') await wijzigStatus(deps, { customerId, status: 'actief', reden: `Teruggekomen van incasso: ${notitie}`, actorId });
        } else {
          await wijzigStatus(deps, { customerId, status: 'afgesloten', afgeslotenAls: als, sinds: vandaag, reden: `Incasso afgesloten (${als}): ${notitie}`, actorId });
        }
        await bewaar(crm, traject.id, { gesloten_op: nu.toISOString(), gesloten_als: als, gesloten_door: door, gesloten_reden: notitie, volgende_check: null, logboek: metLog(traject, regel(`Afgesloten: ${GESLOTEN_LABEL[als]}. ${notitie}`)) });
        if (als === 'betaald') await pipeline(deps, customerId, 'opgelost', 'Incasso-overzicht: betaald', door);
        if (als === 'oninbaar') await pipeline(deps, customerId, 'afschrijven', 'Incasso-overzicht: oninbaar', door);
        return goed(`Afgesloten: ${GESLOTEN_LABEL[als]}.`, { fase: 'afgesloten' });
      }
      default:
        return fout(400, 'actie', 'Onbekende actie.');
    }
  } catch (e) {
    if (e && e.status && e.code) return fout(e.status, String(e.code).toLowerCase(), e.message);
    console.error('[incasso-traject]', actie, e?.message || e);
    return fout(500, 'interne_fout', 'Er ging iets mis. Er is niets half bewaard.');
  }
}

/**
 * Haak voor zetNaarIncasso (onboarding): de klant komt in Mag naar incasso.
 * Fail-soft — de onboarding-incasso mag hier nooit op falen.
 */
export async function stelVoorVanuitOnboarding(crm, { onboardingId, door, reden }) {
  try {
    const { data: ob } = await crm.from('onboardings').select('id, customer_id, customer_name, dfo_lms_student_id, is_test').eq('id', onboardingId).maybeSingle();
    if (!ob?.customer_id || ob.is_test) return { ok: false, reden: 'geen_klant' };
    const { ontbreekt, traject } = await openTraject(crm, ob.customer_id);
    if (ontbreekt) return { ok: false, reden: 'trajecten_niet_actief' };
    if (traject) return { ok: true, al: true };
    const { data: klant } = await crm.from('customers').select('date_of_birth').eq('id', ob.customer_id).maybeSingle();
    if (isMinderjarig(klant?.date_of_birth, vandaagBrussel())) return { ok: false, reden: 'minderjarig' };
    const { error } = await crm.from('incasso_trajecten').insert({
      customer_id: ob.customer_id, onboarding_id: ob.id, lms_student_id: ob.dfo_lms_student_id || null, naam: ob.customer_name || null,
      herkomst: 'onboarding', voorgesteld_door: String(door || 'onboarding').slice(0, 200), voorstel_notitie: reden ? String(reden).slice(0, 1000) : null,
      logboek: [logRegel({ door, tekst: `In de onboarding op incasso gezet${reden ? `: ${reden}` : ''}`, soort: 'voorstel' })],
    });
    if (error && error.code !== '23505') return { ok: false, reden: error.message };
    return { ok: true };
  } catch (e) {
    console.warn('[incasso-traject] voorstel vanuit onboarding:', e?.message || e);
    return { ok: false, reden: e?.message || 'fout' };
  }
}

/** Haak voor activeerUitIncasso: een voorstel uit de onboarding vervalt (enkel in Mag naar incasso). */
export async function sluitOnboardingVoorstel(crm, { onboardingId, door }) {
  try {
    const { data } = await crm.from('incasso_trajecten').select('id, customer_id, logboek, herkomst, geselecteerd_op')
      .eq('onboarding_id', onboardingId).is('gesloten_op', null).maybeSingle();
    if (!data || data.geselecteerd_op) return { ok: true, niets: true };
    const st = await laadIncassoRijen(crm, [data.customer_id], { alleenActief: true });
    if (huidigeStatus(st.rijen, data.customer_id).status !== 'actief') return { ok: true, niets: true };
    await bewaar(crm, data.id, {
      gesloten_op: new Date().toISOString(), gesloten_als: 'niet_naar_incasso', gesloten_door: String(door || 'onboarding').slice(0, 200),
      gesloten_reden: 'Terug actief in de onboarding', logboek: metLog(data, logRegel({ door, tekst: 'Terug actief in de onboarding: niet naar incasso.', soort: 'niet_naar_incasso' })),
    });
    return { ok: true };
  } catch (e) {
    console.warn('[incasso-traject] onboarding-voorstel sluiten:', e?.message || e);
    return { ok: false };
  }
}
