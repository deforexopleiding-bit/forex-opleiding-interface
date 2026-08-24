// api/_lib/test-cockpit-send.js
//
// Fail-closed wrapper voor scope=test-verzendingen. Elke echte outbound in
// het cockpit-pad MOET hierdoor. Drie lagen:
//   L1 — sandbox-contact leeg / to leeg → hard throw.
//   L2 — eigen expliciete recipient-check tegen dunning_sandbox_contact
//        (onafhankelijk van assertRecipientMatchesSandbox; die kan in
//         sommige paden warn-then-skip doen — wij vertrouwen daar niet op).
//   L3 — extra defense-in-depth via assertRecipientMatchesSandbox.
//
// Dependency injection: `overrides.contact` en `overrides.dryRun` bestaan
// UITSLUITEND voor het bewijs-endpoint dunning-test-verify-grendel.js.
// De cockpit-endpoints gebruiken ze nooit — als een productieoproep ze
// meegeeft is dat een ernstige bug en moet in code review geweigerd worden.
//
// Elke aanroep (send, blocked, dry-run-skip) landt in test_cockpit_audit.

import { supabaseAdmin } from '../supabase.js';
import { sendText, sendTemplate } from './meta-whatsapp.js';
import { sendEmailViaSmtp } from './send-email-core.js';
import {
  assertRecipientMatchesSandbox,
  isDryRunEnabled,
} from './dunning-dry-run.js';
import { getSandboxContact } from './wanbetalers-sandbox.js';

// ── Eigen normalisatie (bewust simpel + strict) ─────────────────────────────
function normPhone(p) {
  const digits = String(p || '').replace(/\D+/g, '');
  return digits.replace(/^0+/, '');
}
function phoneEquals(a, b) {
  const na = normPhone(a), nb = normPhone(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // NL-fallback: laatste 9 digits (dekt +316… vs 06… vs 316…).
  if (na.length >= 9 && nb.length >= 9) return na.slice(-9) === nb.slice(-9);
  return false;
}
function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}
function emailEquals(a, b) {
  const na = normEmail(a), nb = normEmail(b);
  return !!na && na === nb;
}

// ── Audit ───────────────────────────────────────────────────────────────────
async function audit({ actor, action, target, payload, result, status, error }) {
  try {
    await supabaseAdmin.from('test_cockpit_audit').insert({
      triggered_by: actor?.userId || null,
      admin_email:  actor?.email || null,
      action,
      scope:        'test',
      target:       target || {},
      payload:      payload || {},
      result:       result || {},
      status,
      error_message: error || null,
    });
  } catch (e) {
    console.error('[test-cockpit-send] audit insert failed:', e?.message || e);
  }
}

// ── Eigen recipient-check (L2), hard throw ─────────────────────────────────
async function assertRecipientOwn({ to, channel, overrides }) {
  const contact = overrides?.contact
    ?? await getSandboxContact();

  if (!contact || (!contact.phone && !contact.email)) {
    throw new Error('[test-cockpit-send] fail-closed: dunning_sandbox_contact niet geconfigureerd.');
  }
  if (!to) {
    throw new Error('[test-cockpit-send] fail-closed: geen recipient meegegeven.');
  }

  if (channel === 'whatsapp') {
    if (!contact.phone) {
      throw new Error('[test-cockpit-send] fail-closed: sandbox.phone ontbreekt.');
    }
    if (!phoneEquals(contact.phone, to)) {
      throw new Error(`[test-cockpit-send] recipient-mismatch (wa): to=${to} != sandbox=${contact.phone}`);
    }
    return;
  }
  if (channel === 'email') {
    if (!contact.email) {
      throw new Error('[test-cockpit-send] fail-closed: sandbox.email ontbreekt.');
    }
    if (!emailEquals(contact.email, to)) {
      throw new Error(`[test-cockpit-send] recipient-mismatch (email): to=${to} != sandbox=${contact.email}`);
    }
    return;
  }
  throw new Error(`[test-cockpit-send] fail-closed: onbekend channel '${channel}'`);
}

async function isDryRunEffective(overrides) {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, 'dryRun')) {
    return !!overrides.dryRun;
  }
  return await isDryRunEnabled();
}

// ── Publieke API ────────────────────────────────────────────────────────────

