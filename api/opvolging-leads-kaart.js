// api/opvolging-leads-kaart.js
//
// POST { lead_id } → de leadkaart van deze lead, idempotent.
//
// Een kaart in opvolging_taken (lijst 'leads') ontstaat pas zodra Dave iets met
// een lead uit de pot doet: bellen, WhatsApp, inplannen, doorsturen, later of
// afronden. Het scherm roept dit vóór elk van die acties aan en werkt daarna
// met de taak_id — zo erft de leadkaart alles wat al werkt (softphone-logging,
// WhatsApp-brug, pogingen-telling, agenda, 48u-wacht-check, doorrol).
//
// IDEMPOTENT: bestaat er al een lopende kaart (open / wacht_inplanning /
// ingepland) voor deze lead, dan komt die terug. Twee gelijktijdige klikken
// botsen op de unieke partiële index opvolging_taken_leadkaart_uniek; de 23505
// daarvan is hier geen fout maar het bewijs dat de kaart er al staat.
//
// Een gearchiveerde kaart (weggegooid) komt NIET terug: dan 409. Wie afgerond
// is, is met reden afgerond — dat oordeel staat in Maxims controlescherm.
//
// Response 200: { ok, taak_id, bestond: bool, taak }
//          409: { code: 'AFGEROND' }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { telefoonNlBe } from './_lib/phone-e164.js';
import { alleenLeadlijst, LIJST_LEADS } from './_lib/opvolging-lijst.js';
import {
  isProefLead, productVan, naamVan, telefoonVan, dagInZone,
} from './_lib/opvolging-leads-pot.js';
import { warmteVoorLead } from './_lib/opvolging-leads-data.js';
import { brugLeadlijstVerversen } from './_lib/opvolging-brug-ververs.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOPEND = ['open', 'wacht_inplanning', 'ingepland'];

/** De notitie op een nieuwe kaart: waarom hij warm was op dit moment. */
export function bouwKaartNotitie({ warmte, vandaag }) {
  if (!warmte || !Array.isArray(warmte.redenen) || warmte.redenen.length === 0) {
    return vandaag + ' · Uit Leads bellen.';
  }
  const redenen = warmte.redenen.map((r) => r.tekst + ' (' + (r.punten > 0 ? '+' : '') + r.punten + ')').join(', ');
  return vandaag + ' · Uit Leads bellen — warmte ' + warmte.score + ' (' + warmte.label.tekst + '): ' + redenen + '.';
}

async function zoekKaart(leadId) {
  const { data, error } = await alleenLeadlijst(supabaseAdmin.from('opvolging_taken').select('*'))
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);
  const rijen = data || [];
  return {
    lopend: rijen.find((t) => LOPEND.includes(t.status)) || null,
    afgerond: rijen.find((t) => t.status === 'gearchiveerd') || null,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  if (!(await requirePermission(req, 'opvolging.leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (opvolging.leads.view)' });
  }

  const b = req.body || {};
  const leadId = String(b.lead_id || '').trim();
  if (!UUID_RE.test(leadId)) return res.status(400).json({ error: 'lead_id ontbreekt of is ongeldig' });

  try {
    const bestaand = await zoekKaart(leadId);
    if (bestaand.lopend) {
      return res.status(200).json({ ok: true, taak_id: bestaand.lopend.id, bestond: true, taak: bestaand.lopend });
    }
    if (bestaand.afgerond) {
      return res.status(409).json({
        code: 'AFGEROND',
        error: 'Deze lead is eerder afgerond en komt niet terug in Leads bellen.',
        taak_id: bestaand.afgerond.id,
      });
    }

    const { data: lead, error: lErr } = await supabaseAdmin
      .from('leads').select('*').eq('id', leadId).maybeSingle();
    if (lErr) throw new Error('lead lezen: ' + lErr.message);
    if (!lead || lead.verwijderd_op) return res.status(404).json({ error: 'Deze lead bestaat niet (meer).' });
    if (!isProefLead(lead)) return res.status(400).json({ error: 'Deze lead hoort niet bij de minicursus of de 7-daagse.' });
    const tel = telefoonVan(lead);
    if (!tel) return res.status(400).json({ error: 'Deze lead heeft geen telefoonnummer.' });

    const nuMs = Date.now();
    const vandaag = dagInZone(nuMs);
    const p = productVan(lead);
    const warmte = await warmteVoorLead(supabaseAdmin, lead, nuMs);

    const rij = {
      lijst      : LIJST_LEADS,
      lead_id    : lead.id,
      reden      : 'lead_bellen',
      bron       : 'lead',
      status     : 'open',
      due        : vandaag,
      later      : false,
      naam       : naamVan(lead),
      telefoon   : telefoonNlBe(tel, { bron: 'opvolging-leads-kaart' }),
      email      : lead.email || null,
      bron_ref   : { lead_id: lead.id, product: p.product, variant: p.variant, bron: lead.bron || null },
      badge_label: p.product || null,
      notitie    : bouwKaartNotitie({ warmte, vandaag }),
    };

    const { data: nieuw, error: iErr } = await supabaseAdmin
      .from('opvolging_taken').insert(rij).select('*').maybeSingle();
    if (iErr) {
      // Twee klikken tegelijk: de unieke index won. Geef de kaart die er staat.
      if (iErr.code === '23505') {
        const opnieuw = await zoekKaart(leadId);
        if (opnieuw.lopend) {
          return res.status(200).json({ ok: true, taak_id: opnieuw.lopend.id, bestond: true, taak: opnieuw.lopend });
        }
      }
      throw new Error('kaart aanmaken: ' + iErr.message);
    }

    // De brug kent het nummer pas na zijn volgende ronde (elke 5 min). Vraag
    // hem nu al te verversen; lukt dat niet, dan is dat geen fout van deze kaart.
    await brugLeadlijstVerversen();

    return res.status(200).json({ ok: true, taak_id: nieuw.id, bestond: false, taak: nieuw });
  } catch (e) {
    console.error('[opvolging-leads-kaart]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}
