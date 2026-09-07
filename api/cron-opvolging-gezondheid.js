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
import {
  controleerInstroom, controleerOptelling, controleerDubbels,
  beoordeelPrintweergave, controleerBrug, bouwMail, FOUT, NIET_GEMETEN,
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
    uitkomsten.push({ naam: 'instroom', staat: NIET_GEMETEN, getallen: { fout: kort(e) },
      uitleg: 'De takenlijst was niet te lezen.' });
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
    const reden = { staat: NIET_GEMETEN, getallen: { fout: kort(e) }, uitleg: 'Het rapport kon niet gebouwd worden.' };
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
  console.log(`[opvolging-gezondheid] ${vandaag} — ${problemen} fout, ${ongemeten} niet gemeten`);

  return res.status(200).json({ ok: true, dag: vandaag, problemen, ongemeten, uitkomsten, mail, subject });
}

const kort = (e) => String(e?.message || e).slice(0, 200);

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
    return beoordeelPrintweergave({ bereikbaar: false, fout: 'geen basis-URL (PUBLIEKE_BASIS_URL of VERCEL_URL)' });
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
  drempels: { spraak_voor_uur: 9, nabel_van_uur: 12, nabel_tot_uur: 13,
              archief_min_dagen: 3, archief_min_wa: 1, gesprek_min_sec: 10 },
  aandacht: [], blinde_vlekken: [],
  dekking: { openstaand_bekend: true, openstaand: [], onbehandeld: [], behandeld: [] },
  vensters: { spraak: { totaal: 0, op_tijd: 0, te_laat: 0, niet_gedaan: 0, niet_nodig: 0 },
              nabel: { totaal: 0, op_tijd: 0, te_laat: 0, niet_gedaan: 0, niet_nodig: 0 },
              rijen: [], zonder_taak: [] },
  zoomcalls: [], archief: [],
  volume: { bel: { uit: 0, seconden: 0, niet_opgenomen: 0, zonder_duur: 0, gesproken: 0, te_kort: 0 },
            wa: { uit: 0, in: 0 }, spraak: { uit: 0, in: 0 }, rijen: [] },
});

/** De brug draait op een eigen VPS; alleen /status wordt gelezen. */
async function meetBrug() {
  const basis = process.env.WHATSAPP_BRUG_URL || '';
  if (!basis) return controleerBrug({ status: null, fout: 'WHATSAPP_BRUG_URL ontbreekt' });
  try {
    const resp = await fetch(basis.replace(/\/$/, '') + '/status', {
      headers: process.env.WHATSAPP_BRUG_TOKEN
        ? { Authorization: 'Bearer ' + process.env.WHATSAPP_BRUG_TOKEN } : {},
    });
    if (!resp.ok) return controleerBrug({ status: null, fout: 'HTTP ' + resp.status });
    return controleerBrug({ status: await resp.json() });
  } catch (e) {
    return controleerBrug({ status: null, fout: kort(e) });
  }
}
