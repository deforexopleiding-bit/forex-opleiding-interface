// api/_lib/lms-stilte.js
//
// DE MOTOR ZWIJGT ALS ER EEN AFSPRAAK LOOPT.
//
// ── DE BRUG, EN WELKE KANT HIJ OP LOOPT ──────────────────────────────────
// Dit is het spiegelbeeld van `hlms_crm_factuurstand`. Daar schrijft het CRM
// en leest het LMS; hier schrijft het LMS en leest de aanmaanmotor. Het
// contract staat in het dfo-lms-project:
//
//   public.hlms_crm_stilte — één rij per student
//     student_id   uuid  PK, FK naar hlms_student(id) ON DELETE CASCADE
//     stil_tot     date  NOT NULL — tot en MET die dag
//     reden        text  NOT NULL — betaling / ziekte / vakantie /
//                                   geen_contact / afspraak / anders
//     reden_tekst  text  — de zin die een mens leest
//     door         uuid  NOT NULL (CHECK) — er bestaat geen stilte zonder mens
//     door_naam    text  — mag leeg zijn, dus nooit blind afdrukken
//     bron         text  NOT NULL — hold / belofte / hand
//     bijgewerkt_op timestamptz
//
// Het LMS schrijft; wij LEZEN, met de service-sleutel die er al is. Deze
// module schrijft NOOIT naar het LMS — er staat een toets op.
//
// ── WAT EEN STILTE WEL EN NIET IS ────────────────────────────────────────
// Een stilte ontstaat alleen als een MENS een afspraak maakte: Dave, Maxim of
// de hoofdmentor, een belofte met datum of een pauze met reden. Een
// automatische betalingspauze in het LMS (2+ vervallen facturen) zet
// uitdrukkelijk GEEN stilte — die legt alleen de coaching stil. Dat
// onderscheid wordt aan LMS-kant gemaakt en wij nemen het over zoals het er
// staat; wij leiden hier niets zelf af uit holds of facturen.
//
// ── DIT IS DE ENIGE POORT. DE HOLD-POORT IS WEG ─────────────────────────
// #1622 zette er een tweede poort naast die `hlms_student_hold` rechtstreeks
// las. Die is op 21 september 2026 verwijderd, op beslissing van Maxim, en
// de reden is precies het onderscheid hierboven:
//
//   * Het LMS kan AUTOMATISCHE betalingsholds schrijven (2+ vervallen
//     facturen, `door` leeg, `reden_soort='betaling'`). Die leggen alleen de
//     coaching stil. De oude poort zou ze als zwijggebod gelezen hebben en
//     dus precies de wanbetalers stilleggen die wél een aanmaning horen te
//     krijgen — de hele doelgroep van deze motor.
//   * Een MENSELIJKE hold projecteert het LMS zelf naar een stilterij met
//     `bron='hold'`. Die bereikt ons dus nog steeds, langs deze poort, met
//     een naam eronder.
//
// Daarmee is er één bron en één regel: zwijgen doen we alleen als een mens
// dat heeft afgesproken. Leidt het LMS ooit iets nieuws af waarbij de motor
// moet zwijgen, dan hoort dat een rij in `hlms_crm_stilte` te worden — niet
// een tweede poort aan deze kant.
//
// ── FAALZACHT, NAAR DE VOORZICHTIGE KANT ─────────────────────────────────
// Leeg is niet hetzelfde als niet-gelukt. Kan de stilte niet gelezen worden,
// dan sturen we deze run NIETS naar klanten met een LMS-koppeling, loggen we
// het als "stilte onbekend", en proberen we het de volgende run opnieuw. Een
// dag later manen kost weinig; manen tegen een afspraak in kost vertrouwen.
//
// Blijft de bron langer dan een etmaal onleesbaar, dan hoort daar een mens
// van te weten: `noteerBronStand()` legt de stand vast en
// `beoordeelStilteBron()` is het oordeel dat de waakhond gebruikt.

