// api/leadsonderhoud-opstartsessie-create.js
//
// POST — "+ Nieuwe call handmatig inplannen" vanuit Opstartsessies/Agenda.
//
// BP3 v22 (2026-09-03) — één endpoint voor drie ingang-paden zodat de UI
// consistent blijft:
//   Path A — bestaande lead   → { mode:'lead',     lead_id,     scheduledAt, durationMinutes?, source_slug? }
//   Path B — bestaande klant  → { mode:'customer', customer_id, scheduledAt, durationMinutes?, source_slug? }
//                              (upsert lightweight lead met customer_id gelinkt, dan Path A)
//   Path C — handmatig contact→ { mode:'contact', contact:{voornaam?,achternaam?,email,telefoon?},
//                                scheduledAt, durationMinutes?, source_slug? }
//                              (GHL contacts/upsert → upsert_lead → source_ref.ghl_contact_id gezet, dan Path A)
//
// Response 200:
//   { ok:true, follow_up_appointment_id, ghl_appointment_id, lead_id,
//     zoom_meeting_id, zoom_join_url }
// Errors: 400 BAD_INPUT / 401 / 403 / 404 / 422 GHL_CONFIG_MISSING /
//         422 NO_GHL_CONTACT (Path A zonder ghl_contact_id) /
//         502 GHL_API / 500.
//
// Auth: leads.update (Romy + Dave + management). Setter-attributie:
//   - profile.role === 'appointmentsetter'   → forceer setter_user_id = user.id
//     (post-write UPDATE); dit garandeert dat een appointmentsetter zijn eigen
//     call later ook kan wijzigen/annuleren (scope-guard eist self-owned).
//   - Anders → bestaande booking_sources.owner_user_id-mapping in de lib
//     handhaaft attributie.
//
// INCASSO-VEILIG: raakt alleen follow_up_appointments (via lib) + leads +
// evt. customers.ghl_contact_id. Geen finance/dunning/arrangement/pending-
// action/mentor.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  createAppointmentForLead,
  ghlUpsertContact,
  mapGhlError,
} from './_lib/create-appointment-from-lead.js';
import { telefoonE164 } from './_lib/lms-provisioning.js';

