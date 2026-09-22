// api/_lib/iris/signalen.js
//
// Wat de mentoren melden, overgenomen uit het LMS.
//
// ── ALLEEN LEZEN ─────────────────────────────────────────────────────────────
// De richting is CRM → LMS voor schrijven, en hier gaat het de andere kant op:
// wij lezen `hlms_signaal` met de sleutel die er al is. Deze module schrijft
// NOOIT naar het LMS. De mentormodule wordt in een andere sessie gebouwd; als
// wij daar iets in zouden zetten, zouden twee sessies dezelfde tabel
// beschrijven zonder van elkaar te weten.
//
// ── WAAROM HET TYPE VRIJE TEKST IS EN GEEN ENUM ──────────────────────────────
// De opdracht noemt drie types die er nog niet zijn: `uitstel`,
// `reageert_niet`, `halt`. Een CHECK-constraint op deze kolom zou betekenen
// dat de synchronisatie breekt op de dag dat het LMS er een vierde toevoegt —
// en die dag komt, want de mentormodule wordt parallel gebouwd.
//
// Een onbekend type is dus geen fout maar een kaart met een type dat we niet
// kennen. Die komt gewoon in de lijst, en een mens leest hem. Dat is beter dan
// een synchronisatie die stilvalt en waarvan niemand het merkt.
//
// Zie docs/iris/lms-signaalcontract.md voor wat we van het LMS verwachten.
//
// ── ÉÉN RIJ PER BRON-SIGNAAL ─────────────────────────────────────────────────
// `bron_id` is UNIQUE en draagt een voorvoegsel per bronsysteem. De
// synchronisatie mag dus zo vaak draaien als ze wil; een tweede poging botst
// op de constraint en wordt stil overgeslagen.

/** Welke signalen we ophalen en hoe ver terug. */
export const TERUGBLIK_DAGEN = 30;
export const MAX_PER_RONDE = 100;

/** Bouw de bron-sleutel. Eén plek, zodat de twee kanten niet uit elkaar lopen. */
export function bronSleutel(systeem, id) {
  return `${systeem === 'crm' ? 'crm' : 'lms'}:${String(id)}`;
}

/**
 * Wat moet er met dit signaal gebeuren?
 *
 * De vertaling van een signaaltype naar een voorstel. Onbekende types krijgen
 * een neutraal voorstel — "laat een mens kijken" — in plaats van niets. Een
 * kaart zonder voorstel is een kaart waar niemand iets mee doet.
 */
export const VOORSTEL_PER_TYPE = Object.freeze({
  uitstel: {
    voorstel: 'on hold met reden, einddatum schuift mee',
    actie: 'lms_on_hold',
    toelichting: 'Bij ziekte of vakantie schuift de einddatum mee. Bij betaling of geen contact niet.',
  },
  reageert_niet: {
    voorstel: 'op de belrij bij Dave',
    actie: 'belrij_toevoegen',
    toelichting: 'Eerst bellen. Pas na een paar dagen zonder contact een bericht.',
  },
  halt: {
    voorstel: 'stopzetten bespreken — altijd een mens',
    actie: null,
    toelichting: 'Een student die wil stoppen, is een gesprek en geen handeling.',
  },
  no_show: {
    voorstel: 'op de belrij',
    actie: 'belrij_toevoegen',
    toelichting: 'Twee keer niet komen opdagen na elkaar is een signaal, geen toeval.',
  },
  factuur: {
    voorstel: 'dossier nakijken in de Post',
    actie: null,
    toelichting: 'De factuurstand komt al via hlms_crm_factuurstand; dit is de mentor die het opmerkt.',
  },
  taken_niet_gedaan: {
    voorstel: 'op de belrij',
    actie: 'belrij_toevoegen',
    toelichting: 'Een student die zijn taken niet doet, haakt meestal af voordat hij het zelf zegt.',
  },
});

export function voorstelVoor(type) {
  const t = String(type || '').trim().toLowerCase();
  return VOORSTEL_PER_TYPE[t] || {
    voorstel: 'laat een mens kijken',
    actie: null,
    toelichting: `Type "${type || 'onbekend'}" kennen we nog niet. Dat is geen fout — het LMS krijgt er types bij.`,
    onbekend: true,
  };
}

