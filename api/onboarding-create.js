// api/onboarding-create.js
//
// ADMIN — maakt een nieuwe onboarding aan voor een bestaande customer +
// traject. Status start op 'aangemeld'. Token = crypto.randomUUID() →
// gebruikt door /modules/onboarding.html?t=<token> (publieke vragenlijst-
// pagina, komt in Fase 1).
//
// Permission: onboarding.create.
//
// Body:
//   { customer_id (uuid), traject_id (uuid) }
//
// Validaties:
//   - customer_id en traject_id moeten bestaan → anders 400/404.
//   - Guard: er mag GEEN bestaande onboarding zijn voor (customer_id) waarvan
//     status != 'gearchiveerd'. Anders 409 met existing_id zodat de UI naar
//     die bestaande kan navigeren.
//
// Response 200:
//   { ok:true, onboarding:{id, token, status}, link }
//
// (Geen Bubble-call — provisioning komt in Fase 2.)

import crypto from 'node:crypto';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function customerDisplayName(c) {
  if (!c) return null;
  if (c.is_company && c.company_name) return c.company_name;
  const fn = (c.first_name || '').trim();
  const ln = (c.last_name  || '').trim();
  const full = `${fn} ${ln}`.trim();
  return full || c.company_name || null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'onboarding.create'))) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.create)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const customerId = typeof body.customer_id === 'string' ? body.customer_id.trim() : '';
  const trajectId  = typeof body.traject_id  === 'string' ? body.traject_id.trim()  : '';
  if (!UUID_RE.test(customerId)) return res.status(400).json({ error: 'customer_id (uuid) vereist' });
  if (!UUID_RE.test(trajectId))  return res.status(400).json({ error: 'traject_id (uuid) vereist' });

  try {
    // 1) Customer bestaat?
    const { data: cust, error: custErr } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, company_name, is_company')
      .eq('id', customerId)
      .maybeSingle();
    if (custErr) throw new Error('customer lookup: ' + custErr.message);
    if (!cust)  return res.status(404).json({ error: 'Klant niet gevonden' });

    // 2) Traject bestaat (en is_active)?
    const { data: traj, error: trajErr } = await supabaseAdmin
      .from('onboarding_trajecten')
      .select('id, is_active')
      .eq('id', trajectId)
      .maybeSingle();
    if (trajErr) throw new Error('traject lookup: ' + trajErr.message);
    if (!traj)  return res.status(404).json({ error: 'Traject niet gevonden' });
    if (!traj.is_active) return res.status(400).json({ error: 'Traject is niet actief' });

    // 3) Guard: bestaande, niet-gearchiveerde onboarding voor deze klant?
    const { data: existing, error: existErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, status')
      .eq('customer_id', customerId)
      .neq('status', 'gearchiveerd')
      .limit(1)
      .maybeSingle();
    if (existErr) throw new Error('onboarding lookup: ' + existErr.message);
    if (existing) {
      return res.status(409).json({
        error       : 'Er bestaat al een actieve onboarding voor deze klant',
        existing_id : existing.id,
      });
    }

    // 4) Insert.
    const token = crypto.randomUUID();
    const customerName = customerDisplayName(cust) || '';
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('onboardings')
      .insert({
        customer_id  : customerId,
        customer_name: customerName,
        traject_id   : trajectId,
        token,
        status       : 'aangemeld',
        created_by   : user.id,
      })
      .select('id, token, status')
      .single();
    if (insErr) throw new Error('onboarding insert: ' + insErr.message);

    return res.status(200).json({
      ok         : true,
      onboarding : inserted,
      link       : '/modules/onboarding.html?t=' + encodeURIComponent(inserted.token),
    });
  } catch (e) {
    console.error('[onboarding-create]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
