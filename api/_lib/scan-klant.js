// api/_lib/scan-klant.js — is de deelnemer van een strategie-scan klant geworden?
//
// Twee bronnen, gecombineerd (opdracht 2026-10-15, aanvulling fase 3):
//   1. AUTOMATISCH uit de bestaande deals. Een deal hoort bij de scan als hij
//      via deals.source_lead_id aan de lead van de scan hangt, aan de klant van
//      die lead (leads.customer_id), of aan een klant met hetzelfde e-mailadres
//      als de deelnemer. "Klant" = een GEWONNEN deal: offerte geaccepteerd
//      (tl_quotation_status='accepted'), niet afgewezen, niet gearchiveerd —
//      dezelfde regel als api/_lib/sales-signed-deals-compute.js.
//   2. HANDMATIG door de assessor op de scan (scans.klant_status_handmatig:
//      'klant' / 'in_gesprek' / 'geen_klant'). Heeft VOORRANG op automatisch.
// Het overzicht én het dashboard (fase 4) gebruiken bepaalKlant().

export const KLANT_STATUSSEN = ['klant', 'in_gesprek', 'geen_klant'];
export const KLANT_LABELS = { klant: 'Klant', in_gesprek: 'In gesprek', geen_klant: 'Geen klant' };

const isGewonnen = (d) => !!d && d.tl_quotation_status === 'accepted' && !d.tl_quotation_declined_at && !d.archived_at;
const datumVan = (d) => d.tl_quotation_accepted_at || d.tl_quotation_signed_at || d.created_at || null;
const emailVan = (s) => (s ? String(s).trim().toLowerCase() : '');

/**
 * Pure: de klant-status van één scan.
 * @param {object} scan  rij uit scans (lead_id, deelnemer_email, klant_status_handmatig)
 * @param {object} ctx   { leadNaarCustomer: Map, emailNaarCustomers: Map<email, id[]>, dealsPerLead: Map, dealsPerCustomer: Map, trajectLabel: Map }
 * @returns {{ status: 'klant'|'in_gesprek'|'geen_klant'|null, bron: 'handmatig'|'automatisch'|null,
 *             klant: boolean, auto: object|null }}
 *   auto = { deal_id, traject, datum, bedrag } van de nieuwste gewonnen deal (of null)
 */
export function bepaalKlant(scan, ctx) {
  const deals = new Map();
  const voeg = (lijst) => (lijst || []).forEach((d) => deals.set(d.id, d));
  if (scan.lead_id) {
    voeg(ctx.dealsPerLead.get(scan.lead_id));
    const cust = ctx.leadNaarCustomer.get(scan.lead_id);
    if (cust) voeg(ctx.dealsPerCustomer.get(cust));
  }
  const mail = emailVan(scan.deelnemer_email);
  if (mail) (ctx.emailNaarCustomers.get(mail) || []).forEach((c) => voeg(ctx.dealsPerCustomer.get(c)));

  const gewonnen = [...deals.values()].filter(isGewonnen)
    .sort((a, b) => String(datumVan(b) || '').localeCompare(String(datumVan(a) || '')));
  const d = gewonnen[0] || null;
  const auto = d ? {
    deal_id: d.id,
    traject: (d.traject_variant_id && ctx.trajectLabel.get(d.traject_variant_id)) || null,
    datum: datumVan(d),
    bedrag: Number(d.total_amount) || 0,
  } : null;

  const hand = KLANT_STATUSSEN.includes(scan.klant_status_handmatig) ? scan.klant_status_handmatig : null;
  if (hand) return { status: hand, bron: 'handmatig', klant: hand === 'klant', auto };
  if (auto) return { status: 'klant', bron: 'automatisch', klant: true, auto };
  return { status: null, bron: null, klant: false, auto: null };
}

const stukken = (lijst, n = 100) => {
  const uit = [];
  for (let i = 0; i < lijst.length; i += n) uit.push(lijst.slice(i, i + n));
  return uit;
};

async function inLees(db, tabel, kolommen, kol, waarden, extra = (q) => q) {
  const uniek = [...new Set(waarden.filter(Boolean))];
  const rijen = [];
  for (const deel of stukken(uniek)) {
    const { data, error } = await extra(db.from(tabel).select(kolommen).in(kol, deel));
    if (error) throw new Error(tabel + ': ' + error.message);
    rijen.push(...(data || []));
  }
  return rijen;
}

const DEAL_KOLOMMEN = 'id, customer_id, source_lead_id, tl_quotation_status, tl_quotation_accepted_at, tl_quotation_signed_at, tl_quotation_declined_at, archived_at, created_at, total_amount, traject_variant_id';

/** Haalt alles op wat bepaalKlant() nodig heeft voor een lijst scans (een handvol queries, in stukken). */
export async function laadKlantContext(db, scans) {
  const leadIds = scans.map((s) => s.lead_id).filter(Boolean);
  const mails = [...new Set(scans.map((s) => emailVan(s.deelnemer_email)).filter(Boolean))];

  const leads = await inLees(db, 'leads', 'id, customer_id', 'id', leadIds);
  const leadNaarCustomer = new Map(leads.filter((l) => l.customer_id).map((l) => [l.id, l.customer_id]));

  // Klanten op e-mail (zoals ingevuld én kleine letters).
  const klanten = await inLees(db, 'customers', 'id, email', 'email', [...mails, ...scans.map((s) => s.deelnemer_email).filter(Boolean)]);
  const emailNaarCustomers = new Map();
  for (const c of klanten) {
    const m = emailVan(c.email);
    if (!m) continue;
    emailNaarCustomers.set(m, [...new Set([...(emailNaarCustomers.get(m) || []), c.id])]);
  }

  const customerIds = [...new Set([...leadNaarCustomer.values(), ...klanten.map((c) => c.id)])];
  const gewonnenFilter = (q) => q.eq('tl_quotation_status', 'accepted').is('archived_at', null);
  const dealsLead = await inLees(db, 'deals', DEAL_KOLOMMEN, 'source_lead_id', leadIds, gewonnenFilter);
  const dealsCust = await inLees(db, 'deals', DEAL_KOLOMMEN, 'customer_id', customerIds, gewonnenFilter);
  const dealsPerLead = new Map(); const dealsPerCustomer = new Map();
  const zet = (m, k, d) => { if (!k) return; m.set(k, [...(m.get(k) || []).filter((x) => x.id !== d.id), d]); };
  for (const d of [...dealsLead, ...dealsCust]) { zet(dealsPerLead, d.source_lead_id, d); zet(dealsPerCustomer, d.customer_id, d); }

  // Trajectnaam: "Traject > Variant" (zelfde label als sales-deal-detail).
  const variantIds = [...new Set([...dealsLead, ...dealsCust].map((d) => d.traject_variant_id).filter(Boolean))];
  const varianten = await inLees(db, 'traject_variants', 'id, name, traject_id', 'id', variantIds);
  const trajecten = await inLees(db, 'trajects', 'id, name', 'id', varianten.map((v) => v.traject_id));
  const trajectNaam = new Map(trajecten.map((t) => [t.id, t.name]));
  const trajectLabel = new Map(varianten.map((v) => [v.id, [trajectNaam.get(v.traject_id), v.name].filter(Boolean).join(' > ')]));

  return { leadNaarCustomer, emailNaarCustomers, dealsPerLead, dealsPerCustomer, trajectLabel };
}