import { supabaseAdmin } from '../supabase.js';
import { getDfoLmsClient } from './dfo-lms-db.js';
import { todayIsoInTz } from './dunning-overdue-guard.js';
import { STUDENT_KOLOMMEN, zoekKlantKandidaten, kiesKlant } from './factuurstand-spiegel.js';
import { bouwVangnet, nlDatum } from './lms-koppelnet.js';

export const STILTE_TABEL = 'hlms_crm_stilte';

// Dezelfde woordenlijst als de andere LMS-lezers in dit repo.
export const BRON_GELEZEN             = 'gelezen';
export const BRON_ONBEREIKBAAR        = 'onbereikbaar';
export const BRON_NIET_GECONFIGUREERD = 'niet-geconfigureerd';

// De reden-code in dunning_log en in de wanbetalersmodule.
export const STILTE_CODE  = 'lms_stilte';
export const STILTE_EVENT = 'skipped_lms_stilte';
// En het geval waarin we het NIET weten. Apart van de gewone stilte, want
// "er is een afspraak" en "we konden niet kijken" zijn niet hetzelfde en
// horen in het dossier ook niet hetzelfde te lezen.
export const ONBEKEND_CODE  = 'lms_stilte_onbekend';
export const ONBEKEND_EVENT = 'skipped_lms_stilte_onbekend';

/** app_settings-sleutel met de laatst bekende stand van de bron. */
export const BRON_SETTING_KEY = 'lms_stilte_bron';
/** Vanaf wanneer een onleesbare bron een mens hoort wakker te maken. */
export const ALARM_NA_MS = 24 * 60 * 60 * 1000;

const STILTE_KOLOMMEN = 'student_id, stil_tot, reden, reden_tekst, door_naam, bron';

// ───────────────────────────────────────────────────────────────────────────
// 1) DE DEFINITIE — puur
// ───────────────────────────────────────────────────────────────────────────

/** 'YYYY-MM-DD' uit een datumwaarde; null als er niets staat. */
function dag(waarde) {
  const s = String(waarde || '').trim();
  return s ? s.slice(0, 10) : null;
}

/**
 * Loopt deze stilte vandaag nog?
 *
 * `stil_tot` is INCLUSIEF — tot en met die dag. Op 1 oktober bij
 * `stil_tot = 2026-10-01` zwijgt de motor dus nog; op 2 oktober niet meer.
 * Let op het verschil met de oude hold-poort, waar `tot` EXCLUSIEF was:
 * daar stond een periode met een einde, hier staat een dag waarop de
 * afspraak nog geldt. Wie die twee door elkaar haalt, maant precies één dag
 * te vroeg.
 *
 * Geen `stil_tot` → geen stilte. Een leeg veld valt hier NIET naar de
 * voorzichtige kant: de kolom staat op NOT NULL, dus een
 * lege waarde is geen "loopt door" maar een rij die niet had mogen bestaan,
 * en daar een eeuwige stilte van maken zou een klant onbereikbaar maken
 * zonder dat iemand er een datum bij heeft gezet.
 *
 * PURE.
 */
export function isActieveStilte(rij, todayIso) {
  if (!rij) return false;
  const tot = dag(rij.stil_tot);
  const vandaag = dag(todayIso);
  if (!tot || !vandaag) return false;
  return tot >= vandaag;
}

/**
 * De zin die in het CRM te lezen valt. Het LMS levert de mensentekst
 * (`reden_tekst`) en de naam; wij plakken er alleen de datum omheen.
 *
 * Alles is defensief: `door_naam` mag leeg zijn (alleen `door` staat op
 * NOT NULL aan LMS-kant), en dan schrijven we niet "afspraak van undefined".
 *
 * PURE.
 */
export function stilteTekst(rij) {
  const tot = nlDatum(rij?.stil_tot);
  const delen = [tot ? ('Afspraak in het LMS — stil tot en met ' + tot) : 'Afspraak in het LMS'];
  const tekst = String(rij?.reden_tekst || '').trim();
  if (tekst) delen.push(tekst);
  const naam = String(rij?.door_naam || '').trim();
  if (naam) delen.push('afgesproken door ' + naam);
  return delen.join(' · ');
}

