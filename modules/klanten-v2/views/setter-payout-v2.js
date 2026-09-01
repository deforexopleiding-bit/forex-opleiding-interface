// modules/klanten-v2/views/setter-payout-v2.js
//
// BP2 setter-commissie-module. Toont eigen overzicht (setter) of admin-view
// (manager+). RBAC: setter.ledger.view (basis) / setter.ledger.admin +
// setter.payout.manage (manager+).
//
// Structuur:
//   /Overzicht — 4 KPI-getallen + regels-lijst.
//   /Uitbetalen — manager-only: bundelen (setter + periode → run).

(function () {
  'use strict';
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[sp-v2] KV_V2.helpers niet geladen.'); return; }
  const H = window.KV_V2.helpers;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const eur = (v) => new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(Number(v) || 0);

  async function tryFetch(label, url) {
    try {
      const r = await window.KV.authedFetch(url);
      if (!r.ok) { console.warn('[sp-v2] fetch fail:', label, r.status); return null; }
      return await r.json();
    } catch (e) { console.warn('[sp-v2] fetch exception:', label, e?.message); return null; }
  }

  const _sp = { data: null, loading: false, error: null, selectedSetter: null };
  const _spStaff = { items: null, loading: false };

  async function loadOverview(setterId) {
    _sp.loading = true; _sp.error = null;
    if (window.DFO?.render) window.DFO.render();
    const q = setterId ? ('?setter_user_id=' + encodeURIComponent(setterId)) : '';
    const j = await tryFetch('overview', '/api/setter-overview' + q);
    _sp.loading = false;
    if (!j) { _sp.error = 'Kon overzicht niet laden'; if (window.DFO?.render) window.DFO.render(); return; }
    _sp.data = j;
    if (window.DFO?.render) window.DFO.render();
  }
  async function loadStaff() {
    if (_spStaff.items || _spStaff.loading) return;
    _spStaff.loading = true;
    const j = await tryFetch('staff', '/api/profiles-list?staff_only=1');
    _spStaff.items = (j && Array.isArray(j.members)) ? j.members : [];
    _spStaff.loading = false;
    if (window.DFO?.render) window.DFO.render();
  }

  window.__spSelectSetter = (id) => {
    _sp.selectedSetter = id || null;
    loadOverview(id).catch(() => {});
  };
  window.__spRunPayout = async () => {
    const perms = (window.RBAC?.getUserPermissions && window.RBAC.getUserPermissions()) || new Set();
    if (!perms.has('*') && !perms.has('setter.payout.manage')) {
      window.KV?.toast?.('Geen rechten (setter.payout.manage)', 'warn'); return;
    }
    const setterId = _sp.selectedSetter || (_sp.data && _sp.data.setter_user_id);
    if (!setterId) return;
    const today = new Date().toISOString().slice(0, 10);
    const first = today.slice(0, 8) + '01';
    const start = prompt('Periode start (YYYY-MM-DD)', first); if (!start) return;
    const end   = prompt('Periode einde (YYYY-MM-DD)', today); if (!end) return;
    try {
      const r = await window.KV.authedJson('/api/setter-payout-run', {
        method: 'POST',
        body: JSON.stringify({ setter_user_id: setterId, period_start: start, period_end: end }),
      });
      window.KV?.toast?.(r?.entry_count ? `Payout aangemaakt: ${r.entry_count} regels, ${eur(r.total_amount || 0)}` : 'Geen vrijgegeven regels in deze periode', 'ok');
      loadOverview(setterId);
    } catch (e) {
      window.KV?.toast?.('Payout mislukt: ' + (e?.message || 'onbekend'), 'warn');
    }
  };

  function _kpi(label, val, color) {
    return `<div style="flex:1;min-width:180px;padding:14px 16px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-sm)">
      <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">${esc(label)}</div>
      <div style="font-size:22px;font-weight:700;color:${color || 'var(--text-1)'}">${esc(eur(val))}</div>
    </div>`;
  }

  function overzichtView() {
    if (!_sp.data && !_sp.loading && !_sp.error) queueMicrotask(() => loadOverview(_sp.selectedSetter));
    const perms = (window.RBAC?.getUserPermissions && window.RBAC.getUserPermissions()) || new Set();
    const isAdmin = perms.has('*') || perms.has('setter.ledger.admin');
    const canPayout = perms.has('*') || perms.has('setter.payout.manage');
    if (isAdmin && !_spStaff.items && !_spStaff.loading) queueMicrotask(() => loadStaff());

    const d = _sp.data;
    const staff = _spStaff.items || [];
    const staffPicker = isAdmin ? `
      <div style="margin-bottom:14px">
        <label style="font-size:11.5px;color:var(--text-3);margin-right:8px">Bekijk setter:</label>
        <select onchange="window.__spSelectSetter(this.value)" style="padding:5px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);font-size:12.5px">
          <option value="">— Ikzelf —</option>
          ${staff.map((s) => `<option value="${esc(s.id)}" ${_sp.selectedSetter === s.id ? 'selected' : ''}>${esc(s.full_name || s.email || s.id)}</option>`).join('')}
        </select>
      </div>` : '';

    if (_sp.loading && !d) return `<div class="pad" style="padding:20px">${staffPicker}<div>Laden…</div></div>`;
    if (_sp.error) return `<div class="pad" style="padding:20px">${staffPicker}<div style="color:var(--rose)">⚠ ${esc(_sp.error)}</div></div>`;
    if (!d) return `<div class="pad" style="padding:20px">${staffPicker}<div>Geen data.</div></div>`;

    const t = d.totals || {};
    const rows = (d.regels || []).map((r) => `
      <tr style="border-bottom:1px solid var(--border)">
        <td style="padding:7px 10px;font-size:12px">${esc(r.customer || '—')}</td>
        <td style="padding:7px 10px;font-size:12px;color:var(--text-3)">${esc(r.deal_ref || '—')}</td>
        <td style="padding:7px 10px;font-size:12px;text-align:right;font-variant-numeric:tabular-nums">${esc(eur(r.basis))}</td>
        <td style="padding:7px 10px;font-size:12px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600">${esc(eur(r.amount))}</td>
        <td style="padding:7px 10px;font-size:11.5px">${r.status === 'uitbetaald' ? '<span style="color:var(--emerald)">✓ uitbetaald</span>' : '<span style="color:var(--amber)">◐ vrijgegeven</span>'}</td>
        <td style="padding:7px 10px;font-size:11.5px;color:var(--text-3)">${esc(String(r.created_at || '').slice(0, 10))}</td>
      </tr>`).join('');

    return `<div class="pad" style="padding:20px">
      ${staffPicker}
      <div style="margin-bottom:8px;font-size:12px;color:var(--text-3)">Commissie-percentage: <b>${Number(d.pct || 0).toFixed(2)}%</b></div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px">
        ${_kpi('Uitbetaald totaal',           t.uitbetaald_totaal,          'var(--emerald)')}
        ${_kpi('Deze maand te ontvangen',     t.deze_maand_te_ontvangen,    'var(--brand)')}
        ${_kpi('Nog te verwachten (forecast)', t.forecast_nog_te_verwachten, 'var(--text-1)')}
        ${_kpi('Vervallen door annulering',   t.vervallen_door_annulering,  'var(--rose)')}
      </div>
      ${canPayout ? `<div style="margin-bottom:14px">
        <button class="btn btn-primary" style="font-size:12.5px;padding:6px 12px" onclick="window.__spRunPayout()">Uitbetaalronde draaien</button>
        <span style="margin-left:10px;font-size:11.5px;color:var(--text-3)">Bundelt alle vrijgegeven regels in de gekozen periode.</span>
      </div>` : ''}
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
        <table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <thead><tr style="text-align:left;color:var(--text-3);border-bottom:1px solid var(--border);font-size:11px;text-transform:uppercase">
            <th style="padding:8px 10px">Klant</th>
            <th style="padding:8px 10px">Offerte</th>
            <th style="padding:8px 10px;text-align:right">Basis (bruto)</th>
            <th style="padding:8px 10px;text-align:right">Commissie</th>
            <th style="padding:8px 10px">Status</th>
            <th style="padding:8px 10px">Datum</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="6" style="padding:28px;text-align:center;color:var(--text-3)">Nog geen regels.</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
  }

  window.DFO = window.DFO || { VIEWS: {} };
  window.DFO.VIEWS = window.DFO.VIEWS || {};
  window.DFO.VIEWS['setter-payout/Overzicht'] = overzichtView;

  // Registreer als v2-native module bij de klanten-v2 shell zodat de
  // hash-router (#setter-payout) 'em oppikt i.p.v. terug te vallen op
  // dashboard. KV_V2_ADD is allowlist-gated; als 'em nog niet bestaat
  // (script-order race), schuif de id in KV_V2_PENDING zodat klanten-v2.js
  // 'em consumeert zodra het definieert.
  try {
    if (typeof window.KV_V2_ADD === 'function') {
      window.KV_V2_ADD('setter-payout');
    } else {
      window.KV_V2_PENDING = window.KV_V2_PENDING || [];
      window.KV_V2_PENDING.push('setter-payout');
    }
  } catch (_) { /* fail-soft */ }

  console.debug('[sp-v2] setter-payout view geregistreerd');
})();
