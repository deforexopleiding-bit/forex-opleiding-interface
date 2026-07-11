// api/_lib/dunning-dry-run.js
//
// Wanbetalers-sandbox veiligheidshelpers. Twee guards:
//
//   1) isDryRunEnabled() — leest app_settings.dunning_dry_run.enabled.
//      Default TRUE (fail-safe: bij DB-fout, missende key of onbekend
//      type → dry-run staat aan, er wordt NIETS verstuurd).
//
//   2) assertRecipientMatchesSandbox({ isTest, expected, actual, channel })
//      — als de klant is_test=true is, vergelijkt het doel-adres met
//      app_settings.dunning_sandbox_contact.{phone|email}. Match niet →
//      throw. Voorkomt dat een test-send ooit naar een echte ontvanger
//      lekt, ook als dry_run per ongeluk uit staat.
//
// Beide helpers werken direct met supabaseAdmin (server-side). Callers
// hoeven geen client mee te geven.

import { supabaseAdmin } from '../supabase.js';

const DRY_RUN_KEY = 'dunning_dry_run';
const CONTACT_KEY = 'dunning_sandbox_contact';

// Kleine in-memory cache (10s) — hetzelfde patroon als dunning-pipeline.js.
// Voorkomt dat elke bulk-recipient of workflow-step opnieuw een SELECT doet.
let _cache = { at: 0, dry: null, contact: null };
const TTL_MS = 10_000;

async function _refresh() {
  const now = Date.now();
  if (now - _cache.at < TTL_MS && _cache.dry !== null) return _cache;
  try {
    const { data, error } = await supabaseAdmin
      .from('app_settings')
      .select('key, value')
      .in('key', [DRY_RUN_KEY, CONTACT_KEY]);
    if (error) throw error;
    const rows = Array.isArray(data) ? data : [];
    const dryRow     = rows.find((r) => r.key === DRY_RUN_KEY);
    const contactRow = rows.find((r) => r.key === CONTACT_KEY);
    // Default DRY-RUN AAN als key ontbreekt (fail-safe).
    const enabled = dryRow?.value?.enabled;
    const dry = (enabled === false) ? false : true;
    const contact = (contactRow?.value && typeof contactRow.value === 'object') ? contactRow.value : {};
    _cache = { at: now, dry, contact };
  } catch (e) {
    // Fail-safe: bij fout dry-run AAN houden en contact leeg.
    console.warn('[dunning-dry-run] settings-lookup faalde, defaults gebruikt:', e?.message || e);
    _cache = { at: now, dry: true, contact: {} };
  }
  return _cache;
}

export async function isDryRunEnabled() {
  const c = await _refresh();
  return !!c.dry;
}

export async function getSandboxContact() {
  const c = await _refresh();
  return c.contact || {};
}

// Reset de cache (voor sandbox-endpoints die net iets aangepast hebben en
// meteen willen dat de guard de nieuwe waarde ziet).
export function invalidateDryRunCache() {
  _cache = { at: 0, dry: null, contact: null };
}

// Normaliseer telefoon/e-mail voor vergelijking (strip whitespace + hoofdletters).
// Cijfer-only normalisatie: strip +, spaties, streepjes, haakjes en 00-prefix.
// Zo matchen '+0612343423' en '0612343423' als hetzelfde nummer, en '+31612…'
// wordt via phoneMatches (laatste 9 cijfers) equivalent aan '0612…'.
function normPhone(p) {
  if (!p) return '';
  return String(p).replace(/\D+/g, '');
}
// Tolerante telefoon-matcher: exact-op-cijfers OF gelijke laatste 9 cijfers
// (nationaal significant deel → dekt landcode-verschillen).
function phoneMatches(a, b) {
  const x = normPhone(a), y = normPhone(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 9 && y.length >= 9 && x.slice(-9) === y.slice(-9)) return true;
  return false;
}
function normEmail(e) {
  if (!e) return '';
  return String(e).trim().toLowerCase();
}

// Gooit als channel='whatsapp' en isTest=true, maar actual-nummer niet
// matcht het sandbox-contact. Idem voor e-mail. Bij isTest=false: no-op.
export async function assertRecipientMatchesSandbox({ isTest, actual, channel }) {
  if (!isTest) return;
  const contact = await getSandboxContact();
  if (channel === 'whatsapp') {
    const want = normPhone(contact.phone);
    if (!want) {
      throw new Error('[sandbox-guard] geen sandbox-telefoon geconfigureerd — abort test-verzending');
    }
    if (!phoneMatches(contact.phone, actual)) {
      throw new Error(`[sandbox-guard] test-verzending geblokkeerd: doel=${normPhone(actual)} matcht niet met sandbox=${want}`);
    }
    return;
  }
  if (channel === 'email') {
    const want = normEmail(contact.email);
    const got  = normEmail(actual);
    if (!want) {
      throw new Error('[sandbox-guard] geen sandbox-e-mail geconfigureerd — abort test-verzending');
    }
    if (want !== got) {
      throw new Error(`[sandbox-guard] test-verzending geblokkeerd: doel=${got} matcht niet met sandbox=${want}`);
    }
    return;
  }
  throw new Error(`[sandbox-guard] onbekend channel '${channel}'`);
}

// Log-helper: hoe wordt een dry-run-verzending vastgelegd? Callers kunnen
// hun bestaande dunning_log-insert doen; deze helper geeft alleen een
// consistente payload-shape terug voor het `dry_run:true`-log-blok.
export function buildDryRunLogPayload({ channel, to, isTest, preview }) {
  return {
    dry_run: true,
    channel,
    to,
    is_test: !!isTest,
    rendered_preview: preview || null,
  };
}