const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /.+@.+\..+/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.update'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.update)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const mode = String(body.mode || '').trim().toLowerCase();
  const scheduledAt = String(body.scheduledAt || '').trim();
  const durationMinutes = Number.isFinite(Number(body.durationMinutes))
    ? Math.max(15, Math.min(120, Number(body.durationMinutes)))
    : 30;
  const source_slug = (typeof body.source_slug === 'string' && body.source_slug.trim())
    ? body.source_slug.trim().toLowerCase()
    : null;

  if (!['lead', 'customer', 'contact'].includes(mode)) {
    return res.status(400).json({ error: "mode moet 'lead' | 'customer' | 'contact' zijn" });
  }
  if (!scheduledAt || isNaN(new Date(scheduledAt).getTime())) {
    return res.status(400).json({ error: 'scheduledAt (ISO) vereist' });
  }
  if (new Date(scheduledAt).getTime() < Date.now() - 5 * 60 * 1000) {
    return res.status(400).json({ error: 'scheduledAt ligt in het verleden' });
  }

  try {
    let leadRow = null;

    // ─── Path A ─────────────────────────────────────────────────────────
    if (mode === 'lead') {
      const leadId = String(body.lead_id || '').trim();
      if (!UUID_RE.test(leadId)) return res.status(400).json({ error: 'lead_id (uuid) vereist' });
      const { data, error } = await supabaseAdmin
        .from('leads')
        .select('id, naam, voornaam, achternaam, email, telefoon, customer_id, source_ref, owner_id')
        .eq('id', leadId).maybeSingle();
      if (error) throw new Error('leads-lookup: ' + error.message);
      if (!data)  return res.status(404).json({ error: 'Lead niet gevonden' });
      leadRow = data;
    }

    // ─── Path B ─────────────────────────────────────────────────────────
    // Zoek eerst of er al een lead voor deze klant/email bestaat; anders
    // upsert lightweight lead met customer_id link.
    if (mode === 'customer') {
      const customerId = String(body.customer_id || '').trim();
      if (!UUID_RE.test(customerId)) return res.status(400).json({ error: 'customer_id (uuid) vereist' });

      const { data: cust, error: cErr } = await supabaseAdmin
        .from('customers')
        .select('id, first_name, last_name, email, phone, ghl_contact_id')
        .eq('id', customerId).maybeSingle();
      if (cErr) throw new Error('customers-lookup: ' + cErr.message);
      if (!cust) return res.status(404).json({ error: 'Klant niet gevonden' });

      // Bestaande lead op deze klant?
      let { data: existingLead } = await supabaseAdmin
        .from('leads')
        .select('id, naam, voornaam, achternaam, email, telefoon, customer_id, source_ref, owner_id')
        .eq('customer_id', customerId).order('created_at', { ascending: false }).limit(1).maybeSingle();

      if (!existingLead) {
        // upsert_lead RPC verwacht bron+soort+traject; gebruik 'handmatig' /
        // 'opstartsessie' / 'opstartsessie' als vaste labels.
        const upsertPayload = {
          voornaam       : cust.first_name || null,
          achternaam     : cust.last_name  || null,
          email          : String(cust.email || '').trim().toLowerCase() || null,
          telefoon       : cust.phone || null,
          telefoon_e164  : telefoonE164(cust.phone),
          bron           : 'handmatig',
          soort          : 'opstartsessie',
          traject        : 'opstartsessie',
        };
        if (!upsertPayload.email) return res.status(400).json({ error: 'Klant heeft geen e-mail — kan geen lead aanmaken' });
        const { data: rpcLead, error: rpcErr } = await supabaseAdmin.rpc('upsert_lead', { p: upsertPayload });
        if (rpcErr) throw new Error('upsert_lead (customer→lead): ' + rpcErr.message);
        const newLeadId = rpcLead?.id;
        if (!newLeadId) throw new Error('upsert_lead retourneerde geen id');
        // Link customer_id + evt. source_ref met ghl_contact_id.
        const patch = { customer_id: customerId };
        if (cust.ghl_contact_id) patch.source_ref = { ghl_contact_id: cust.ghl_contact_id };
        await supabaseAdmin.from('leads').update(patch).eq('id', newLeadId);
        const { data: reload } = await supabaseAdmin
          .from('leads')
          .select('id, naam, voornaam, achternaam, email, telefoon, customer_id, source_ref, owner_id')
          .eq('id', newLeadId).maybeSingle();
        leadRow = reload;
      } else {
        leadRow = existingLead;
      }
    }

    // ─── Path C ─────────────────────────────────────────────────────────
    if (mode === 'contact') {
      const contact = (body.contact && typeof body.contact === 'object') ? body.contact : null;
      if (!contact) return res.status(400).json({ error: 'contact-object vereist' });
      const email      = String(contact.email      || '').trim().toLowerCase();
      const voornaam   = contact.voornaam   ? String(contact.voornaam).trim()   : null;
      const achternaam = contact.achternaam ? String(contact.achternaam).trim() : null;
      const telefoon   = contact.telefoon   ? String(contact.telefoon).trim()   : null;
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Geldig e-mailadres vereist voor handmatig contact' });

      // 1) GHL contacts/upsert — geeft ghl_contact_id (dedupe op e-mail/tel).
      let ghlContactId;
      try {
        ghlContactId = await ghlUpsertContact({
          email, phone: telefoon, firstName: voornaam, lastName: achternaam,
        });
      } catch (e) {
        if (e?.code === 'GHL_CONFIG_MISSING') {
          return res.status(422).json({ error: 'GHL-configuratie ontbreekt op de server (GHL_LOCATION_ID/GHL_PIT_TOKEN)' });
        }
        const nl = (typeof mapGhlError === 'function')
          ? mapGhlError(e?.ghlStatus, e?.ghlBody)
          : ('GHL contact-upsert-fout (' + (e?.ghlStatus || '?') + ')');
        return res.status(502).json({ error: nl || 'GHL contact-upsert-fout', ghlStatus: e?.ghlStatus || null });
      }

      // 2) upsert_lead RPC (unieke lower(email)); source_ref met ghl_contact_id
      //    zodat createAppointmentForLead 'em direct vindt (skipt customer-lookup).
      const { data: rpcLead, error: rpcErr } = await supabaseAdmin.rpc('upsert_lead', {
        p: {
          voornaam, achternaam, email, telefoon,
          telefoon_e164: telefoonE164(telefoon),
          bron: 'handmatig', soort: 'opstartsessie', traject: 'opstartsessie',
        },
      });
      if (rpcErr) throw new Error('upsert_lead (contact): ' + rpcErr.message);
      const newLeadId = rpcLead?.id;
      if (!newLeadId) throw new Error('upsert_lead retourneerde geen id');

      // 3) Merge source_ref (behoud eventuele bestaande sleutels).
      const { data: preLead } = await supabaseAdmin
        .from('leads').select('source_ref').eq('id', newLeadId).maybeSingle();
      const prevRef = (preLead && preLead.source_ref && typeof preLead.source_ref === 'object')
        ? preLead.source_ref : {};
      const newRef = { ...prevRef, ghl_contact_id: ghlContactId };
      await supabaseAdmin.from('leads').update({ source_ref: newRef }).eq('id', newLeadId);

      const { data: reload } = await supabaseAdmin
        .from('leads')
        .select('id, naam, voornaam, achternaam, email, telefoon, customer_id, source_ref, owner_id')
        .eq('id', newLeadId).maybeSingle();
      leadRow = reload;
    }

    if (!leadRow) return res.status(500).json({ error: 'Interne fout: geen lead-row geproduceerd' });

    // ─── Aanmaak via bestaande lib ─────────────────────────────────────
    let result;
    try {
      result = await createAppointmentForLead({
        lead: leadRow,
        scheduledAt,
        durationMinutes,
        source: source_slug,
      });
    } catch (e) {
      if (e?.code === 'BAD_INPUT')         return res.status(400).json({ error: e.message });
      if (e?.code === 'NO_GHL_CONTACT')    return res.status(422).json({ code: 'NO_GHL_CONTACT', error: 'Geen GHL-contact voor deze lead — kies handmatig-contact-pad of vul e-mail/telefoon aan.' });
      if (e?.code === 'GHL_CONFIG_MISSING')return res.status(422).json({ error: 'GHL-configuratie ontbreekt (GHL_CALENDAR_ID / GHL_LOCATION_ID)' });
      if (e?.code === 'GHL_API') {
        const nl = (typeof mapGhlError === 'function') ? mapGhlError(e.ghlStatus, e.ghlBody) : ('GHL API-fout (' + (e.ghlStatus || '?') + ')');
        return res.status(502).json({ error: nl || 'GHL API-fout', ghlStatus: e.ghlStatus || null });
      }
      throw e;
    }

    // Setter-override: appointmentsetter mag zichzelf altijd als setter zetten
    // zodat de scope-guard 'em later toestaat de eigen call te wijzigen.
    const apptId = result?.follow_up_appointment_id || result?.appointmentId || null;
    if (apptId) {
      try {
        const { data: prof } = await supabaseAdmin
          .from('profiles').select('role').eq('id', user.id).maybeSingle();
        if (String(prof?.role || '').toLowerCase() === 'appointmentsetter') {
          await supabaseAdmin
            .from('follow_up_appointments')
            .update({ setter_user_id: user.id })
            .eq('id', apptId);
        }
      } catch (e) {
        console.warn('[opstartsessie-create] setter-override (soft):', e?.message || e);
      }
    }

    return res.status(200).json({
      ok: true,
      follow_up_appointment_id: apptId,
      ghl_appointment_id:       result?.ghl_appointment_id || result?.ghl_id || null,
      lead_id:                  leadRow.id,
      zoom_meeting_id:          result?.zoom_meeting_id || null,
      zoom_join_url:            result?.zoom_join_url   || null,
    });
  } catch (e) {
    console.error('[opstartsessie-create] exception:', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
