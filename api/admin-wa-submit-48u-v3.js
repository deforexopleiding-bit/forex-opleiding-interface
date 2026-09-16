// api/admin-wa-submit-48u-v3.js
//
// ⚠ TIJDELIJK EENMALIG — verwijderen na gebruik.
//
// Doel: reminder_toegang_48u_v3 (of _v4 fallback) rechtstreeks bij Meta indienen
// via Graph API, omdat het interne template-scherm leeg toont (UI-bug). De
// 48u-stap van cron-toegang-aanvragen.js verwacht al de naam
// reminder_toegang_48u_v3 — als die goedgekeurd raakt is er GEEN codewijziging
// nodig. Bestaat 'ie al in APPROVED/PENDING/PAUSED/SUBMITTED-staat → val terug
// op reminder_toegang_48u_v4 en meld dat (1 regel in de cron aan te passen).
//
// GET  /api/admin-wa-submit-48u-v3            → HTML-shell (super_admin only)
// POST /api/admin-wa-submit-48u-v3?data=1     → precheck bij Meta + submit
//                                               (auth via Bearer super_admin JWT)
//
// Server-side gebruikt META_WHATSAPP_ACCESS_TOKEN + META_WHATSAPP_BUSINESS_ACCOUNT_ID.
// Tokens NIET terug in respons. Geen DB-writes op whatsapp_meta_templates —
// de bestaande sync-endpoint kan Meta later spiegelen naar de lokale tabel.
//
// 0 mutaties in incasso/finance/dunning. 0 code-writes in andere endpoints.

import { verifyAdmin } from './supabase.js';

const META_API_VERSION = 'v25.0';
const META_BASE_URL    = `https://graph.facebook.com/${META_API_VERSION}`;

const CANDIDATE_NAMES = ['reminder_toegang_48u_v3', 'reminder_toegang_48u_v4'];
const LANGUAGE        = 'nl';
const CATEGORY        = 'UTILITY';
const BODY_TEXT       = 'Hoi {{1}}, je gratis toegang staat nog steeds voor je klaar — we hebben alleen je bevestiging nog nodig. Eén berichtje terug (een "ja" is genoeg) en we zetten \'m meteen voor je open. Liever niet meer? Ook prima, dan laten we het hierbij. 😊';
const EXAMPLE_VARS    = ['Jeffrey'];

// Meta-statussen die een template "in gebruik of pending" maken → naam blijft
// bezet, we moeten uitwijken naar de volgende.
const RESERVED_STATUSES = new Set(['APPROVED', 'PAUSED', 'PENDING', 'PENDING_REVIEW', 'IN_APPEAL', 'SUBMITTED']);
// DISABLED / REJECTED laten Meta een nieuwe submit onder dezelfde naam wel toe.
const REUSABLE_STATUSES = new Set(['REJECTED', 'DISABLED']);

async function metaGetTemplatesByName(name, baid, token) {
  const fields = 'name,language,status,id,rejected_reason';
  const url = `${META_BASE_URL}/${encodeURIComponent(baid)}/message_templates?fields=${encodeURIComponent(fields)}&name=${encodeURIComponent(name)}&limit=25`;
  const res = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  return { ok: res.ok, http_status: res.status, data: parsed, raw: text };
}

async function metaSubmitTemplate({ name, baid, token }) {
  const url = `${META_BASE_URL}/${encodeURIComponent(baid)}/message_templates`;
  const payload = {
    name,
    language:               LANGUAGE,
    category:               CATEGORY,
    allow_category_change:  true,
    components: [
      {
        type: 'BODY',
        text: BODY_TEXT,
        example: { body_text: [EXAMPLE_VARS] },
      },
    ],
  };
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  return { ok: res.ok, http_status: res.status, data: parsed, raw: text };
}

/**
 * Kies target-naam: v3 als die vrij of REJECTED/DISABLED is; anders v4.
 * Retourneert { target, decision, precheck: [{name, existing_variants}] }.
 */