/**
 * Verstuur WA-tekst naar sandbox-contact. Weigert hard bij mismatch/lege config.
 * @param {object} p
 * @param {{userId?:string,email?:string}} [p.actor]
 * @param {string} p.to
 * @param {string} p.body
 * @param {object} [p.target]
 * @param {{contact?:object,dryRun?:boolean}} [p.overrides] — alleen voor verify-grendel.
 * @returns {Promise<{ok:true, wamid?:string, dryRun?:boolean}>}
 */
export async function sendTestWaText({ actor, to, body, target, overrides }) {
  try {
    await assertRecipientOwn({ to, channel: 'whatsapp', overrides });
  } catch (e) {
    await audit({ actor, action: 'send_wa_text', target, payload: { to }, status: 'blocked', error: e.message });
    throw e;
  }
  // L3: bestaande assert — sla over bij overrides (die leest live app_settings).
  if (!overrides) {
    try {
      await assertRecipientMatchesSandbox({ isTest: true, actual: to, channel: 'whatsapp' });
    } catch (e) {
      await audit({ actor, action: 'send_wa_text', target, payload: { to }, status: 'blocked', error: 'L3:' + e.message });
      throw e;
    }
  }
  if (await isDryRunEffective(overrides)) {
    await audit({ actor, action: 'send_wa_text', target, payload: { to, body_preview: String(body || '').slice(0, 60) }, result: { dryRun: true }, status: 'ok' });
    return { ok: true, dryRun: true };
  }
  const r = await sendText({ to, body });
  await audit({ actor, action: 'send_wa_text', target, payload: { to }, result: { wamid: r.wamid }, status: 'ok' });
  return { ok: true, wamid: r.wamid };
}

export async function sendTestWaTemplate({ actor, to, templateName, languageCode, variables, components, target, overrides }) {
  try {
    await assertRecipientOwn({ to, channel: 'whatsapp', overrides });
  } catch (e) {
    await audit({ actor, action: 'send_wa_template', target, payload: { to, templateName }, status: 'blocked', error: e.message });
    throw e;
  }
  if (!overrides) {
    try {
      await assertRecipientMatchesSandbox({ isTest: true, actual: to, channel: 'whatsapp' });
    } catch (e) {
      await audit({ actor, action: 'send_wa_template', target, payload: { to, templateName }, status: 'blocked', error: 'L3:' + e.message });
      throw e;
    }
  }
  if (await isDryRunEffective(overrides)) {
    await audit({ actor, action: 'send_wa_template', target, payload: { to, templateName }, result: { dryRun: true }, status: 'ok' });
    return { ok: true, dryRun: true };
  }
  const r = await sendTemplate({ to, templateName, languageCode, variables, components });
  await audit({ actor, action: 'send_wa_template', target, payload: { to, templateName }, result: { wamid: r.wamid }, status: 'ok' });
  return { ok: true, wamid: r.wamid };
}

export async function sendTestEmail({ actor, fromMailbox, to, subject, text, html, target, overrides }) {
  try {
    await assertRecipientOwn({ to, channel: 'email', overrides });
  } catch (e) {
    await audit({ actor, action: 'send_email', target, payload: { to, subject }, status: 'blocked', error: e.message });
    throw e;
  }
  if (!overrides) {
    try {
      await assertRecipientMatchesSandbox({ isTest: true, actual: to, channel: 'email' });
    } catch (e) {
      await audit({ actor, action: 'send_email', target, payload: { to, subject }, status: 'blocked', error: 'L3:' + e.message });
      throw e;
    }
  }
  if (await isDryRunEffective(overrides)) {
    await audit({ actor, action: 'send_email', target, payload: { to, subject }, result: { dryRun: true }, status: 'ok' });
    return { ok: true, dryRun: true };
  }
  const r = await sendEmailViaSmtp({ fromMailbox, to, subject, text, html });
  await audit({ actor, action: 'send_email', target, payload: { to, subject }, result: { ok: r.ok, messageId: r.messageId, reason: r.reason }, status: r.ok ? 'ok' : 'error', error: r.ok ? null : r.reason });
  if (!r.ok) throw new Error(`[test-cockpit-send] email SMTP faalde: ${r.reason}`);
  return { ok: true, messageId: r.messageId };
}
