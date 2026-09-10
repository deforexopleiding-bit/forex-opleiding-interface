// api/cron-opvolging-gezondheid.js
//
// DE DAGELIJKSE GEZONDHEIDSCONTROLE VAN DE OPVOLGMODULE.
//
// Draait om 05:00 UTC — 07:00 Amsterdamse tijd in de zomer, 06:00 in de winter,
// dus altijd vóór Dave begint. Een kapotte dag valt op voordat hij ermee werkt.
//
// WAAROM DIT BESTAAT. Deze week stonden zes keer alle tests groen terwijl
// productie stuk was, en elke keer was de TEST het probleem. Nog meer
// unit-tests lost dat niet op. Dit kijkt naar de ECHTE uitkomst op de ECHTE
// data en vraagt zich af of die logisch kan zijn.
//
// TEGEN PRODUCTIE, NIET TEGEN EEN TESTOMGEVING. Het gaat juist om wat daar
// gebeurt. supabaseAdmin wijst naar de productiedatabank; er wordt uitsluitend
// gelezen.
//
// WAAROM HET RAPPORT NIET VIA HTTP WORDT OPGEHAALD. Een self-call binnen
// dezelfde Vercel-deployment is in deze repo een gedocumenteerd anti-pattern
// (zie de kop van api/_lib/joost-suggest-core.js): dat faalde structureel met
// `TypeError: fetch failed`. Deze cron roept daarom bouwRapport() rechtstreeks
// aan — dezelfde functie die het endpoint draait, op dezelfde data. Dat is
// strenger dan een HTTP-call: geen nabootsing, hetzelfde rekenwerk.
//
// De printweergave wordt WEL over HTTP opgehaald, want daar is de vraag juist
// wat de server uitlevert. Zie controle 4.

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import { bouwRapport } from './opvolging-rapport.js';
import { sendEmailViaSmtp } from './_lib/send-email-core.js';
import { brugConfig, brugFetch } from './_lib/whatsapp-brug-client.js';
import {
  controleerInstroom, controleerOptelling, controleerDubbels,
  beoordeelPrintweergave, controleerBrug, controleerDagritme,
  bouwMail, OK, FOUT, NIET_GEMETEN,
} from './_lib/opvolging-gezondheid.js';

const ZONE = 'Europe/Amsterdam';
const MAIL_VAN = 'leads@deforexopleiding.nl';

const dagInZone = (ms) => new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(ms));