async function decideTargetName({ baid, token }) {
  const precheck = [];
  let target = null;
  let decision = null;
  for (const name of CANDIDATE_NAMES) {
    const r = await metaGetTemplatesByName(name, baid, token);
    if (!r.ok) {
      precheck.push({ name, error: r.data?.error?.message || `HTTP ${r.http_status}` });
      // Precheck-fout is fataal — anders zouden we blind een naam bezet-verklaren.
      throw new Error(`Precheck faalde voor ${name}: ${r.data?.error?.message || r.http_status}`);
    }
    const variants = Array.isArray(r.data?.data) ? r.data.data : [];
    precheck.push({
      name,
      existing_variants: variants.map((v) => ({
        id: v.id, language: v.language, status: v.status, rejected_reason: v.rejected_reason || null,
      })),
    });
    // Filter: alleen de nl-variant telt (of alle als er geen language-filter mogelijk was).
    const nlVariants = variants.filter((v) => String(v.language || '') === LANGUAGE);
    const anyReserved = nlVariants.some((v) => RESERVED_STATUSES.has(String(v.status || '').toUpperCase()));
    if (!anyReserved) {
      target = name;
      decision = nlVariants.length === 0
        ? 'vrij (geen variant bij Meta)'
        : `hergebruikbaar (statussen: ${nlVariants.map((v) => v.status).join(', ')})`;
      break;
    }
  }
  if (!target) {
    throw new Error(`Beide kandidaat-namen (${CANDIDATE_NAMES.join(', ')}) zijn bezet bij Meta — extend CANDIDATE_NAMES of ruim eerst op.`);
  }
  return { target, decision, precheck };
}

