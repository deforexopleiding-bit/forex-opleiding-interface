// api/lead-handmatig-toevoegen.js
// POST → handmatig een lead toevoegen MET echte LMS-toegang.
// Permission: leads.update.
//
// Doet, server-side met de service role (spiegelt geefToegang uit dfo-website):
//   1) leads-rij (bron='handmatig', soort/traject = primair gegund product);
//   2) account: auth-user (createUser, email_confirm=true → OTP-login werkt
//      meteen) + lms_gebruikers, gekoppeld via lead_id;
//   3) één of meer lms_toegang-grants met begin/einddatum voor de gekozen
//      ACTIEVE lms_producten (upsert, dedup op gebruiker_id+product_id).
//
// Body: { voornaam?, achternaam?, email, telefoon?,
//         producten: [ { slug, van: 'YYYY-MM-DD', tot: 'YYYY-MM-DD' }, ... ] }
// Het EERSTE product is het primaire (bepaalt soort/traject op de lead).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { vindOfMaakAccount, zetGrant, telefoonE164, vanIso, totIso } from './_lib/lms-provisioning.js';

const EMAIL_RE = /.+@.+\..+/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  const email = String(body.email || '').trim().toLowerCase();
  const voornaam = body.voornaam ? String(body.voornaam).trim() : null;
  const achternaam = body.achternaam ? String(body.achternaam).trim() : null;
  const telefoon = body.telefoon ? String(body.telefoon).trim() : null;
  const gekozen = Array.isArray(body.producten) ? body.producten : [];

  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Geldig e-mailadres vereist' });
  if (!gekozen.length) return res.status(400).json({ error: 'Kies minstens één product' });
  for (const p of gekozen) {
    if (!p || !p.slug) return res.status(400).json({ error: 'Product zonder slug' });
    if (!DATE_RE.test(String(p.van || '')) || !DATE_RE.test(String(p.tot || ''))) {
      return res.status(400).json({ error: `Begin/einddatum ontbreekt of ongeldig voor ${p.slug}` });
    }
    if (p.van > p.tot) return res.status(400).json({ error: `Einddatum vóór begindatum voor ${p.slug}` });
  }

  try {
    // Valideer dat alle gekozen producten bestaan én actief zijn.
    const slugs = [...new Set(gekozen.map(p => String(p.slug)))];
    const { data: prod, error: pErr } = await supabaseAdmin
      .from('lms_producten').select('id, slug, actief').in('slug', slugs);
    if (pErr) throw new Error('lms_producten: ' + pErr.message);
    const bySlug = new Map((prod || []).filter(p => p.actief).map(p => [p.slug, p]));
    for (const s of slugs) {
      if (!bySlug.has(s)) return res.status(400).json({ error: `Onbekend of inactief product: ${s}` });
    }

    const primair = String(gekozen[0].slug);

    // 1) LEAD aanmaken.
    const { data: lead, error: lErr } = await supabaseAdmin.from('leads').insert({
      voornaam, achternaam, email, telefoon, telefoon_e164: telefoonE164(telefoon),
      bron: 'handmatig', soort: primair, traject: primair,
      afwijzer: false, antwoorden: [], status: 'nieuw', toestemming: false,
    }).select('id').single();
    if (lErr) throw new Error('leads insert: ' + lErr.message);
    const leadId = lead.id;

    // 2) ACCOUNT (venster envelopeert alle grants, voor legacy venster-checks).
    const van = gekozen.map(p => p.van).sort()[0];
    const tot = gekozen.map(p => p.tot).sort().slice(-1)[0];
    const { id: gebruikerId } = await vindOfMaakAccount({
      email, voornaam, achternaam, leadId, van: vanIso(van), tot: totIso(tot),
    });

    // 3) GRANTS voor elk gekozen product.
    for (const p of gekozen) {
      await zetGrant({
        gebruikerId, productId: bySlug.get(String(p.slug)).id,
        van: vanIso(p.van), tot: totIso(p.tot),
      });
    }

    return res.status(200).json({ ok: true, lead_id: leadId, gebruiker_id: gebruikerId });
  } catch (e) {
    console.error('[lead-handmatig-toevoegen]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
