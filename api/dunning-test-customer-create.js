// POST /api/dunning-test-customer-create
//
// Maakt één is_test=true customer aan voor de test-cockpit.
// Super_admin-only. Volgt exact hetzelfde INSERT-pattern als
// wanbetalers-sandbox-seed (first_name, last_name:'', email, phone,
// is_company:false, is_test:true), zodat de test-omgeving consistent
// blijft met de bestaande sandbox-flow.
//
// De opgegeven phone/email worden NOOIT gebruikt voor daadwerkelijke
// verzending — die routeert altijd via dunning_sandbox_contact. Deze
// velden dienen alleen ter herkenning in overzichten.
//
// Body: { full_name: string, email?: string, phone?: string }

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin } from './_lib/wanbetalers-sandbox.js';

const TEST_NAME_PREFIX = '🧪 TEST — ';

async function audit({ actor, payload, result, status, error }) {
  try {
    await supabaseAdmin.from('test_cockpit_audit').insert({
      triggered_by: actor?.userId || null,
      admin_email:  actor?.email || null,
      action:       'create_test_customer',
      scope:        'test',
      target:       result?.customer_id ? { customer_id: result.customer_id } : {},
      payload:      payload || {},
      result:       result || {},
      status,
      error_message: error || null,
    });
  } catch (e) {
    console.error('[dunning-test-customer-create] audit insert failed:', e?.message || e);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  const actor = { userId: admin.user.id, email: admin.profile.email };
  const body = req.body || {};

  const rawName = String(body.full_name || '').trim();
  if (!rawName) return res.status(400).json({ error: 'full_name is verplicht.' });

  // Splits naam simpel (eerste woord = voornaam, rest = achternaam). Behoud
  // TEST-prefix in first_name zodat de UI-lijst is_test-customers herkent
  // zonder extra query — consistent met sandboxDisplayName in wanbetalers-
  // sandbox.js.
  const nameParts = rawName.split(/\s+/);
  const firstName = TEST_NAME_PREFIX + nameParts[0];
  const lastName  = nameParts.slice(1).join(' ') || '';

  const email = body.email ? String(body.email).trim() : null;
  const phone = body.phone ? String(body.phone).trim() : null;

  try {
    const { data: created, error: insErr } = await supabaseAdmin
      .from('customers')
      .insert({
        first_name: firstName,
        last_name:  lastName,
        email,
        phone,
        is_company: false,
        is_test:    true,
      })
      .select('id, first_name, last_name, email, phone, is_test, created_at')
      .single();

    if (insErr) {
      await audit({ actor, payload: { full_name: rawName }, status: 'error', error: insErr.message });
      return res.status(500).json({ error: insErr.message });
    }

    await audit({
      actor,
      payload: { full_name: rawName, email: !!email, phone: !!phone },
      result:  { customer_id: created.id },
      status:  'ok',
    });

    return res.status(201).json({
      ok: true,
      customer: created,
      message: 'Test-customer aangemaakt. Verzending routeert altijd via dunning_sandbox_contact.',
    });
  } catch (e) {
    await audit({ actor, payload: { full_name: rawName }, status: 'error', error: e?.message || String(e) });
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