// ───────────────────────────────────────────────────────────────────────────
// 2) DE STAND — één keer per run ophalen
// ───────────────────────────────────────────────────────────────────────────

/**
 * Welke klanten mag de motor deze run niet benaderen?
 *
 * Het contract beschrijft de vraag per student ("... where student_id = X
 * and stil_tot >= current_date"). Wij stellen dezelfde vraag één keer voor
 * alle lopende stiltes en koppelen daarna — een motor die honderden klanten
 * langsloopt mag het LMS niet honderden keren bevragen. De uitkomst is
 * dezelfde; alleen het aantal bevragingen verschilt.
 *
 * De peildatum is die van de motor (Europe/Amsterdam), niet `current_date`
 * van de LMS-databank. Zo beslissen de vervaldatum-poort en deze poort op
 * dezelfde dag, ook als de twee servers net over een middernacht heen staan.
 *
 * @param {{db?: object, lmsClient?: object, nu?: Date, todayIso?: string}} [opties]
 */
export async function haalStilteStand(opties = {}) {
  const db = opties.db || supabaseAdmin;
  const todayIso = opties.todayIso || todayIsoInTz(opties.nu || new Date());
  const telling = { rijen: 0, actief: 0, gekoppeld: 0, niet_gekoppeld: 0, student_onbekend: 0 };

  const lms = opties.lmsClient || getDfoLmsClient();
  if (!lms) {
    // Geen LMS-koppeling geconfigureerd is iets anders dan een storing: in
    // een omgeving zonder DFO_LMS_*-variabelen bestaat het LMS domweg niet,
    // en fail-closed zou daar de hele motor stilzetten voor een afspraak die
    // niet kan bestaan.
    return { bron_status: BRON_NIET_GECONFIGUREERD, stiltes: new Map(), vangnet: new Set(),
      fout: 'DFO_LMS_SUPABASE_URL/KEY ontbreekt', telling, peildatum: todayIso };
  }

  // ── 1) De lopende stiltes ────────────────────────────────────────────
  let rijen;
  try {
    const { data, error } = await lms
      .from(STILTE_TABEL).select(STILTE_KOLOMMEN).gte('stil_tot', todayIso);
    if (error) throw new Error(error.message);
    rijen = Array.isArray(data) ? data : [];
  } catch (e) {
    return await onbereikbaar(db, e?.message || String(e), telling, todayIso);
  }

  telling.rijen = rijen.length;
  // De `gte` hierboven doet het werk al; deze zeef is er voor het geval de
  // databank een andere dag telt dan de motor. Dan wint de motor.
  const actief = rijen.filter((r) => isActieveStilte(r, todayIso));
  telling.actief = actief.length;

  const stiltes = new Map();
  if (actief.length === 0) {
    await noteerBronStand(db, { status: BRON_GELEZEN, fout: null });
    return { bron_status: BRON_GELEZEN, stiltes, vangnet: new Set(), fout: null,
      telling, peildatum: todayIso };
  }

  // ── 2) Studenten erbij, dan de koppeling van de factuurspiegel ───────
  try {
    const ids = Array.from(new Set(actief.map((r) => String(r.student_id || '')).filter(Boolean)));
    const { data, error } = await lms
      .from('hlms_student').select(STUDENT_KOLOMMEN).in('id', ids);
    if (error) throw new Error('hlms_student lezen: ' + error.message);
    const studentById = new Map((data || []).map((s) => [String(s.id), s]));

    for (const rij of actief) {
      const student = studentById.get(String(rij.student_id)) || null;
      if (!student) {
        // Kan door de FK eigenlijk niet, maar een stilte op een student die
        // we niet terugvinden is een gegevensprobleem en geen "niet
        // gekoppeld" — dat onderscheid hoort in de telling te staan.
        telling.student_onbekend++;
        console.warn('[lms-stilte] stilte op onbekende student ' + rij.student_id);
        continue;
      }
      // DE koppeling van de factuurspiegel (#1614). Geen tweede.
      const keuze = kiesKlant(await zoekKlantKandidaten(student, { db }));
      if (!keuze.customer_id) {
        telling.niet_gekoppeld++;
        console.warn('[lms-stilte] stilte zonder CRM-klant voor student '
          + rij.student_id + ' (' + (keuze.reden || 'geen-klant-gevonden') + ')');
        continue;
      }
      telling.gekoppeld++;
      // Twee stiltes op dezelfde klant (twee studenten, één betaler): de
      // LAATSTE datum wint. De motor zwijgt dan tot de laatste afspraak af is.
      const bestaand = stiltes.get(keuze.customer_id);
      if (!bestaand || dag(rij.stil_tot) > dag(bestaand.stil_tot)) {
        stiltes.set(keuze.customer_id, { ...rij, _via: keuze.via });
      }
    }
  } catch (e) {
    return await onbereikbaar(db, e?.message || String(e), telling, todayIso);
  }

  await noteerBronStand(db, { status: BRON_GELEZEN, fout: null });
  return { bron_status: BRON_GELEZEN, stiltes, vangnet: new Set(), fout: null,
    telling, peildatum: todayIso };
}