/**
 * Maak van een LMS-rij de vorm die iris_signalen verwacht.
 */
export function vormSignaal(rij, { systeem = 'dfo_lms' } = {}) {
  const type = String(rij?.type || rij?.signaal_type || 'onbekend').trim().toLowerCase();
  return {
    bron_id: bronSleutel(systeem === 'crm' ? 'crm' : 'lms', rij.id),
    bron_systeem: systeem === 'crm' ? 'crm' : 'dfo_lms',
    type,
    mentor_naam: rij.mentor_naam || rij.mentor || null,
    toelichting: rij.toelichting || rij.omschrijving || rij.notitie || null,
    gevraagde_actie: rij.gevraagde_actie || voorstelVoor(type).voorstel,
    signaal_op: rij.aangemaakt_op || rij.created_at || rij.signaal_op || new Date().toISOString(),
  };
}

/** Welke bron-sleutels staan er nog niet in? Hetzelfde verzamelverschil als opname.js. */
export function filterNieuw(rijen, bekende, systeem = 'dfo_lms') {
  const bekend = bekende instanceof Set ? bekende : new Set(bekende || []);
  const uit = [];
  for (const r of (rijen || [])) {
    if (!r || !r.id) continue;
    const sleutel = bronSleutel(systeem === 'crm' ? 'crm' : 'lms', r.id);
    if (bekend.has(sleutel)) continue;
    uit.push(r);
  }
  return uit;
}

/**
 * Haal de mentorsignalen op en zet ze klaar.
 *
 * Faalt dit, dan is dat een waarschuwing en geen fout: de rest van de ronde
 * hoort gewoon door te lopen. Een LMS dat even niet bereikbaar is, mag de
 * post niet stilleggen.
 *
 * @returns {Promise<{opgehaald: number, nieuw: number, fout: string|null}>}
 */
export async function haalSignalen({ crmDb, lmsClient, nu = new Date() } = {}) {
  if (!lmsClient) return { opgehaald: 0, nieuw: 0, fout: 'LMS-koppeling niet geconfigureerd' };
  if (!crmDb) return { opgehaald: 0, nieuw: 0, fout: 'geen CRM-client' };

  const sinds = new Date(nu.getTime() - TERUGBLIK_DAGEN * 24 * 3600 * 1000).toISOString();

  try {
    const { data, error } = await lmsClient
      .from('hlms_signaal')
      .select('*')
      .gte('created_at', sinds)
      .order('created_at', { ascending: false })
      .limit(MAX_PER_RONDE);
    if (error) throw new Error(error.message);

    const rijen = data || [];
    if (!rijen.length) return { opgehaald: 0, nieuw: 0, fout: null };

    const { data: bestaand, error: bFout } = await crmDb
      .from('iris_signalen')
      .select('bron_id')
      .gte('signaal_op', sinds);
    if (bFout) throw new Error('bestaande signalen: ' + bFout.message);

    const bekend = new Set((bestaand || []).map((r) => r.bron_id));
    const nieuw = filterNieuw(rijen, bekend, 'dfo_lms');

    let gelukt = 0;
    for (const r of nieuw) {
      // Per signaal apart. Eén rij die struikelt mag de andere niet meenemen.
      try {
        const { error: iFout } = await crmDb.from('iris_signalen').insert(vormSignaal(r));
        if (iFout) {
          if (String(iFout.code) === '23505') continue;  // gelijktijdige ronde was ons voor
          throw new Error(iFout.message);
        }
        gelukt++;
      } catch (e) {
        console.error('[iris/signalen] signaal', r.id, 'niet opgeslagen:', e?.message || e);
      }
    }

    return { opgehaald: rijen.length, nieuw: gelukt, fout: null };
  } catch (e) {
    console.error('[iris/signalen] ophalen mislukt:', e?.message || e);
    return { opgehaald: 0, nieuw: 0, fout: e?.message || String(e) };
  }
}
