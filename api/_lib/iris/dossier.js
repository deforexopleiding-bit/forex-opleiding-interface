// api/_lib/iris/dossier.js
//
// De dossierkaart: alles wat je over iemand moet weten vóór je antwoordt,
// in één opvraging.
//
// ── WAAROM DIT BESTAAT ───────────────────────────────────────────────────────
// De opdracht zegt het precies: "zodat Maxim nooit iets hoeft op te zoeken".
// Dat is geen luxe. Wie tijdens een gesprek naar een ander scherm moet om te
// kijken of die factuur nu wel of niet betaald is, antwoordt trager en vager —
// en precies bij een betalingsgesprek is vaagheid duur.
//
// ── ZES BRONNEN, ZES KEER FAALZACHT ──────────────────────────────────────────
// Facturen, de stand bij de aanmaanmotor, het LMS, beloftes, mentorsignalen en
// belpogingen. Elke bron kan los stuk zijn, en dan hoort de kaart de andere
// vijf gewoon te tonen. Een halve kaart is bruikbaar; een lege kaart met een
// foutmelding is dat niet.
//
// Wat wél belangrijk is: een bron die niet gelezen kon worden krijgt
// `gelezen: false`. "Er zijn geen open facturen" en "we konden de facturen
// niet zien" mogen er in het scherm nooit hetzelfde uitzien. Wie op de eerste
// aanneming een klant belt over een factuur die er wel is, staat voor gek; wie
// op de tweede afgaat, denkt dat hij het weet.
//
// ── WAT ER NIET IN ZIT ───────────────────────────────────────────────────────
// Geen berekende adviezen, geen "hij zou nu gebeld moeten worden". Dit is een
// kaart, geen mening. De mening komt van de classificatie en van de mens.

import { customerDisplayName } from '../customer-name.js';

const DAG_MS = 24 * 3600 * 1000;
const MAX_FACTUREN = 25;

/** Een bron die niet gelezen kon worden. */
function nietGelezen(reden) {
  return { gelezen: false, reden, items: [] };
}

/**
 * Reken één factuurrij om naar wat het scherm nodig heeft.
 *
 * Volledig gecrediteerde facturen en facturen zonder openstaand bedrag vallen
 * weg. Dat is dezelfde logica als inbox-conversation-context.js gebruikt; die
 * is daar uitgevochten en klopt.
 */
export function vormFactuur(inv, nu = new Date()) {
  const totaal = Number(inv.amount_total) || 0;
  const betaald = Number(inv.amount_paid) || 0;
  const gecrediteerd = Number(inv.credited_amount) || 0;
  if (gecrediteerd > 0 && totaal > 0 && gecrediteerd >= totaal) return null;
  const open = Math.max(0, totaal - betaald);
  if (open <= 0) return null;

  let dagenTeLaat = 0;
  if (inv.due_date) {
    const vervalt = new Date(inv.due_date + 'T00:00:00').getTime();
    if (Number.isFinite(vervalt) && vervalt < nu.getTime()) {
      dagenTeLaat = Math.floor((nu.getTime() - vervalt) / DAG_MS);
    }
  }

  return {
    id: inv.id,
    nummer: inv.invoice_number || null,
    bedrag_totaal: totaal,
    bedrag_open: Math.round(open * 100) / 100,
    vervaldatum: inv.due_date || null,
    dagen_te_laat: dagenTeLaat,
    te_laat: dagenTeLaat > 0,
    status: inv.status,
  };
}

/**
 * Mag er over deze facturen überhaupt iets gezegd worden?
 *
 * De harde regel uit de opdracht: geen enkel bericht over een factuur zolang
 * die niet effectief te laat is. Niet "bijna", niet "vandaag" — te laat.
 *
 * Dit staat hier als losse functie omdat het een antwoord is dat op drie
 * plekken nodig is (de kaart, het schrijven, het versturen) en dat nergens
 * opnieuw bedacht mag worden.
 */
export function magOverFacturenPraten(facturen) {
  const teLaat = (facturen || []).filter((f) => f && f.te_laat);
  if (!teLaat.length) {
    return { mag: false, reden: 'geen enkele factuur is over de vervaldatum heen' };
  }
  return { mag: true, reden: `${teLaat.length} factuur/facturen over de vervaldatum`, facturen: teLaat };
}

/**
 * Bouw de dossierkaart.
 *
 * @param {object} supabase       CRM-client (supabaseAdmin)
 * @param {object} contact        een rij uit iris_contacten
 * @param {object} opties
 * @param {Function} opties.lmsClient  geeft de dfo-lms-client, of null
 */
