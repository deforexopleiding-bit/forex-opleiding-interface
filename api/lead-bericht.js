// api/lead-bericht.js
//
// "Stuur bericht" (fase 1) — 1-op-1 WhatsApp-template of e-mail naar één lead.
// Gebruikt door de gedeelde popup modules/klanten-v2/views/_stuur-bericht.js
// (Leads → detail, Leadsonderhoud → Contacten). Logica: api/_lib/lead-bericht.js.
//
// GET  ?lead_id=<uuid>
//   → { lead:{ id, naam, email, telefoon, geldig_email, geldig_telefoon },
//       variabelen:{ voornaam, achternaam, naam, email, boekingslink },
//       wa:{ ok, reden?, waba_id, phone_number_id, templates:[…] } }
//   templates = de ECHT goedgekeurde templates op de lead-WABA (live, 360dialog).
// POST { lead_id, kanaal:'whatsapp', template, taal?, variabelen:[…] }
//      { lead_id, kanaal:'mail', onderwerp, html }
//   → 200 { ok, … } | 4xx/5xx { error, code } — nooit stil mislukken.
//
// RBAC: leads.view (zelfde als de bestaande 1-op-1-acties op leads).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  E164_RE, EMAIL_RE, leadVariabelen, waTemplatesVoorLead, verstuurWaTemplate, verstuurMail, LeadBerichtFout,
} from './_lib/lead-bericht.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function laadLead(leadId) {
  const { data: lead, error } = await supabaseAdmin.from('leads')
    .select('id, voornaam, achternaam, email, telefoon_e164, traject, verwijderd_op')
    .eq('id', leadId).maybeSingle();
  if (error) throw new Error('lead lezen: ' + error.message);
  if (!lead) return { lead: null, boekingslink: null };
  let boekingslink = null;
  if (lead.traject) {
    const { data: tr, error: tErr } = await supabaseAdmin.from('onderhoud_trajecten')
      .select('agenda_link').ilike('slug', lead.traject).maybeSingle();
    if (tErr) console.warn('[lead-bericht] traject lezen mislukt:', tErr.message);
    boekingslink = tr?.agenda_link || null;
  }
  return { lead, boekingslink };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) return res.status(403).json({ error: 'Geen rechten (leads.view)' });

  try {
    if (req.method === 'GET') {
      const leadId = String(req.query?.lead_id || '');
      if (!UUID_RE.test(leadId)) return res.status(400).json({ error: 'lead_id ontbreekt of ongeldig' });
      const { lead, boekingslink } = await laadLead(leadId);
      if (!lead) return res.status(404).json({ error: 'Lead niet gevonden' });
      const vars = leadVariabelen(lead, { boekingslink });
      let wa;
      try { wa = await waTemplatesVoorLead(supabaseAdmin, lead, vars); }
      catch (e) { console.error('[lead-bericht] templates laden mislukt:', e?.message || e); wa = { ok: false, reden: 'FOUT', templates: [] }; }
      return res.status(200).json({
        lead: {
          id: lead.id, naam: vars.naam || vars.email || 'Lead', email: lead.email || null, telefoon: lead.telefoon_e164 || null,
          geldig_email: EMAIL_RE.test(String(lead.email || '').trim()), geldig_telefoon: E164_RE.test(String(lead.telefoon_e164 || '').trim()),
          gearchiveerd: !!lead.verwijderd_op,
        },
        variabelen: vars,
        wa,
      });
    }

    if (req.method === 'POST') {
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      const leadId = String(b.lead_id || '');
      if (!UUID_RE.test(leadId)) return res.status(400).json({ error: 'lead_id ontbreekt of ongeldig' });
      const { lead, boekingslink } = await laadLead(leadId);
      if (!lead) return res.status(404).json({ error: 'Lead niet gevonden' });

      if (b.kanaal === 'whatsapp') {
        const r = await verstuurWaTemplate(supabaseAdmin, {
          lead, templateNaam: String(b.template || ''), taal: String(b.taal || 'nl'),
          variabelen: Array.isArray(b.variabelen) ? b.variabelen : [], agent: user.email || user.id,
        });
        return res.status(200).json(r);
      }
      if (b.kanaal === 'mail') {
        const r = await verstuurMail(supabaseAdmin, {
          lead, onderwerp: b.onderwerp, html: b.html, boekingslink, userId: user.id,
        });
        return res.status(200).json(r);
      }
      return res.status(400).json({ error: "kanaal moet 'whatsapp' of 'mail' zijn" });
    }

    return res.status(405).json({ error: 'GET of POST' });
  } catch (e) {
    if (e instanceof LeadBerichtFout) {
      return res.status(e.status).json({ error: e.message, code: e.code, ...(e.onbekend ? { onbekend: e.onbekend } : {}) });
    }
    console.error('[lead-bericht] fout:', e?.message || e);
    return res.status(500).json({ error: 'Bericht versturen mislukt' });
  }
}
