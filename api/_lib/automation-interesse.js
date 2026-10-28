// api/_lib/automation-interesse.js
//
// AUTOMATION-INTERESSE UIT DE ONBOARDING → EEN BELKAART VOOR DAVE.
//
// Kiest een klant in de onboarding-portal (www.deforexopleiding.nl/onboarding)
// "Ja, bel mij" bij de laatste vraag (answers.robot_interesse = 'ja_interesse'),
// dan staat er METEEN — bij de save, niet pas bij afronden — één kaart in de
// sectie Automation (lijst 'automation', sinds 27 okt 2026 NIET meer in Daves
// daglijst) met reden 'automation_interesse'. Dave belt, en plant een gesprek in
// (booking_source 'automation', zie api/opvolging-agenda.js).
//
// REGELS (Maxim, 27 okt 2026):
//   · IDEMPOTENT: één kaart per onboarding, ooit. De databank bewaakt dat met
//     een partiële unieke index op bron_ref->>'onboarding_id'
//     (docs/sql-migrations/2026-10-27-opvolging-automation-interesse.sql).
//   · due = vandaag (Brussel); na 20:00 → morgen.
//   · Zet de klant het terug op nee VÓÓR er contact was → kaart dicht met
//     archief_reden 'klant_trok_interesse_in'. Zet hij het daarna weer op ja,
//     dan gaat diezelfde kaart weer open.
//   · NA CONTACT verandert er automatisch niets meer: dan is het Daves gesprek.
//     Contact = een poging die isContact() als contact telt (dezelfde ene
//     definitie als het Salesrapport), of de kaart is al ingepland / door Dave
//     afgesloten.
//   · GEEN WhatsApp of mail naar de klant: Dave belt, mondeling.
//
// De beslissing (beslis) is PUUR en getoetst in tests/automation-interesse.test.js;
// syncAutomationKaart doet het lezen en schrijven en is faalzacht: een fout hier
// mag de save van de klant nooit breken.

import { isContact } from './opvolging-poging-telling.js';
import { telefoonNlBe } from './phone-e164.js';
import { alleenAutomationlijst, AUTOMATION_REDEN, LIJST_AUTOMATION, LIJST_DAG } from './opvolging-lijst.js';

export { AUTOMATION_REDEN };
/** archief_reden (en reden_code) wanneer de klant zelf terug op nee zet. */
export const TROK_IN = 'klant_trok_interesse_in';
/** reden_code bij Daves eigen afsluitingen vanuit "Wat nu?". */
export const AFSLUIT_CODES = Object.freeze({
  gesprek_gehad : 'automation_gesprek',
  geen_interesse: 'automation_geen_interesse',
});
const ZONE = 'Europe/Brussels';
const LAAT_UUR = 20;

export const BELMOMENT_LABEL = Object.freeze({
  voormiddag: 'voormiddag', namiddag: 'namiddag', avond: 'avond', weekend: 'zaterdag',
});

function deelInZone(ms) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const g = (t) => p.find((x) => x.type === t)?.value;
  return { dag: `${g('year')}-${g('month')}-${g('day')}`, uur: Number(g('hour')) };
}