const dagPlus = (dag, n) => {
  const d = new Date(dag + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const vandaag = dagInZone(Date.now());
  const uitkomsten = [];

  // ── 1 · Instroom ─────────────────────────────────────────────────────────
  try {
    const { data: taken, error } = await supabaseAdmin
      .from('opvolging_taken')
      .select('id, naam, due, created_at, opvolging_pogingen(id)')
      .eq('status', 'open').eq('bron', 'event').eq('reden', 'aanmelding');
    if (error) throw error;
    const zonderPoging = (taken || [])
      .filter((t) => !(t.opvolging_pogingen || []).length)
      .map((t) => ({ naam: t.naam, due: t.due, aangemaakt_op: String(t.created_at || '').slice(0, 10) }));
    uitkomsten.push(controleerInstroom({ taken: zonderPoging, vandaag, dagPlus }));
  } catch (e) {
    // Een leesfout van de databank is een storing, geen blinde vlek.
    uitkomsten.push({ naam: 'instroom', staat: FOUT, getallen: { fout: kort(e) },
      uitleg: 'De takenlijst was niet te lezen: ' + kort(e) });
  }

  // ── 2 en 3 · Het rapport van vandaag ─────────────────────────────────────
  let rapport = null;
  try {
    const vanMs = Date.parse(vandaag + 'T00:00:00Z');
    rapport = await bouwRapport({
      supabase: supabaseAdmin, van: vandaag, tot: vandaag, dagen: [vandaag], vandaag,
      vanIso: new Date(vanMs - 2 * 3600 * 1000).toISOString(),
      totIso: new Date(vanMs + 22 * 3600 * 1000).toISOString(),
    });
  } catch (e) {
    // Een exception uit de rapportmotor is juist DE storing die deze bewaking
    // hoort te zien. Die als 'niet gemeten' boeken zou hem onzichtbaar maken.
    const reden = { staat: FOUT, getallen: { fout: kort(e) },
      uitleg: 'Het rapport kon niet gebouwd worden: ' + kort(e) };
    uitkomsten.push({ naam: 'optelling', ...reden }, { naam: 'dubbels', ...reden });
  }
  if (rapport) {
    uitkomsten.push(controleerOptelling({ rapport }));
    uitkomsten.push(controleerDubbels({ rapport }));
  }

  // ── 4 · De printweergave, zoals de server hem uitlevert ──────────────────
  uitkomsten.push(await meetPrintweergave(vandaag));

  // ── 5 · De WhatsApp-brug ─────────────────────────────────────────────────
  uitkomsten.push(await meetBrug());

  // ── 6 · Het dagritme ─────────────────────────────────────────────────────
  // Na de nachtelijke doorrol hoort geen enkele open taak nog een due van vóór
  // vandaag te hebben. Staat die er wel, dan ziet Dave die kaart niet meer.
  uitkomsten.push(await meetDagritme(vandaag));

  // ── De mail ──────────────────────────────────────────────────────────────
  const { subject, text } = bouwMail({ uitkomsten, dag: vandaag });
  const ontvanger = process.env.OPVOLGING_GEZONDHEID_MAIL_TO || '';
  let mail;
  if (!ontvanger) {
    // Luid, niet stil: een bewaker zonder ontvanger bewaakt niets.
    console.error('[opvolging-gezondheid] OPVOLGING_GEZONDHEID_MAIL_TO ontbreekt — er is niets verstuurd');
    mail = { ok: false, reden: 'OPVOLGING_GEZONDHEID_MAIL_TO ontbreekt' };
  } else {
    const r = await sendEmailViaSmtp({ fromMailbox: MAIL_VAN, to: ontvanger, subject, text });
    mail = r?.ok ? { ok: true, to: ontvanger } : { ok: false, reden: r?.reason || 'onbekend' };
    if (!r?.ok) console.error('[opvolging-gezondheid] mail faalde:', r?.reason);
  }

  const problemen = uitkomsten.filter((u) => u.staat === FOUT).length;
  const ongemeten = uitkomsten.filter((u) => u.staat === NIET_GEMETEN).length;
  // De logregel noemt de controles BIJ NAAM. '0 fout, 2 niet gemeten' dwong op
  // 7 september tot naslaan welke twee dat waren; dat is precies de stilte die
  // deze bewaking hoort weg te nemen.
  console.log('[opvolging-gezondheid] ' + vandaag + ' — ' + samenvatting(uitkomsten));

  return res.status(200).json({ ok: true, dag: vandaag, problemen, ongemeten, uitkomsten, mail, subject });
}

const kort = (e) => String(e?.message || e).slice(0, 200);

/**
 * De open taken, alleen hun due. Een leesfout is hier GEEN nul: dan is er
 * niets gemeten, en 'niet gemeten' telt in de mail even zwaar als 'fout'.
 */
async function meetDagritme(vandaag) {
  try {
    const { data, error } = await supabaseAdmin
      .from('opvolging_taken')
      .select('due')
      .eq('status', 'open')
      .limit(5000);
    if (error) throw new Error(error.message);
    return controleerDagritme({ taken: data || [], vandaag, leesfout: null });
  } catch (e) {
    return controleerDagritme({ taken: [], vandaag, leesfout: kort(e) });
  }
}

/** Eén regel die per staat de namen noemt, met de reden bij wat niet klopt. */
export function samenvatting(uitkomsten) {
  const groep = (staat, metReden) => uitkomsten
    .filter((u) => u.staat === staat)
    .map((u) => u.naam + (metReden ? ` (${String(u.uitleg || '').slice(0, 80)})` : ''))
    .join(', ');
  const delen = [];
  const f = groep(FOUT, true);         if (f) delen.push('FOUT: ' + f);
  const n = groep(NIET_GEMETEN, true); if (n) delen.push('niet gemeten: ' + n);
  const o = groep(OK, false);          if (o) delen.push('ok: ' + o);
  return delen.join(' | ') || 'geen enkele controle gedraaid';
}

/**
 * De printweergave ophalen ZOALS DE SERVER HEM UITLEVERT en zijn script draaien.
 *
 * Dit is het enige onderdeel dat wél over HTTP gaat, en met reden: de vraag is
 * hier juist wat er uitgeleverd wordt. Op 7 september stond een reparatie op
 * main terwijl de server de oude pagina nog serveerde — een controle die het
 * bestand van schijf leest had dat niet gezien.
 *
 * Het script draait in een vm met een minimale nagebootste browser. De fetch
 * naar het rapport-endpoint wordt daarbij NIET echt gedaan: we geven een leeg
 * maar geldig antwoord terug. De vraag is of de pagina tekent, niet of het
 * rapport klopt — dat meten controle 2 en 3 al.
 */
async function meetPrintweergave(vandaag) {
  const basis = process.env.PUBLIEKE_BASIS_URL || process.env.VERCEL_URL
    ? (process.env.PUBLIEKE_BASIS_URL || 'https://' + process.env.VERCEL_URL) : null;
  if (!basis) {
    return beoordeelPrintweergave({
      bereikbaar: false, configFout: true,
      fout: 'geen basis-URL (PUBLIEKE_BASIS_URL of VERCEL_URL)',
    });
  }
  let html;
  try {
    const resp = await fetch(basis + '/modules/klanten-v2/rapport-print.html', { redirect: 'follow' });
    if (!resp.ok) return beoordeelPrintweergave({ bereikbaar: false, fout: 'HTTP ' + resp.status });
    html = await resp.text();
  } catch (e) {
    return beoordeelPrintweergave({ bereikbaar: false, fout: kort(e) });
  }

  const verwacht = (html.match(/OPMAAK_VERSIE\s*=\s*'([^']+)'/) || [])[1] || null;
  try {
    const vm = await import('node:vm');
    const el = { innerHTML: '' };
    let fout = null;
    const window = {
      AuthShared: { requireAuth: async () => ({ id: 'cron' }), getAccessToken: async () => 'x' },
      print() {}, location: { search: `?van=${vandaag}&tot=${vandaag}` },
    };
    window.window = window;
    window._authSharedReady = Promise.resolve();
    const ctx = vm.createContext({
      window,
      document: { getElementById: (id) => (id === 'blad' ? el : null) },
      location: window.location, URLSearchParams,
      fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(LEEG_RAPPORT(vandaag)) }),
      requestAnimationFrame: (fn) => { fn(); return 1; },
      console: { error: (...a) => { fout = a.join(' '); }, warn() {}, log() {}, debug() {} },
      Date, Math, Number, String, JSON, Intl, Set, Map, Array, Object, Promise, RegExp, Error,
      encodeURIComponent, isNaN, parseInt, parseFloat, setTimeout,
    });
    const blokken = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    if (!blokken.length) return beoordeelPrintweergave({ bereikbaar: false, fout: 'geen inline script gevonden' });
    vm.runInContext(blokken[blokken.length - 1][1], ctx, { filename: 'rapport-print.html' });
    for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));

    const versie = (el.innerHTML.match(/\brp-\d+\b/) || [])[0] || null;
    return beoordeelPrintweergave({
      bereikbaar: true, fout, html: el.innerHTML, versie, verwachteVersie: verwacht,
    });
  } catch (e) {
    return beoordeelPrintweergave({ bereikbaar: false, fout: kort(e) });
  }
}

