// api/setter-calls.js
//
// GET ?setter_user_id=<uuid>  (optioneel — default: de ingelogde user zelf)
//
// "Mijn calls" voor een appointmentsetter: de calls die zij boekte, wat er van
// geworden is (categorie uit api/_lib/call-uitkomst-categorie.js) en bij een
// sale het offertebedrag (deals.total_amount, incl. btw) als de deal te
// koppelen is. De regels zelf staan in api/_lib/setter-calls.js.
//
// Respons:
//   {
//     setter_user_id, startdatum: 'YYYY-MM-DD',
//     telling: { totaal, per_categorie: [{ key, label, kleur, aantal }] },
//       — alleen calls vanaf startdatum (Amsterdam), in de volgorde van de mapping
//     komend: [regel], gedaan: [regel], eerder: [regel],
//       — komend = nog niet voorbij (start + duur + 15 min);
//         gedaan = voorbij, vanaf startdatum;
//         eerder = voorbij, vóór startdatum (geen 'nog niet vastgelegd'-oordeel)
//     sale_koppeling_fout?: true   — deals konden niet gelezen worden
//   }
//   regel = { id, lead_name, scheduled_at, datum_nl, tijd_nl, status, uitkomst,
//             categorie: {key,label,kleur} | null, toelichting, heeft_opvolger,
//             via_keten, komend, meetellen,
//             sale: null | { gekoppeld:false } | { gekoppeld:true, deal_id,
//                   bedrag, offerte_status, offerte_status_label, in_afwachting } }
//
// Gate (zelfde als api/setter-overview.js):
//   - setter.ledger.view  — eigen calls.
//   - setter.ledger.admin — een andere setter bekijken via ?setter_user_id.
//
// Bewust NIET in de respons: snelle_notitie (werkaantekening van de closer),
// lead_email en lead_phone. Zie de kop van api/_lib/setter-calls.js.
//
// INCASSO-VEILIG: leest follow_up_appointments + deals + customers +
// app_settings. Schrijft NIETS.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { MAX_KETEN_DIEPTE } from './_lib/setter-keten.js';
import { SETTER_DEAL_COLS, isUitgeslotenDeal } from './_lib/setter-sale-plan.js';
import { leesCallRapportageStart } from './_lib/call-rapportage-start.js';
import { bouwCallsOverzicht } from './_lib/setter-calls.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const APPT_COLS = [
  'id', 'lead_name', 'lead_email', 'lead_phone', 'scheduled_at', 'duration_minutes',
  'status', 'uitkomst', 'parent_appointment_id', 'setter_user_id', 'is_test',
].join(', ');

const MAX_RIJEN = 2000;
const IN_CHUNK = 200;

function chunks(arr, n) {
  const uit = [];
  for (let i = 0; i < arr.length; i += n) uit.push(arr.slice(i, i + n));
  return uit;
}

/**
 * Haar eigen rijen plus alle opvolgers (op willekeurige diepte) — die laatste
 * ongeacht hun setter; bouwCallsOverzicht beslist via setterUitKeten welke van
 * haar zijn. Zo weten we ook welke van haar rijen een opvolger hebben.
 */
export async function laadKetenRijen(db, setterId) {
  const { data: eigen, error } = await db
    .from('follow_up_appointments')
    .select(APPT_COLS)
    .eq('setter_user_id', setterId)
    .order('scheduled_at', { ascending: false })
    .limit(MAX_RIJEN);
  if (error) throw new Error('follow_up_appointments: ' + error.message);

  const perId = new Map((eigen || []).map((r) => [String(r.id), r]));
  let grens = [...perId.keys()];
  for (let diepte = 0; grens.length && diepte < MAX_KETEN_DIEPTE; diepte += 1) {
    const nieuw = [];
    for (const deel of chunks(grens, IN_CHUNK)) {
      const { data: kinderen, error: kErr } = await db
        .from('follow_up_appointments')
        .select(APPT_COLS)
        .in('parent_appointment_id', deel);
      if (kErr) throw new Error('opvolgers: ' + kErr.message);
      for (const k of (kinderen || [])) {
        const id = String(k.id);
        if (perId.has(id)) continue;
        perId.set(id, k);
        nieuw.push(id);
      }
    }
    grens = nieuw;
  }
  return [...perId.values()];
}

/** Deals van de setter met de klant erbij (alleen e-mail en telefoon). */
export async function laadDealsMetKlant(db, setterId) {
  const { data: deals, error } = await db
    .from('deals')
    .select(SETTER_DEAL_COLS)
    .eq('setter_user_id', setterId);
  if (error) throw new Error('deals: ' + error.message);
  const tellend = (deals || []).filter((d) => !isUitgeslotenDeal(d));
  const custIds = [...new Set(tellend.map((d) => d.customer_id).filter(Boolean))];
  const klantPerId = new Map();
  for (const deel of chunks(custIds, IN_CHUNK)) {
    const { data: klanten, error: cErr } = await db
      .from('customers').select('id, email, phone').in('id', deel);
    if (cErr) throw new Error('customers: ' + cErr.message);
    for (const k of (klanten || [])) klantPerId.set(k.id, k);
  }
  return tellend.map((d) => ({ deal: d, klant: klantPerId.get(d.customer_id) || null }));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'setter.ledger.view'))) {
    return res.status(403).json({ error: 'Geen rechten (setter.ledger.view)' });
  }

  const requestedSetter = String(req.query?.setter_user_id || '').trim();
  let targetSetter = user.id;
  if (requestedSetter && requestedSetter !== user.id) {
    if (!UUID_RE.test(requestedSetter)) return res.status(400).json({ error: 'setter_user_id ongeldig' });
    if (!(await requirePermission(req, 'setter.ledger.admin'))) {
      return res.status(403).json({ error: 'Alleen setter.ledger.admin mag andere setters bekijken' });
    }
    targetSetter = requestedSetter;
  }

  try {
    const [rijen, startdatum] = await Promise.all([
      laadKetenRijen(supabaseAdmin, targetSetter),
      leesCallRapportageStart(supabaseAdmin),
    ]);

    // Deals alleen als er een sale tussen zit. Fail-soft: zonder deals staat
    // de sale er gewoon, alleen zonder bedrag.
    let dealsMetKlant = [];
    let saleKoppelingFout = false;
    const heeftSale = rijen.some((r) => String(r.uitkomst || '').trim().toLowerCase() === 'sale');
    if (heeftSale) {
      try {
        dealsMetKlant = await laadDealsMetKlant(supabaseAdmin, targetSetter);
      } catch (e) {
        saleKoppelingFout = true;
        console.error('[setter-calls] deals lezen faalde (soft):', e?.message || e);
      }
    }

    const overzicht = bouwCallsOverzicht({
      rijen,
      setterId: targetSetter,
      dealsMetKlant,
      nuMs: Date.now(),
      startdatum,
    });

    return res.status(200).json({
      setter_user_id: targetSetter,
      ...overzicht,
      ...(saleKoppelingFout ? { sale_koppeling_fout: true } : {}),
    });
  } catch (e) {
    console.error('[setter-calls]', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
