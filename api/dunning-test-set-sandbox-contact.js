// POST /api/dunning-test-set-sandbox-contact
//
// Losstaand super_admin-only endpoint dat ALLEEN de sandbox-contact zet
// (phone + email) in app_settings.dunning_sandbox_contact. Geen side-effect
// op customers/invoices/pipelines — anders dan wanbetalers-sandbox-seed dat
// ook een test-customer + testfacturen creëert.
//
// Pagina-onafhankelijk: kan vanuit elk ingelogd cockpit-tabblad worden
// aangeroepen via window.AgentShared.apiFetch — zonder Bearer-token te
// hoeven kopieren.
//
// Body: { phone?: string|null, email?: string|null }
//   - null of leeg = veld wissen (grendel wordt daarmee fail-closed voor dat
//     channel).
//   - beide leeg = valid input; cockpit weigert daarna alle verzending.

import { supabaseAdmin } from './supabase.js';
import {
  requireSuperAdmin,
  setSandboxContact,
  getSandboxContact,
} from './_lib/wanbetalers-sandbox.js';
import { invalidateDryRunCache } from './_lib/dunning-dry-run.js';

async function audit({ actor, payload, result, status, error }) {
  try {
    await supabaseAdmin.from('test_cockpit_audit').insert({
      triggered_by: actor?.userId || null,
      admin_email:  actor?.email || null,
      action:       'set_sandbox_contact',
      scope:        'test',
      target:       {},
      payload:      payload || {},
      result:       result || {},
      status,
      error_message: error || null,
    });
  } catch (e) {
    console.error('[dunning-test-set-sandbox-contact] audit insert failed:', e?.message || e);
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

  // Normaliseer input: undefined blijft weg, null/'' → null (wissen).
  const phone = (body.phone === undefined) ? undefined
              : (body.phone === null || body.phone === '' ? null : String(body.phone).trim());
  const email = (body.email === undefined) ? undefined
              : (body.email === null || body.email === '' ? null : String(body.email).trim());

  // We schrijven de HELE contact-key, dus lees eerst wat er staat en merge
  // enkel de meegegeven velden. Zo overschrijft "alleen phone meesturen" niet
  // stiekem de email.
  const current = await getSandboxContact();
  const next = {
    phone: (phone !== undefined) ? phone : (current?.phone ?? null),
    email: (email !== undefined) ? email : (current?.email ?? null),
  };

  try {
    const saved = await setSandboxContact(next);
    invalidateDryRunCache();
    await audit({
      actor,
      payload: { phone_changed: phone !== undefined, email_changed: email !== undefined },
      result:  { saved },
      status:  'ok',
    });
    return res.status(200).json({
      ok: true,
      sandbox_contact: saved,
      message: 'Sandbox-contact bijgewerkt. Grendel gebruikt deze waarde meteen.',
    });
  } catch (e) {
    await audit({
      actor,
      payload: { phone_changed: phone !== undefined, email_changed: email !== undefined },
      status:  'error',
      error:   e?.message || String(e),
    });
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