/** Een minimaal maar volledig geldig rapport-antwoord voor controle 4. */
const LEEG_RAPPORT = (dag) => ({
  periode: { van: dag, tot: dag, dagen: 1, vandaag: dag, bevat_verleden: false, bevat_vandaag: true },
  // DEZE VORM MOET MEEBEWEGEN MET HET ECHTE RAPPORT. Hij is wat de controle
  // gebruikt als ze niets kan lezen; klopt hij niet, dan liegt de bewaking
  // juist op het moment dat er iets stuk is. Hij stond nog op gesprek_min_sec
  // 10 en een te_kort-emmer, allebei vervallen op 8 september.
  drempels: { spraak_voor_uur: 9, nabel_van_uur: 12, nabel_tot_uur: 13,
              archief_min_dagen: 3, archief_min_wa: 1,
              gesprek_bron: 'resultaat', gesprek_min_sec: null,
              werkuur_van: 9, werkuur_tot: 21,
              gat_drempel_min: 120, bezetting_drempel: 0.6 },
  aandacht: [], blinde_vlekken: [],
  dekking: { openstaand_bekend: true, openstaand: [], onbehandeld: [], behandeld: [] },
  // `niet_gemeten` en `nabel_niet_gemeten` kwamen erbij toen zoomleads zonder
  // opvolgkaart beoordeeld werden (leegTel in opvolging-rapport.js). Ontbreken
  // ze hier, dan tekent de printweergave in deze proef een ander rapport dan in
  // het echt — en dat is precies wat deze proef moet uitsluiten.
  vensters: { spraak: { totaal: 0, op_tijd: 0, te_laat: 0, niet_gedaan: 0, niet_nodig: 0, niet_gemeten: 0 },
              nabel: { totaal: 0, op_tijd: 0, te_laat: 0, niet_gedaan: 0, niet_nodig: 0, niet_gemeten: 0 },
              nabel_niet_gemeten: 0,
              rijen: [], zonder_taak: [] },
  zoomcalls: [], archief: [],
  volume: { bel: { uit: 0, seconden: 0, gesproken: 0, niet_opgenomen: 0,
                   onbekend_resultaat: 0, zonder_duur: 0, via_ander: 0 },
            wa: { uit: 0, in: 0 }, spraak: { uit: 0, in: 0 }, rijen: [] },
  // De blokken die er op 7 en 8 september bij zijn gekomen. Ontbreken ze hier,
  // dan tekent de printweergave in deze proef iets anders dan in het echt.
  werkritme: [{ dag, per_uur: [], totaal: 0, binnen_werkuren: 0, buiten_werkuren: 0,
                actieve_uren: 0, werkuren: 12, langste_gat: null, bevindingen: [] }],
  afgehandeld: [{ dag, afgesloten: [], doorgeschoven: [], aangeraakt: [],
                  aantallen: { afgesloten: 0, doorgeschoven: 0, aangeraakt: 0 } }],
  tijdlijn: [{ dag, svg: '<svg viewBox="0 0 1000 300" width="100%"></svg>',
               verruimd: null, gat: null, venster: { van: '09:00', tot: '21:00' },
               aantallen: { bel: 0, whatsapp: 0, zoomcalls: 0 }, drukste_kwartier: 1 }],
});

