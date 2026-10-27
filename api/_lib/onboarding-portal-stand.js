// api/_lib/onboarding-portal-stand.js
//
// WAT DE BACKOFFICE OVER DE PORTAL EN DE AUTOMATION-INTERESSE WIL WETEN.
//
// Voor het onboardingdetail (tab "Onboarding") en de lijst (KPI-tegel +
// icoontje). Alles faalzacht: ontbreekt een kolom of een kaart, dan staat er
// null — nooit een 500 op het detail of de lijst.
//
//   startcode / startcode_fmt / portal_link     uit onboardings.startcode
//   automation.interesse / op / belmoment       onboardings.automation_* (of
//                                               terugval op answers.robot_*)
//   automation.kaart                            Daves Opvolging-kaart (reden
//                                               'automation_interesse') met
//                                               zijn stand

import { formatteer } from './onboarding-startcode.js';
import { portalLink, portalLive, persoonlijkeLink } from './onboarding-link.js';
import { alleenAutomationlijst } from './opvolging-lijst.js';
import { isMoeite } from './opvolging-poging-telling.js';

const REDEN = 'automation_interesse';
export const KAART_OPEN = Object.freeze(['open', 'wacht_inplanning']);

/** De stand van een kaart in mensentaal. PURE. */
export function kaartStand(kaart, pogingen = []) {
  if (!kaart) return null;
  const bel = (pogingen || []).filter((p) => isMoeite(p) && p.soort === 'call').length;
  const ref = kaart.afspraak_ref || {};
  let stand = 'open';
  if (kaart.status === 'ingepland') stand = 'ingepland';
  else if (kaart.status === 'gearchiveerd') stand = 'afgesloten';
  else if (kaart.status === 'wacht_inplanning') stand = 'wacht_inplanning';
  return {
    id: kaart.id,
    status: kaart.status,
    stand,
    due: kaart.due || null,
    pogingen: (pogingen || []).length,
    belpogingen: bel,
    ingepland_op: ref.scheduled_at || null,
    archief_reden: kaart.archief_reden || null,
    reden_code: kaart.reden_code || null,
    gearchiveerd_at: kaart.gearchiveerd_at || null,
  };
}

/** interesse 'ja'|'nee'|null uit de kolom, met terugval op answers. PURE. */
export function interesseVan(rij) {
  if (rij?.automation_interesse === 'ja' || rij?.automation_interesse === 'nee') return rij.automation_interesse;
  const a = rij?.answers?.robot_interesse;
  if (a === 'ja_interesse') return 'ja';
  if (a === 'nee') return 'nee';
  return null;
}

/** Het hele blok voor één onboarding (detail). */
export async function leesPortalStand(db, ob) {
  const uit = { startcode: null, startcode_fmt: null, portal_link: null, portal_live: false, persoonlijke_link: null,
    automation: { interesse: interesseVan(ob), op: null, belmoment: [], kaart: null } };
  try {
    const { data, error } = await db.from('onboardings')
      .select('startcode, automation_interesse, automation_interesse_op, automation_belmoment')
      .eq('id', ob.id).maybeSingle();
    if (error) throw new Error(error.message);
    if (data) {
      uit.startcode = data.startcode || null;
      uit.startcode_fmt = formatteer(data.startcode) || null;
      uit.portal_link = portalLink(data.startcode);
      uit.automation.interesse = interesseVan({ ...data, answers: ob.answers });
      uit.automation.op = data.automation_interesse_op || null;
      uit.automation.belmoment = Array.isArray(data.automation_belmoment) ? data.automation_belmoment
        : (Array.isArray(ob.answers?.robot_belmoment) ? ob.answers.robot_belmoment : []);
    }
  } catch (e) {
    console.warn('[onboarding-portal-stand] kolommen (soft):', e?.message || e);
  }
  // De link die de klant krijgt (en die de kopieerknoppen kopiëren): achter de
  // vlag de portal, anders de klassieke wizard.
  uit.portal_live = await portalLive(db);
  uit.persoonlijke_link = persoonlijkeLink({ token: ob.token, startcode: uit.startcode, live: uit.portal_live }) || null;
  try {
    const { data: kaarten, error } = await alleenAutomationlijst(db.from('opvolging_taken')
      .select('id, status, due, afspraak_ref, archief_reden, reden_code, gearchiveerd_at'))
      .eq('reden', REDEN).eq('bron_ref->>onboarding_id', ob.id).limit(1);
    if (error) throw new Error(error.message);
    const kaart = (kaarten || [])[0] || null;
    if (kaart) {
      const { data: pog, error: pErr } = await db.from('opvolging_pogingen')
        .select('soort, resultaat, richting, automatisch').eq('taak_id', kaart.id);
      if (pErr) throw new Error(pErr.message);
      uit.automation.kaart = kaartStand(kaart, pog || []);
    }
  } catch (e) {
    console.warn('[onboarding-portal-stand] kaart (soft):', e?.message || e);
  }
  return uit;
}

