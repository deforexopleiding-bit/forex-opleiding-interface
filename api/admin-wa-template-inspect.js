// api/admin-wa-template-inspect.js
//
// ⚠ TIJDELIJK EENMALIG — verwijderen na gebruik.
//
// Doel: rechtstreeks bij Meta lezen wat de goedgekeurde template-shape is voor
// bevestig_toegang_a en bevestig_toegang_b, omdat het interne template-scherm
// leeg toont (UI-bug) en de cron sinds 06:56 UTC 2026-09-15 132000 krijgt op
// bevestig_toegang_b (code stuurt 2 body-params, Meta zou er 1 verwachten).
//
// GET  /api/admin-wa-template-inspect            → HTML-shell (self-fetch met Bearer)
// GET  /api/admin-wa-template-inspect?data=1     → JSON per template
//
// Auth: super_admin (verifyAdmin + profile.role === 'super_admin').
// Server-side call naar Graph API v25.0 met META_WHATSAPP_ACCESS_TOKEN +
// META_WHATSAPP_BUSINESS_ACCOUNT_ID. Tokens NIET terug in de respons.
//
// 0 mutaties, 0 incasso-writes, 0 DB-writes.

import { verifyAdmin } from './supabase.js';

const META_API_VERSION = 'v25.0';
const META_BASE_URL    = `https://graph.facebook.com/${META_API_VERSION}`;

const TEMPLATES_TO_INSPECT = ['bevestig_toegang_b', 'bevestig_toegang_a'];

// Tel unieke {{N}}-placeholders in body-text (positional). Named placeholders
// ({{voornaam}}) tellen we apart. Retourneert { positional_count, named_count, positional_indices }.
function countPlaceholders(text) {
  if (!text) return { positional_count: 0, named_count: 0, positional_indices: [] };
  const posSet = new Set();
  const namedSet = new Set();
  const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const key = String(m[1]).trim();
    if (/^\d+$/.test(key)) posSet.add(Number(key));
    else                    namedSet.add(key);
  }
  return {
    positional_count : posSet.size,
    named_count      : namedSet.size,
    positional_indices: Array.from(posSet).sort((a, b) => a - b),
    named_keys       : Array.from(namedSet),
  };
}

