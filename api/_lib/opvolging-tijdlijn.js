// api/_lib/opvolging-tijdlijn.js
//
// DE DAG ALS TIJDLIJN — vier lanen op één tijdas, plus een kwartier-heatmap.
//
// Waar de balk-per-uur laat zien HOEVEEL er per uur gebeurde, laat dit zien
// WANNEER precies. Op 7 september maakte dat drie werkblokken zichtbaar
// (10:11-11:27, 16:55-17:20, 19:23-20:35, samen 2 uur 53 van de twaalf), een
// stilte van 5 uur 28 in het midden, en de helft van alle belpogingen na 19:00
// waarvan twaalf tussen 20:05 en 20:35.
//
// ── DRIE DINGEN DIE HIER STIL FOUT GAAN, EN HOE ZE HIER GEDICHT ZIJN ───────
//
// 1. VASTE SCHAAL, NIET DE LANGSTE CALL VAN DIE DAG. Schalen op het dagmaximum
//    laat een dag met een langste gesprek van 30 seconden er precies zo uitzien
//    als een dag met 90. In een rapport dat je dag na dag naast elkaar legt is
//    dat waardeloos. Referentie is dus vast: 120 seconden. Alles daarboven
//    wordt afgekapt met een driehoekje dat dat zegt.
//
// 2. NIETS VALT STIL VAN DE AS. Een belpoging om 22:10 hoort er gewoon op te
//    staan. Valt er iets buiten 09:00-21:00, dan groeit de as mee naar het
//    vroegste en laatste tijdstip van die dag, en de tijdlijn zegt erbij dat
//    het venster verruimd is. Liever een bredere as dan een verzwegen poging.
//
// 3. BOTSINGEN. Er stonden vandaag zes calls in zeven minuten; die vallen op
//    dezelfde pixel. Staven die dichter dan 7 eenheden bij elkaar komen worden
//    uit elkaar geschoven, en botst de groep tegen de rechterrand dan schuift
//    hij als geheel terug. Anders verdwijnt er werk uit beeld.
//
// ── EN ÉÉN OORDEEL, NIET TWEE ─────────────────────────────────────────────
// Of een call een gesprek was komt uit classificeerResultaat() — dezelfde
// functie die de tellingen erboven gebruikt. Een tweede oordeel hier zou de
// tijdlijn morgen iets anders laten vertellen dan de getallen erboven, en dat
// is precies de foutklasse die deze week zes keer toesloeg.
//
// ── STATISCHE SVG ─────────────────────────────────────────────────────────
// Dit levert opmaak, geen tekenopdracht. Zou de grafiek na het laden met
// JavaScript getekend worden, dan is de printweergave leeg of half — en dat is
// precies het soort fout dat pas opvalt als er iemand een PDF opslaat.

import { classificeerResultaat, GESPROKEN, NIET_OPGENOMEN, WA_SOORTEN } from './opvolging-poging-telling.js';

// ── Maten ─────────────────────────────────────────────────────────────────
export const BREEDTE = 1000;
export const HOOGTE  = 300;
export const MARGE   = 8;
export const AS_BREED = BREEDTE - 2 * MARGE;          // 984

export const VENSTER_VAN_UUR = 9;
export const VENSTER_TOT_UUR = 21;
const STANDAARD_MINUTEN = (VENSTER_TOT_UUR - VENSTER_VAN_UUR) * 60;   // 720

const Y_ZOOM      = 22;   const H_ZOOM = 18;
const Y_BEL       = 150;  const MAX_STAAF = 82;  const H_MIS = 11;
const Y_WA        = 212;  const WA_B = 6; const WA_H = 8;
const Y_KWARTIER  = 250;  const H_KWARTIER = 20;
const Y_AS        = 272;  const Y_UUR = 286;

/** Vaste referentie voor de staafhoogte. Zie punt 1 hierboven. */
export const REFERENTIE_SEC = 120;
const MIN_AFSTAND = 7;
/** De blokjes zijn 6 breed; 7,5 houdt er een haarlijn tussen. */
export const WA_MIN_AFSTAND = 7.5;

