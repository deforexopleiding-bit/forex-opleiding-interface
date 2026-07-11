// api/_lib/wanbetalers-sandbox.js
//
// Gedeelde helpers voor alle wanbetalers-sandbox endpoints:
//   - requireSuperAdmin(req, res) — 401/403 gate, returnt user of null
//   - getSandboxCustomer() — huidige (single) test-persoon of null
//   - getSandboxContact() / setSandboxContact() — app_settings-CRUD
//
// Alle sandbox-endpoints zijn super_admin-only. We hergebruiken verifyAdmin()
// uit api/supabase.js en checken profile.role === 'super_admin' expliciet
// (zelfde patroon als api/admin-rbac-backfill-roles.js).

import { supabaseAdmin, verifyAdmin } from '../supabase.js';

const SANDBOX_NAME_PREFIX = '🧪 TEST — ';
const CONTACT_KEY         = 'dunning_sandbox_contact';
const DRY_RUN_KEY         = 'dunning_dry_run';

export async function requireSuperAdmin(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'Method not allowed' });
    return null;
  }
  const admin = await verifyAdmin(req);
  if (!admin) {
    res.status(401).json({ error: 'Niet geauthenticeerd' });
    return null;
  }
  if (admin.profile.role !== 'super_admin') {
    res.status(403).json({ error: 'Alleen super_admin.' });
    return null;
  }
  return admin;
}

export async function getSandboxCustomer() {
  const { data, error } = await supabaseAdmin
    .from('customers')
    .select('id, first_name, last_name, company_name, is_company, email, phone, is_test, created_at')
    .eq('is_test', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error('customers lookup: ' + error.message);
  return data || null;
}

export async function getSandboxContact() {
  const { data } = await supabaseAdmin
    .from('app_settings').select('value').eq('key', CONTACT_KEY).maybeSingle();
  return (data?.value && typeof data.value === 'object') ? data.value : {};
}

export async function setSandboxContact({ phone, email }) {
  const value = { phone: phone || null, email: email || null };
  const { error: sErr } = await supabaseAdmin
    .from('app_settings').select('key').eq('key', CONTACT_KEY).maybeSingle();
  // Upsert-strategie: als de key bestaat → update, anders insert.
  const { error: upErr } = await supabaseAdmin
    .from('app_settings').upsert({ key: CONTACT_KEY, value }, { onConflict: 'key' });
  if (upErr) throw new Error('contact save: ' + upErr.message);
  return value;
}

export async function getDryRun() {
  const { data } = await supabaseAdmin
    .from('app_settings').select('value').eq('key', DRY_RUN_KEY).maybeSingle();
  const enabled = data?.value?.enabled;
  return enabled === false ? false : true; // default AAN
}

export async function setDryRun(enabled) {
  const value = { enabled: !!enabled };
  const { error: upErr } = await supabaseAdmin
    .from('app_settings').upsert({ key: DRY_RUN_KEY, value }, { onConflict: 'key' });
  if (upErr) throw new Error('dry_run save: ' + upErr.message);
  return value;
}

export function sandboxDisplayName(rawName) {
  const s = String(rawName || '').trim() || 'Sandbox';
  return SANDBOX_NAME_PREFIX + s;
}

export function isSandboxCustomer(customer) {
  return !!(customer && customer.is_test === true);
}
