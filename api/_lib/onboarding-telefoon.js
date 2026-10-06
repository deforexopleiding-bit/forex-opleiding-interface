// api/_lib/onboarding-telefoon.js
//
// HET TELEFOONNUMMER VAN EEN ONBOARDING — één afleiding, vaste voorrang.
//
// ── WAAROM (Maxim, 6 oktober 2026) ───────────────────────────────────────
// De intake-pot en de kaarten in het LMS toonden "Geen telefoonnummer in het
// CRM", terwijl het nummer wel ergens in het CRM stond. De spiegel keek op één
// plek (`customers.phone`), en die is leeg zodra de klant via een import of
// een offerte zonder telefoon binnenkwam. Het nummer zat dan in het gesprek
// op WhatsApp, in de lead, of in de afspraak die de setter boekte.
//
// ── DE VOORRANG (meest betrouwbare eerst) ────────────────────────────────
//   1. customers.phone            — de klantkaart (Teamleader-contact)
//   2. whatsapp_conversations     — een nummer waarmee we al echt praten
//   3. leads.telefoon_e164/telefoon — wat de lead zelf invulde (op e-mail)
//   4. follow_up_appointments.lead_phone — de geboekte call (op e-mail)
//   5. onboardings.answers        — een wizardveld met telefoon/gsm erin
//
// Per bron: de eerste die een EENDUIDIG E.164-nummer oplevert, wint. Levert
// geen enkele bron dat op, dan het eerste ruwe nummer — zichtbaar, maar zonder
// WhatsApp-link (het LMS maakt die alleen bij een landcode). Nooit gokken: de
// normalisatie is die van phone-e164.js (NL/BE, landveld van de klant).
//
// Alles leest; er wordt NIETS weggeschreven in het CRM. Een bron die faalt,
// valt weg met een log — de volgende neemt het over.

import { normaliseerNlBe } from './phone-e164.js';

export const TELEFOON_BRONNEN = Object.freeze([
  'klant', 'whatsapp', 'lead', 'afspraak', 'wizard',
]);

const WIZARD_SLEUTEL = /(telefoon|phone|gsm|mobiel|mobile|whatsapp)/i;

/**
 * Kies het nummer uit kandidaten in voorrangsvolgorde. PURE.
 * @param {{bron: string, ruw: any}[]} kandidaten  al in voorrangsvolgorde
 * @param {string|null} land  'NL' | 'BE' | null — het landveld van de klant
 * @returns {{ telefoon: string|null, bron: string|null, zeker: boolean }}
 */
export function kiesTelefoon(kandidaten, land = null) {
  let eersteRuw = null;
  for (const k of kandidaten || []) {
    const r = normaliseerNlBe(k?.ruw, { land: land || null });
    if (!r.telefoon) continue;
    if (r.e164) return { telefoon: r.e164, bron: k.bron, zeker: true };
    if (!eersteRuw) eersteRuw = { telefoon: r.telefoon, bron: k.bron, zeker: false };
  }
  return eersteRuw || { telefoon: null, bron: null, zeker: false };
}

/** Telefoonvelden uit de wizardantwoorden, in vaste (alfabetische) volgorde. PURE. */
export function telefoonsUitAntwoorden(answers) {
  if (!answers || typeof answers !== 'object') return [];
  return Object.keys(answers)
    .filter((k) => WIZARD_SLEUTEL.test(k) && typeof answers[k] === 'string')
    .sort()
    .map((k) => answers[k]);
}

function emailSleutel(e) {
  const s = String(e || '').trim().toLowerCase();
  return s || null;
}

async function veilig(label, fn) {
  try {
    return await fn();
  } catch (e) {
    console.warn('[onboarding-telefoon] bron ' + label + ' niet gelezen:', e?.message || e);
    return null;
  }
}

/**
 * De nummers van een reeks onboardings, in één ronde per bron.
 * @param {object} db  supabase-client (service_role)
 * @param {{id: string, customer_id?: string|null, answers?: object|null}[]} obs
 * @returns {Promise<Map<string, {telefoon: string|null, bron: string|null, zeker: boolean}>>}
 */
