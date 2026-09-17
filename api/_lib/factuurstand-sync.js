// api/_lib/factuurstand-sync.js
//
// De RONDE van de factuurstand-spiegel, als gedeelde logica.
//
// Twee ingangen gebruiken dit bestand:
//   - api/cron/factuurstand-spiegel-sync.js  — dagelijks, met CRON_SECRET;
//   - api/factuurstand-spiegel-sync-run.js   — de knop in het CRM, met een
//     ingelogde gebruiker en `students.all.view`.
// Eén implementatie, twee ingangen: er is geen tweede versie die kan afwijken.
//
// ── DE DROOGLOOP IS HET HALVE WERK ───────────────────────────────────────
// `dry: true` doet ALLES behalve schrijven, en geeft terug wat een mens moet
// weten vóór de eerste echte schrijfronde:
//   * de MATCHGRAAD per weg (onboarding / bubble / e-mail) en wat er afviel;
//   * hoeveel studenten er op 'gelezen', 'niet_gekoppeld' en 'onbereikbaar'
//     zouden komen;
//   * hoeveel er 1 vervallen factuur hebben en hoeveel er 2 of meer hebben —
//     precies de twee drempels van de LMS-regel;
//   * een lijstje voorbeelden per geval, met naam en reden;
//   * de meting van `invoices.is_historical` en van de openstaande signalen
//     in `student_signals`, zodat die twee vragen met een getal beantwoord
//     worden en niet met een aanname.
//
// Dat is geen sier. Deze getallen gaan in het LMS gedrag sturen (een mentor
// die niet kan inplannen), en de eerste schrijfronde gebeurt pas nadat Maxim
// deze uitkomst gezien heeft.
//
// ── VERZOENEN, NIET BIJWERKEN ────────────────────────────────────────────
// Drie dingen: TOEVOEGEN wat mist, BIJWERKEN wat er staat, VERWIJDEREN wat
// er niet meer hoort (student niet langer een actieve mentorship-student).
// Alleen bijwerken laat wezen achter van iedere student die is uitgestroomd.
//
// ── LEEG IS NIET HETZELFDE ALS NIET-GELUKT ───────────────────────────────
// Mislukt de bevraging van het LMS of van het CRM als geheel, dan stopt de
// ronde met 502 en wordt er NIETS verwijderd. Anders zou één storing de hele
// spiegel legen.

import { supabaseAdmin } from '../supabase.js';
import { getDfoLmsClient } from './dfo-lms-db.js';
import { GEKOPPELD_SETTING_KEY } from './lms-hold.js';
import {
  SPIEGEL_TABEL, STUDENT_KOLOMMEN,
  BRON_GELEZEN, BRON_NIET_GEKOPPELD, BRON_ONBEREIKBAAR,
  SPIEGEL_GESCHREVEN, SPIEGEL_BEHOUDEN, SPIEGEL_MISLUKT, SPIEGEL_TABEL_ONTBREEKT,
  REDEN_GEEN_KANDIDAAT,
  redenNietActief, isEchteKlant, teltMeeAlsOpen,
  isTabelOntbreekt, NIET_MENTORSHIP, ZONDER_ACCOUNT, TRAJECT_AFGELOPEN,
  spiegelFactuurstandVoorStudent, leesOpenFacturen, maakContext,
} from './factuurstand-spiegel.js';

/** Ruim boven de 304 studentrijen van vandaag; een stille afkapping telt op. */
const CAP = 2000;
/** Genoeg foutmeldingen om een patroon te zien, te weinig om te verdrinken. */
const MAX_ERRORS = 20;
/** Hoeveel voorbeelden per geval de droogloop meestuurt. */
const MAX_VOORBEELDEN = 10;

/** Naam van een student voor in een voorbeeldregel. */
function naamVan(s) {
  const n = [s?.voornaam, s?.achternaam].map((v) => String(v || '').trim())
    .filter(Boolean).join(' ');
  return n || String(s?.email || '').trim() || String(s?.id || '');
}

