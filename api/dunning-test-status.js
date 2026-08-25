// GET /api/dunning-test-status
//
// Cockpit-init voor de Dunning Test Cockpit. Super_admin-only.
// Retourneert de sandbox-contact-config, de dry-run-schakelaar, de
// tellingen van test-data en de laatste 20 audit-rijen. UI gebruikt
// `ready`/`blockers` om te bepalen of de cockpit veilig te gebruiken is.

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin, getSandboxContact } from './_lib/wanbetalers-sandbox.js';
// Splitsing 2026-08-25: cockpit toont beide vlaggen. De 'dry_run_enabled'-key
// verwijst nu autoritatief naar de TEST-vlag (wat de cockpit-UI wil weten);
// 'dry_run_enabled_production' is er als extra transparantie zodat de
// gebruiker ziet of productie ook nog gate't.
import { isDryRunEnabled, isTestDryRunEnabled } from './_lib/dunning-dry-run.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  const contact       = await getSandboxContact();
  const dryRunTest    = await isTestDryRunEnabled();
  const dryRunProd    = await isDryRunEnabled();

  const [customersRes, invoicesRes, auditRes] = await Promise.all([
    supabaseAdmin.from('customers').select('id', { count: 'exact', head: true }).eq('is_test', true),
    supabaseAdmin.from('invoices').select('id',  { count: 'exact', head: true }).eq('is_test', true),
    supabaseAdmin.from('test_cockpit_audit')
      .select('id, action, status, admin_email, target, error_message, created_at')
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  const blockers = [];
  if (!contact?.phone) blockers.push('sandbox_contact.phone niet geconfigureerd — cockpit weigert WA-verzending');
  if (!contact?.email) blockers.push('sandbox_contact.email niet geconfigureerd — cockpit weigert email-verzending');

  return res.status(200).json({
    ready:                        blockers.length === 0,
    blockers,
    sandbox_contact:              contact || {},
    dry_run_enabled:              !!dryRunTest,      // TEST-vlag (autoritatief voor cockpit-UI)
    dry_run_enabled_production:   !!dryRunProd,      // productie-vlag (transparantie)
    test_customer_count:          customersRes.count || 0,
    test_invoice_count:           invoicesRes.count || 0,
    recent_audit:                 auditRes.data || [],
  });
}