async function runSubmit(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Unauthorized' });
  if (admin.profile?.role !== 'super_admin') {
    return res.status(403).json({ error: 'Alleen super_admin' });
  }

  const token = process.env.META_WHATSAPP_ACCESS_TOKEN;
  const baid  = process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!token) return res.status(500).json({ error: 'META_WHATSAPP_ACCESS_TOKEN ontbreekt in env' });
  if (!baid)  return res.status(500).json({ error: 'META_WHATSAPP_BUSINESS_ACCOUNT_ID ontbreekt in env' });

  try {
    // Stap 1 — beslis target-naam.
    const { target, decision, precheck } = await decideTargetName({ baid, token });

    // Stap 2 — submit naar Meta.
    const submit = await metaSubmitTemplate({ name: target, baid, token });

    if (!submit.ok) {
      const err = submit.data?.error || {};
      return res.status(502).json({
        ok:                false,
        target_name:       target,
        decision,
        precheck,
        stage:             'meta_submit',
        http_status:       submit.http_status,
        meta_code:         err.code ?? null,
        meta_subcode:      err.error_subcode ?? null,
        meta_message:      err.message ?? (submit.raw ? submit.raw.slice(0, 500) : null),
        meta_fbtrace:      err.fbtrace_id ?? null,
        meta_error_data:   err.error_data ?? null,
      });
    }

    return res.status(200).json({
      ok:                true,
      target_name:       target,
      decision,
      precheck,
      code_change_needed: target === 'reminder_toegang_48u_v3' ? 'NEE (naam is al wat de cron gebruikt)' : `JA — pas TEMPLATES.reminder_48u.name aan naar '${target}' in api/cron-toegang-aanvragen.js (regel ~126).`,
      submit: {
        meta_template_id: submit.data?.id || null,
        status:           submit.data?.status || null,
        category:         submit.data?.category || null,
        raw:              submit.data || null,
      },
      submitted_payload: {
        name:     target,
        language: LANGUAGE,
        category: CATEGORY,
        body_text: BODY_TEXT,
        example_vars: EXAMPLE_VARS,
      },
    });
  } catch (e) {
    console.error('[admin-wa-submit-48u-v3]', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}

function htmlShell() {
  return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Submit reminder_toegang_48u</title>
<script src="/modules/shared/supabase-client.js"></script>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 24px 32px; font: 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; color: #1a2333; background: #f7f9fb; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 22px 0 8px; }
  .sub { color: #6b7280; font-size: 12px; margin-bottom: 16px; }
  .banner { padding: 10px 14px; background: #fef3c7; border: 1px solid #fbbf24; border-radius: 6px; color: #92400e; margin-bottom: 16px; font-size: 13px; }
  .card { background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:16px 18px; margin-bottom:14px; }
  .btn { display: inline-block; background: #093d54; color: #fff; border: none; border-radius: 6px; padding: 10px 18px; font-size: 13px; font-weight: 600; cursor: pointer; }
  .btn:hover { background: #0b4d6b; }
  .btn:disabled { opacity: .5; cursor: not-allowed; }
  code, pre { background:#f3f4f6; padding: 1px 5px; border-radius:3px; font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { padding: 10px 12px; overflow-x:auto; white-space: pre-wrap; }
  .badge { display:inline-block; padding: 2px 8px; border-radius:10px; font-size:11px; font-weight:600; margin-right:4px; }
  .b-ok  { background:#d1fae5; color:#065f46; }
  .b-warn{ background:#fef3c7; color:#92400e; }
  .b-err { background:#fee2e2; color:#991b1b; }
  .err   { padding: 16px; background:#fee2e2; border:1px solid #fca5a5; border-radius:6px; color:#7f1d1d; white-space:pre-wrap; }
</style>
</head>
<body>
  <div class="banner">
    <strong>TIJDELIJK diagnose-endpoint.</strong> Dient <code>reminder_toegang_48u_v3</code>
    (of <code>_v4</code> als v3 bezet is) rechtstreeks in bij Meta. Geen wijzigingen aan
    <code>cron-toegang-aanvragen.js</code>. Verwijderen na gebruik.
  </div>
  <h1>Submit reminder_toegang_48u naar Meta</h1>
  <div class="sub">Body: 1× <code>{{1}}</code> = voornaam · Language: nl · Category: UTILITY · Geen header/footer/buttons</div>

  <div class="card">
    <h2>Voorstel</h2>
    <pre id="preview">Hoi {{1}}, je gratis toegang staat nog steeds voor je klaar — we hebben alleen je bevestiging nog nodig. Eén berichtje terug (een "ja" is genoeg) en we zetten 'm meteen voor je open. Liever niet meer? Ook prima, dan laten we het hierbij. 😊</pre>
    <p style="font-size:12px;color:#6b7280;margin-top:6px">Example value <code>{{1}}</code> = <b>Jeffrey</b></p>
  </div>

  <button id="btn" class="btn">Submit naar Meta</button>

  <div id="result" style="margin-top:20px"></div>

<script>
(async () => {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const btn = document.getElementById('btn');
  const resEl = document.getElementById('result');

  await window._authSharedReady;
  if (!window.AuthShared) { resEl.innerHTML = '<div class="err">Niet ingelogd.</div>'; return; }
  const token = await window.AuthShared.getAccessToken();
  if (!token) { resEl.innerHTML = '<div class="err">Geen sessie — log eerst in.</div>'; return; }

  btn.addEventListener('click', async () => {
    if (!confirm('Weet je 100% zeker? Dit stuurt de submit definitief naar Meta.')) return;
    btn.disabled = true; btn.textContent = 'Bezig…';
    try {
      const r = await fetch('/api/admin-wa-submit-48u-v3?data=1', {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + token },
      });
      const data = await r.json();
      renderResult(data, r.ok);
    } catch (e) {
      resEl.innerHTML = '<div class="err">' + esc(e?.message || String(e)) + '</div>';
    } finally {
      btn.disabled = false; btn.textContent = 'Opnieuw';
    }
  });

  function renderResult(d, ok) {
    if (!ok) {
      resEl.innerHTML =
        '<div class="card"><h2>Meta weigerde <span class="badge b-err">FOUT</span></h2>' +
        '<pre>' + esc(JSON.stringify(d, null, 2)) + '</pre></div>';
      return;
    }
    const st = d?.submit?.status || '?';
    const stBadge = st === 'APPROVED' ? 'b-ok' : (st === 'PENDING' ? 'b-warn' : 'b-err');
    resEl.innerHTML =
      '<div class="card">' +
      '<h2>Target: <code>' + esc(d.target_name || '') + '</code> · Meta-status: <span class="badge ' + stBadge + '">' + esc(st) + '</span></h2>' +
      '<p><b>Beslissing:</b> ' + esc(d.decision || '') + '</p>' +
      '<p><b>Code-change nodig?</b> ' + esc(d.code_change_needed || '') + '</p>' +
      '<h2>Precheck (Meta GET)</h2>' +
      '<pre>' + esc(JSON.stringify(d.precheck, null, 2)) + '</pre>' +
      '<h2>Submit-response</h2>' +
      '<pre>' + esc(JSON.stringify(d.submit, null, 2)) + '</pre>' +
      '<h2>Volledige JSON</h2>' +
      '<pre>' + esc(JSON.stringify(d, null, 2)) + '</pre>' +
      '</div>';
  }
})();
</script>
</body>
</html>`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const wantsData = String(req.query?.data || '') === '1';

  if (wantsData) {
    if (req.method !== 'POST') {
      res.setHeader('Content-Type', 'application/json');
      return res.status(405).json({ error: 'POST only (met ?data=1)' });
    }
    res.setHeader('Content-Type', 'application/json');
    return runSubmit(req, res);
  }

  if (req.method !== 'GET') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(405).json({ error: 'GET (shell) of POST ?data=1 (submit)' });
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(htmlShell());
}
