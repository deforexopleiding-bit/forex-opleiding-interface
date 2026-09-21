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
// belofte_vandaag · alles. Dat zijn de vragen die iemand 's ochtends stelt.
// "Alle open gesprekken" is er geen van.
//
// 'venster_bijna_dicht' wordt na het ophalen berekend en niet in SQL. Reden:
// de grens verschuift elke minuut, dus een WHERE erop zou een index opleveren
// die nooit klopt. Over vijftig rijen is dat rekenwerk niets.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { haalInstellingen } from './_lib/iris/instellingen.js';
import { vensterStand, magVersturen } from './_lib/iris/venster.js';

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
  const venster = vensterStand(gesprek.laatste_inbound, nu);
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
    venster: {
      open: venster.open,
      bijna_dicht: venster.bijna_dicht,
      tekst: venster.resterend_tekst,
      resterend_ms: venster.resterend_ms,
    },
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
    if (actie === 'lijst') return await geefLijst(q, res);
    return res.status(400).json({ error: `onbekende actie: ${actie}` });
  } catch (e) {
    console.error('[iris-post]', actie, e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

// ── De lijst ─────────────────────────────────────────────────────────────────

async function geefLijst(q, res) {
  const filter = FILTERS.includes(String(q.filter || '')) ? String(q.filter) : 'wacht_op_ons';
  const categorie = String(q.categorie || '').trim() || null;
  const zoek = String(q.zoek || '').trim();
  const limiet = klem(q.limiet, STANDAARD_LIMIET, 1, MAX_LIMIET);
  const vanaf = klem(q.vanaf, 0, 0, 100000);
  const nu = new Date();

  let vraag = supabaseAdmin
    .from('iris_gesprekken')
    .select('id, contact_id, kanaal, categorie, status, toegewezen_aan, laatste_inbound, laatste_outbound, ongelezen', { count: 'exact' })
    .order('laatste_inbound', { ascending: false, nullsFirst: false });

  if (filter === 'wacht_op_ons') vraag = vraag.in('status', ['nieuw', 'wacht_op_ons']);
  else if (filter === 'wacht_op_klant') vraag = vraag.eq('status', 'wacht_op_klant');
  else if (filter === 'niet_gekoppeld') vraag = vraag.is('contact_id', null);
  else if (filter === 'venster_bijna_dicht') {
    // Voorselectie in SQL op "inbound binnen de laatste 24 uur"; de precieze
    // grens van twee uur komt daarna. Zonder deze voorselectie zou de hele
    // tabel opgehaald moeten worden om er een handvol uit te vissen.
    vraag = vraag.gte('laatste_inbound', new Date(nu.getTime() - 24 * 3600 * 1000).toISOString());
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
    const naald = `%${zoek}%`;
    const { data: gevonden } = await supabaseAdmin
      .from('iris_contacten')
      .select('id')
      .or(`weergavenaam.ilike.${naald},emails.cs.{"${zoek.toLowerCase()}"}`)
      .limit(200);
    const ids = (gevonden || []).map((c) => c.id);
    if (!ids.length) {
      return res.status(200).json({ items: [], totaal: 0, filter, vanaf, limiet, filters: FILTERS });
    }
    vraag = vraag.in('contact_id', ids);
  }

  const { data: gesprekken, error, count } = await vraag.range(vanaf, vanaf + limiet - 1);
  if (error) throw new Error('gesprekken: ' + error.message);

  const rijen = gesprekken || [];
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
    totaal: count ?? items.length,
    filter,
    categorie,
    vanaf,
    limiet,
    meer: (count ?? 0) > vanaf + items.length,
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
