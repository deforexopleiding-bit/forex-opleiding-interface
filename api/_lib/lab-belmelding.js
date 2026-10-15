// api/_lib/lab-belmelding.js
//
// DE BELMELDING VAN THE LAB — wanneer moet Dave een lab-lead bellen?
//
// Een lab-lead die warm is, belt hij binnen het kwartier. Daarom zet
// cron-lab-belmelding (elke 5 minuten) een belopdracht BOVENAAN zijn
// Opvolging-module (opvolging_taken, reden 'lab_bellen') zodra één van deze
// redenen geldt — in deze volgorde van voorrang:
//
//   lab_vraag            de lead vroeg zelf "bel me" (einde van The Lab)
//   lab_af_niet_geboekt  The Lab afgewerkt en 5 minuten later nog niet geboekt
//   lab_investeren       kwalificatie "investeren in begeleiding" = ja/misschien
//   lab_stil_24u         stap ≥ 5 gehaald, niet afgewerkt, en 24 uur stil
//
// HARDE REGELS (getoetst in tests/lab-belmelding.test.js):
//   · nooit na een boeking — en een open belopdracht vervalt bij een boeking;
//   · één belopdracht per lead per reden (ook na archiveren niet opnieuw) —
//     de databank bewaakt dat met een partiële unieke index;
//   · hoogstens één OPEN belopdracht per lead tegelijk (Dave belt één keer);
//   · Dave werkt ma–za: de taak staat op de eerstvolgende ma–za-dag
//     (Europe/Brussels). Op zondag ontstaat ze wel, maar staat ze op maandag.
//   · testleads (is_test) krijgen een testtaak (is_test = true), echte leads
//     een echte — nooit door elkaar.
//
// Alles hier is PUUR; het lezen en schrijven doet de cron.

export const LAB_BEL_REDEN = 'lab_bellen';
export const BEL_REDENEN = Object.freeze(['lab_vraag', 'lab_af_niet_geboekt', 'lab_investeren', 'lab_stil_24u']);
export const BEL_LABEL = Object.freeze({
  lab_vraag: 'Vroeg zelf om te bellen',
  lab_af_niet_geboekt: 'Lab afgewerkt, nog niet geboekt',
  lab_investeren: 'Wil investeren in begeleiding',
  lab_stil_24u: '24u stil in The Lab',
});

export const MIN = 60 * 1000;
export const UUR = 60 * MIN;
export const WACHT_NA_AFGEROND = 5 * MIN;
export const STIL_NA = 24 * UUR;
export const STIL_VANAF_STAP = 5;

const TZ = 'Europe/Brussels';