export async function bouwDossier(supabase, contact, { lmsClient = null, nu = new Date() } = {}) {
  const kaart = {
    contact: contact ? {
      id: contact.id,
      naam: contact.weergavenaam || null,
      emails: contact.emails || [],
      telefoons: contact.telefoons || [],
      koppelstatus: contact.koppelstatus,
      koppel_reden: contact.koppel_reden || null,
      customer_id: contact.customer_id || null,
    } : null,
    klant: null,
    facturen: nietGelezen('nog niet opgehaald'),
    aanmaanmotor: nietGelezen('nog niet opgehaald'),
    lms: nietGelezen('nog niet opgehaald'),
    beloftes: nietGelezen('nog niet opgehaald'),
    signalen: nietGelezen('nog niet opgehaald'),
    belpogingen: nietGelezen('nog niet opgehaald'),
    totalen: { open_bedrag: 0, aantal_open: 0, oudste_dagen_te_laat: 0 },
  };

  if (!contact) return kaart;
  const klantId = contact.customer_id || null;

  // Alle zes tegelijk. Ze hangen niet van elkaar af, en zes keer wachten op
  // elkaar zou de kaart merkbaar traag maken bij het wisselen van gesprek.
  const [klant, facturen, motor, lms, beloftes, signalen, pogingen] = await Promise.all([
    klantId ? haalKlant(supabase, klantId) : Promise.resolve(null),
    klantId ? haalFacturen(supabase, klantId, nu) : Promise.resolve({ gelezen: true, items: [] }),
    klantId ? haalMotorstand(supabase, klantId) : Promise.resolve({ gelezen: true, fase: null }),
    haalLms(lmsClient, contact),
    haalBeloftes(supabase, contact.id),
    haalSignalen(supabase, contact.id),
    haalBelpogingen(supabase, contact.id),
  ]);

  kaart.klant = klant;
  kaart.facturen = facturen;
  kaart.aanmaanmotor = motor;
  kaart.lms = lms;
  kaart.beloftes = beloftes;
  kaart.signalen = signalen;
  kaart.belpogingen = pogingen;

  if (facturen.gelezen) {
    kaart.totalen.aantal_open = facturen.items.length;
    kaart.totalen.open_bedrag = Math.round(
      facturen.items.reduce((s, f) => s + f.bedrag_open, 0) * 100
    ) / 100;
    kaart.totalen.oudste_dagen_te_laat = facturen.items.reduce(
      (m, f) => Math.max(m, f.dagen_te_laat), 0
    );
  }
  kaart.mag_over_facturen_praten = magOverFacturenPraten(facturen.items);

  return kaart;
}

// ── De zes bronnen ───────────────────────────────────────────────────────────

async function haalKlant(supabase, id) {
  try {
    // KOLOMNAMEN. Geen `name` — die kolom bestaat niet. Zie de toelichting in
    // _lib/iris/koppel.js; de weergavenaam wordt samengesteld met de gedeelde
    // helper, zodat een bedrijf zijn bedrijfsnaam houdt en een particulier
    // zijn voor- en achternaam.
    const { data, error } = await supabase
      .from('customers')
      .select('id, is_company, first_name, last_name, company_name, email, phone, created_at')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return { ...data, naam: customerDisplayName(data, '') || null };
  } catch (e) {
    console.error('[iris/dossier] klant:', e?.message || e);
    return null;
  }
}

async function haalFacturen(supabase, klantId, nu) {
  try {
    const { data, error } = await supabase
      .from('invoices')
      .select('id, invoice_number, amount_total, amount_paid, credited_amount, due_date, issue_date, status')
      .eq('customer_id', klantId)
      .in('status', ['open', 'partially_paid'])
      .order('due_date', { ascending: true, nullsFirst: false })
      .limit(MAX_FACTUREN);
    if (error) throw new Error(error.message);
    const items = (data || []).map((r) => vormFactuur(r, nu)).filter(Boolean);
    return { gelezen: true, items };
  } catch (e) {
    console.error('[iris/dossier] facturen:', e?.message || e);
    return nietGelezen(e?.message || 'facturen niet gelezen');
  }
}

/**
 * Waar staat de aanmaanmotor voor deze klant?
 *
 * Alleen LEZEN. Iris schrijft niet in de pipeline van Joost; dat is de hele
 * afspraak van sectie 1 van de opdracht. Wat we tonen is de fase en wanneer
 * die voor het laatst veranderde, zodat iemand die gaat antwoorden weet of er
 * gisteren nog een aanmaning uit is gegaan.
 */