/** Alles ophalen, met paginering. PostgREST knipt stil op 1000 rijen. */
async function alleRijen(bouwQuery, cap = CAP) {
  const uit = [];
  const PAGINA = 1000;
  for (let van = 0; van < cap; van += PAGINA) {
    const { data, error } = await bouwQuery().range(van, van + PAGINA - 1);
    if (error) throw new Error(error.message);
    const blok = Array.isArray(data) ? data : [];
    uit.push(...blok);
    if (blok.length < PAGINA) break;
  }
  return uit;
}

/**
 * De koppelingsverzameling van het CRM, in één keer opgehaald.
 *
 * Drie kaarten, één per weg. De KEUZE zit hier niet in — die staat als pure
 * functie in factuurstand-spiegel.js (`kiesKlant`) en wordt per student
 * toegepast. Hier wordt alleen verzameld.
 */
async function bouwKoppelingIndex(db, studenten) {
  const perStudentId = new Map();
  const perBubbleId  = new Map();
  const perEmail     = new Map();
  const duw = (kaart, sleutel, waarde) => {
    if (!sleutel || !waarde) return;
    const k = String(sleutel);
    if (!kaart.has(k)) kaart.set(k, []);
    kaart.get(k).push(waarde);
  };

  // ── Weg a + b: onboardings ──────────────────────────────────────────────
  // In één bevraging; de tabel is klein (tientallen rijen) en zo kan de
  // droogloop ook melden hoeveel onboardings er überhaupt een LMS-verwijzing
  // dragen. Testrijen doen niet mee — zelfde regel als de inhaalslag.
  const obs = await alleRijen(() => db.from('onboardings')
    .select('id, customer_id, dfo_lms_student_id, bubble_user_id, is_test'));
  let obMetStudentId = 0;
  let obMetBubbleId  = 0;
  for (const ob of obs) {
    if (ob?.is_test === true || !ob?.customer_id) continue;
    if (ob.dfo_lms_student_id) { obMetStudentId++; duw(perStudentId, ob.dfo_lms_student_id, ob.customer_id); }
    if (ob.bubble_user_id)     { obMetBubbleId++;  duw(perBubbleId,  ob.bubble_user_id,     ob.customer_id); }
  }

  // ── Weg c: klanten op e-mailadres ───────────────────────────────────────
  // Alleen de adressen die we nodig hebben, in blokken. Een `.in()` zou
  // hoofdlettergevoelig zijn en dus stilletjes minder vinden; `ilike` zonder
  // jokerteken is de hoofdletterongevoelige variant van gelijkheid. De
  // na-controle in JS vangt af dat een `%` of `_` in een adres het patroon
  // oprekt.
  const emails = Array.from(new Set(studenten
    .map((s) => String(s?.email || '').trim().toLowerCase()).filter(Boolean)));
  const BLOK = 40;
  for (let i = 0; i < emails.length; i += BLOK) {
    const blok = emails.slice(i, i + BLOK);
    // Adressen met een komma of haakje zouden de or-uitdrukking breken. Die
    // bestaan niet in een geldig e-mailadres, maar wel in rommel — en dan
    // slaan we ze over in plaats van de hele bevraging te laten struikelen.
    const veilig = blok.filter((e) => !/[,()]/.test(e));
    if (veilig.length === 0) continue;
    const rijen = await alleRijen(() => db.from('customers')
      .select('id, email, is_test')
      .or(veilig.map((e) => 'email.ilike.' + e).join(',')));
    for (const k of rijen) {
      if (!isEchteKlant(k)) continue;
      const mail = String(k.email || '').trim().toLowerCase();
      if (veilig.includes(mail)) duw(perEmail, mail, k.id);
    }
  }

  return {
    perStudentId, perBubbleId, perEmail,
    meting: {
      onboardings_totaal          : obs.length,
      onboardings_met_lms_student : obMetStudentId,
      onboardings_met_bubble_id   : obMetBubbleId,
      klant_emails_gezocht        : emails.length,
      klant_emails_gevonden       : perEmail.size,
    },
  };
}

