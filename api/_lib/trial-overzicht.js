// api/_lib/trial-overzicht.js
//
// Leadsonderhoud › The Lab = het overzicht van ALLE trial-leads (26 okt 2026):
// minicursus, 7-daagse, webinar, website en The Lab komen allemaal als
// lab-lead in het echte LMS binnen. Hier staat de rekenkern, PUUR (geen
// databank), zodat elke regel in een test staat:
//
//   * de KPI's per product: leads → ingelogd → video gezien → Lab gestart →
//     Lab afgewerkt → sessie geboekt → klant (testleads tellen nooit mee);
//   * per lead de status-chips, dagen over, laatste bericht (motor, of anders
//     de welkomstmail van de aanmelding) en laatste belpoging;
//   * wie al student is (resultaat al_toegang, geen lab-account) staat apart
//     (al_student): niet in de KPI's, niet in de bellijst;
//   * de webinar hoort NIET in de trialflow (26 okt, Maxim: eigen flow). De
//     webinar-trials die op 26 okt toch ontstonden staan apart (buiten_flow):
//     niet in de KPI's, niet in de bellijst;
//   * de BELLIJST: wie nu het meest waard is om te bellen.
//       1. warm (Lab afgewerkt of ≥ 2 video's) en geen sessie
//       2. ingelogd zonder sessie
//       3. niet ingelogd, met toestemming
//     Nooit: geboekt, klant, afgemeld, zonder telefoonnummer, of een testlead.
//     Binnen een groep: de hoogste score eerst; wie de laatste 24 uur al gebeld
//     werd, schuift achteraan.

import { herkomstVanAanmelding, productLabel, PRODUCTEN, isBuitenTrialflow } from './trial-product.js';
import { isAfgerond, isGestart } from './lab-dossier.js';
import { labScore } from './lab-trial-stand.js';

const DAG = 86400000;

export const BEL_GROEPEN = Object.freeze({
  warm: 'Warm, geen sessie',
  ingelogd: 'Ingelogd, geen sessie',
  niet_ingelogd: 'Niet ingelogd (met toestemming)',
});

/** Eén lege KPI-rij. */
function leeg(sleutel, label) {
  return { sleutel, label, leads: 0, ingelogd: 0, video: 0, lab_gestart: 0, lab_afgewerkt: 0, geboekt: 0, klant: 0 };
}

/**
 * De status-chips van één lead, in leesvolgorde. PURE.
 * @returns {{ code: string, label: string }[]}
 */
export function statusChips(r) {
  const c = [];
  if (r.klant) c.push({ code: 'klant', label: 'Klant' });
  if (r.geboekt) c.push({ code: 'geboekt', label: 'Sessie geboekt' + (r.sessie_moment ? ' · ' + r.sessie_moment_label : '') });
  c.push(r.ingelogd ? { code: 'ingelogd', label: 'Ingelogd' } : { code: 'niet_ingelogd', label: 'Niet ingelogd' });
  if (r.videos > 0) c.push({ code: 'video', label: `Video's · ${r.videos}` });
  if (r.lab.afgerond) c.push({ code: 'lab_af', label: 'Lab afgewerkt' });
  else if (r.lab.gestart) c.push({ code: 'lab', label: 'Lab · stap ' + r.lab.stap + (r.lab.stappen ? '/' + r.lab.stappen : '') });
  if (r.verlopen) c.push({ code: 'verlopen', label: 'Verlopen' });
  if (r.afgemeld) c.push({ code: 'afgemeld', label: 'Afgemeld' });
  return c;
}

/** In welke belgroep hoort deze lead? null = niet bellen. PURE. */
export function belGroep(r) {
  if (r.is_test || r.geboekt || r.klant || r.afgemeld || !r.telefoon) return null;
  if (r.lab.afgerond || r.videos >= 2) return 'warm';
  if (r.ingelogd) return 'ingelogd';
  if (r.toestemming) return 'niet_ingelogd';
  return null;
}

const GROEP_ORDE = { warm: 0, ingelogd: 1, niet_ingelogd: 2 };

/** Sorteer de bellijst. PURE. */
export function sorteerBellijst(a, b, nu = Date.now()) {
  const g = GROEP_ORDE[a.bel_groep] - GROEP_ORDE[b.bel_groep];
  if (g) return g;
  const recent = (r) => (r.laatste_belpoging && nu - Date.parse(r.laatste_belpoging.op) < DAG ? 1 : 0);
  const rc = recent(a) - recent(b);
  if (rc) return rc;
  if (b.score !== a.score) return b.score - a.score;
  return String(b.aangemeld).localeCompare(String(a.aangemeld));
}