// ── Kleuren ───────────────────────────────────────────────────────────────
// Op één plek en met een naam, niet als losse hexcodes door de tekencode heen.
// De drie zachte varianten die niet waren vastgelegd (blauw, amber, violet)
// staan hier expliciet zodat ze te herzien zijn zonder de tekencode te lezen.
export const KLEUR = {
  gesprek       : '#07835A', gesprek_zacht : '#E4F5EE',
  gemist        : '#C22B3E',
  wa_uit        : '#1B5FBF', wa_uit_zacht  : '#E7EEFA',
  wa_in         : '#C2700A', wa_in_zacht   : '#FBF0DE',
  zoom          : '#6D3FD4', zoom_zacht    : '#EDE7FB',
  tekst         : '#111721', tekst_zacht   : '#586374',
  raster        : '#E6E9EF',
};

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Minuten sinds middernacht, in Amsterdamse tijd. */
export function minutenInZone(ts) {
  const ms = ts == null ? NaN : new Date(ts).getTime();
  if (!Number.isFinite(ms)) return null;
  const t = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  }).format(new Date(ms));
  const [u, m] = t.split(':').map(Number);
  return u * 60 + m;
}

const klok = (min) => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');

/** De hoogte van een staaf. Vaste schaal, wortel zodat korte gesprekken zichtbaar blijven. */
export function staafHoogte(sec) {
  const d = Math.max(0, Number(sec) || 0);
  const geklemd = Math.min(d, REFERENTIE_SEC);
  return { h: 9 + 73 * Math.sqrt(geklemd / REFERENTIE_SEC), afgekapt: d > REFERENTIE_SEC };
}

/**
 * Staven uit elkaar schuiven die op dezelfde pixel vallen.
 *
 * Zes calls in zeven minuten stonden vandaag op één plek. Zonder dit verdwijnt
 * er werk uit beeld zonder dat iemand het merkt.
 */
export function spreid(xs, minAfstand = MIN_AFSTAND, rechterrand = BREEDTE - MARGE) {
  const uit = xs.slice().sort((a, b) => a - b);
  for (let i = 1; i < uit.length; i++) {
    if (uit[i] - uit[i - 1] < minAfstand) uit[i] = uit[i - 1] + minAfstand;
  }
  // Raakt de groep de rechterrand, dan schuift hij als geheel terug.
  const over = uit.length ? uit[uit.length - 1] - rechterrand : 0;
  if (over > 0) for (let i = 0; i < uit.length; i++) uit[i] -= over;
  return uit;
}

/**
 * @param {object} p
 * @param {object} [p.gat]  het langste gat, ZOALS bouwWerkritme het al berekende
 *   ({van:'11:27', tot:'16:55', minuten}). Bewust doorgegeven en niet hier
 *   opnieuw uitgerekend: twee berekeningen van dezelfde stilte zouden vroeg of
 *   laat twee verschillende tijdstippen tonen, en dan spreekt het beeld de zin
 *   eronder tegen.
 * @param {number} [p.gatDrempelMin]  onder deze grens tekenen we geen kader.
 */