/**
 * De openstaande signalen in het CRM, per type en per status.
 *
 * Staat hier omdat de opdracht er expliciet om vraagt: de bestaande
 * no-show-signalen worden NIET aangeraakt (het LMS leidt no-shows voortaan
 * zelf af uit `hlms_sessie`), maar ze moeten wel geteld worden zodat er een
 * beslissing over genomen kan worden. Tellen is geen aanraken.
 *
 * Faalzacht: een mislukte telling mag de droogloop niet omgooien, maar geeft
 * ook geen nullen terug — dan staat er een `fout` in plaats van cijfers.
 */
async function telStudentSignalen(db) {
  try {
    // Ruime bovengrens: dit zijn er vandaag tientallen, maar een afgekapte
    // telling zou een verkeerd beeld geven van iets waar een beslissing op
    // volgt.
    const rijen = await alleRijen(() => db.from('student_signals').select('type, status'), 20000);
    const per = {};
    for (const r of rijen) {
      const t = String(r?.type || 'onbekend');
      const s = String(r?.status || 'onbekend');
      per[t] = per[t] || {};
      per[t][s] = (per[t][s] || 0) + 1;
    }
    return { totaal: rijen.length, per_type_en_status: per, fout: null };
  } catch (e) {
    return { totaal: null, per_type_en_status: null, fout: e?.message || String(e) };
  }
}

/**
 * @param {{dry?: boolean, door?: string}} [opties]
 * @returns {Promise<{status: number, result: object}>}
 */
