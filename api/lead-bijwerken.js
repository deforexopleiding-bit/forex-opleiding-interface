// api/lead-bijwerken.js
// POST → een lead bewerken: basisvelden + e-mail-sync naar het auth-account +
// toegangsbeheer op lms_toegang. Permission: leads.update. Alles via supabaseAdmin.
//
// Body:
//   { lead_id,
//     voornaam?, achternaam?, email, telefoon?,
//     grants?: [ { slug, van, tot, intrekken? } ],  // BESTAANDE grants: datums / intrekken
//     nieuw?:  [ { slug, van, tot } ] }              // producten TOEVOEGEN (moeten actief zijn)
//
// - E-mail-sync: wijzigt de email en er is een gekoppeld auth-account, dan óók
//   admin.updateUserById + lms_gebruikers bijwerken. Botsing (adres al in gebruik)
//   -> 409, en NIETS half doorvoeren (auth-update gebeurt vóór de DB-writes).
// - Intrekken = toegang_tot op now() (verlopen), NOOIT hard verwijderen.
// - Auth-accounts worden nooit verwijderd.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { vindOfMaakAccount, zetGrant, telefoonE164, vanIso, totIso } from './_lib/lms-provisioning.js';

const EMAIL_RE = /.+@.+\..+/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.update'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.update)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const leadId = String(body.lead_id || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const voornaam = body.voornaam ? String(body.voornaam).trim() : null;
  const achternaam = body.achternaam ? String(body.achternaam).trim() : null;
  const telefoon = body.telefoon ? String(body.telefoon).trim() : null;
  // Herkomst (Feature 2) = leads.soort; alleen bijwerken als de dropdown een
  // waarde meestuurt (leeg -> niet overschrijven).
  const herkomst = body.herkomst ? String(body.herkomst).trim() : null;
  const grants = Array.isArray(body.grants) ? body.grants : [];
  const nieuw = Array.isArray(body.nieuw) ? body.nieuw : [];

  if (!UUID_RE.test(leadId)) return res.status(400).json({ error: 'lead_id ongeldig' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Geldig e-mailadres vereist' });
  const okDatum = (p, eisTot) => DATE_RE.test(String(p.van || '')) &&
    (!eisTot || DATE_RE.test(String(p.tot || ''))) &&
    (!eisTot || p.van <= p.tot);
  for (const g of grants) {
    if (!g || !g.slug) return res.status(400).json({ error: 'Grant zonder slug' });
    if (!g.intrekken && !okDatum(g, true)) return res.status(400).json({ error: `Ongeldige datums voor ${g.slug}` });
  }
  for (const p of nieuw) {
    if (!p || !p.slug) return res.status(400).json({ error: 'Nieuw product zonder slug' });
    if (!okDatum(p, true)) return res.status(400).json({ error: `Ongeldige datums voor ${p.slug}` });
  }

  try {
    const { data: lead, error: lErr } = await supabaseAdmin
      .from('leads').select('id, email').eq('id', leadId).maybeSingle();
    if (lErr) throw new Error('leads fetch: ' + lErr.message);
    if (!lead) return res.status(404).json({ error: 'Lead niet gevonden' });
    const oudeEmail = (lead.email || '').toLowerCase();

    // Producten valideren: nieuw moet ACTIEF; grants mogen op bestaande (evt.
    // inactieve) producten zitten. Eén lookup over alle betrokken slugs.
    const alleSlugs = [...new Set([...grants, ...nieuw].map(x => String(x.slug)))];
    const bySlug = new Map();
    if (alleSlugs.length) {
      const { data: prod, error: pErr } = await supabaseAdmin
        .from('lms_producten').select('id, slug, actief').in('slug', alleSlugs);
      if (pErr) throw new Error('lms_producten: ' + pErr.message);
      (prod || []).forEach(p => bySlug.set(p.slug, p));
    }
    for (const p of nieuw) {
      const pr = bySlug.get(String(p.slug));
      if (!pr || !pr.actief) return res.status(400).json({ error: `Onbekend of inactief product: ${p.slug}` });
    }
    for (const g of grants) {
      if (!bySlug.has(String(g.slug))) return res.status(400).json({ error: `Onbekend product: ${g.slug}` });
    }

    // Account zoeken (op lead_id, anders op oude email).
    let account = null;
    const { data: opLead } = await supabaseAdmin
      .from('lms_gebruikers').select('id, auth_id, email').eq('lead_id', leadId).maybeSingle();
    account = opLead || null;
    if (!account && oudeEmail) {
      const { data: opMail } = await supabaseAdmin
        .from('lms_gebruikers').select('id, auth_id, email').eq('email', oudeEmail).maybeSingle();
      account = opMail || null;
    }

    // E-MAIL-SYNC eerst (voordat we iets schrijven), zodat een botsing niets
    // half doorvoert.
    const emailGewijzigd = email !== oudeEmail;
    if (emailGewijzigd && account?.auth_id) {
      const { error: aErr } = await supabaseAdmin.auth.admin.updateUserById(account.auth_id, { email });
      if (aErr) {
        const msg = (aErr.message || '').toLowerCase();
        if (msg.includes('already') || msg.includes('registered') || aErr.status === 422 || aErr.code === 'email_exists') {
          return res.status(409).json({ error: 'Dit e-mailadres is al in gebruik door een ander account.' });
        }
        throw new Error('auth updateUserById: ' + aErr.message);
      }
    }

    // 1) Basisvelden op de lead. Met de unieke index op lower(email) kan een
    // e-mailwijziging botsen met een andere lead → 23505. Vang dat netjes af
    // als 409 (zoals de account-collisie hierboven) i.p.v. een generieke 500.
    const { error: uErr } = await supabaseAdmin.from('leads').update({
      voornaam, achternaam, email, telefoon, telefoon_e164: telefoonE164(telefoon),
      ...(herkomst ? { soort: herkomst } : {}),
    }).eq('id', leadId);
    if (uErr) {
      if (uErr.code === '23505' || /duplicate key|leads_email_uniek/i.test(uErr.message || '')) {
        return res.status(409).json({ error: 'Dit e-mailadres is al in gebruik door een andere lead.' });
      }
      throw new Error('leads update: ' + uErr.message);
    }

    // 2) Account bijwerken (email + naam) als het bestaat.
    if (account) {
      await supabaseAdmin.from('lms_gebruikers')
        .update({ email, voornaam, achternaam, lead_id: leadId })
        .eq('id', account.id);
    }

    // 3) Toegangsbeheer.
    let gebruikerId = account?.id || null;

    // Nieuwe producten: maak zonodig eerst een account (met venster om de grants).
    if (nieuw.length && !gebruikerId) {
      const van = nieuw.map(p => p.van).sort()[0];
      const tot = nieuw.map(p => p.tot).sort().slice(-1)[0];
      const res2 = await vindOfMaakAccount({ email, voornaam, achternaam, leadId, van: vanIso(van), tot: totIso(tot) });
      gebruikerId = res2.id;
    }

    if (gebruikerId) {
      // Bestaande grants: datums bijstellen of intrekken (tot = now()).
      const nu = new Date().toISOString();
      for (const g of grants) {
        const pid = bySlug.get(String(g.slug)).id;
        await zetGrant({
          gebruikerId, productId: pid,
          van: vanIso(g.van || String(nu).slice(0, 10)),
          tot: g.intrekken ? nu : totIso(g.tot),
        });
      }
      // Nieuwe producten toevoegen.
      for (const p of nieuw) {
        await zetGrant({ gebruikerId, productId: bySlug.get(String(p.slug)).id, van: vanIso(p.van), tot: totIso(p.tot) });
      }
    }

    return res.status(200).json({ ok: true, lead_id: leadId, gebruiker_id: gebruikerId });
  } catch (e) {
    console.error('[lead-bijwerken]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