async function fetchTemplateFromMeta(name, baid, token) {
  const fields = 'name,language,status,category,id,components,rejected_reason';
  const url = `${META_BASE_URL}/${encodeURIComponent(baid)}/message_templates?fields=${encodeURIComponent(fields)}&name=${encodeURIComponent(name)}&limit=25`;
  const res = await fetch(url, {
    method : 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  if (!res.ok) {
    const err = parsed?.error || null;
    return {
      ok        : false,
      http_status: res.status,
      meta_code : err?.code ?? res.status,
      meta_subcode: err?.error_subcode ?? '',
      meta_message: err?.message ?? (text ? text.slice(0, 200) : ''),
      meta_fbtrace: err?.fbtrace_id ?? '',
      raw       : parsed || null,
    };
  }
  return { ok: true, data: Array.isArray(parsed?.data) ? parsed.data : [] };
}

function summarizeTemplateRow(row) {
  const components = Array.isArray(row.components) ? row.components : [];
  const findComp = (t) => components.find((c) => String(c?.type || '').toUpperCase() === t);
  const body   = findComp('BODY');
  const header = findComp('HEADER');
  const footer = findComp('FOOTER');
  const btns   = findComp('BUTTONS');

  const bodyText   = body?.text || null;
  const bodyPh     = countPlaceholders(bodyText);
  const bodyExample = body?.example?.body_text || null;

  const headerFormat = header?.format || null;
  const headerText   = header?.text || null;
  const headerPh     = countPlaceholders(headerText);

  const buttons = Array.isArray(btns?.buttons) ? btns.buttons.map((b) => ({
    type       : b?.type || null,
    text       : b?.text || null,
    url        : b?.url || null,
    example    : b?.example || null,
    placeholders: countPlaceholders(b?.url || b?.text || ''),
  })) : [];

  return {
    id             : row.id || null,
    name           : row.name || null,
    language       : row.language || null,
    status         : row.status || null,
    category       : row.category || null,
    rejected_reason: row.rejected_reason || null,
    body: {
      text              : bodyText,
      placeholder_count : bodyPh.positional_count + bodyPh.named_count,
      positional_indices: bodyPh.positional_indices,
      named_keys        : bodyPh.named_keys,
      example_body_text : bodyExample,
    },
    header: header ? {
      format             : headerFormat,
      text               : headerText,
      placeholder_count  : headerPh.positional_count + headerPh.named_count,
      example            : header?.example || null,
    } : null,
    footer: footer ? { text: footer?.text || null } : null,
    buttons,
    raw_components: components,
  };
}

async function fetchData(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Unauthorized' });
  if (admin.profile?.role !== 'super_admin') {
    return res.status(403).json({ error: 'Alleen super_admin' });
  }

  const token = process.env.META_WHATSAPP_ACCESS_TOKEN;
  const baid  = process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!token) return res.status(500).json({ error: 'META_WHATSAPP_ACCESS_TOKEN ontbreekt in env' });
  if (!baid)  return res.status(500).json({ error: 'META_WHATSAPP_BUSINESS_ACCOUNT_ID ontbreekt in env' });

  const templates = [];
  for (const name of TEMPLATES_TO_INSPECT) {
    const r = await fetchTemplateFromMeta(name, baid, token);
    if (!r.ok) {
      templates.push({
        name,
        error       : r.meta_message,
        meta_code   : r.meta_code,
        meta_subcode: r.meta_subcode,
        meta_fbtrace: r.meta_fbtrace,
        http_status : r.http_status,
      });
      continue;
    }
    if (r.data.length === 0) {
      templates.push({ name, error: 'Niet gevonden bij Meta voor deze WABA.' });
      continue;
    }
    // Meerdere language-variants mogelijk — geef ze allemaal terug.
    templates.push({
      name,
      variants: r.data.map(summarizeTemplateRow),
    });
  }

  return res.status(200).json({
    now                 : new Date().toISOString(),
    business_account_id : baid ? `${String(baid).slice(0, 4)}…${String(baid).slice(-4)}` : null,
    graph_api_version   : META_API_VERSION,
    templates,
  });
}

function htmlShell() {
  return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WA-template inspect</title>
<script src="/modules/shared/supabase-client.js"></script>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 24px 32px; font: 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; color: #1a2333; background: #f7f9fb; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 22px 0 8px; }
  h3 { font-size: 13px; margin: 14px 0 6px; color: #093d54; }
  .sub { color: #6b7280; font-size: 12px; margin-bottom: 16px; }
  .banner { padding: 10px 14px; background: #fef3c7; border: 1px solid #fbbf24; border-radius: 6px; color: #92400e; margin-bottom: 16px; font-size: 13px; }
  .card { background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:16px 18px; margin-bottom:14px; }
  .kv { display:grid; grid-template-columns: 160px 1fr; gap: 4px 12px; font-size:13px; }
  .kv .k { color:#6b7280; }
  code, pre { background:#f3f4f6; padding: 1px 5px; border-radius:3px; font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { padding: 10px 12px; overflow-x:auto; white-space: pre-wrap; }
  .badge { display:inline-block; padding: 2px 8px; border-radius:10px; font-size:11px; font-weight:600; }
  .b-ok  { background:#d1fae5; color:#065f46; }
  .b-warn{ background:#fef3c7; color:#92400e; }
  .b-err { background:#fee2e2; color:#991b1b; }
  .empty { color:#9ca3af; font-style:italic; }
  .err   { padding: 16px; background:#fee2e2; border:1px solid #fca5a5; border-radius:6px; color:#7f1d1d; white-space:pre-wrap; }
  .loading { padding: 40px; text-align:center; color:#6b7280; }
</style>
</head>
<body>
  <div class="banner">
    <strong>TIJDELIJK diagnose-endpoint.</strong> Leest live bij Meta Graph API v25.0 wat de
    approved shape is van <code>bevestig_toegang_b</code> en <code>bevestig_toegang_a</code>.
    Geen wijzigingen. Verwijderen na gebruik.
  </div>
  <h1>WhatsApp-template inspect (Meta authoritatief)</h1>
  <div class="sub" id="sub">Bezig met ophalen…</div>
  <div id="content"><div class="loading">Even wachten — 2 × Graph API-call, meestal <3s.</div></div>

<script>
(async () => {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const contentEl = document.getElementById('content');
  const subEl     = document.getElementById('sub');

  await window._authSharedReady;
  if (!window.AuthShared) { contentEl.innerHTML = '<div class="err">Niet ingelogd (auth-shared ontbreekt).</div>'; return; }
  const token = await window.AuthShared.getAccessToken();
  if (!token) { contentEl.innerHTML = '<div class="err">Geen sessie — log eerst in.</div>'; return; }

  try {
    const res = await fetch('/api/admin-wa-template-inspect?data=1', {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!res.ok) {
      const txt = await res.text().catch(()=>'');
      throw new Error('HTTP ' + res.status + ' — ' + txt.slice(0, 500));
    }
    const data = await res.json();
    render(data);
  } catch (e) {
    contentEl.innerHTML = '<div class="err">' + esc(e?.message || String(e)) + '</div>';
    subEl.textContent = 'Fout';
  }

  function render(data) {
    subEl.textContent =
      'Graph API ' + esc(data.graph_api_version || '') +
      ' · WABA ' + esc(data.business_account_id || '?') +
      ' · gegenereerd ' + esc(data.now || '');

    const cards = (data.templates || []).map(t => {
      if (t.error) {
        return '<div class="card"><h2>' + esc(t.name) + ' <span class="badge b-err">FOUT</span></h2>' +
               '<div class="kv"><div class="k">error</div><div>' + esc(t.error) + '</div>' +
               (t.meta_code ? '<div class="k">meta_code</div><div>' + esc(t.meta_code) + '</div>' : '') +
               (t.meta_fbtrace ? '<div class="k">fbtrace</div><div><code>' + esc(t.meta_fbtrace) + '</code></div>' : '') +
               '</div></div>';
      }
      return (t.variants || []).map(v => renderVariant(t.name, v)).join('');
    }).join('') || '<div class="empty">Geen templates gevonden.</div>';

    contentEl.innerHTML = cards +
      '<h2>Volledige JSON (voor terugplak)</h2>' +
      '<pre>' + esc(JSON.stringify(data, null, 2)) + '</pre>';
  }

  function renderVariant(name, v) {
    const statusBadgeClass =
      v.status === 'APPROVED' ? 'b-ok' :
      (v.status === 'REJECTED' || v.status === 'DISABLED' || v.status === 'PAUSED') ? 'b-err' : 'b-warn';
    const bodyPhCount = v.body?.placeholder_count ?? 0;
    const bodyPhIdx   = (v.body?.positional_indices || []).join(', ') || '—';
    const bodyNamed   = (v.body?.named_keys || []).join(', ') || '—';
    const example     = Array.isArray(v.body?.example_body_text) && v.body.example_body_text[0]
                        ? v.body.example_body_text[0] : null;

    const buttons = (v.buttons || []).map(b =>
      '<li><b>' + esc(b.type || '?') + '</b>' +
      (b.text ? ' · text=<code>' + esc(b.text) + '</code>' : '') +
      (b.url  ? ' · url=<code>'  + esc(b.url)  + '</code>' : '') +
      (b.placeholders?.positional_count || b.placeholders?.named_count
        ? ' · placeholders=' + (b.placeholders.positional_count + b.placeholders.named_count)
        : '') +
      '</li>'
    ).join('') || '<li class="empty">geen buttons</li>';

    return '<div class="card">' +
      '<h2>' + esc(name) + ' <span class="badge ' + statusBadgeClass + '">' + esc(v.status || '?') + '</span>' +
      ' <span class="badge b-warn">' + esc(v.language || '?') + '</span></h2>' +
      '<div class="kv">' +
        '<div class="k">meta_template_id</div><div><code>' + esc(v.id || '') + '</code></div>' +
        '<div class="k">category</div><div>' + esc(v.category || '?') + '</div>' +
        '<div class="k">rejected_reason</div><div>' + (v.rejected_reason ? esc(v.rejected_reason) : '<span class="empty">—</span>') + '</div>' +
      '</div>' +

      '<h3>BODY</h3>' +
      '<pre>' + esc(v.body?.text || '(geen body-tekst)') + '</pre>' +
      '<div class="kv">' +
        '<div class="k">placeholder_count</div><div><b>' + bodyPhCount + '</b> (positional: ' + esc(bodyPhIdx) + ' · named: ' + esc(bodyNamed) + ')</div>' +
        '<div class="k">example_body_text[0]</div><div>' + (example ? '<code>' + esc(JSON.stringify(example)) + '</code>' : '<span class="empty">—</span>') + '</div>' +
      '</div>' +

      (v.header ? (
        '<h3>HEADER (' + esc(v.header.format || '?') + ')</h3>' +
        (v.header.text ? '<pre>' + esc(v.header.text) + '</pre>' : '<div class="empty">geen header-tekst</div>') +
        '<div class="kv"><div class="k">placeholder_count</div><div>' + esc(v.header.placeholder_count ?? 0) + '</div></div>'
      ) : '') +

      '<h3>BUTTONS</h3>' +
      '<ul style="margin:0; padding-left:18px">' + buttons + '</ul>' +

      (v.footer?.text ? ('<h3>FOOTER</h3><pre>' + esc(v.footer.text) + '</pre>') : '') +

      '</div>';
  }
})();
</script>
</body>
</html>`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }
  const wantsData = String(req.query?.data || '') === '1';
  if (wantsData) {
    res.setHeader('Content-Type', 'application/json');
    try {
      return await fetchData(req, res);
    } catch (e) {
      console.error('[admin-wa-template-inspect]', e?.message || e);
      return res.status(500).json({ error: e?.message || String(e) });
    }
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(htmlShell());
}