export async function draaiFactuurstandSync({ dry = false, door = 'cron' } = {}) {
  const result = {
    ok: true, dry, door,
    bron: 'invoices', bron_status: null,
    peildatum: null, tijdzone: 'Europe/Amsterdam (= Europe/Brussels)',
    gratiedagen: null,

    // Wat er aan studenten gevonden is.
    studenten_in_lms: 0, studenten_actief_mentorship: 0,
    // Waarom een student buiten de spiegel valt, per grond. Op één hoop is
    // "er staan er maar zoveel in de lijst" niet na te rekenen.
    afgevallen_membership: 0, afgevallen_zonder_account: 0,
    afgevallen_traject_afgelopen: 0,

    // Wat er geschreven zou worden / geschreven is.
    geschreven: 0, behouden: 0, mislukt: 0, overtollig_verwijderd: 0,
    overgeslagen_door_limiet: 0,

    // De drie bronstanden — dit is waar de droogloop om draait.
    gelezen: 0, niet_gekoppeld: 0, onbereikbaar: 0,

    // De matchgraad, per weg.
    via_onboarding: 0, via_bubble: 0, via_email: 0,
    niet_gekoppeld_redenen: {},

    // De twee drempels van de LMS-regel.
    met_1_vervallen: 0, met_2_of_meer_vervallen: 0, zonder_vervallen: 0,

    // Metingen die een beslissing dragen.
    facturen_meegeteld: 0, is_historical_meegeteld: 0,
    koppeling_meting: null, signalen: null,

    voorbeelden: { vervallen: [], niet_gekoppeld: [], onbereikbaar: [] },
    errors: [],
  };

  try {
    const lms = getDfoLmsClient();
    if (!lms) {
      result.ok = false;
      result.bron_status = BRON_ONBEREIKBAAR;
      result.error = 'DFO_LMS_SUPABASE_URL/KEY ontbreekt';
      console.error('[factuurstand-sync/' + door + ']', result.error);
      return { status: 502, result };
    }

    const ctx = await maakContext({ db: supabaseAdmin, lmsClient: lms });
    result.peildatum   = ctx.todayIso;
    result.gratiedagen = ctx.graceDays;

    // ── 1) De studenten uit het LMS ─────────────────────────────────────
    let studentenRuw;
    try {
      studentenRuw = await alleRijen(() => lms.from('hlms_student').select(STUDENT_KOLOMMEN));
    } catch (e) {
      result.ok = false;
      result.bron_status = BRON_ONBEREIKBAAR;
      result.error = 'hlms_student lezen: ' + (e?.message || e);
      console.error('[factuurstand-sync/' + door + ']', result.error);
      return { status: 502, result };
    }
    result.studenten_in_lms = studentenRuw.length;

    let studenten = [];
    for (const s of studentenRuw) {
      const reden = redenNietActief(s, ctx.todayIso);
      if (reden === null) { studenten.push(s); continue; }
      if      (reden === NIET_MENTORSHIP)   result.afgevallen_membership++;
      else if (reden === ZONDER_ACCOUNT)    result.afgevallen_zonder_account++;
      else if (reden === TRAJECT_AFGELOPEN) result.afgevallen_traject_afgelopen++;
    }
    if (studenten.length > CAP) {
      result.overgeslagen_door_limiet = studenten.length - CAP;
      studenten = studenten.slice(0, CAP);
      console.warn('[factuurstand-sync/' + door + '] limiet geraakt — '
        + result.overgeslagen_door_limiet + ' studenten niet verwerkt deze ronde');
    }
    result.studenten_actief_mentorship = studenten.length;

    // ── 2) Het CRM, in twee bevragingen ─────────────────────────────────
    let index;
    let facturen;
    try {
      index = await bouwKoppelingIndex(supabaseAdmin, studenten);
      result.koppeling_meting = index.meting;
      facturen = await leesOpenFacturen(supabaseAdmin, null);
    } catch (e) {
      // Het CRM als geheel is niet te lezen. Niets schrijven, niets
      // verwijderen — de oude spiegel is beter dan een lege.
      result.ok = false;
      result.bron_status = BRON_ONBEREIKBAAR;
      result.error = 'CRM lezen: ' + (e?.message || e);
      console.error('[factuurstand-sync/' + door + ']', result.error);
      return { status: 502, result };
    }

    const meegeteld = facturen.filter(teltMeeAlsOpen);
    result.facturen_meegeteld = meegeteld.length;
    result.is_historical_meegeteld = meegeteld.filter((f) => f.is_historical === true).length;
    result.bron_status = BRON_GELEZEN;

    ctx.index = index;

    // Zie schrijfAfdrukGekoppeldeKlanten() onderaan dit bestand.
    const gekoppeldeKlanten = new Set();

    // ── 3) Wat er NU in de spiegel staat ────────────────────────────────
    let aanwezigeIds = new Set();
    let tabelOntbreekt = false;
    {
      const { data, error } = await lms.from(SPIEGEL_TABEL).select('student_id');
      if (error) {
        // De tabel wordt aan LMS-kant aangemaakt. Bestaat hij nog niet, dan
        // is dat geen storing maar een volgorde-kwestie: de droogloop draait
        // gewoon door (die schrijft toch niets) en een echte ronde stopt met
        // een duidelijke melding in plaats van een stapel schrijffouten.
        if (isTabelOntbreekt(error)) {
          tabelOntbreekt = true;
          result.tabel_ontbreekt = true;
          console.warn('[factuurstand-sync/' + door + '] ' + SPIEGEL_TABEL
            + ' bestaat nog niet in het LMS');
          if (!dry) {
            result.ok = false;
            result.error = SPIEGEL_TABEL + ' bestaat nog niet in het LMS — '
              + 'de LMS-kant maakt die tabel aan. Droogloop werkt wel.';
            return { status: 503, result };
          }
        } else {
          result.ok = false;
          result.bron_status = BRON_ONBEREIKBAAR;
          result.error = 'spiegel lezen: ' + error.message;
          console.error('[factuurstand-sync/' + door + ']', result.error);
          return { status: 502, result };
        }
      } else {
        aanwezigeIds = new Set((data || []).map((r) => String(r.student_id)).filter(Boolean));
      }
    }
    result.aanwezig = aanwezigeIds.size;

    // ── 4) Per student ──────────────────────────────────────────────────
    for (const student of studenten) {
      aanwezigeIds.delete(String(student.id));
      try {
        const uit = await spiegelFactuurstandVoorStudent(student, ctx, { facturen, dry });

        if (uit.bron_status === BRON_GELEZEN) {
          result.gelezen++;
          if (uit.customer_id) gekoppeldeKlanten.add(String(uit.customer_id));
          if (uit.via === 'onboarding') result.via_onboarding++;
          else if (uit.via === 'bubble') result.via_bubble++;
          else if (uit.via === 'email')  result.via_email++;

          const n = uit.rij?.vervallen_aantal || 0;
          if (n === 0)      result.zonder_vervallen++;
          else if (n === 1) result.met_1_vervallen++;
          else              result.met_2_of_meer_vervallen++;

          if (n > 0 && result.voorbeelden.vervallen.length < MAX_VOORBEELDEN) {
            result.voorbeelden.vervallen.push({
              student: naamVan(student), via: uit.via,
              vervallen: n, open: uit.rij?.open_aantal || 0,
              oudste_vervaldatum: uit.rij?.oudste_vervaldatum || null,
              openstaand_bedrag: uit.rij?.openstaand_bedrag ?? null,
            });
          }
        } else if (uit.bron_status === BRON_NIET_GEKOPPELD) {
          result.niet_gekoppeld++;
          const reden = uit.reden || REDEN_GEEN_KANDIDAAT;
          result.niet_gekoppeld_redenen[reden] = (result.niet_gekoppeld_redenen[reden] || 0) + 1;
          if (result.voorbeelden.niet_gekoppeld.length < MAX_VOORBEELDEN) {
            result.voorbeelden.niet_gekoppeld.push({
              student: naamVan(student), email: student.email || null,
              via: uit.via, reden,
            });
          }
        } else if (uit.bron_status === BRON_ONBEREIKBAAR) {
          result.onbereikbaar++;
          if (result.voorbeelden.onbereikbaar.length < MAX_VOORBEELDEN) {
            result.voorbeelden.onbereikbaar.push({
              student: naamVan(student), fout: uit.fout || 'onbekend',
            });
          }
        }

        if      (uit.resultaat === SPIEGEL_GESCHREVEN) result.geschreven++;
        else if (uit.resultaat === SPIEGEL_BEHOUDEN)   result.behouden++;
        else if (uit.resultaat === SPIEGEL_TABEL_ONTBREEKT) {
          result.tabel_ontbreekt = true;
          tabelOntbreekt = true;
        } else if (uit.resultaat === SPIEGEL_MISLUKT) {
          result.mislukt++;
          if (result.errors.length < MAX_ERRORS) {
            result.errors.push({ student_id: student.id, error: uit.fout || 'onbekend' });
          }
        }
      } catch (e) {
        // spiegelFactuurstandVoorStudent gooit niet, maar mocht dat ooit
        // veranderen dan stopt één student nooit de hele ronde.
        result.mislukt++;
        console.error('[factuurstand-sync/' + door + '] student mislukt',
          student.id, e?.message || e);
        if (result.errors.length < MAX_ERRORS) {
          result.errors.push({ student_id: student.id, error: e?.message || String(e) });
        }
      }
    }

    // ── 5) Wat overblijft hoort er niet meer ────────────────────────────
    // Uitgestroomde studenten, of rijen van vóór een wijziging in de
    // definitie. Alleen als we de spiegel hebben kunnen lezen: anders weten
    // we niet wat overtollig is.
    if (!tabelOntbreekt) {
      for (const overtollig of aanwezigeIds) {
        if (dry) { result.overtollig_verwijderd++; continue; }
        try {
          const { error } = await lms.from(SPIEGEL_TABEL).delete().eq('student_id', overtollig);
          if (error) throw new Error(error.message);
          result.overtollig_verwijderd++;
        } catch (e) {
          result.mislukt++;
          console.error('[factuurstand-sync/' + door + '] overtollige rij niet weg te krijgen',
            overtollig, e?.message || e);
          if (result.errors.length < MAX_ERRORS) {
            result.errors.push({ student_id: overtollig, error: e?.message || String(e) });
          }
        }
      }
    }

    // ── 6) De afdruk voor het hold-vangnet ──────────────────────────────
    if (!dry) {
      result.afdruk_klanten = await schrijfAfdrukGekoppeldeKlanten(
        supabaseAdmin, gekoppeldeKlanten);
    }

    // ── 7) De twee metingen die alleen de droogloop nodig heeft ─────────
    if (dry) result.signalen = await telStudentSignalen(supabaseAdmin);

    console.log('[factuurstand-sync/' + door + '] klaar — actief='
      + result.studenten_actief_mentorship
      + ' gelezen=' + result.gelezen
      + ' niet_gekoppeld=' + result.niet_gekoppeld
      + ' onbereikbaar=' + result.onbereikbaar
      + ' 1-vervallen=' + result.met_1_vervallen
      + ' 2+-vervallen=' + result.met_2_of_meer_vervallen
      + ' mislukt=' + result.mislukt
      + (dry ? ' (droogloop — niets geschreven)' : ''));

    return { status: 200, result };
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('[factuurstand-sync/' + door + ']', msg);
    result.ok = false;
    result.error = msg;
    return { status: 500, result };
  }
}