/** Op welke dag staat de kaart? Vandaag in Brussel, na 20:00 morgen. PURE. */
export function dueVoor(nuMs) {
  const { dag, uur } = deelInZone(nuMs);
  if (uur < LAAT_UUR) return dag;
  const d = new Date(`${dag}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function datumNl(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(String(iso))) return null;
  return new Date(String(iso).slice(0, 10) + 'T12:00:00Z')
    .toLocaleDateString('nl-BE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: ZONE });
}

/**
 * Ander nummer of e-mail uit de Autopilot-stap (28 okt 2026). PURE.
 * Alleen bij "ja"; leeg = niet opgegeven → { tel: null, email: null }.
 */
export function contactVoorkeur(answers) {
  const a = answers || {};
  if (a.robot_interesse !== 'ja_interesse') return { tel: null, email: null };
  const tekst = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return { tel: tekst(a.robot_contact_tel), email: tekst(a.robot_contact_email) };
}

/** De zin over het opgegeven nummer/e-mail, of null. PURE. */
function contactZin(contact) {
  const c = contact || {};
  const delen = [];
  if (c.tel) delen.push(`BEL OP HET OPGEGEVEN NUMMER: ${c.tel} (niet het bekende).`);
  if (c.email) delen.push(`Opgegeven e-mailadres: ${c.email}.`);
  return delen.length ? delen.join(' ') : null;
}

/** De notitie op de kaart. PURE. */
export function kaartNotitie({ trajectLabel, startDatum, belmoment, contact = null }) {
  const delen = ['Kwam binnen via de onboarding: wil graag gebeld worden over de automation.'];
  if (trajectLabel) delen.push(`Traject: ${trajectLabel}.`);
  const start = datumNl(startDatum);
  if (start) delen.push(`Start: ${start}.`);
  const bm = (Array.isArray(belmoment) ? belmoment : []).map((b) => BELMOMENT_LABEL[b] || b);
  delen.push(bm.length ? `Voorkeur belmoment: ${bm.join(', ')}.` : 'Geen voorkeur voor het belmoment.');
  const cz = contactZin(contact);
  if (cz) delen.push(cz);
  return delen.join(' ');
}

/** De nieuwe kaart. PURE. */
export function kaartRij({ onboarding, klant, trajectLabel, belmoment, contact = null, nuMs }) {
  const naam = [klant?.first_name, klant?.last_name].filter(Boolean).join(' ').trim()
    || onboarding.customer_name || klant?.email || 'Onbekende klant';
  return {
    naam,
    email: klant?.email || null,
    // Een opgegeven ander nummer is het nummer dat Dave belt; het bekende blijft in bron_ref.
    telefoon: contact?.tel || klant?.phone || null,
    reden: AUTOMATION_REDEN,
    reden_code: null,
    bron: 'handmatig',
    bron_ref: {
      onboarding_id: onboarding.id,
      customer_id: onboarding.customer_id || null,
      traject_id: onboarding.traject_id || null,
      start_date: onboarding.start_date || null,
      belmoment: Array.isArray(belmoment) ? belmoment : [],
      ...contactRef(contact, klant?.phone || null),
      bron: 'onboarding-portal',
    },
    badge_label: null,
    due: dueVoor(nuMs),
    later: false,
    status: 'open',
    lijst: LIJST_AUTOMATION,
    notitie: kaartNotitie({ trajectLabel, startDatum: onboarding.start_date, belmoment, contact }),
    is_test: onboarding.is_test === true,
    eigenaar_id: null,
  };
}

/**
 * Wat moet er met de kaart gebeuren? PURE.
 *
 * @param {object} p
 * @param {'ja_interesse'|'nee'} p.interesse  de nieuwe keuze van de klant
 * @param {object|null} p.kaart               de bestaande kaart (of null)
 * @param {boolean} p.contact                 was er al contact (poging die telt)?
 * @returns {{actie: 'maak'|'heropen'|'bijwerken'|'sluit'|'niets', waarom: string}}
 */
export function beslis({ interesse, kaart, contact }) {
  if (interesse !== 'ja_interesse' && interesse !== 'nee') return { actie: 'niets', waarom: 'geen keuze' };
  if (!kaart) {
    return interesse === 'ja_interesse'
      ? { actie: 'maak', waarom: 'nieuwe interesse' }
      : { actie: 'niets', waarom: 'nee zonder kaart' };
  }
  const status = String(kaart.status || '');
  const doorKlantGesloten = status === 'gearchiveerd' && kaart.archief_reden === TROK_IN;
  if (contact) return { actie: 'niets', waarom: 'na contact verandert er niets automatisch' };
  if (status === 'ingepland') return { actie: 'niets', waarom: 'al ingepland' };
  if (status === 'gearchiveerd' && !doorKlantGesloten) return { actie: 'niets', waarom: 'door Dave afgesloten' };

  if (interesse === 'ja_interesse') {
    return doorKlantGesloten
      ? { actie: 'heropen', waarom: 'klant zette het weer op ja' }
      : { actie: 'bijwerken', waarom: 'belmoment of notitie bijwerken' };
  }
  // nee
  return doorKlantGesloten
    ? { actie: 'niets', waarom: 'al dicht' }
    : { actie: 'sluit', waarom: 'klant trok zijn interesse in vóór contact' };
}

/** contact_tel/contact_email (null = niet opgegeven) + het bekende nummer, voor bron_ref. PURE. */
function contactRef(contact, telefoonBekend) {
  return {
    contact_tel: contact?.tel || null,
    contact_email: contact?.email || null,
    telefoon_bekend: telefoonBekend || null,
  };
}

function nieuweGeschiedenis(kaart, tekst, nuIso) {
  const log = Array.isArray(kaart?.uitkomst_log) ? kaart.uitkomst_log : [];
  return [...log, { op: nuIso, soort: 'automatisch', tekst }];
}

/**
 * Lees, beslis en schrijf. Faalzacht: geeft altijd een verslag terug, gooit niet.
 *
 * @param {object} db  supabase-client (service role)
 * @param {{onboarding: object, answers: object, nu?: Date}} p
 */
export async function syncAutomationKaart(db, { onboarding, answers, nu = new Date() }) {
  if (!db || !onboarding?.id) return { actie: 'niets', waarom: 'geen onboarding', taak_id: null };
  return voerUit(db, {
    sleutel: 'onboarding_id',
    bronId: onboarding.id,
    // Testonboardings (is_test) krijgen NOOIT een kaart: Dave mag geen
    // testkaarten in zijn Opvolging zien. Interesse staat wel op de onboarding.
    isTest: onboarding.is_test === true,
    testWaarom: 'testonboarding',
    answers,
    nu,
    log: { onboarding_id: onboarding.id },
    // De klant en het traject — alleen nodig voor een nieuwe of bijgewerkte kaart.
    context: async () => {
      const [klantR, trajR] = await Promise.all([
        onboarding.customer_id
          ? db.from('customers').select('first_name, last_name, email, phone').eq('id', onboarding.customer_id).maybeSingle()
          : Promise.resolve({ data: null }),
        onboarding.traject_id
          ? db.from('onboarding_trajecten').select('label').eq('id', onboarding.traject_id).maybeSingle()
          : Promise.resolve({ data: null }),
      ]);
      if (klantR?.error) console.warn('[automation-interesse] klant lezen (soft):', klantR.error.message);
      if (trajR?.error) console.warn('[automation-interesse] traject lezen (soft):', trajR.error.message);
      return { klant: klantR?.data || null, trajectLabel: trajR?.data?.label || null };
    },
    nieuweRij: ({ klant, trajectLabel }, belmoment, nuMs, contact) => kaartRij({ onboarding, klant, trajectLabel, belmoment, contact, nuMs }),
    notitie: ({ trajectLabel }, belmoment, contact) => kaartNotitie({ trajectLabel, startDatum: onboarding.start_date, belmoment, contact }),
  });
}

// ── De studentencheck-in (27 okt 2026) ─────────────────────────────────────
//
// Dezelfde vraag ("Mogen we je er vrijblijvend over bellen?") staat in "Jouw
// DFO-check-in" voor bestaande studenten (www.deforexopleiding.nl/checkin,
// api/checkin-portal.js). Dezelfde regels als hierboven — één kaart in de
// sectie Automation, nee vóór contact sluit, na contact verandert er niets —
// met een EIGEN idempotentiesleutel: bron_ref.checkin_toewijzing_id (partiële
// unieke index in docs/sql-migrations/2026-10-27-studentencheck-in.sql). De
// student staat in het LMS (hlms_student), niet in customers: naam, e-mail en
// telefoon komen daarvandaan.

/** De notitie op een check-in-kaart. PURE. */
export function checkinKaartNotitie({ trajectLabel, belmoment, contact = null }) {
  const delen = ['Kwam binnen via de studentencheck-in: bestaande student, wil graag gebeld worden over de automation.'];
  if (trajectLabel) delen.push(`Traject: ${trajectLabel}.`);
  const bm = (Array.isArray(belmoment) ? belmoment : []).map((b) => BELMOMENT_LABEL[b] || b);
  delen.push(bm.length ? `Voorkeur belmoment: ${bm.join(', ')}.` : 'Geen voorkeur voor het belmoment.');
  const cz = contactZin(contact);
  if (cz) delen.push(cz);
  return delen.join(' ');
}

/** De nieuwe check-in-kaart. PURE. */
export function checkinKaartRij({ toewijzing, student, trajectLabel, mentorNaam = null, belmoment, contact = null, nuMs }) {
  const naam = [student?.voornaam, student?.achternaam].filter(Boolean).join(' ').trim()
    || student?.email || 'Onbekende student';
  return {
    naam,
    email: student?.email || null,
    telefoon: contact?.tel || student?.telefoon || null,
    reden: AUTOMATION_REDEN,
    reden_code: null,
    bron: 'handmatig',
    bron_ref: {
      checkin_toewijzing_id: toewijzing.id,
      checkin_campagne_id: toewijzing.campagne_id || null,
      lms_student_id: toewijzing.student_id || student?.id || null,
      belmoment: Array.isArray(belmoment) ? belmoment : [],
      ...contactRef(contact, student?.telefoon || null),
      bron: 'checkin',
      // Voor de sectie Automation: een check-in-kaart heeft geen onboardingdossier.
      traject_label: trajectLabel || null,
      mentor_naam: mentorNaam || null,
    },
    badge_label: null,
    due: dueVoor(nuMs),
    later: false,
    status: 'open',
    lijst: LIJST_AUTOMATION,
    notitie: checkinKaartNotitie({ trajectLabel, belmoment, contact }),
    is_test: toewijzing.is_test === true,
    eigenaar_id: null,
  };
}

/**
 * Check-in → kaart. Faalzacht, zelfde verslag als syncAutomationKaart.
 *
 * @param {object} db  CRM-client (service role) — daar staat opvolging_taken
 * @param {{toewijzing: object, student?: object, trajectLabel?: string, answers: object, nu?: Date}} p
 */
export async function syncCheckinAutomationKaart(db, { toewijzing, student = null, trajectLabel = null, mentorNaam = null, answers, nu = new Date() }) {
  if (!db || !toewijzing?.id) return { actie: 'niets', waarom: 'geen toewijzing', taak_id: null };
  return voerUit(db, {
    sleutel: 'checkin_toewijzing_id',
    bronId: toewijzing.id,
    // Testtoewijzingen (Maxims eigen login) krijgen NOOIT een kaart — zelfde
    // regel als de testonboardings (#1902).
    isTest: toewijzing.is_test === true,
    testWaarom: 'testtoewijzing',
    answers,
    nu,
    log: { checkin_toewijzing_id: toewijzing.id },
    context: async () => ({ student, trajectLabel, mentorNaam }),
    nieuweRij: (ctx, belmoment, nuMs, contact) => checkinKaartRij({ toewijzing, student: ctx.student, trajectLabel: ctx.trajectLabel, mentorNaam: ctx.mentorNaam, belmoment, contact, nuMs }),
    notitie: (ctx, belmoment, contact) => checkinKaartNotitie({ trajectLabel: ctx.trajectLabel, belmoment, contact }),
  });
}

/** De gedeelde kern: lees de kaart, beslis, schrijf. Gooit niet. */
async function voerUit(db, { sleutel, bronId, isTest, testWaarom, answers, nu, log, context, nieuweRij, notitie: maakNotitie }) {
  const verslag = { actie: 'niets', waarom: null, taak_id: null };
  try {
    if (isTest) return { ...verslag, waarom: testWaarom };
    const interesse = answers?.robot_interesse;
    const belmoment = Array.isArray(answers?.robot_belmoment) ? answers.robot_belmoment : [];
    const opgegeven = contactVoorkeur(answers);
    const nuMs = nu.getTime();
    const nuIso = nu.toISOString();

    // Een automation-kaart staat in lijst 'automation' (vóór de migratie nog 'dag').
    const { data: kaarten, error: kErr } = await alleenAutomationlijst(db.from('opvolging_taken')
      .select('id, status, archief_reden, notitie, bron_ref, uitkomst_log, telefoon'))
      .eq(`bron_ref->>${sleutel}`, bronId)
      .limit(1);
    if (kErr) throw new Error('kaart lezen: ' + kErr.message);
    const kaart = (kaarten || [])[0] || null;

    let contact = false;
    if (kaart) {
      const { data: pog, error: pErr } = await db.from('opvolging_pogingen')
        .select('soort, resultaat, richting').eq('taak_id', kaart.id);
      if (pErr) throw new Error('pogingen lezen: ' + pErr.message);
      contact = (pog || []).some((p) => isContact(p) === true);
    }

    const besluit = beslis({ interesse, kaart, contact });
    Object.assign(verslag, besluit, { taak_id: kaart?.id || null });
    if (besluit.actie === 'niets') return verslag;

    const ctx = await context();

    if (besluit.actie === 'maak') {
      const rij = nieuweRij(ctx, belmoment, nuMs, opgegeven);
      rij.telefoon = telefoonNlBe(rij.telefoon, { bron: 'automation-interesse' });
      let { data: nieuw, error } = await db.from('opvolging_taken').insert(rij).select('id').maybeSingle();
      // Vóór de migratie 2026-10-27-automation-lijst.sql kent de CHECK de lijst
      // 'automation' nog niet (23514): dan zoals vroeger in de daglijst.
      if (error && String(error.code) === '23514' && /lijst/.test(String(error.message || ''))) {
        console.warn('[automation-interesse] lijst automation nog niet in de CHECK — kaart in lijst dag');
        ({ data: nieuw, error } = await db.from('opvolging_taken').insert({ ...rij, lijst: LIJST_DAG }).select('id').maybeSingle());
      }
      if (error) {
        // Twee saves tegelijk: de andere was eerst. Idempotent, geen fout.
        if (String(error.code) === '23505') return { ...verslag, actie: 'niets', waarom: 'bestond al (gelijktijdig)' };
        throw new Error('kaart maken: ' + error.message);
      }
      verslag.taak_id = nieuw?.id || null;
      return verslag;
    }

    const notitie = maakNotitie(ctx, belmoment, opgegeven);
    // Het bekende nummer onthouden we de eerste keer dat er een ander komt, zodat
    // "geen ander nummer meer" de kaart terugzet op het bekende.
    const oud = kaart.bron_ref || {};
    const bekend = Object.prototype.hasOwnProperty.call(oud, 'telefoon_bekend') ? oud.telefoon_bekend : (kaart.telefoon || null);
    const bron_ref = { ...oud, belmoment, ...contactRef(opgegeven, bekend) };
    const telefoon = telefoonNlBe(opgegeven.tel || bekend, { bron: 'automation-interesse' });

    if (besluit.actie === 'bijwerken') {
      const { error } = await db.from('opvolging_taken')
        .update({ notitie, bron_ref, telefoon, updated_at: nuIso })
        .eq('id', kaart.id).in('status', ['open', 'wacht_inplanning']);
      if (error) throw new Error('kaart bijwerken: ' + error.message);
      return verslag;
    }

    if (besluit.actie === 'heropen') {
      const { error } = await db.from('opvolging_taken').update({
        status: 'open', due: dueVoor(nuMs), later: false, gearchiveerd_at: null, archief_reden: null,
        reden_code: null, notitie, bron_ref, telefoon, updated_at: nuIso,
        uitkomst_log: nieuweGeschiedenis(kaart, 'De klant zette de automation-interesse weer op ja.', nuIso),
      }).eq('id', kaart.id).eq('status', 'gearchiveerd').eq('archief_reden', TROK_IN);
      if (error) throw new Error('kaart heropenen: ' + error.message);
      return verslag;
    }

    // sluit
    const { error } = await db.from('opvolging_taken').update({
      status: 'gearchiveerd', gearchiveerd_at: nuIso, archief_reden: TROK_IN, reden_code: TROK_IN,
      updated_at: nuIso,
      uitkomst_log: nieuweGeschiedenis(kaart, 'De klant zette de automation-interesse terug op nee (vóór contact).', nuIso),
    }).eq('id', kaart.id).in('status', ['open', 'wacht_inplanning']);
    if (error) throw new Error('kaart sluiten: ' + error.message);
    return verslag;
  } catch (e) {
    console.error('[automation-interesse] mislukt', { ...log, fout: e?.message || e });
    return { ...verslag, actie: 'fout', waarom: String(e?.message || e) };
  }
}