/** Het nieuwste van een paar { op }-berichten (null's genegeerd). PURE. */
function nieuwste(...lijst) {
  return lijst.filter(Boolean).sort((x, y) => String(y.op).localeCompare(String(x.op)))[0] || null;
}

const DATUM = new Intl.DateTimeFormat('nl-BE', { timeZone: 'Europe/Brussels', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const datumLabel = (iso) => { try { return iso ? DATUM.format(new Date(iso)) : null; } catch { return null; } };

/**
 * @param {object} p
 * @param {object[]} p.aanmeldingen          lab_aanmeldingen-rijen ('*')
 * @param {Map} p.standPerEmail              email → lab-trial-stand (leesLabStandPerEmail)
 * @param {Map} [p.leadsPerEmail]            email → { id, voornaam, achternaam, telefoon_e164, toestemming, status, customer_id }
 * @param {Set} [p.geboektAgenda]            e-mails met een Lab-strategiesessie in de agenda
 * @param {Set} [p.afgemeld]                 e-mails die zich afmeldden
 * @param {Map} [p.laatsteMotor]             email (of aanmelding_id) → { stap, kanaal, op }
 * @param {Map} [p.laatsteBel]               email → { op, resultaat, notitie, door_naam }
 * @param {{product?:string, hook?:string, variant?:string}} [p.filter]
 * @param {number} [p.nu]
 */
export function bouwOverzicht({ aanmeldingen = [], standPerEmail = new Map(), leadsPerEmail = new Map(), geboektAgenda = new Set(), afgemeld = new Set(), laatsteMotor = new Map(), laatsteBel = new Map(), filter = {}, nu = Date.now() }) {
  // Eén rij per e-mail: de EERSTE aanmelding in de periode bepaalt de belofte.
  const eerste = new Map();
  const touches = new Map();
  const alToegang = new Set();
  const welkom = new Map(); // email → eerste verstuurde welkomstmail (aanmelding)
  for (const a of [...aanmeldingen].sort((x, y) => String(x.aangemaakt).localeCompare(String(y.aangemaakt)))) {
    const em = String(a.email || '').toLowerCase();
    if (!em) continue;
    touches.set(em, (touches.get(em) || 0) + 1);
    if (!eerste.has(em)) eerste.set(em, { ...a, ...herkomstVanAanmelding(a) });
    if (a.resultaat === 'al_toegang') alToegang.add(em);
    if (a.mail_status === 'verstuurd' && !welkom.has(em)) {
      welkom.set(em, { stap: a.resultaat === 'al_toegang' ? 'al-toegang' : a.resultaat === 'nieuwe_link' ? 'nieuwe-link' : 'welkom', kanaal: 'mail', op: a.aangemaakt });
    }
  }

  const rijen = [];
  const alStudent = [];
  const buitenFlow = [];
  for (const [em, a] of eerste) {
    const st = standPerEmail.get(em) || null;
    const ll = st?.labLead || null;
    const lead = leadsPerEmail.get(em) || null;
    const product = ll?.product || a.product;
    if (filter.product && filter.product !== 'alle' && product !== filter.product) continue;
    if (filter.hook && String(a.hook || '') !== filter.hook) continue;
    const variant = a.variant || null;
    if (filter.variant && String(variant || '') !== filter.variant) continue;
    // Al student / bestaande LMS-identiteit: geen lab-account, dus geen trial.
    // Apart tonen, buiten de KPI's en de bellijst.
    if (!ll && alToegang.has(em)) {
      alStudent.push({
        email: em, lead_id: a.lead_id || lead?.id || null, naam: [lead?.voornaam || a.voornaam, lead?.achternaam || a.achternaam].filter(Boolean).join(' ') || em,
        product, product_label: productLabel(product), bron: a.bron || null, aangemeld: a.aangemaakt,
        is_test: a.is_test === true, chips: [{ code: 'al_student', label: 'Al student' }],
      });
      continue;
    }
    const totMs = ll?.toegang_tot ? Date.parse(ll.toegang_tot) : NaN;
    const gestart = isGestart(st?.sessie);
    const afgerond = isAfgerond(st?.sessie);
    const ingelogd = !!ll?.eerste_login_op;
    const videos = st?.videos || 0;
    const geboekt = !!ll?.sessie_geboekt_op || geboektAgenda.has(em);
    const r = {
      email: em,
      lead_id: a.lead_id || lead?.id || null,
      aanmelding_id: a.id,
      voornaam: ll?.voornaam || a.voornaam || lead?.voornaam || null,
      naam: [lead?.voornaam || a.voornaam || ll?.voornaam, lead?.achternaam || a.achternaam].filter(Boolean).join(' ') || em,
      telefoon: lead?.telefoon_e164 || a.telefoon_e164 || null,
      toestemming: lead?.toestemming === true || a.toestemming === true,
      product, product_label: productLabel(product), bron: a.bron || null, variant, hook: a.hook || null,
      touches: touches.get(em) || 1,
      aangemeld: a.aangemaakt,
      toegang_tot: ll?.toegang_tot || null,
      dagen_over: Number.isFinite(totMs) ? Math.ceil((totMs - nu) / DAG) : null,
      verlopen: Number.isFinite(totMs) ? totMs < nu : false,
      ingelogd, eerste_login_op: ll?.eerste_login_op || null, laatste_login_op: ll?.laatste_login_op || null,
      videos, video_titels: (st?.videoTitels || []).map((v) => v.titel),
      lab: { gestart, afgerond, stap: st?.sessie?.stap ?? null, stappen: st?.sessie?.stappen ?? null },
      geboekt, sessie_moment: ll?.sessie_moment || null, sessie_moment_label: datumLabel(ll?.sessie_moment),
      klant: !!(lead && (lead.customer_id || lead.status === 'gewonnen')),
      afgemeld: afgemeld.has(em),
      is_test: a.is_test === true || ll?.is_test === true,
      geen_account: !ll,
      resultaat: a.resultaat || null,
      laatste_bericht: nieuwste(laatsteMotor.get(em), laatsteMotor.get(a.id), welkom.get(em)),
      laatste_belpoging: laatsteBel.get(em) || null,
      score: labScore({ ingelogd, videos, gestart, afgerond }),
    };
    r.chips = statusChips(r);
    // Webinar: eigen flow — apart, nooit in de KPI's of de bellijst.
    if (isBuitenTrialflow(product)) { r.bel_groep = null; buitenFlow.push(r); continue; }
    r.bel_groep = belGroep(r);
    rijen.push(r);
  }

  // KPI's per product + totaal. Testleads tellen nooit mee.
  const per = new Map(PRODUCTEN.filter((p) => !isBuitenTrialflow(p)).map((p) => [p, leeg(p, productLabel(p))]));
  const totaal = leeg('totaal', 'Totaal');
  for (const r of rijen) {
    if (r.is_test) continue;
    if (!per.has(r.product)) per.set(r.product, leeg(r.product, r.product_label));
    for (const k of [per.get(r.product), totaal]) {
      k.leads++;
      if (r.ingelogd) k.ingelogd++;
      if (r.videos > 0) k.video++;
      if (r.lab.gestart || r.lab.afgerond) k.lab_gestart++;
      if (r.lab.afgerond) k.lab_afgewerkt++;
      if (r.geboekt) k.geboekt++;
      if (r.klant) k.klant++;
    }
  }

  rijen.sort((a, b) => String(b.aangemeld).localeCompare(String(a.aangemeld)));
  const bellijst = rijen.filter((r) => r.bel_groep).sort((a, b) => sorteerBellijst(a, b, nu));
  alStudent.sort((a, b) => String(b.aangemeld).localeCompare(String(a.aangemeld)));
  buitenFlow.sort((a, b) => String(b.aangemeld).localeCompare(String(a.aangemeld)));
  return { kpi: [...per.values(), totaal], leads: rijen, bellijst, al_student: alStudent, buiten_flow: buitenFlow };
}

/** CSV van de bellijst (puntkomma, voor Excel NL/BE). PURE. */
export function bellijstCsv(rijen) {
  const kol = ['groep', 'naam', 'telefoon', 'email', 'product', 'bron', 'aangemeld', 'dagen_over', 'ingelogd', 'videos', 'lab', 'laatste_belpoging', 'resultaat', 'notitie'];
  const cel = (v) => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const regels = rijen.map((r) => [
    BEL_GROEPEN[r.bel_groep] || '', r.naam, r.telefoon, r.email, r.product_label, r.bron || '', String(r.aangemeld || '').slice(0, 10),
    r.dagen_over ?? '', r.ingelogd ? 'ja' : 'nee', r.videos, r.lab.afgerond ? 'afgewerkt' : r.lab.gestart ? `stap ${r.lab.stap}` : 'nee',
    r.laatste_belpoging ? String(r.laatste_belpoging.op).slice(0, 16).replace('T', ' ') : '', r.laatste_belpoging?.resultaat || '', r.laatste_belpoging?.notitie || '',
  ].map(cel).join(';'));
  return [kol.join(';'), ...regels].join('\n');
}
