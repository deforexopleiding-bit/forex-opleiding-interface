// api/iris-post.js
//
// De Post: de lijst met gesprekken, en één gesprek in detail.
//
//   GET ?actie=lijst    &filter=…&categorie=…&zoek=…&limiet=…&vanaf=…
//   GET ?actie=gesprek  &id=<uuid>
//
// Recht: iris.view.
//
// ── PAGINERING, EN WAAROM DIE ER METEEN IN ZIT ───────────────────────────────
// De bestaande gesprekkenlijst haalt duizend rijen op zonder paginering en
// doet dat elke zes seconden opnieuw. Bij 115 gesprekken is dat ongeveer 54 MB
// per uur per geopend tabblad (zie docs/iris/02-gesprekken-audit.md, 4.1). Dat
// werkt vandaag en het endpoint waarschuwt er zelf voor dat het een keer
// misgaat.
//
// Hier staat paginering er vanaf de eerste regel in, met een grens van
// vijftig. Niet omdat vijftig bijzonder is, maar omdat het achteraf inbouwen
// van paginering betekent dat je élke plek moet nalopen die aannam dat de
// lijst compleet was — en dat is precies waarom het in de bestaande module
// nooit gebeurd is.
//
// ── DE FILTERS ───────────────────────────────────────────────────────────────
// wacht_op_ons · wacht_op_klant · venster_bijna_dicht · niet_gekoppeld ·
// belofte_vandaag · spam · alles. Dat zijn de vragen die iemand 's ochtends
// stelt. "Alle open gesprekken" is er geen van.
//
// 'spam' is de tegenhanger van wat er uit wacht_op_ons weggehaald is: die
// gesprekken verdwijnen niet, ze staan alleen niet meer tussen het werk.
//
// 'venster_bijna_dicht' wordt na het ophalen berekend en niet in SQL. Reden:
// de grens verschuift elke minuut, dus een WHERE erop zou een index opleveren
// die nooit klopt. Over vijftig rijen is dat rekenwerk niets.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { haalInstellingen, GEEN_WERK, werkbakCategorieFilter } from './_lib/iris/instellingen.js';
import { vensterStand, magVersturen, BIJNA_DICHT_MINUTEN } from './_lib/iris/venster.js';
import { contactZoekFilter } from './_lib/iris/zoekfilter.js';
import { aandachtsregel } from './_lib/iris/aandacht.js';
import { leesOrdening, klokVenster, voegSamen, MAX_DRINGEND, ORDENINGEN } from './_lib/iris/ordening.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STANDAARD_LIMIET = 50;
const MAX_LIMIET = 200;
const MAX_BERICHTEN = 100;

export const FILTERS = Object.freeze([
  'wacht_op_ons',
  'wacht_op_klant',
  'venster_bijna_dicht',
  'niet_gekoppeld',
  'belofte_vandaag',
  'spam',
  'alles',
]);