/**
 * Laat een AFDRUK achter van de klanten die deze ronde aan een LMS-student
 * gekoppeld zijn, in `app_settings`.
 *
 * ── WAAROM DIT HIER STAAT EN NIET IN DE MOTOR ───────────────────────────
 * De hold-poort (api/_lib/lms-hold.js) moet, als het LMS onbereikbaar is,
 * weten wélke klanten een LMS-koppeling hebben — want díé slaat hij dan
 * over. Twee van de drie koppelwegen staan in het CRM zelf en zijn dus ook
 * bij een storing leesbaar. De derde, het e-mailadres, heeft aan CRM-kant
 * geen enkel spoor: die koppeling ontstaat pas doordat een LMS-student
 * hetzelfde adres draagt. Zonder deze afdruk zouden precies die klanten bij
 * een storing door het vangnet heen vallen.
 *
 * Het is nadrukkelijk een AFDRUK en geen tweede waarheid:
 *   • hij wordt alleen hier geschreven, door de ronde die de koppeling toch
 *     al uitrekent — er is geen tweede plek die dit bijhoudt;
 *   • hij wordt alleen gebruikt om het vangnet BREDER te maken, nooit om
 *     iets te versturen of om een klant te koppelen;
 *   • ontbreekt hij of is hij oud, dan doet het vangnet het nog steeds met
 *     de twee CRM-wegen. Daarom gaat `bijgewerkt_op` mee.
 *
 * Alleen bij een ECHTE ronde, en alleen als er ook echt studenten verwerkt
 * zijn: een ronde die halverwege afbrak mag de afdruk niet uithollen tot
 * een handvol klanten.
 *
 * Faalzacht: mislukt het schrijven, dan is dat een waarschuwing. De oude
 * afdruk blijft dan staan, en dat is precies goed — een oude afdruk is
 * breder dan geen afdruk.
 */
async function schrijfAfdrukGekoppeldeKlanten(db, klanten) {
  if (!(klanten instanceof Set) || klanten.size === 0) {
    console.warn('[factuurstand-sync] geen gekoppelde klanten in deze ronde — '
      + 'afdruk ONGEWIJZIGD gelaten (een lege afdruk zou het hold-vangnet legen)');
    return null;
  }
  try {
    const value = {
      customer_ids : Array.from(klanten),
      bijgewerkt_op: new Date().toISOString(),
    };
    const { error } = await db
      .from('app_settings')
      .upsert({ key: GEKOPPELD_SETTING_KEY, value }, { onConflict: 'key' });
    if (error) throw new Error(error.message);
    return klanten.size;
  } catch (e) {
    console.warn('[factuurstand-sync] afdruk gekoppelde klanten niet weggeschreven: '
      + (e?.message || e) + ' — de vorige afdruk blijft staan');
    return null;
  }
}