/**
 * Voor de lijst: per onboarding-id { interesse, kaart_status } — of een lege
 * map bij een fout (dan toont de lijst geen icoon en telt de tegel 0).
 */
export async function automationPerOnboarding(db, rijen) {
  const kaart = new Map();
  const ids = [...new Set((rijen || []).map((r) => r.id).filter(Boolean))];
  if (!ids.length) return kaart;
  const interesse = new Map();
  for (const r of rijen) { const i = interesseVan(r); if (i) interesse.set(r.id, i); }
  try {
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await db.from('onboardings')
        .select('id, automation_interesse').in('id', ids.slice(i, i + 200));
      if (error) throw new Error(error.message);
      for (const d of data || []) if (d.automation_interesse) interesse.set(d.id, d.automation_interesse);
    }
  } catch (e) {
    console.warn('[onboarding-portal-stand] interesse (soft):', e?.message || e);
  }
  const status = new Map();
  try {
    const ja = ids.filter((id) => interesse.get(id) === 'ja');
    for (let i = 0; i < ja.length; i += 200) {
      const { data, error } = await alleenAutomationlijst(db.from('opvolging_taken').select('status, bron_ref'))
        .eq('reden', REDEN).in('bron_ref->>onboarding_id', ja.slice(i, i + 200));
      if (error) throw new Error(error.message);
      for (const t of data || []) if (t.bron_ref?.onboarding_id) status.set(t.bron_ref.onboarding_id, t.status);
    }
  } catch (e) {
    console.warn('[onboarding-portal-stand] kaarten (soft):', e?.message || e);
  }
  for (const id of ids) {
    if (!interesse.has(id)) continue;
    kaart.set(id, { interesse: interesse.get(id), kaart_status: status.get(id) || null });
  }
  return kaart;
}

/**
 * Voor de lijst: per onboarding-id de persoonlijke link (kopieerknop "Link
 * kopiëren"). Leest de startcodes gebatcht; faalzacht → klassieke link.
 * @returns {Promise<Map<string,string>>}
 */
export async function linksPerOnboarding(db, rijen) {
  const links = new Map();
  const lijst = (rijen || []).filter((r) => r && r.id);
  if (!lijst.length) return links;
  const live = await portalLive(db);
  const codes = new Map();
  if (live) {
    try {
      const ids = lijst.map((r) => r.id);
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await db.from('onboardings').select('id, startcode').in('id', ids.slice(i, i + 200));
        if (error) throw new Error(error.message);
        for (const d of data || []) if (d.startcode) codes.set(d.id, d.startcode);
      }
    } catch (e) {
      console.warn('[onboarding-portal-stand] startcodes (soft):', e?.message || e);
    }
  }
  for (const r of lijst) {
    const l = persoonlijkeLink({ token: r.token, startcode: codes.get(r.id) || null, live });
    if (l) links.set(r.id, l);
  }
  return links;
}