export function bouwTijdlijn({ pogingen, afspraken, dag, gat = null, gatDrempelMin = 120 }) {
  const bel = [];
  const wa  = [];
  for (const p of pogingen || []) {
    const min = minutenInZone(p && p.tijdstip);
    if (min === null) continue;
    if (p.soort === 'call') {
      if (p.richting === 'in') continue;
      const k = classificeerResultaat(p.resultaat);
      bel.push({ min, klasse: k, duur: k === GESPROKEN ? p.duur_sec : null, resultaat: p.resultaat || null });
    } else if (WA_SOORTEN.has(p.soort)) {
      wa.push({ min, uit: p.richting !== 'in', soort: p.soort });
    }
  }
  const zoom = [];
  for (const a of afspraken || []) {
    const min = minutenInZone(a && a.scheduled_at);
    if (min === null) continue;
    const status = String(a.status || '');
    zoom.push({
      min, naam: a.lead_name || null,
      duur: Number.isFinite(Number(a.duration_minutes)) && Number(a.duration_minutes) > 0 ? Number(a.duration_minutes) : 30,
      vervallen: status === 'cancelled' || status === 'verplaatst',
    });
  }

  // ── Het venster, en of het verruimd moest worden ─────────────────────────
  const alle = [...bel.map((x) => x.min), ...wa.map((x) => x.min),
                ...zoom.flatMap((z) => [z.min, z.min + z.duur])];
  let vanMin = VENSTER_VAN_UUR * 60;
  let totMin = VENSTER_TOT_UUR * 60;
  let verruimd = null;
  if (alle.length) {
    const vroegste = Math.min(...alle);
    const laatste  = Math.max(...alle);
    if (vroegste < vanMin || laatste > totMin) {
      const nieuwVan = Math.min(vanMin, Math.floor(vroegste / 60) * 60);
      const nieuwTot = Math.max(totMin, Math.ceil(laatste / 60) * 60);
      verruimd = {
        van: klok(nieuwVan), tot: klok(nieuwTot),
        reden: 'Er valt werk buiten ' + klok(vanMin) + '-' + klok(totMin) +
               '; de as is verruimd zodat er niets van af valt.',
      };
      vanMin = nieuwVan; totMin = nieuwTot;
    }
  }
  const span = Math.max(1, totMin - vanMin);
  const x = (min) => MARGE + ((min - vanMin) / span) * AS_BREED;

  // ── Tekenen ──────────────────────────────────────────────────────────────
  const d = [];
  // Uurraster.
  for (let m = Math.ceil(vanMin / 60) * 60; m <= totMin; m += 60) {
    d.push(`<line x1="${x(m).toFixed(1)}" y1="14" x2="${x(m).toFixed(1)}" y2="${Y_AS}" stroke="${KLEUR.raster}" stroke-width="1"/>`);
    d.push(`<text x="${x(m).toFixed(1)}" y="${Y_UUR}" font-size="10" text-anchor="middle" fill="${KLEUR.tekst_zacht}">${String(Math.floor(m / 60)).padStart(2, '0')}</text>`);
  }

  // Zoombandjes.
  for (const z of zoom) {
    const x1 = x(z.min); const b = Math.max(4, x(z.min + z.duur) - x1);
    d.push(`<rect x="${x1.toFixed(1)}" y="${Y_ZOOM}" width="${b.toFixed(1)}" height="${H_ZOOM}" rx="3"` +
      ` fill="${z.vervallen ? KLEUR.zoom_zacht : KLEUR.zoom_zacht}" stroke="${KLEUR.zoom}" stroke-width="1"` +
      (z.vervallen ? ' stroke-dasharray="3 2"' : '') + `><title>${esc(z.naam || 'zoomcall')} ${klok(z.min)}${z.vervallen ? ' (vervallen)' : ''}</title></rect>`);
    if (z.vervallen) {
      const my = Y_ZOOM + H_ZOOM / 2;
      d.push(`<line x1="${x1.toFixed(1)}" y1="${my}" x2="${(x1 + b).toFixed(1)}" y2="${my}" stroke="${KLEUR.zoom}" stroke-width="1"/>`);
    }
    // WIE EN HOE LAAT, LEESBAAR. Vier paarse pillen zonder label zeggen niets,
    // en dat er twee geannuleerd zijn was alleen aan een stippellijn te zien.
    // Gecentreerd boven het bandje en binnen de as geklemd, zodat een afspraak
    // aan de rand niet half buiten beeld valt.
    const label = (z.naam ? z.naam + ' · ' : '') + klok(z.min) + (z.vervallen ? ' · geannuleerd' : '');
    const breedte = label.length * 4.6;
    const mx = Math.min(BREEDTE - MARGE - breedte / 2, Math.max(MARGE + breedte / 2, x1 + b / 2));
    d.push(`<text x="${mx.toFixed(1)}" y="${Y_ZOOM - 4}" font-size="9" text-anchor="middle"` +
      ` fill="${z.vervallen ? KLEUR.tekst_zacht : KLEUR.tekst}">${esc(label)}</text>`);
  }

  // Hulplijnen op 30 en 60 seconden — altijd, ook op een dag zonder lange
  // gesprekken. Zonder die lijnen is de schaal niet te lezen.
  for (const sec of [30, 60]) {
    const y = Y_BEL - staafHoogte(sec).h;
    d.push(`<line x1="${MARGE}" y1="${y.toFixed(1)}" x2="${BREEDTE - MARGE}" y2="${y.toFixed(1)}" stroke="${KLEUR.raster}" stroke-width="1" stroke-dasharray="2 3"/>`);
    d.push(`<text x="${MARGE + 2}" y="${(y - 2).toFixed(1)}" font-size="8" fill="${KLEUR.tekst_zacht}">${sec}s</text>`);
  }

  // Belpogingen. Eerst de x-posities spreiden, in tijdvolgorde.
  const belGesorteerd = bel.slice().sort((a, b) => a.min - b.min);
  const xs = spreid(belGesorteerd.map((b) => x(b.min)));
  belGesorteerd.forEach((b, i) => {
    const bx = xs[i];
    if (b.klasse === GESPROKEN) {
      const bekend = b.duur !== null && b.duur !== undefined && Number.isFinite(Number(b.duur));
      const { h, afgekapt } = staafHoogte(bekend ? b.duur : 0);
      // Gesproken zonder geregistreerde lengte: gestippeld met een vraagteken.
      // NOOIT als nul — dat zou een gesprek van nul seconden beweren.
      const hh = bekend ? h : 34;
      d.push(`<rect x="${(bx - 2.5).toFixed(1)}" y="${(Y_BEL - hh).toFixed(1)}" width="5" height="${hh.toFixed(1)}" rx="1.5"` +
        (bekend ? ` fill="${KLEUR.gesprek}"` : ` fill="${KLEUR.gesprek_zacht}" stroke="${KLEUR.gesprek}" stroke-width="1" stroke-dasharray="2 2"`) +
        `><title>${klok(b.min)} — ${bekend ? b.duur + ' s' : 'gesproken, lengte niet geregistreerd'}</title></rect>`);
      if (!bekend) {
        d.push(`<text x="${bx.toFixed(1)}" y="${(Y_BEL - hh - 3).toFixed(1)}" font-size="9" text-anchor="middle" fill="${KLEUR.gesprek}">?</text>`);
      } else if (afgekapt) {
        const ty = Y_BEL - hh;
        d.push(`<polygon points="${(bx - 3.5).toFixed(1)},${(ty - 2).toFixed(1)} ${(bx + 3.5).toFixed(1)},${(ty - 2).toFixed(1)} ${bx.toFixed(1)},${(ty - 7).toFixed(1)}" fill="${KLEUR.gesprek}"><title>afgekapt: ${b.duur} s</title></polygon>`);
      }
    } else if (b.klasse === NIET_OPGENOMEN) {
      d.push(`<rect x="${(bx - 2).toFixed(1)}" y="${Y_BEL}" width="4" height="${H_MIS}" rx="1" fill="none" stroke="${KLEUR.gemist}" stroke-width="1"><title>${klok(b.min)} — niet opgenomen</title></rect>`);
    } else {
      d.push(`<circle cx="${bx.toFixed(1)}" cy="${Y_BEL + 5}" r="2.5" fill="none" stroke="${KLEUR.tekst_zacht}" stroke-width="1"><title>${klok(b.min)} — resultaat onbekend</title></circle>`);
    }
  });
  d.push(`<line x1="${MARGE}" y1="${Y_BEL}" x2="${BREEDTE - MARGE}" y2="${Y_BEL}" stroke="${KLEUR.tekst_zacht}" stroke-width="1"/>`);

  // WhatsApp — MET SPREIDING, PER LAAG APART.
  //
  // Dit ontbrak, en het was precies de fout die dit ontwerp maakt: de staven
  // werden wél gespreid, de blokjes niet. Gemeten op productie stonden drie
  // uitgaande berichten op exact dezelfde x en vier antwoorden ook; van
  // negentien handelingen waren er zo'n zeven te zien. Alle rechthoeken zaten
  // in de SVG — ze lagen op elkaar, en dat is werk dat stil uit beeld valt.
  //
  // Uitgaand en inkomend gaan APART door spreid(): ze staan boven en onder de
  // lijn, dus een uitgaand bericht hoeft een antwoord op hetzelfde moment niet
  // opzij te duwen.
  for (const laag of [true, false]) {
    const rij = wa.filter((w) => w.uit === laag).sort((a, b) => a.min - b.min);
    const xs = spreid(rij.map((w) => x(w.min)), WA_MIN_AFSTAND);
    rij.forEach((w, i) => {
      const wx = xs[i];
      d.push(`<rect x="${(wx - WA_B / 2).toFixed(1)}" y="${w.uit ? Y_WA - WA_H - 1 : Y_WA + 1}" width="${WA_B}" height="${WA_H}" rx="1.5"` +
        ` fill="${w.uit ? KLEUR.wa_uit_zacht : KLEUR.wa_in_zacht}" stroke="${w.uit ? KLEUR.wa_uit : KLEUR.wa_in}" stroke-width="1">` +
        `<title>${klok(w.min)} — ${w.uit ? 'uitgaand' : 'antwoord van de lead'}</title></rect>`);
    });
  }
  d.push(`<line x1="${MARGE}" y1="${Y_WA}" x2="${BREEDTE - MARGE}" y2="${Y_WA}" stroke="${KLEUR.raster}" stroke-width="1"/>`);

  // Kwartierstrook.
  const kwartieren = [];
  for (let m = vanMin; m < totMin; m += 15) {
    const n = [...bel, ...wa].filter((e) => e.min >= m && e.min < m + 15).length;
    kwartieren.push({ min: m, aantal: n });
  }
  const drukste = Math.max(1, ...kwartieren.map((k) => k.aantal));
  for (const k of kwartieren) {
    const x1 = x(k.min); const b = Math.max(1, x(k.min + 15) - x1 - 0.5);
    const alfa = k.aantal ? 0.14 + 0.86 * (k.aantal / drukste) : 0;
    d.push(`<rect x="${x1.toFixed(1)}" y="${Y_KWARTIER}" width="${b.toFixed(1)}" height="${H_KWARTIER}"` +
      ` fill="rgba(27,95,191,${alfa.toFixed(3)})"><title>${klok(k.min)} — ${k.aantal} handeling${k.aantal === 1 ? '' : 'en'}</title></rect>`);
  }
  d.push(`<line x1="${MARGE}" y1="${Y_AS}" x2="${BREEDTE - MARGE}" y2="${Y_AS}" stroke="${KLEUR.tekst}" stroke-width="1"/>`);

  // HET LANGSTE GAT, IN HET BEELD ZELF. Het stond alleen als zin onder de
  // grafiek; dan moet je de tekst lezen om te weten waar de stilte zit.
  const naarMin = (t) => {
    const m = String(t || '').match(/^(\d{1,2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const gatVan = gat ? naarMin(gat.van) : null;
  const gatTot = gat ? naarMin(gat.tot) : null;
  const gatZichtbaar = gat && gatVan !== null && gatTot !== null
    && Number(gat.minuten) >= gatDrempelMin;
  if (gatZichtbaar) {
    const gx1 = x(gatVan); const gx2 = x(gatTot);
    d.unshift(`<rect class="gat" x="${gx1.toFixed(1)}" y="14" width="${(gx2 - gx1).toFixed(1)}" height="${Y_AS - 14}"` +
      ` fill="rgba(17,23,33,0.035)" stroke="${KLEUR.raster}" stroke-width="1" stroke-dasharray="4 3"/>`);
    d.push(`<text x="${((gx1 + gx2) / 2).toFixed(1)}" y="${Y_BEL - 92}" font-size="9" text-anchor="middle" fill="${KLEUR.tekst_zacht}">` +
      `${esc(gat.van)}–${esc(gat.tot)} stil</text>`);
  }

  const svg = `<svg viewBox="0 0 ${BREEDTE} ${HOOGTE}" width="100%" height="auto" role="img" ` +
    `aria-label="Tijdlijn van ${esc(dag)}" xmlns="http://www.w3.org/2000/svg">${d.join('')}</svg>`;

  return {
    dag, svg, verruimd, gat: gatZichtbaar ? gat : null,
    venster: { van: klok(vanMin), tot: klok(totMin) },
    aantallen: { bel: bel.length, whatsapp: wa.length, zoomcalls: zoom.length },
    drukste_kwartier: drukste,
  };
}