/**
 * De brug draait op een eigen VPS; alleen /status wordt gelezen.
 *
 * VIA DE BESTAANDE CLIENT, NIET VIA EEN EIGEN KOPIE. De eerste versie hiervan
 * las WHATSAPP_BRUG_TOKEN uit (een naam die nergens anders in deze repo
 * voorkomt) en stuurde 'Authorization: Bearer'. De brug leest
 * WHATSAPP_BRUG_SECRET en de header 'X-Brug-Secret'. Gevolg: een 401, en die
 * werd geboekt als 'niet gemeten'. Met brugFetch() is er nog maar één plek
 * waar die namen staan.
 *
 * De fetcher is injecteerbaar zodat een test dit pad echt kan draaien.
 */
export async function meetBrug(haal = brugFetch) {
  const cfg = brugConfig();
  if (!cfg.ok) return controleerBrug({ status: null, fout: cfg.melding, configFout: true });
  try {
    return controleerBrug({ status: await haal('/status') });
  } catch (e) {
    // ONBEREIKBAAR en BRUG_FOUT zijn STORINGEN. Alleen GEEN_CONFIG is een
    // ontbrekende instelling. Die twee door elkaar halen laat een echte
    // storing verdwijnen in de bak voor 'nog niet ingesteld'.
    return controleerBrug({
      status: null,
      fout: kort(e) + (e?.status ? ` (HTTP ${e.status})` : ''),
      configFout: e?.code === 'GEEN_CONFIG',
    });
  }
}
