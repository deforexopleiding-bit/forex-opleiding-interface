// api/_lib/opvolging-call-wa.js
//
// WHATSAPP-BERICHTEN ALS POGINGEN, VOOR EEN LEAD ZONDER OPVOLGTAAK.
//
// ── HET GAT ──────────────────────────────────────────────────────────────
// De twee vensters (spraakbericht vóór 09:00, nabellen tussen 12 en 13) worden
// beoordeeld op `opvolging_pogingen`, en die rijen hangen aan een TAAK. Een
// zoomlead heeft meestal geen taak: hij boekte zelf een call en kwam nooit in
// de werklijst. api/opvolging-whatsapp-webhook.js gooide zo'n bericht dan ook
// weg — `if (!taak) return gekoppeld:false` — en dus was er niets om op te
// rekenen.
//
// Gemeten op 10 september: de brug liet de nummers gewoon door (118 op
// webhook.verstuurd, 36 doorgelaten op message_create), maar
// /api/opvolging-whatsapp-gesprek?nummer= gaf nul regels voor Rani
// (31641440096), Nadia (32494113391), Nive (32484533550) en Claudia
// (31624270002). Het scherm zei daarom '7 ingeplande calls, maar geen ervan
// staat in de takenlijst' — een nul die eruitzag als een meting.
//
// ── DE OPLOSSING, EN WAAROM ZE HIER STAAT ────────────────────────────────
// De webhook bewaart een bericht van een onbekend nummer voortaan wél als
// gespreksregel (`opvolging_wa_berichten`, taak_id NULL). Deze module maakt van
// zo'n regel een poging-vórmig object, zodat de BESTAANDE beoordeelSpraak() en
// beoordeelNabel() er gewoon op kunnen rekenen. Er komt dus geen tweede
// definitie van 'op tijd' bij — dat is precies wat er niet mag gebeuren.
//
// GEEN RIJ IN opvolging_pogingen. Een poging hoort bij een kaart; er een
// schrijven zonder taak zou een taak-loze telling opleveren die nergens
// zichtbaar is en de dekking van iemand anders kan vervuilen. Het bericht
// staat in het gesprek, en hier wordt het pas op het moment van rekenen tot
// poging omgevormd.

/**
 * Wat WhatsApp een ingesproken bericht noemt. Tweeling van dezelfde set in
 * api/opvolging-whatsapp-webhook.js — die beslist wat er als 'spraakbericht' in
 * de pogingen komt, deze doet hetzelfde voor een regel zonder taak. Lopen ze
 * uiteen, dan telt hetzelfde bericht mét en zónder kaart anders.
 */
export const SPRAAK_TYPES = new Set(['ptt', 'audio', 'voice']);

/** Alleen cijfers, en een internationale 00-prefix eraf. Tweeling van telCijfers. */
export function normaliseerNummer(s) {
  const c = String(s == null ? '' : s).replace(/\D/g, '');
  if (!c) return null;
  return c.startsWith('00') ? (c.slice(2) || null) : c;
}

/**
 * Een gespreksregel als poging-vormig object.
 *
 * Draagt precies de vier velden waar beoordeelSpraak/beoordeelNabel op lezen:
 * `soort`, `richting`, `tijdstip` — plus `bron` zodat je in een dump ziet dat
 * deze poging niet uit opvolging_pogingen komt.
 *
 * Geen `taak_id`: er is er geen, en er een verzinnen zou de rij in tellingen
 * laten opduiken die over kaarten gaan.
 */
export function regelAlsPoging(r) {
  const spraak = SPRAAK_TYPES.has(String((r && r.media_type) || '').toLowerCase());
  return {
    soort   : spraak ? 'spraakbericht' : 'whatsapp',
    richting: (r && r.richting) === 'in' ? 'in' : 'uit',
    tijdstip: r ? r.tijdstip : null,
    bron    : 'wa_bericht',
  };
}

/**
 * De gespreksregels die bij dit telefoonnummer horen.
 *
 * Eerst exact op de volle cijferreeks, dan op de laatste negen — het CRM
 * noteert nummers ook lokaal terwijl WhatsApp altijd met landcode aankomt.
 * Zie CLAUDE.md lesson 18.
 *
 * Anders dan bij het zoeken van een TAAK is een dubbele treffer hier geen
 * probleem: we koppelen een bericht aan een nummer, niet aan een persoon, en
 * twee regels van hetzelfde nummer zijn gewoon twee berichten.
 */
export function regelsVoorNummer(regels, tel) {
  const doel = normaliseerNummer(tel);
  if (!doel) return [];
  const staart = doel.length >= 9 ? doel.slice(-9) : null;
  return (Array.isArray(regels) ? regels : []).filter((r) => {
    const c = normaliseerNummer(r && r.nummer);
    if (!c) return false;
    if (c === doel) return true;
    return !!staart && c.length >= 9 && c.slice(-9) === staart;
  });
}

/** De pogingen die bij dit nummer horen, klaar voor beoordeelSpraak/beoordeelNabel. */
export function waPogingenVoorNummer(regels, tel) {
  return regelsVoorNummer(regels, tel).map(regelAlsPoging);
}

/**
 * De gespreksregels van een periode.
 *
 * GEEN TEKST. Het scherm en het rapport hebben alleen nodig WANNEER er iets
 * ging en van welk soort; de inhoud van een gesprek hoort in het gesprekspaneel
 * en niet in een telling. Dat scheelt ook een hoop bytes op een weekrapport.
 *
 * Gooit niet: bij een leesfout komt `{ regels: [], fout }` terug zodat de
 * aanroeper er een BLINDE VLEK van kan maken. Een lege lijst als 'er ging geen
 * spraakbericht' laten lezen zou precies het verwijt opleveren dat we niet
 * mogen maken.
 */
export async function haalWaRegels(db, vanIso, totIso) {
  try {
    const { data, error } = await db
      .from('opvolging_wa_berichten')
      .select('nummer, richting, media_type, tijdstip')
      .gte('tijdstip', vanIso)
      .lt('tijdstip', totIso)
      .order('tijdstip', { ascending: true })
      .limit(5000);
    if (error) throw new Error(error.message);
    return { regels: data || [], fout: null };
  } catch (e) {
    console.warn('[opvolging-call-wa] regels lezen:', e?.message || e);
    return { regels: [], fout: e?.message || String(e) };
  }
}