/** De bron haperde: vangnet ophalen, stand vastleggen, luid loggen. */
async function onbereikbaar(db, fout, telling, todayIso) {
  console.error('[lms-stilte] STILTE NIET TE LEZEN — de motor houdt zich deze '
    + 'run in voor alle klanten met een LMS-koppeling. Reden: ' + fout);
  const vangnet = await bouwVangnet(db);
  await noteerBronStand(db, { status: BRON_ONBEREIKBAAR, fout });
  return {
    bron_status: BRON_ONBEREIKBAAR, stiltes: new Map(), vangnet: vangnet.klanten,
    fout, telling, peildatum: todayIso,
    vangnet_meting: {
      klanten: vangnet.klanten.size,
      afdruk_bijgewerkt_op: vangnet.afdruk_bijgewerkt_op,
      crm_fout: vangnet.crm_fout,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 3) DE POORT — wat de motor aanroept
// ───────────────────────────────────────────────────────────────────────────

/**
 * Mag de motor deze klant benaderen?
 *
 * @returns {null | {code, reden, stil_tot, bron_status, student_id, event}}
 *   null = vrij. Een object = NIET versturen, met de reden erbij.
 *
 * PURE (leest alleen uit de meegegeven stand).
 */
export function stilteBlokkade(stand, customerId) {
  if (!stand || !customerId) return null;
  const id = String(customerId);

  if (stand.bron_status === BRON_ONBEREIKBAAR) {
    if (!stand.vangnet?.has(id)) return null;
    return {
      code: ONBEKEND_CODE,
      event: ONBEKEND_EVENT,
      reden: 'Stilte onbekend — het LMS is niet te lezen, dus deze klant wordt '
        + 'deze ronde overgeslagen. De volgende ronde probeert het opnieuw.',
      stil_tot: null,
      bron_status: stand.bron_status,
      student_id: null,
      door_naam: null,
    };
  }

  const rij = stand.stiltes?.get(id);
  if (!rij) return null;
  return {
    code: STILTE_CODE,
    event: STILTE_EVENT,
    reden: stilteTekst(rij),
    stil_tot: dag(rij.stil_tot),
    bron_status: stand.bron_status,
    student_id: rij.student_id || null,
    door_naam: rij.door_naam || null,
    reden_soort: rij.reden || null,
    bron: rij.bron || null,
  };
}

/** Eén logregel per cron-run. */
export function stilteStandSamenvatting(stand) {
  if (!stand) return 'lms-stilte: niet geladen';
  if (stand.bron_status === BRON_ONBEREIKBAAR) {
    return 'lms-stilte: BRON ONBEREIKBAAR (' + (stand.fout || 'onbekend') + ') — '
      + (stand.vangnet?.size || 0) + ' klant(en) met LMS-koppeling overgeslagen';
  }
  if (stand.bron_status === BRON_NIET_GECONFIGUREERD) {
    return 'lms-stilte: dfo-lms niet geconfigureerd — geen stiltes toegepast';
  }
  const t = stand.telling || {};
  return 'lms-stilte: ' + (t.actief || 0) + ' lopende afspra(a)k(en), '
    + (t.gekoppeld || 0) + ' gekoppeld aan een klant, '
    + (t.niet_gekoppeld || 0) + ' zonder klant, '
    + (t.student_onbekend || 0) + ' zonder studentrij';
}

// ───────────────────────────────────────────────────────────────────────────
// 4) DE GEZONDHEIDSCONTROLE
// ───────────────────────────────────────────────────────────────────────────

/**
 * Leg vast hoe de bron er deze run bij stond.
 *
 * `onleesbaar_sinds` blijft staan zolang het mis is, zodat de waakhond kan
 * zien HOE LANG het al duurt — dat is het verschil tussen een hikje en een
 * storing. Bij de eerste geslaagde lezing wordt hij gewist.
 *
 * Faalzacht: dit is een dagboek, geen poort. Mislukt het schrijven, dan gaat
 * de motor gewoon door.
 */
export async function noteerBronStand(db, { status, fout }) {
  try {
    const nuIso = new Date().toISOString();
    const { data } = await db
      .from('app_settings').select('value').eq('key', BRON_SETTING_KEY).maybeSingle();
    const vorige = data?.value || {};
    const value = status === BRON_ONBEREIKBAAR
      ? {
        status,
        laatste_fout: fout || 'onbekend',
        // NIET overschrijven: het gaat om het BEGIN van de storing.
        onleesbaar_sinds: vorige.onleesbaar_sinds || nuIso,
        laatste_ok: vorige.laatste_ok || null,
        bijgewerkt_op: nuIso,
      }
      : {
        status,
        laatste_fout: null,
        onleesbaar_sinds: null,
        laatste_ok: nuIso,
        bijgewerkt_op: nuIso,
      };
    await db.from('app_settings').upsert({ key: BRON_SETTING_KEY, value }, { onConflict: 'key' });
  } catch (e) {
    console.warn('[lms-stilte] bronstand niet vastgelegd: ' + (e?.message || e));
  }
}

/**
 * Het oordeel voor de waakhond: is de stilte-bron zo lang onleesbaar dat er
 * een mens bij moet?
 *
 * Eén etmaal is de drempel. Korter is een hikje — de motor heeft dan
 * hooguit één ronde overgeslagen, en dat herstelt zichzelf. Langer betekent
 * dat er dagen niemand gemaand wordt zonder dat iemand het weet, en dát is
 * het stille falen waar deze hele brug tegen gebouwd is.
 *
 * PURE.
 */
export function beoordeelStilteBron({ nuMs, stand, drempelMs = ALARM_NA_MS }) {
  const status = String(stand?.status || '') || null;
  if (status !== BRON_ONBEREIKBAAR) {
    return { alarm: false, staat: status || 'onbekend', uren_stil: null };
  }
  const sinds = Date.parse(stand?.onleesbaar_sinds || '');
  if (!Number.isFinite(sinds)) {
    // Onleesbaar zonder begintijd: we weten niet hoe lang al. Niet alarmeren
    // op een getal dat we niet hebben; de volgende run zet de tijd wel.
    return { alarm: false, staat: BRON_ONBEREIKBAAR, uren_stil: null };
  }
  const msStil = Math.max(0, (Number(nuMs) || Date.now()) - sinds);
  return {
    alarm: msStil >= drempelMs,
    staat: BRON_ONBEREIKBAAR,
    uren_stil: Math.floor(msStil / 3600000),
    sinds_iso: stand.onleesbaar_sinds,
    laatste_fout: stand.laatste_fout || null,
  };
}