async function haalMotorstand(supabase, klantId) {
  try {
    const { data, error } = await supabase
      .from('dunning_pipeline_customers')
      .select('stage_slug, stage_changed_at, last_activity_at')
      .eq('customer_id', klantId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return {
      gelezen: true,
      fase: data?.stage_slug || null,
      fase_sinds: data?.stage_changed_at || null,
      laatste_activiteit: data?.last_activity_at || null,
    };
  } catch (e) {
    console.error('[iris/dossier] aanmaanmotor:', e?.message || e);
    return { gelezen: false, reden: e?.message || 'motorstand niet gelezen', fase: null };
  }
}

/**
 * De LMS-stand.
 *
 * Leest uit het dfo-lms-project, met de sleutel die er al is. Schrijft nooit.
 * Ontbreekt de sleutel, dan is dat geen fout maar een feit dat we melden —
 * getDfoLmsClient() geeft dan null en dat mag de rest van de kaart niet
 * meeslepen.
 */
async function haalLms(client, contact) {
  if (!client) {
    return { gelezen: false, reden: 'LMS-koppeling niet geconfigureerd', items: [] };
  }
  const emails = (contact.emails || []).filter(Boolean);
  if (!contact.hlms_student_id && !emails.length) {
    return { gelezen: true, student: null, items: [] };
  }
  try {
    let vraag = client
      .from('hlms_student')
      .select('id, email, start_datum, eind_datum, mentor_id, product_soort, no_show_count, crm_onboarding_id');
    vraag = contact.hlms_student_id
      ? vraag.eq('id', contact.hlms_student_id)
      : vraag.in('email', emails.map((e) => String(e).toLowerCase()));
    const { data, error } = await vraag.limit(2);
    if (error) throw new Error(error.message);

    const rijen = data || [];
    if (rijen.length !== 1) {
      return {
        gelezen: true,
        student: null,
        items: [],
        reden: rijen.length ? `${rijen.length} studenten op dit adres` : 'geen student gevonden',
      };
    }
    const s = rijen[0];
    const eind = s.eind_datum ? new Date(s.eind_datum + 'T23:59:59') : null;
    return {
      gelezen: true,
      student: {
        id: s.id,
        email: s.email,
        start: s.start_datum,
        toegang_tot: s.eind_datum,
        toegang_geldig: eind ? eind.getTime() > Date.now() : null,
        mentor_id: s.mentor_id,
        product: s.product_soort,
        no_shows: s.no_show_count,
      },
      items: [],
    };
  } catch (e) {
    console.error('[iris/dossier] LMS:', e?.message || e);
    return nietGelezen(e?.message || 'LMS niet gelezen');
  }
}

async function haalBeloftes(supabase, contactId) {
  try {
    const { data, error } = await supabase
      .from('iris_beloftes')
      .select('id, bedrag, datum, status, bron, notitie, aangemaakt_op')
      .eq('contact_id', contactId)
      .order('datum', { ascending: false })
      .limit(5);
    if (error) throw new Error(error.message);
    return { gelezen: true, items: data || [], actief: (data || []).find((b) => b.status === 'actief') || null };
  } catch (e) {
    console.error('[iris/dossier] beloftes:', e?.message || e);
    return nietGelezen(e?.message || 'beloftes niet gelezen');
  }
}

async function haalSignalen(supabase, contactId) {
  try {
    const { data, error } = await supabase
      .from('iris_signalen')
      .select('id, type, mentor_naam, toelichting, gevraagde_actie, signaal_op, verwerkt_op')
      .eq('contact_id', contactId)
      .order('signaal_op', { ascending: false })
      .limit(5);
    if (error) throw new Error(error.message);
    return { gelezen: true, items: data || [] };
  } catch (e) {
    console.error('[iris/dossier] signalen:', e?.message || e);
    return nietGelezen(e?.message || 'signalen niet gelezen');
  }
}

async function haalBelpogingen(supabase, contactId) {
  try {
    const { data, error } = await supabase
      .from('iris_belpogingen')
      .select('id, uitkomst, afgebroken_voor_opname, notitie, gebeld_op, gebeld_door')
      .eq('contact_id', contactId)
      .order('gebeld_op', { ascending: false })
      .limit(10);
    if (error) throw new Error(error.message);
    const items = data || [];
    // Afgebroken pogingen tellen niet mee. Zie de regel in de opdracht: een
    // call die wordt afgebroken vóór er opgenomen is, telt nooit als poging.
    const echt = items.filter((p) => !p.afgebroken_voor_opname);
    return {
      gelezen: true,
      items,
      aantal_echt: echt.length,
      laatste_contact: echt.find((p) => p.uitkomst === 'gesproken')?.gebeld_op || null,
    };
  } catch (e) {
    console.error('[iris/dossier] belpogingen:', e?.message || e);
    return nietGelezen(e?.message || 'belpogingen niet gelezen');
  }
}