export async function telefoonsVoorOnboardings(db, obs) {
  const lijst = (obs || []).filter((o) => o?.id);
  const klantIds = [...new Set(lijst.map((o) => o.customer_id).filter(Boolean))];

  // 1) De klantkaart: telefoon, e-mail (sleutel voor 3 en 4) en land.
  const klanten = new Map();
  if (klantIds.length) {
    await veilig('klant', async () => {
      for (let i = 0; i < klantIds.length; i += 200) {
        const { data, error } = await db.from('customers')
          .select('id, phone, email, address_country').in('id', klantIds.slice(i, i + 200));
        if (error) throw new Error(error.message);
        for (const k of data || []) klanten.set(k.id, k);
      }
    });
  }

  // 2) WhatsApp-gesprekken die aan de klant hangen; het laatst actieve eerst.
  const wa = new Map();
  if (klantIds.length) {
    await veilig('whatsapp', async () => {
      for (let i = 0; i < klantIds.length; i += 200) {
        const { data, error } = await db.from('whatsapp_conversations')
          .select('customer_id, phone_number, last_message_at')
          .in('customer_id', klantIds.slice(i, i + 200))
          .order('last_message_at', { ascending: false, nullsFirst: false });
        if (error) throw new Error(error.message);
        for (const c of data || []) if (!wa.has(c.customer_id) && c.phone_number) wa.set(c.customer_id, c.phone_number);
      }
    });
  }

  const emails = [...new Set([...klanten.values()].map((k) => emailSleutel(k.email)).filter(Boolean))];

  // 3) De lead (op e-mail).
  const leads = new Map();
  // 4) De geboekte afspraak (op e-mail); de laatste eerst.
  const afspraken = new Map();
  if (emails.length) {
    await veilig('lead', async () => {
      for (let i = 0; i < emails.length; i += 200) {
        const { data, error } = await db.from('leads')
          .select('email, telefoon, telefoon_e164').in('email', emails.slice(i, i + 200));
        if (error) throw new Error(error.message);
        for (const l of data || []) {
          const s = emailSleutel(l.email);
          if (s && !leads.has(s)) leads.set(s, l.telefoon_e164 || l.telefoon || null);
        }
      }
    });
    await veilig('afspraak', async () => {
      for (let i = 0; i < emails.length; i += 200) {
        const { data, error } = await db.from('follow_up_appointments')
          .select('lead_email, lead_phone, scheduled_at').in('lead_email', emails.slice(i, i + 200))
          .order('scheduled_at', { ascending: false, nullsFirst: false });
        if (error) throw new Error(error.message);
        for (const a of data || []) {
          const s = emailSleutel(a.lead_email);
          if (s && a.lead_phone && !afspraken.has(s)) afspraken.set(s, a.lead_phone);
        }
      }
    });
  }

  const uit = new Map();
  for (const o of lijst) {
    const k = o.customer_id ? klanten.get(o.customer_id) : null;
    const e = emailSleutel(k?.email);
    const kandidaten = [
      { bron: 'klant', ruw: k?.phone },
      { bron: 'whatsapp', ruw: o.customer_id ? wa.get(o.customer_id) : null },
      { bron: 'lead', ruw: e ? leads.get(e) : null },
      { bron: 'afspraak', ruw: e ? afspraken.get(e) : null },
      ...telefoonsUitAntwoorden(o.answers).map((ruw) => ({ bron: 'wizard', ruw })),
    ];
    uit.set(o.id, kiesTelefoon(kandidaten, k?.address_country || null));
  }
  return uit;
}

/** Eén onboarding. */
export async function telefoonVoorOnboarding(db, ob) {
  if (!ob?.id) return { telefoon: null, bron: null, zeker: false };
  const m = await telefoonsVoorOnboardings(db, [ob]);
  return m.get(ob.id) || { telefoon: null, bron: null, zeker: false };
}