/** Klem een getal binnen grenzen. */
function klem(v, standaard, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return standaard;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * Bouw de lijstrij die het scherm nodig heeft.
 *
 * Exporteerbaar en zuiver, zodat de vorm te testen is zonder databank. Dat is
 * niet alleen gemak: de aftelling van het venster is de reden dat dit hele
 * scherm er komt (gat G3), en die wil je kunnen nakijken.
 */
export function bouwLijstRij(gesprek, { contact, laatsteBericht, nu = new Date() } = {}) {
  // Het servicevenster van 24 uur is een regel van META over WHATSAPP. Voor
  // mail bestaat het niet: je mag een klant antwoorden wanneer je wilt.
  //
  // Toch stond er op een mailrij "venster open nog 23u34". Dat is niet alleen
  // onzin, het is schadelijke onzin: het suggereert een deadline die er niet is,
  // en een deadline die er niet is, laat je haasten met iets waar je juist rustig
  // over had moeten nadenken. Bij mail gaat het vaak over advocaten en
  // betalingsregelingen — precies waar haast het duurst is.
  //
  // Dus: null voor mail. Uitdrukkelijk null en geen object met open:false, want
  // "dicht" is ook een bewering over een venster dat niet bestaat.
  const venster = gesprek.kanaal === 'whatsapp'
    ? vensterStand(gesprek.laatste_inbound, nu)
    : null;
  return {
    id: gesprek.id,
    kanaal: gesprek.kanaal,
    categorie: gesprek.categorie || null,
    status: gesprek.status,
    toegewezen_aan: gesprek.toegewezen_aan || null,
    ongelezen: gesprek.ongelezen || 0,
    laatste_inbound: gesprek.laatste_inbound || null,
    laatste_outbound: gesprek.laatste_outbound || null,
    naam: contact?.weergavenaam || contact?.emails?.[0] || contact?.telefoons?.[0] || 'Onbekend',
    contact_id: contact?.id || null,
    customer_id: contact?.customer_id || null,
    koppelstatus: contact?.koppelstatus || 'onbekend',
    koppel_reden: contact?.koppel_reden || null,
    voorbeeld: laatsteBericht?.tekst_kort || null,
    samenvatting: laatsteBericht?.samenvatting || null,
    zekerheid: laatsteBericht?.zekerheid ?? null,
    venster: venster
      ? {
        open: venster.open,
        bijna_dicht: venster.bijna_dicht,
        tekst: venster.resterend_tekst,
        resterend_ms: venster.resterend_ms,
      }
      : null,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Alleen GET' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet aangemeld' });
  if (!(await requirePermission(req, 'iris.view'))) {
    return res.status(403).json({ error: 'Geen rechten (iris.view)' });
  }

  const q = req.query || {};
  const actie = String(q.actie || 'lijst').trim();

  try {
    if (actie === 'gesprek') return await geefGesprek(q, res);
    if (actie === 'aandacht') return await geefAandacht(res);
    if (actie === 'lijst') return await geefLijst(q, res);
    return res.status(400).json({ error: `onbekende actie: ${actie}` });
  } catch (e) {
    console.error('[iris-post]', actie, e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

// ── Wat er nú moet gebeuren ──────────────────────────────────────────────────
//
// Drie tellingen, drie head-queries. Geen rij wordt opgehaald: `head: true`
// met `count: 'exact'` vraagt de databank alleen om het getal. Voor een balk
// die op élke tab staat en bij elke poll ververst, is dat het verschil tussen
// een regel tekst en een halve megabyte.

async function geefAandacht(res) {
  const nu = new Date();
  const tellingen = { venster_bijna_dicht: 0, melding_hangt: 0, wacht_op_ons: 0 };

  // 1. Vensters die bijna dichtgaan. Alleen WhatsApp -- voor mail bestaat het
  //    venster niet (P-1). De ondergrens is nu minus 24 uur plus de marge:
  //    daarbinnen staat het venster nog open maar niet lang meer.
  const dicht = new Date(nu.getTime() - 24 * 3600 * 1000);
  const bijna = new Date(dicht.getTime() + BIJNA_DICHT_MINUTEN * 60 * 1000);
  const { count: cVenster, error: eVenster } = await supabaseAdmin
    .from('iris_gesprekken')
    .select('id', { count: 'exact', head: true })
    .eq('kanaal', 'whatsapp')
    .gt('laatste_inbound', dicht.toISOString())
    .lte('laatste_inbound', bijna.toISOString());
  if (eVenster) throw new Error('vensters tellen: ' + eVenster.message);
  tellingen.venster_bijna_dicht = Number(cVenster || 0);

  // 2. Meldingen die hangen. De tabel bestaat pas na de migratie van 28
  //    september; ontbreekt hij, dan is het getal nul en niet een storing.
  const { count: cHangt, error: eHangt } = await supabaseAdmin
    .from('iris_opvolgingen')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'verlopen');
  if (eHangt && !/does not exist/i.test(String(eHangt.message)) && eHangt.code !== '42P01') {
    throw new Error('opvolgingen tellen: ' + eHangt.message);
  }
  tellingen.melding_hangt = Number(cHangt || 0);

  // 3. Werk dat wacht. Dezelfde twee sloten als het lijstfilter: spam telt niet
  //    mee, want spam is geen werk (P-2).
  const { count: cWacht, error: eWacht } = await supabaseAdmin
    .from('iris_gesprekken')
    .select('id', { count: 'exact', head: true })
    .in('status', ['nieuw', 'wacht_op_ons'])
    .or(werkbakCategorieFilter());
  if (eWacht) throw new Error('werk tellen: ' + eWacht.message);
  tellingen.wacht_op_ons = Number(cWacht || 0);

  return res.status(200).json({ tellingen, regel: aandachtsregel(tellingen) });
}

// ── De lijst ─────────────────────────────────────────────────────────────────

async function geefLijst(q, res) {
  const filter = FILTERS.includes(String(q.filter || '')) ? String(q.filter) : 'wacht_op_ons';
  const categorie = String(q.categorie || '').trim() || null;
  const zoek = String(q.zoek || '').trim();
  const limiet = klem(q.limiet, STANDAARD_LIMIET, 1, MAX_LIMIET);
  const vanaf = klem(q.vanaf, 0, 0, 100000);
  const nu = new Date();
  // Zoeken heeft zijn eigen volgorde nodig -- wie zoekt, wil vinden, niet
  // gesorteerd worden op iets anders. Vandaar: geen klok-groep bij een zoekterm.
  const ordening = zoek ? 'nieuwste' : leesOrdening(q.ordening, filter);

  let vraag = supabaseAdmin
    .from('iris_gesprekken')
    .select('id, contact_id, kanaal, categorie, status, toegewezen_aan, laatste_inbound, laatste_outbound, ongelezen', { count: 'exact' })
    .order('laatste_inbound', { ascending: false, nullsFirst: false });

  if (filter === 'wacht_op_ons') {
    // Twee sloten op hetzelfde. cron-iris-werk zet spam sinds P-2 niet meer op
    // wacht_op_ons, maar de gesprekken die er VÓÓR die wijziging in zijn
    // beland staan er nog. Dit filter haalt ze er alsnog uit, zonder dat er
    // één rij in de databank aangeraakt hoeft te worden.
    //
    // Let op de or: zie werkbakCategorieFilter() voor waarom een kale
    // .not('categorie','in',...) de nog-niet-ingedeelde gesprekken zou wissen.
    vraag = vraag
      .in('status', ['nieuw', 'wacht_op_ons'])
      .or(werkbakCategorieFilter());
  } else if (filter === 'spam') {
    // Niet weg, wel weg uit het werk. Hier kijk je na of Iris het goed zag, en
    // één klik zet een vergissing terug (iris-indeling).
    vraag = vraag.in('categorie', [...GEEN_WERK]);
  } else if (filter === 'wacht_op_klant') vraag = vraag.eq('status', 'wacht_op_klant');
  else if (filter === 'niet_gekoppeld') vraag = vraag.is('contact_id', null);
  else if (filter === 'venster_bijna_dicht') {
    // Voorselectie in SQL op "inbound binnen de laatste 24 uur"; de precieze
    // grens van twee uur komt daarna. Zonder deze voorselectie zou de hele
    // tabel opgehaald moeten worden om er een handvol uit te vissen.
    //
    // En alleen WhatsApp. Dit filter bestond, maar gaf verkeerde uitkomsten:
    // mailgesprekken kwamen er ook in, want die kregen ook een venster
    // toegerekend. Een filter dat moet tonen waar de tijd dringt, duwde dan
    // een WhatsApp-gesprek dat écht bijna dicht was uit beeld ten gunste van
    // een mail waarvoor geen enkele klok loopt. Dat is erger dan een filter dat
    // niet bestaat.
    vraag = vraag
      .eq('kanaal', 'whatsapp')
      .gte('laatste_inbound', new Date(nu.getTime() - 24 * 3600 * 1000).toISOString());
  } else if (filter === 'belofte_vandaag') {
    const { data: beloftes } = await supabaseAdmin
      .from('iris_beloftes')
      .select('contact_id')
      .eq('status', 'actief')
      .lte('datum', nu.toISOString().slice(0, 10));
    const ids = [...new Set((beloftes || []).map((b) => b.contact_id).filter(Boolean))];
    if (!ids.length) {
      return res.status(200).json({ items: [], totaal: 0, filter, vanaf, limiet, filters: FILTERS });
    }
    vraag = vraag.in('contact_id', ids);
  }

  if (categorie) vraag = vraag.eq('categorie', categorie);

  // Zoeken gaat over de contactgegevens, niet over de gesprekstabel — daar
  // staat geen naam in. Eerst de contacten zoeken, dan de gesprekken daarvan.
  if (zoek) {
    // Het zoekwoord gaat door contactZoekFilter heen: een komma of een haakje
    // in de invoer zou anders de or-tekenreeks van PostgREST in tweeën hakken.
    // Zoeken op "Janssen, Jan" gaf zo een 400, en dat ziet er voor de
    // gebruiker uit als "zoeken is kapot".
    const filter = contactZoekFilter(zoek);
    if (!filter) {
      return res.status(200).json({ items: [], totaal: 0, filter: 'wacht_op_ons', vanaf, limiet, filters: FILTERS });
    }
    const { data: gevonden } = await supabaseAdmin
      .from('iris_contacten')
      .select('id')
      .or(filter)
      .limit(200);
    const ids = (gevonden || []).map((c) => c.id);
    if (!ids.length) {
      return res.status(200).json({ items: [], totaal: 0, filter, vanaf, limiet, filters: FILTERS });
    }
    vraag = vraag.in('contact_id', ids);
  }

  // ── DE KLOK-GROEP ──────────────────────────────────────────────────────────
  // WhatsApp-gesprekken waarvan het venster bijna dichtgaat, kortste tijd
  // eerst. Alleen bovenaan de EERSTE pagina: hem bij elk doorladen herhalen zou
  // betekenen dat je dezelfde gesprekken opnieuw ziet, en dan vertrouw je de
  // lijst niet meer.
  //
  // Een aparte opvraging en geen slimme ORDER BY, omdat "hoe dringend is dit"
  // een berekening is die elke minuut verschuift. PostgREST kan daar niet op
  // sorteren, en een kolom die het antwoord bewaart zou elke minuut verouderen.
  let dringendRijen = [];
  if (ordening === 'dringend' && vanaf === 0) {
    const klok = klokVenster(nu);
    const { data, error: eKlok } = await supabaseAdmin
      .from('iris_gesprekken')
      .select('id, contact_id, kanaal, categorie, status, toegewezen_aan, laatste_inbound, laatste_outbound, ongelezen')
      .eq('kanaal', 'whatsapp')
      .gt('laatste_inbound', klok.van)
      .lte('laatste_inbound', klok.tot)
      .order('laatste_inbound', { ascending: true })
      .limit(MAX_DRINGEND);
    // Mislukt dit, dan is de lijst gewoon de gewone lijst. Een klok-groep die
    // niet geladen kon worden is geen reden om de hele lijst te weigeren.
    if (eKlok) console.warn('[iris-post] klok-groep niet geladen:', eKlok.message);
    else dringendRijen = data || [];
  }

  const { data: gesprekken, error, count } = await vraag.range(vanaf, vanaf + limiet - 1);
  if (error) throw new Error('gesprekken: ' + error.message);

  // Het AANTAL UIT DE HOOFDOPVRAGING, niet uit de samengevoegde lijst. De
  // cursor loopt over de hoofdopvraging; zou hij over `items` lopen, dan sloeg
  // hij bij het doorladen net zoveel gesprekken over als er in de klok-groep
  // stonden -- en die verdwijnen dan stil uit de lijst.
  const hoofdAantal = (gesprekken || []).length;
  const samen = voegSamen(dringendRijen, gesprekken || [], { eerstePagina: vanaf === 0 });
  const rijen = samen.items;
  const contactIds = [...new Set(rijen.map((g) => g.contact_id).filter(Boolean))];
  const gesprekIds = rijen.map((g) => g.id);

  const [contacten, laatsteBerichten] = await Promise.all([
    haalContacten(contactIds),
    haalLaatsteBerichten(gesprekIds),
  ]);

  let items = rijen.map((g) => bouwLijstRij(g, {
    contact: contacten.get(g.contact_id) || null,
    laatsteBericht: laatsteBerichten.get(g.id) || null,
    nu,
  }));

  // De precieze grens voor "bijna dicht" — zie de toelichting bovenaan.
  if (filter === 'venster_bijna_dicht') {
    items = items.filter((i) => i.venster.bijna_dicht);
  }

  return res.status(200).json({
    items,
    totaal: count ?? hoofdAantal,
    filter,
    categorie,
    ordening,
    ordeningen: ORDENINGEN,
    vanaf,
    limiet,
    dringend_aantal: samen.dringend_aantal,
    meer: (count ?? 0) > vanaf + hoofdAantal,
    volgende_vanaf: vanaf + hoofdAantal,
    filters: FILTERS,
  });
}

async function haalContacten(ids) {
  const kaart = new Map();
  if (!ids.length) return kaart;
  const { data, error } = await supabaseAdmin
    .from('iris_contacten')
    .select('id, customer_id, onboarding_id, emails, telefoons, koppelstatus, koppel_reden, weergavenaam')
    .in('id', ids);
  if (error) {
    console.error('[iris-post] contacten:', error.message);
    return kaart;
  }
  for (const c of (data || [])) kaart.set(c.id, c);
  return kaart;
}

async function haalLaatsteBerichten(gesprekIds) {
  const kaart = new Map();
  if (!gesprekIds.length) return kaart;
  // Eén vraag voor alle gesprekken samen, daarna client-side de nieuwste per
  // gesprek pakken. Een lateral join per gesprek zou netter zijn maar kan niet
  // via PostgREST, en vijftig gesprekken × een handvol berichten is niets.
  const { data, error } = await supabaseAdmin
    .from('iris_berichten')
    .select('id, gesprek_id, richting, tekst_kort, samenvatting, zekerheid, categorie, ontvangen_op')
    .in('gesprek_id', gesprekIds)
    .order('ontvangen_op', { ascending: false })
    .limit(gesprekIds.length * 5);
  if (error) {
    console.error('[iris-post] laatste berichten:', error.message);
    return kaart;
  }
  for (const b of (data || [])) {
    if (!kaart.has(b.gesprek_id)) kaart.set(b.gesprek_id, b);
  }
  return kaart;
}

// ── Eén gesprek ──────────────────────────────────────────────────────────────

async function geefGesprek(q, res) {
  const id = String(q.id || '').trim();
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id moet een geldige uuid zijn' });

  const { data: gesprek, error } = await supabaseAdmin
    .from('iris_gesprekken')
    .select('id, contact_id, kanaal, extern_id, categorie, status, toegewezen_aan, laatste_inbound, laatste_outbound, ongelezen')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error('gesprek: ' + error.message);
  if (!gesprek) return res.status(404).json({ error: 'Gesprek niet gevonden' });

  const [contact, berichten, instellingen] = await Promise.all([
    gesprek.contact_id
      ? supabaseAdmin.from('iris_contacten')
          .select('id, customer_id, onboarding_id, hlms_student_id, emails, telefoons, koppelstatus, koppel_reden, weergavenaam')
          .eq('id', gesprek.contact_id).maybeSingle().then((r) => r.data)
      : Promise.resolve(null),
    supabaseAdmin.from('iris_berichten')
      .select('id, bron, bron_id, richting, ontvangen_op, tekst_kort, categorie, categorie_reden, zekerheid, samenvatting, verwerkt_op, verwerk_fout')
      .eq('gesprek_id', id)
      .order('ontvangen_op', { ascending: true })
      .limit(MAX_BERICHTEN)
      .then((r) => r.data || []),
    haalInstellingen(supabaseAdmin),
  ]);

  // De verzendstatus per WhatsApp-bericht. Die staat in de brontabel en werd
  // in het bestaande scherm nergens getoond — gat G9 uit de audit, en het
  // stilste van allemaal: een mislukt bericht zag er hetzelfde uit als een
  // afgeleverd bericht.
  const waIds = berichten.filter((b) => b.bron === 'whatsapp').map((b) => b.bron_id);
  const statussen = new Map();
  if (waIds.length) {
    const { data: waRijen, error: waFout } = await supabaseAdmin
      .from('whatsapp_messages')
      .select('id, status, sent_at, delivered_at, read_at, failed_reason')
      .in('id', waIds);
    if (waFout) console.warn('[iris-post] verzendstatus niet gelezen:', waFout.message);
    for (const r of (waRijen || [])) statussen.set(r.id, r);
  }

  const nu = new Date();
  const verzendbaar = magVersturen({
    laatsteInbound: gesprek.laatste_inbound,
    stilleUrenInstelling: instellingen.stille_uren,
    automatisch: false,
    // Zonder dit krijgt een mail de WhatsApp-regels opgelegd: buiten 24 uur
    // "alleen een goedgekeurde template". Dat is geen scheve badge maar een
    // blokkade op het antwoorden.
    kanaal: gesprek.kanaal,
    nu,
  });

  return res.status(200).json({
    gesprek: {
      ...gesprek,
      naam: contact?.weergavenaam || contact?.emails?.[0] || contact?.telefoons?.[0] || 'Onbekend',
    },
    contact,
    berichten: berichten.map((b) => {
      const s = statussen.get(b.bron_id);
      return {
        ...b,
        verzendstatus: s ? {
          status: s.status,
          verzonden_op: s.sent_at,
          afgeleverd_op: s.delivered_at,
          gelezen_op: s.read_at,
          fout: s.failed_reason || null,
        } : null,
      };
    }),
    venster: verzendbaar.venster,
    verzenden: { mag: verzendbaar.mag, vorm: verzendbaar.vorm, reden: verzendbaar.reden },
    stil: verzendbaar.stil,
  });
}