/** YYYY-MM-DD in Brussel. PURE. */
export function brusselsDag(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/** 0 = zondag … 6 = zaterdag, in Brussel. PURE. */
export function brusselsWeekdag(ms) {
  const d = brusselsDag(ms);
  return new Date(d + 'T12:00:00Z').getUTCDay();
}

/** De dag waarop Dave de taak ziet: vandaag, of maandag als het zondag is. PURE. */
export function werkdagVoor(ms) {
  const d = brusselsDag(ms);
  if (brusselsWeekdag(ms) !== 0) return d;
  const volgende = new Date(d + 'T12:00:00Z');
  volgende.setUTCDate(volgende.getUTCDate() + 1);
  return volgende.toISOString().slice(0, 10);
}

const ms = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * De stand van één lead, uit de twee databanken samengevoegd. PURE.
 * @param {object} p
 * @param {object} p.labLead   hlms_lab_lead-rij
 * @param {object|null} p.sessie  nieuwste hlms_lab_sessie (licht) of null
 * @param {boolean} p.geboektInCrm  er staat een (geplande/gehouden) afspraak in het CRM
 * @param {string[]} [p.vragen]  ISO-tijdstippen waarop de lead "bel me" vroeg
 */
export function leadStand({ labLead, sessie, geboektInCrm = false, vragen = [] }) {
  const afgerond = !!sessie && (sessie.afgerond === true || sessie.afgerond === 'true' || Number(sessie.voortgang || 0) >= 100);
  const afgerondOp = afgerond ? (ms(sessie.afgerond_op) ?? ms(sessie.bijgewerkt_op)) : null;
  const activiteit = [ms(sessie?.bijgewerkt_op), ms(labLead?.laatste_login_op), ms(labLead?.eerste_login_op)].filter((x) => x != null);
  return {
    geboekt: !!labLead?.sessie_geboekt_op || !!geboektInCrm,
    afgerond,
    afgerondOp,
    stap: Number(sessie?.stap || 0),
    laatsteActiviteit: activiteit.length ? Math.max(...activiteit) : null,
    investeren: labLead?.kwalificatie?.investeren || null,
    vroegBellen: (vragen || []).some((v) => ms(v) != null),
  };
}

/** Welke redenen gelden NU, in volgorde van voorrang. PURE. */
export function geldendeRedenen(s, nu) {
  if (!s || s.geboekt) return [];
  const uit = [];
  if (s.vroegBellen) uit.push('lab_vraag');
  if (s.afgerond && s.afgerondOp != null && nu - s.afgerondOp >= WACHT_NA_AFGEROND) uit.push('lab_af_niet_geboekt');
  if (s.investeren === 'ja' || s.investeren === 'misschien') uit.push('lab_investeren');
  if (!s.afgerond && s.stap >= STIL_VANAF_STAP && s.laatsteActiviteit != null && nu - s.laatsteActiviteit >= STIL_NA) uit.push('lab_stil_24u');
  return uit;
}

/**
 * De ene beslissing per lead. PURE.
 * @param {object} s  leadStand()
 * @param {object} p
 * @param {Set<string>} p.gehad   redenen waarvoor er al ooit een taak was (open of niet)
 * @param {boolean} p.heeftOpen   er staat al een open lab-belopdracht voor deze lead
 * @returns {{ actie: 'maak', reden: string } | { actie: 'vervalt' } | null}
 */
export function beslis(s, { gehad = new Set(), heeftOpen = false } = {}, nu = Date.now()) {
  if (s.geboekt) return heeftOpen ? { actie: 'vervalt' } : null;
  if (heeftOpen) return null;
  const reden = geldendeRedenen(s, nu).find((r) => !gehad.has(r));
  return reden ? { actie: 'maak', reden } : null;
}

const KW = {
  doel: { bijverdienste: 'bijverdienste', volledig_inkomen: 'volledig inkomen', vermogen: 'vermogen opbouwen', weet_niet: 'weet het nog niet' },
  tijd: { minder_3u: '< 3 u/week', '3_6u': '3–6 u/week', meer_6u: '> 6 u/week' },
  investeren: { ja: 'investeren: ja', misschien: 'investeren: misschien', nee: 'investeren: nee' },
};

/** De drie antwoorden in één regel ("bijverdienste · 3–6 u/week · investeren: ja"). PURE. */
export function antwoordenRegel(k) {
  if (!k) return null;
  const delen = ['doel', 'tijd', 'investeren'].map((x) => (k[x] ? KW[x][k[x]] || k[x] : null)).filter(Boolean);
  return delen.length ? delen.join(' · ') : null;
}

/** De rij voor opvolging_taken. PURE (de telefoon wordt door de cron genormaliseerd). */
export function taakRij({ labLead, sessie, reden, nu, crmLeadId = null }) {
  const naam = [labLead.voornaam, labLead.achternaam].filter(Boolean).join(' ').trim() || labLead.email || 'Lab-lead';
  const antwoorden = antwoordenRegel(labLead.kwalificatie);
  const stand = sessie?.stap ? `stap ${sessie.stap}${sessie.stappen ? '/' + sessie.stappen : ''}` : 'nog niet gestart';
  const notitie = [
    BEL_LABEL[reden] + '.',
    labLead.hook ? `Hook: ${labLead.hook}.` : null,
    `The Lab: ${stand}.`,
    antwoorden ? `Antwoorden: ${antwoorden}.` : null,
  ].filter(Boolean).join(' ');
  return {
    naam,
    email: labLead.email || null,
    telefoon: labLead.telefoon || null,
    reden: LAB_BEL_REDEN,
    reden_code: reden,
    bron: 'lead',
    bron_ref: {
      lab_lead_id: labLead.id,
      crm_lead_id: crmLeadId || labLead.crm_lead_id || null,
      hook: labLead.hook || null,
      kwalificatie: labLead.kwalificatie || null,
      stap: sessie?.stap ?? null,
      stappen: sessie?.stappen ?? null,
      reden,
    },
    badge_label: 'The Lab',
    due: werkdagVoor(nu),
    later: false,
    status: 'open',
    lijst: 'dag',
    lead_id: crmLeadId || labLead.crm_lead_id || null,
    notitie,
    is_test: labLead.is_test === true,
    eigenaar_id: null,
  };
}
