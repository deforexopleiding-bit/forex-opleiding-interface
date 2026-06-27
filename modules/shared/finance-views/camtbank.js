/* modules/shared/finance-views/camtbank.js
 *
 * Finance CAMT Bank-view — sub-tabs Transacties / Matches / Config.
 *
 * Verantwoordelijkheden:
 *   - CAMT-saldo + transactie-lijst (Transacties)
 *   - Payment-matching engine (Matches sub-tab)
 *   - CAMT-upload + autopilot-instelling + bulk-matcher + invoice bulk-resync
 *     (Config sub-tab)
 *   - bankTxModal koppel-search voor inkomende CAMT-tx → factuur
 *
 * Niet inbegrepen:
 *   - bankTxModal DOM blijft in finance.html (gedeeld met view-bank).
 *     Module gebruikt rechtstreeks document.getElementById('bankTxModal') en
 *     hangt content erop tijdens openCamtBankTxModal().
 *   - openDetail (invoice-modal) blijft in finance.html. Module roept
 *     opts.openInvoiceById(invId) aan; finance.html stelt die in op een
 *     wrapper die openDetail aanroept.
 *
 * Public API:
 *   window.FinanceViewCamtBank.mount({
 *     host:                 HTMLElement,  // view-camtbank container
 *     openInvoiceById:      Function,     // (invId:string) → opent factuur-modal
 *     canBankBalanceView:   boolean,
 *     canBankTxView:        boolean,
 *   })
 *
 * Mount is idempotent (zelfde host = geen re-render). Init wordt eenmaal
 * gedaan; daarna is de module verantwoordelijk voor lazy-load van data
 * (loadCamtBalance / loadCamtBank) bij eerste activatie via load().
 */
(function () {
  if (window.FinanceViewCamtBank && window.FinanceViewCamtBank.__loaded) return;

  // ── Locale helpers (kopie uit finance.html voor encapsulatie) ──
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function fmtEur2Cents(c) {
    const n = Number(c) || 0;
    return '€' + (n / 100).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtDateNl(s) {
    if (!s) return '—';
    const d = new Date(String(s) + 'T00:00:00');
    if (isNaN(d.getTime())) return '—';
    return String(d.getDate()).padStart(2, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + d.getFullYear();
  }

  // ── Module-state ──
  let _mountedHost = null;
  let _loadedOnce = false;
  let _matchesLoadedOnce = false;
  let _openInvoiceByIdCb = null;
  let _perms = { canBankBalanceView: false, canBankTxView: false };

  const camtBankState = { dir: 'all', from: '', to: '', q: '', page: 1, pageSize: 50, total: 0 };
  let _camtBankItems = [];
  let _camtBankSearchTimer = null;

  const matchState = { statusFilter: 'open', page: 1, pageSize: 50, total: 0 };
  let _matchItems = [];

  // bankTxModal koppel-search (alleen voor inkomende CAMT-tx)
  let _bankTxLinkCurrent = null;
  let _bankTxLinkSearchTimer = null;
  let _bankTxLinkResultsCache = [];

  function renderHTML() {
    return `
    <div class="bank-locked" id="camtBankLocked" hidden style="background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.3);border-radius:8px;padding:14px 16px;margin-bottom:14px">
      <div style="font-size:15px;font-weight:700;margin-bottom:6px">Geen toegang tot bankoverzicht</div>
      <div style="font-size:12.5px">Je mist het recht <code>finance.bank.transactions_view</code>. Vraag een beheerder dit aan te zetten.</div>
    </div>
    <div id="camtBankMain">
      <!-- Sub-tabs -->
      <div class="sr-segments" id="camtSubNav" style="margin-bottom:14px">
        <button class="sr-seg active" data-camt-sub="transactions" type="button">Transacties</button>
        <button class="sr-seg" data-camt-sub="matches" type="button">Matches <span id="camtMatchesBadge" style="display:none;margin-left:6px;padding:2px 6px;background:#10b981;color:#fff;border-radius:999px;font-size:10px;font-weight:600"></span></button>
        <button class="sr-seg" data-camt-sub="config" type="button">Config</button>
      </div>

      <!-- Sub-view: Transacties (default) -->
      <div id="camtSubTransactions">
      <div style="background:linear-gradient(135deg, rgba(16,185,129,.12), rgba(16,185,129,.04));border:1px solid rgba(16,185,129,.3);border-radius:12px;padding:18px 22px;margin-bottom:18px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
        <div>
          <div style="font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.06em;font-weight:600">Eindsaldo · uit laatste CAMT-bestand</div>
          <div id="camtBalanceVal" style="font-size:32px;font-weight:700;color:#10b981;margin-top:4px;font-variant-numeric:tabular-nums">€ —</div>
          <div id="camtBalanceMeta" style="font-size:11.5px;color:var(--text-faint);margin-top:2px"></div>
        </div>
        <button class="sr-ibtn" id="camtBalanceRefresh" type="button" title="Saldo vernieuwen"><i class="ti ti-refresh"></i></button>
      </div>
      <div class="sr-filterstrip" id="camtBankFilters" style="margin-bottom:12px;flex-wrap:wrap;gap:8px;align-items:center">
        <div class="sr-segments" id="camtBankDirSeg">
          <button class="sr-seg active" data-dir="all" type="button">Alle</button>
          <button class="sr-seg" data-dir="in" type="button">Inkomend</button>
          <button class="sr-seg" data-dir="out" type="button">Uitgaand</button>
        </div>
        <input id="camtBankFrom" type="date" class="fin-input" title="Vanaf datum"/>
        <input id="camtBankTo" type="date" class="fin-input" title="T/m datum"/>
        <input id="camtBankSearch" type="search" placeholder="Zoek op omschrijving, IBAN, factuurnr…" class="fin-input" style="min-width:240px"/>
        <span style="flex:1"></span>
        <button class="sr-ibtn" id="camtBankRefresh" title="Lijst vernieuwen" type="button"><i class="ti ti-refresh"></i></button>
      </div>
      <div class="sr-tablewrap" style="overflow-x:auto">
        <table class="sr-table" id="camtBankTable" style="min-width:980px;table-layout:fixed">
          <thead><tr>
            <th style="width:90px">Datum</th>
            <th style="min-width:200px">Omschrijving</th>
            <th style="min-width:140px">Tegenpartij</th>
            <th style="width:160px">IBAN</th>
            <th style="width:130px">Referentie</th>
            <th style="width:140px;text-align:center">Gekoppelde factuur</th>
            <th class="num" style="width:120px;white-space:nowrap;text-align:right">Bedrag</th>
          </tr></thead>
          <tbody id="camtBankTbody"><tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-faint)">Laden…</td></tr></tbody>
        </table>
      </div>
      <div id="camtBankPager" style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;font-size:12.5px;color:var(--text-dim)"></div>
      </div><!-- /camtSubTransactions -->

      <!-- Sub-view: Matches -->
      <div id="camtSubMatches" hidden>
        <div class="sr-filterstrip" style="margin-bottom:12px;flex-wrap:wrap;gap:8px;align-items:center">
          <div class="sr-segments" id="matchStatusSeg">
            <button class="sr-seg active" data-status="open" type="button">Te beoordelen</button>
            <button class="sr-seg" data-status="confirmed_all" type="button">Bevestigd</button>
            <button class="sr-seg" data-status="rejected" type="button">Verworpen</button>
            <button class="sr-seg" data-status="all" type="button">Alle</button>
          </div>
          <span style="flex:1"></span>
          <button class="sr-ibtn" id="matchRefresh" title="Vernieuwen" type="button"><i class="ti ti-refresh"></i></button>
        </div>
        <div class="sr-tablewrap">
          <table class="sr-table" id="matchTable">
            <thead><tr>
              <th style="width:90px">Datum</th>
              <th class="num" style="width:110px">Bedrag</th>
              <th>Tegenpartij</th>
              <th>Omschrijving</th>
              <th style="width:70px">Score</th>
              <th>Redenen</th>
              <th>Factuur</th>
              <th style="width:140px">Status</th>
              <th style="width:140px"></th>
            </tr></thead>
            <tbody id="matchTbody"><tr><td colspan="9" style="text-align:center;padding:24px;color:var(--text-faint)">Laden…</td></tr></tbody>
          </table>
        </div>
        <div id="matchPager" style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;font-size:12.5px;color:var(--text-dim)"></div>
      </div>

      <!-- Sub-view: Config -->
      <div id="camtSubConfig" hidden>
        <div style="margin-bottom:14px;padding:14px 16px;border:1px solid var(--border-subtle, #e5e7eb);border-radius:10px;background:rgba(255,255,255,0.02)">
          <div style="font-size:14px;font-weight:700;margin-bottom:4px">CAMT-import</div>
          <div style="font-size:12px;color:var(--text-faint);margin-bottom:12px;line-height:1.5">Upload een ISO 20022 CAMT.053 bestand (.xml) vanaf Mijn ING Zakelijk → Rekeningafschriften. Transacties worden automatisch gespiegeld naar de DB en getoond op de Transacties-tab.</div>
          <div style="margin-bottom:14px;padding:16px 18px;border:2px dashed var(--border-subtle, #d1d5db);border-radius:10px;background:rgba(255,255,255,0.02)">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
              <div>
                <div style="font-size:14px;font-weight:600;margin-bottom:4px">Importeer CAMT-bestand</div>
                <div style="font-size:12px;color:var(--text-faint);line-height:1.5">Download van Mijn ING Zakelijk → Rekeningafschriften → CAMT (.xml). Sleep hier naartoe of klik om te kiezen.</div>
              </div>
              <div style="display:flex;gap:8px;align-items:center">
                <input type="file" id="camtFileInput" accept=".xml,application/xml,text/xml" style="display:none"/>
                <button class="sr-abtn primary" id="camtUploadBtn" type="button"><i class="ti ti-upload"></i> Kies bestand</button>
              </div>
            </div>
            <div id="camtUploadStatus" style="margin-top:10px;font-size:12.5px;display:none"></div>
            <div id="camtUploadDrop" style="margin-top:10px;padding:14px;text-align:center;border:1px dashed var(--border-subtle, #d1d5db);border-radius:8px;font-size:12px;color:var(--text-faint);background:rgba(0,0,0,0.02)">Of sleep een .xml-bestand op deze plek</div>
          </div>
          <div id="camtStatementsList" style="font-size:12.5px"></div>
        </div>

        <div style="margin-bottom:14px;padding:14px 16px;border:1px solid var(--border-subtle, #e5e7eb);border-radius:10px;background:rgba(255,255,255,0.02)">
          <div style="font-size:14px;font-weight:700;margin-bottom:4px">Matching</div>
          <div style="font-size:12px;color:var(--text-faint);margin-bottom:12px;line-height:1.5">Stel autopilot in voor automatische factuurkoppeling bij hoge match-zekerheid, of draai eenmalig een bulk-matcher voor historische transacties zonder kandidaten.</div>
          <div style="margin-bottom:12px;padding:14px 16px;border:1px solid var(--border-subtle, #e5e7eb);border-radius:10px;background:rgba(255,255,255,0.02)">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
              <div>
                <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;font-weight:600">
                  <input type="checkbox" id="matchAutoToggle" style="width:auto;cursor:pointer"/>
                  <span>Automatisch matchen bij hoge zekerheid (autopilot)</span>
                </label>
                <div id="matchAutoMeta" style="font-size:11.5px;color:var(--text-faint);margin-top:4px">Laden…</div>
              </div>
              <div id="matchAutoThresholdBox" style="display:none;align-items:center;gap:8px">
                <label style="font-size:12px;color:var(--text-dim)">Drempel</label>
                <input id="matchAutoThreshold" type="range" min="50" max="100" step="5" value="95" style="width:140px"/>
                <span id="matchAutoThresholdVal" style="font-size:12.5px;font-weight:600;min-width:32px">95</span>
                <button class="sr-abtn primary" id="matchAutoSave" type="button" style="font-size:12px">Opslaan</button>
              </div>
            </div>
            <div id="matchAutoStatus" style="display:none;margin-top:8px;font-size:12px"></div>
          </div>
          <div style="padding:12px 16px;border:1px dashed var(--border-subtle, #e5e7eb);border-radius:10px;background:rgba(255,255,255,0.02);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
            <div>
              <div style="font-size:13px;font-weight:600">Bulk-matcher voor historische transacties</div>
              <div style="font-size:11.5px;color:var(--text-faint);margin-top:2px">Genereert match-kandidaten voor camt-transacties die nog niet beoordeeld zijn. Autopilot-bevestiging wordt toegepast als die aanstaat.</div>
            </div>
            <button class="sr-abtn primary" id="matchBulkRunBtn" type="button" style="font-size:12.5px">
              <i class="ti ti-player-play" style="margin-right:4px"></i>Match historische data
            </button>
          </div>
        </div>

        <div style="margin-bottom:14px;padding:14px 16px;border:1px solid var(--border-subtle, #e5e7eb);border-radius:10px;background:rgba(255,255,255,0.02)">
          <div style="font-size:14px;font-weight:700;margin-bottom:4px">Onderhoud</div>
          <div style="font-size:12px;color:var(--text-faint);margin-bottom:12px;line-height:1.5">Periodieke onderhoudsacties voor data-consistentie tussen Teamleader en de lokale spiegel.</div>
          <div style="padding:12px 16px;border:1px dashed var(--border-subtle, #e5e7eb);border-radius:10px;background:rgba(255,255,255,0.02);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
            <div>
              <div style="font-size:13px;font-weight:600">Re-sync open facturen met TL</div>
              <div style="font-size:11.5px;color:var(--text-faint);margin-top:2px">Haalt alle openstaande facturen opnieuw op uit Teamleader om stale paid-statussen te herstellen. Handig na de cursor-overshoot fix om historische misses op te ruimen.</div>
            </div>
            <button class="sr-abtn primary" id="invBulkResyncBtn" type="button" style="font-size:12.5px">
              <i class="ti ti-refresh" style="margin-right:4px"></i>Re-sync open facturen met TL
            </button>
          </div>
        </div>
      </div>
    </div>
    `;
  }

  // ── Data-loaders ──
  async function loadCamtBalance() {
    const valEl = document.getElementById('camtBalanceVal');
    const metaEl = document.getElementById('camtBalanceMeta');
    if (!valEl) return;
    valEl.textContent = '€ —';
    metaEl.textContent = 'Laden…';
    try {
      const r = await window.AgentShared.apiFetch('/api/finance-bank-camt-balance');
      if (r.status === 403) { metaEl.textContent = 'Geen rechten'; return; }
      const d = await r.json();
      if (!r.ok) {
        metaEl.textContent = 'Fout: ' + (d.error || 'HTTP ' + r.status);
        valEl.style.color = '#ef4444';
        return;
      }
      if (d.balance_cents == null) {
        valEl.textContent = '€ —';
        valEl.style.color = 'var(--text-faint)';
        metaEl.textContent = d.message || 'Geen statements';
        return;
      }
      valEl.textContent = fmtEur2Cents(d.balance_cents);
      valEl.style.color = (Number(d.balance_cents) || 0) >= 0 ? '#10b981' : '#ef4444';
      metaEl.textContent = 'Per ' + fmtDateNl(d.as_of_date) + ' · ' + (d.account_iban || '—') + ' · uit ' + (d.file_name || 'CAMT');
    } catch (e) {
      metaEl.textContent = 'Fout: ' + e.message;
    }
  }

  async function loadCamtBank() {
    const tb = document.getElementById('camtBankTbody');
    if (!tb) return;
    tb.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-faint)">Laden…</td></tr>';
    const p = new URLSearchParams();
    if (camtBankState.dir && camtBankState.dir !== 'all') p.set('direction', camtBankState.dir);
    if (camtBankState.from) p.set('from', camtBankState.from);
    if (camtBankState.to)   p.set('to', camtBankState.to);
    if (camtBankState.q)    p.set('q', camtBankState.q);
    p.set('limit', String(camtBankState.pageSize));
    p.set('offset', String((camtBankState.page - 1) * camtBankState.pageSize));
    try {
      const r = await window.AgentShared.apiFetch('/api/finance-bank-camt-transactions?' + p.toString());
      if (r.status === 403) {
        document.getElementById('camtBankMain').hidden = true;
        document.getElementById('camtBankLocked').hidden = false;
        return;
      }
      const d = await r.json();
      if (!r.ok) {
        tb.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:#ef4444">Fout: ' + esc(d.error || 'HTTP ' + r.status) + '</td></tr>';
        return;
      }
      camtBankState.total = d.total || 0;
      const items = d.items || [];
      _camtBankItems = items;
      if (!items.length) {
        tb.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-faint)">Geen transacties gevonden. Upload een CAMT-bestand om te beginnen.</td></tr>';
      } else {
        tb.innerHTML = items.map((t, i) => {
          const cents = Number(t.amount_cents) || 0;
          const amtColor = cents > 0 ? '#10b981' : (cents < 0 ? '#ef4444' : 'var(--text)');
          const amtSign = cents > 0 ? '+' : '';
          const li = t.linked_invoice || null;
          const linkedCell = li
            ? `<a href="#" data-open-invoice-id="${esc(li.id)}" class="sr-tag green" title="Open factuur (status: ${esc(li.match_status || '')})" style="display:inline-block;text-decoration:none">${esc(li.invoice_number || '—')}</a>`
            : '<span class="sr-cellsub">—</span>';
          const descRaw = String(t.description || '');
          const partyRaw = String(t.counterparty_name || '');
          const ibanRaw = String(t.counterparty_iban || '');
          const refRaw = String(t.end_to_end_id || '');
          const truncCss = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
          return `<tr class="clickable-row" data-camt-row="${i}">
            <td style="white-space:nowrap">${esc(fmtDateNl(t.booking_date))}</td>
            <td title="${esc(descRaw)}" style="${truncCss}">${esc(descRaw || '—')}</td>
            <td title="${esc(partyRaw)}" style="${truncCss}">${esc(partyRaw || '—')}</td>
            <td title="${esc(ibanRaw)}" style="font-family:monospace;font-size:11.5px;${truncCss}">${esc(ibanRaw || '—')}</td>
            <td title="${esc(refRaw)}" style="${truncCss}">${refRaw ? `<span class="sr-tag blue">${esc(refRaw)}</span>` : '<span class="sr-cellsub">—</span>'}</td>
            <td style="text-align:center">${linkedCell}</td>
            <td class="num" style="color:${amtColor};font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;text-align:right">${amtSign}${fmtEur2Cents(Math.abs(cents))}</td>
          </tr>`;
        }).join('');
        tb.querySelectorAll('[data-camt-row]').forEach(tr => tr.addEventListener('click', (e) => {
          if (e.target.closest('button, a')) return;
          openCamtBankTxModal(Number(tr.dataset.camtRow));
        }));
        tb.querySelectorAll('[data-open-invoice-id]').forEach(a => a.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (typeof _openInvoiceByIdCb === 'function') _openInvoiceByIdCb(a.dataset.openInvoiceId);
        }));
      }
      const pages = Math.max(1, Math.ceil(camtBankState.total / camtBankState.pageSize));
      document.getElementById('camtBankPager').innerHTML =
        `<span>${camtBankState.total} transacties · pagina ${camtBankState.page}/${pages}</span>` +
        `<span><button class="sr-ibtn" id="camtBankPrev" type="button" ${camtBankState.page <= 1 ? 'disabled' : ''}><i class="ti ti-chevron-left"></i></button>` +
        `<button class="sr-ibtn" id="camtBankNext" type="button" ${camtBankState.page >= pages ? 'disabled' : ''}><i class="ti ti-chevron-right"></i></button></span>`;
      const prev = document.getElementById('camtBankPrev'), next = document.getElementById('camtBankNext');
      if (prev) prev.addEventListener('click', () => { if (camtBankState.page > 1) { camtBankState.page--; loadCamtBank(); } });
      if (next) next.addEventListener('click', () => { if (camtBankState.page < pages) { camtBankState.page++; loadCamtBank(); } });
    } catch (e) {
      tb.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:#ef4444">Fout: ' + esc(e.message) + '</td></tr>';
    }
  }

  // Open shared bankTxModal met CAMT-tx data.
  // Accepteert numerieke index in _camtBankItems OF tx-object direct
  // (Matches-tab geeft m.camt door — heeft niet alle velden).
  function openCamtBankTxModal(idxOrTx) {
    const t = (typeof idxOrTx === 'number') ? _camtBankItems[idxOrTx] : idxOrTx;
    if (!t) return;
    const cents = Number(t.amount_cents) || 0;
    const amtColor = cents > 0 ? '#10b981' : (cents < 0 ? '#ef4444' : 'var(--text)');
    const amtSign = cents > 0 ? '+' : (cents < 0 ? '−' : '');
    document.getElementById('bankTxTitle').textContent = fmtDateNl(t.booking_date) + ' · ' + (cents > 0 ? 'Inkomend (Credit)' : 'Uitgaand (Debit)');
    const amtEl = document.getElementById('bankTxAmount');
    amtEl.textContent = amtSign + fmtEur2Cents(Math.abs(cents));
    amtEl.style.color = amtColor;
    document.getElementById('bankTxDescription').textContent = t.description || '—';
    document.getElementById('bankTxCounterparty').textContent = t.counterparty_name || '—';
    document.getElementById('bankTxIban').textContent = t.counterparty_iban || '—';
    document.getElementById('bankTxInvoiceNumber').textContent = t.end_to_end_id || '—';
    document.getElementById('bankTxEbId').textContent = t.entry_reference || '—';
    document.getElementById('bankTxLedger').textContent = t.account_iban || '—';
    document.getElementById('bankTxRaw').textContent = JSON.stringify(t, null, 2);
    // Toon manual-link sectie alleen bij inkomende CAMT-tx (id is uuid).
    const linkSection = document.getElementById('bankTxLinkSection');
    if (linkSection) {
      const isIncomingCamt = t && typeof t.id === 'string' && /^[0-9a-f-]{36}$/i.test(t.id) && (Number(t.amount_cents) || 0) > 0;
      linkSection.hidden = !isIncomingCamt;
      if (isIncomingCamt) {
        _bankTxLinkCurrent = t;
        const inp = document.getElementById('bankTxLinkSearch');
        if (inp) { inp.value = ''; }
        const list = document.getElementById('bankTxLinkResults');
        if (list) { list.innerHTML = ''; list.style.display = 'none'; }
        bankTxLinkSetStatus('');
      } else {
        _bankTxLinkCurrent = null;
      }
    }
    document.getElementById('bankTxModal').classList.remove('hidden');
  }

  // bankTxLink koppel-search
  function bankTxLinkSetStatus(text, color) {
    const el = document.getElementById('bankTxLinkSearchStatus');
    if (!el) return;
    el.textContent = text;
    el.style.color = color || '';
  }
  function bankTxLinkRenderResults(items) {
    const list = document.getElementById('bankTxLinkResults');
    if (!list) return;
    _bankTxLinkResultsCache = items;
    if (!items.length) {
      list.innerHTML = '<div style="padding:14px;text-align:center;color:var(--text-faint);font-size:12px">Geen openstaande facturen gevonden voor deze zoekterm.</div>';
      list.style.display = 'block';
      return;
    }
    list.innerHTML = items.map((inv, i) => {
      const total = Number(inv.amount_total) || 0;
      const open = Number(inv.amount_open) || total;
      const statusBadge =
          inv.display_status === 'overdue'        ? '<span class="sr-tag warning" style="margin-left:6px">Te laat</span>'
        : inv.status === 'partially_paid'         ? '<span class="sr-tag warning" style="margin-left:6px">Deels betaald</span>'
        :                                           '<span class="sr-tag gray" style="margin-left:6px">Open</span>';
      return `<div data-link-pick="${i}" class="clickable-row" style="padding:10px 12px;border-bottom:1px solid var(--border-subtle, #2b2f3a);display:flex;justify-content:space-between;align-items:center;gap:10px">
        <div style="flex:1;min-width:0">
          <div style="font-size:12.5px;font-weight:600">
            <span class="sr-tag blue">${esc(inv.invoice_number || '—')}</span>
            <span style="margin-left:6px">${esc(inv.customer_name || '—')}</span>
            ${statusBadge}
          </div>
          <div style="font-size:11px;color:var(--text-faint);margin-top:2px">${esc(fmtDateNl(inv.issue_date))}${inv.due_date ? ' · vervalt ' + esc(fmtDateNl(inv.due_date)) : ''}</div>
        </div>
        <div class="num" style="font-variant-numeric:tabular-nums;text-align:right">
          <div style="font-size:13px;font-weight:600">${fmtEur2Cents(open * 100)}</div>
          ${open !== total ? `<div style="font-size:10.5px;color:var(--text-faint)">van ${fmtEur2Cents(total * 100)}</div>` : ''}
        </div>
      </div>`;
    }).join('');
    list.style.display = 'block';
    list.querySelectorAll('[data-link-pick]').forEach(el => el.addEventListener('click', () => {
      const idx = Number(el.dataset.linkPick);
      const inv = _bankTxLinkResultsCache[idx];
      if (inv) bankTxLinkPickInvoice(inv);
    }));
  }
  async function bankTxLinkRunSearch(query) {
    const camt = _bankTxLinkCurrent;
    if (!camt) return;
    const q = String(query || '').trim();
    if (q.length < 2) {
      bankTxLinkSetStatus('Min 2 tekens');
      const list = document.getElementById('bankTxLinkResults');
      if (list) { list.innerHTML = ''; list.style.display = 'none'; }
      return;
    }
    bankTxLinkSetStatus('Zoeken…');
    try {
      const p = ['open', 'partially_paid', 'overdue'].map(st => {
        const params = new URLSearchParams({ q, status: st, page_size: '10', sort: 'issue_date', dir: 'desc' });
        return window.AgentShared.apiFetch('/api/finance-invoices?' + params.toString())
          .then(r => r.json().catch(() => ({})))
          .then(j => Array.isArray(j.items) ? j.items : []);
      });
      const arrs = await Promise.all(p);
      const seen = new Set();
      const merged = [];
      for (const arr of arrs) for (const inv of arr) {
        if (seen.has(inv.id)) continue; seen.add(inv.id);
        merged.push(inv);
      }
      const camtEuro = (Number(camt.amount_cents) || 0) / 100;
      merged.sort((a, b) => {
        const aMatch = Math.abs(Number(a.amount_open) - camtEuro) < 0.01 ? 0 : 1;
        const bMatch = Math.abs(Number(b.amount_open) - camtEuro) < 0.01 ? 0 : 1;
        if (aMatch !== bMatch) return aMatch - bMatch;
        return (b.issue_date || '').localeCompare(a.issue_date || '');
      });
      const top = merged.slice(0, 10);
      bankTxLinkSetStatus(`${top.length}/${merged.length} resultaten`);
      bankTxLinkRenderResults(top);
    } catch (e) {
      console.error('[bank-tx-link search]', e);
      bankTxLinkSetStatus('Fout: ' + e.message, '#ef4444');
    }
  }
  async function bankTxLinkPickInvoice(inv) {
    const camt = _bankTxLinkCurrent;
    if (!camt || !inv) return;
    const camtEuro = (Number(camt.amount_cents) || 0) / 100;
    const msg = `Koppel betaling ${fmtEur2Cents(camtEuro * 100)} aan factuur ${inv.invoice_number} van ${inv.customer_name || '—'}?\n\nDe factuur wordt op betaald gezet in Teamleader.`;
    if (!confirm(msg)) return;
    bankTxLinkSetStatus('Koppelen…');
    try {
      const r = await window.AgentShared.apiFetch('/api/finance-payment-match-manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ camt_transaction_id: camt.id, invoice_id: inv.id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      window.AgentShared.showToast('✓ ' + (d.message || 'Gekoppeld'), 'success');
      document.getElementById('bankTxModal').classList.add('hidden');
      loadCamtBank();
      if (_matchesLoadedOnce) loadMatches();
    } catch (e) {
      console.error('[bank-tx-link pick]', e);
      bankTxLinkSetStatus('');
      window.AgentShared.showToast('Koppelen mislukt: ' + e.message, 'error');
    }
  }

  async function loadCamtStatementsList() {
    const el = document.getElementById('camtStatementsList');
    if (!el) return;
    el.innerHTML = '<span style="color:var(--text-faint)">Statements laden…</span>';
    try {
      const r = await window.AgentShared.apiFetch('/api/finance-bank-camt-balance');
      const d = await r.json().catch(() => null);
      if (!r.ok || !d) { el.innerHTML = ''; return; }
      if (d.num_statements === 0) {
        el.innerHTML = '<span style="color:var(--text-faint)">Nog geen statements geüpload.</span>';
        return;
      }
      el.innerHTML = `<span style="color:var(--text-dim)">${d.num_statements} statement${d.num_statements === 1 ? '' : 's'} geüpload · laatste: <strong>${esc(d.file_name || '?')}</strong> per ${esc(fmtDateNl(d.as_of_date))}</span>`;
    } catch (e) {
      el.innerHTML = '';
    }
  }

  async function uploadCamtFile(file) {
    const status = document.getElementById('camtUploadStatus');
    status.style.display = '';
    status.style.color = 'var(--text-dim)';
    status.textContent = 'Lezen + uploaden ' + file.name + '…';
    try {
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      const chunk = 8192;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      const base64 = btoa(binary);
      const r = await window.AgentShared.apiFetch('/api/finance-bank-camt-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_name: file.name, xml_content_base64: base64 }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        status.style.color = '#ef4444';
        status.textContent = 'Upload mislukt: ' + (d.error || 'HTTP ' + r.status);
        return;
      }
      status.style.color = '#10b981';
      const matchesPart = d.matches_generated
        ? ` · ${d.matches_generated} matches gegenereerd${d.auto_confirmed ? `, waarvan ${d.auto_confirmed} auto-bevestigd` : ''}`
        : '';
      status.textContent = `✓ ${d.num_inserted} transacties geïmporteerd, ${d.num_skipped} duplicaten gefilterd · periode ${fmtDateNl(d.statement_from)} – ${fmtDateNl(d.statement_to)}${matchesPart}`;
      window.AgentShared?.showToast?.(`${d.num_inserted} transacties uit ${file.name}${d.matches_generated ? ` · ${d.matches_generated} matches` : ''}`, 'success');
      loadCamtBalance();
      camtBankState.page = 1;
      loadCamtBank();
      loadCamtStatementsList();
      _matchesLoadedOnce = true; loadMatches();
    } catch (e) {
      status.style.color = '#ef4444';
      status.textContent = 'Upload mislukt: ' + e.message;
    }
  }

  // ── Matches sub-tab ──
  function setCamtSubView(sub) {
    document.getElementById('camtSubTransactions').hidden = (sub !== 'transactions');
    document.getElementById('camtSubMatches').hidden = (sub !== 'matches');
    const cfg = document.getElementById('camtSubConfig');
    if (cfg) cfg.hidden = (sub !== 'config');
    document.querySelectorAll('#camtSubNav .sr-seg').forEach(b => b.classList.toggle('active', b.dataset.camtSub === sub));
    if (sub === 'matches' && !_matchesLoadedOnce) {
      _matchesLoadedOnce = true;
      loadMatchAutopilotSetting();
      loadMatches();
    }
    if (sub === 'config') {
      loadMatchAutopilotSetting();
    }
  }

  async function loadMatchAutopilotSetting() {
    const cb = document.getElementById('matchAutoToggle');
    const meta = document.getElementById('matchAutoMeta');
    const thrBox = document.getElementById('matchAutoThresholdBox');
    const thrInput = document.getElementById('matchAutoThreshold');
    const thrVal = document.getElementById('matchAutoThresholdVal');
    if (!cb || !meta) return;
    meta.textContent = 'Laden…';
    try {
      const r = await window.AgentShared.apiFetch('/api/app-settings?key=payment_match_autopilot');
      const d = await r.json();
      if (!r.ok) { meta.textContent = 'Setting niet gevonden — gebruik standaardwaarden.'; return; }
      const v = d.value || { enabled: false, threshold: 95 };
      cb.checked = !!v.enabled;
      thrBox.style.display = cb.checked ? 'flex' : 'none';
      thrInput.value = String(v.threshold || 95);
      thrVal.textContent = String(v.threshold || 95);
      meta.textContent = v.enabled
        ? `Aan · facturen worden automatisch gemarkeerd als betaald bij match-score ≥ ${v.threshold || 95}`
        : 'Uit · alle matches vereisen handmatige bevestiging';
    } catch (e) { meta.textContent = 'Fout: ' + e.message; }
  }

  async function saveMatchAutopilotSetting() {
    const status = document.getElementById('matchAutoStatus');
    const cb = document.getElementById('matchAutoToggle');
    const thrInput = document.getElementById('matchAutoThreshold');
    const value = { enabled: !!cb.checked, threshold: Number(thrInput.value) || 95 };
    status.style.display = '';
    status.style.color = 'var(--text-dim)';
    status.textContent = 'Opslaan…';
    try {
      const r = await window.AgentShared.apiFetch('/api/app-settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'payment_match_autopilot', value }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        status.style.color = '#ef4444';
        status.textContent = 'Mislukt: ' + (d.error || 'HTTP ' + r.status);
        return;
      }
      status.style.color = '#10b981';
      status.textContent = '✓ Opgeslagen.';
      loadMatchAutopilotSetting();
    } catch (e) {
      status.style.color = '#ef4444';
      status.textContent = 'Mislukt: ' + e.message;
    }
  }

  async function loadMatches() {
    const tb = document.getElementById('matchTbody');
    if (!tb) return;
    tb.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--text-faint)">Laden…</td></tr>';
    const p = new URLSearchParams();
    if (matchState.statusFilter === 'open') p.set('status', 'suggested,auto_confirmed');
    else if (matchState.statusFilter === 'confirmed_all') p.set('status', 'confirmed,manual_confirmed');
    else if (matchState.statusFilter === 'rejected') p.set('status', 'rejected');
    p.set('limit', String(matchState.pageSize));
    p.set('offset', String((matchState.page - 1) * matchState.pageSize));
    try {
      const r = await window.AgentShared.apiFetch('/api/finance-payment-matches?' + p.toString());
      const d = await r.json();
      if (!r.ok) {
        tb.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:24px;color:#ef4444">Fout: ' + esc(d.error || 'HTTP ' + r.status) + '</td></tr>';
        return;
      }
      matchState.total = d.total || 0;
      _matchItems = d.items || [];
      const badge = document.getElementById('camtMatchesBadge');
      if (badge && matchState.statusFilter === 'open') {
        if (d.total > 0) { badge.style.display = ''; badge.textContent = String(d.total); }
        else badge.style.display = 'none';
      }
      if (!_matchItems.length) {
        tb.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--text-faint)">Geen matches gevonden. Upload een CAMT-bestand om nieuwe te genereren.</td></tr>';
        document.getElementById('matchPager').innerHTML = '';
        return;
      }
      tb.innerHTML = _matchItems.map((m, i) => {
        const cents = Number(m.camt?.amount_cents) || 0;
        const score = Number(m.match_score) || 0;
        const scoreColor = score >= 90 ? '#10b981' : (score >= 70 ? '#f59e0b' : '#eab308');
        const reasonsLbl = { exact_amount: 'Bedrag', exact_amount_due: 'Bedrag (deel)', invoice_number_in_description: 'Factuurnr', customer_name_match: 'Naam', date_within_30_days: 'Datum', manual_link: 'Handmatig' };
        const reasonsHtml = (m.match_reasons || []).map(r => `<span style="color:#10b981">${esc(reasonsLbl[r] || r)} ✓</span>`).join(' · ');
        const statusBadge = (() => {
          if (m.status === 'suggested') return '<span class="sr-tag gray">Te beoordelen</span>';
          if (m.status === 'auto_confirmed') return '<span class="sr-tag warning">Auto-bevestigd</span>';
          if (m.status === 'confirmed') return '<span class="sr-tag green">Bevestigd</span>';
          if (m.status === 'manual_confirmed') return '<span class="sr-tag green">Handmatig gekoppeld</span>';
          if (m.status === 'rejected') return '<span class="sr-tag danger">Verworpen</span>';
          return esc(m.status);
        })();
        const actionable = (m.status === 'suggested');
        const actionsHtml = actionable
          ? `<button class="sr-abtn primary" data-match-confirm="${i}" type="button" style="font-size:11px;padding:4px 8px"><i class="ti ti-check"></i> Bevestig</button> <button class="sr-abtn" data-match-reject="${i}" type="button" style="font-size:11px;padding:4px 8px;background:transparent;border:1px solid var(--border);color:var(--text-dim)"><i class="ti ti-x"></i></button>`
          : (m.status === 'auto_confirmed' ? `<button class="sr-abtn" data-match-reject="${i}" type="button" style="font-size:11px;padding:4px 8px;background:transparent;border:1px solid var(--border);color:var(--text-dim)" title="Verwerp deze automatische match (handmatige correctie)">Verwerp</button>` : '');
        const descRaw = (m.camt?.description || '').trim();
        const descShort = descRaw.length > 60 ? (descRaw.slice(0, 57) + '…') : descRaw;
        return `<tr class="clickable-row" data-match-row="${i}">
          <td>${esc(fmtDateNl(m.camt?.booking_date))}</td>
          <td class="num" style="color:#10b981;font-weight:600;font-variant-numeric:tabular-nums">+${fmtEur2Cents(Math.abs(cents))}</td>
          <td>${esc(m.camt?.counterparty_name || '—')}</td>
          <td title="${esc(descRaw)}" style="font-size:11.5px;color:var(--text-dim)">${esc(descShort || '—')}</td>
          <td><span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;color:#fff;background:${scoreColor}">${score}</span></td>
          <td style="font-size:11.5px">${reasonsHtml}</td>
          <td><span class="sr-tag blue">${esc(m.invoice?.invoice_number || '—')}</span> <span class="sr-cellsub">${esc(m.invoice?.customer_name || '')}</span></td>
          <td>${statusBadge}</td>
          <td>${actionsHtml}</td>
        </tr>`;
      }).join('');
      tb.querySelectorAll('[data-match-confirm]').forEach(b => b.addEventListener('click', () => confirmMatch(Number(b.dataset.matchConfirm))));
      tb.querySelectorAll('[data-match-reject]').forEach(b => b.addEventListener('click', () => rejectMatch(Number(b.dataset.matchReject))));
      tb.querySelectorAll('[data-match-row]').forEach(tr => tr.addEventListener('click', (e) => {
        if (e.target.closest('button, a')) return;
        const m = _matchItems[Number(tr.dataset.matchRow)];
        if (m && m.camt) openCamtBankTxModal(m.camt);
      }));
      const pages = Math.max(1, Math.ceil(matchState.total / matchState.pageSize));
      document.getElementById('matchPager').innerHTML =
        `<span>${matchState.total} matches · pagina ${matchState.page}/${pages}</span>` +
        `<span><button class="sr-ibtn" id="matchPrev" type="button" ${matchState.page <= 1 ? 'disabled' : ''}><i class="ti ti-chevron-left"></i></button>` +
        `<button class="sr-ibtn" id="matchNext" type="button" ${matchState.page >= pages ? 'disabled' : ''}><i class="ti ti-chevron-right"></i></button></span>`;
      const prev = document.getElementById('matchPrev'), next = document.getElementById('matchNext');
      if (prev) prev.addEventListener('click', () => { if (matchState.page > 1) { matchState.page--; loadMatches(); } });
      if (next) next.addEventListener('click', () => { if (matchState.page < pages) { matchState.page++; loadMatches(); } });
    } catch (e) {
      tb.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:24px;color:#ef4444">Fout: ' + esc(e.message) + '</td></tr>';
    }
  }

  async function confirmMatch(idx) {
    const m = _matchItems[idx];
    if (!m) return;
    if (!confirm(`Bevestig dat €${fmtEur2Cents(Math.abs(Number(m.camt?.amount_cents) || 0))} op factuur ${m.invoice?.invoice_number} geboekt mag worden in Teamleader?`)) return;
    try {
      const r = await window.AgentShared.apiFetch('/api/finance-payment-match-confirm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ match_id: m.id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = (d.error || 'HTTP ' + r.status) + (d.tl_response ? ('\n\nTL: ' + String(d.tl_response).slice(0, 300)) : '');
        window.AgentShared?.showToast?.('Match bevestigen mislukt: ' + msg.slice(0, 200), 'error');
        return;
      }
      window.AgentShared?.showToast?.(`Factuur ${m.invoice?.invoice_number} → ${d.status} (${fmtEur2Cents(Number(d.amount_paid) * 100 || 0)})`, 'success');
      loadMatches();
    } catch (e) {
      window.AgentShared?.showToast?.('Mislukt: ' + e.message, 'error');
    }
  }

  async function rejectMatch(idx) {
    const m = _matchItems[idx];
    if (!m) return;
    const reason = prompt('Optionele reden van afwijzen:', '');
    if (reason === null) return;
    try {
      const r = await window.AgentShared.apiFetch('/api/finance-payment-match-reject', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ match_id: m.id, reason: reason || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { window.AgentShared?.showToast?.('Afwijzen mislukt: ' + (d.error || 'HTTP ' + r.status), 'error'); return; }
      window.AgentShared?.showToast?.('Match verworpen', 'success');
      loadMatches();
    } catch (e) {
      window.AgentShared?.showToast?.('Mislukt: ' + e.message, 'error');
    }
  }

  // ── Bulk-acties (Config sub-tab) ──
  async function runBulkInvoiceResync() {
    const btn = document.getElementById('invBulkResyncBtn');
    if (!btn) return;
    if (!confirm('Alle openstaande facturen opnieuw spiegelen vanuit TL? Dit kan 1-2 minuten duren bij ~200 facturen. Bij timeout: opnieuw klikken tot er geen openstaand meer is gewijzigd.')) return;
    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="ti ti-loader-2" style="margin-right:4px;animation:spin 1s linear infinite"></i>Bezig…';
    try {
      const r = await window.AgentShared.apiFetch('/api/finance-invoice-bulk-resync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'all_open' }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      const parts = [];
      parts.push(`${j.processed || 0} facturen ge-resynct`);
      parts.push(`${j.updated || 0} updated`);
      if (j.inserted) parts.push(`${j.inserted} nieuw`);
      if (j.errors) parts.push(`${j.errors} errors`);
      if (j.aborted_by_timeout) parts.push('⚠️ timeout — opnieuw klikken voor de rest');
      window.AgentShared.showToast('✓ ' + parts.join(' · '), j.errors ? 'warning' : 'success');
      if (j.error_samples && j.error_samples.length) {
        console.warn('[bulk-resync] error_samples:', j.error_samples);
      }
    } catch (e) {
      console.error('[bulk-resync]', e);
      window.AgentShared.showToast('Re-sync mislukt: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  }

  async function runBulkMatcher() {
    const btn = document.getElementById('matchBulkRunBtn');
    if (!btn) return;
    if (!confirm('Match-engine draaien voor alle ongematchte transacties? Dit kan even duren bij veel historische data.')) return;
    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="ti ti-loader-2" style="margin-right:4px;animation:spin 1s linear infinite"></i>Bezig…';
    try {
      const r = await window.AgentShared.apiFetch('/api/finance-payment-matcher-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'unmatched' }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      const parts = [];
      parts.push(`${j.processed || 0} verwerkt`);
      parts.push(`${j.candidates_created || 0} kandidaten`);
      if (j.auto_confirmed) parts.push(`${j.auto_confirmed} auto-bevestigd`);
      if (j.auto_confirm_failed) parts.push(`${j.auto_confirm_failed} auto-faal`);
      if (j.errors) parts.push(`${j.errors} fout`);
      if (j.aborted_by_timeout) parts.push('⚠️ timeout — opnieuw draaien voor de rest');
      window.AgentShared.showToast('✓ ' + parts.join(' · '), j.errors ? 'warning' : 'success');
      matchState.page = 1;
      loadMatches();
    } catch (e) {
      console.error('[bulk-matcher]', e);
      window.AgentShared.showToast('Bulk-matcher mislukt: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  }

  // ── Wiring ──
  function wireOnce() {
    const camtDirSeg = document.getElementById('camtBankDirSeg');
    if (camtDirSeg) camtDirSeg.querySelectorAll('.sr-seg').forEach(b => b.addEventListener('click', () => {
      camtDirSeg.querySelectorAll('.sr-seg').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      camtBankState.dir = b.dataset.dir || 'all';
      camtBankState.page = 1;
      loadCamtBank();
    }));
    const cbf = document.getElementById('camtBankFrom'); if (cbf) cbf.addEventListener('change', e => { camtBankState.from = e.target.value; camtBankState.page = 1; loadCamtBank(); });
    const cbt = document.getElementById('camtBankTo'); if (cbt) cbt.addEventListener('change', e => { camtBankState.to = e.target.value; camtBankState.page = 1; loadCamtBank(); });
    const cbs = document.getElementById('camtBankSearch'); if (cbs) cbs.addEventListener('input', e => { clearTimeout(_camtBankSearchTimer); _camtBankSearchTimer = setTimeout(() => { camtBankState.q = e.target.value.trim(); camtBankState.page = 1; loadCamtBank(); }, 350); });
    const cbr = document.getElementById('camtBankRefresh'); if (cbr) cbr.addEventListener('click', () => { camtBankState.page = 1; loadCamtBank(); });
    const cbbr = document.getElementById('camtBalanceRefresh'); if (cbbr) cbbr.addEventListener('click', loadCamtBalance);

    // Upload
    const fileInput = document.getElementById('camtFileInput');
    const uploadBtn = document.getElementById('camtUploadBtn');
    const dropZone  = document.getElementById('camtUploadDrop');
    if (uploadBtn && fileInput) {
      uploadBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) uploadCamtFile(f); fileInput.value = ''; });
    }
    if (dropZone) {
      ['dragenter','dragover'].forEach(ev => dropZone.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dropZone.style.borderColor = 'var(--accent-cyan, #0891b2)'; }));
      ['dragleave','drop'].forEach(ev => dropZone.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dropZone.style.borderColor = ''; }));
      dropZone.addEventListener('drop', (e) => { const f = e.dataTransfer?.files?.[0]; if (f) uploadCamtFile(f); });
    }

    // Sub-tabs
    document.querySelectorAll('#camtSubNav .sr-seg').forEach(b => b.addEventListener('click', () => setCamtSubView(b.dataset.camtSub)));

    // Autopilot
    const autoCb = document.getElementById('matchAutoToggle');
    const thrBox = document.getElementById('matchAutoThresholdBox');
    const thrInput = document.getElementById('matchAutoThreshold');
    const thrVal = document.getElementById('matchAutoThresholdVal');
    const autoSave = document.getElementById('matchAutoSave');
    if (autoCb) autoCb.addEventListener('change', () => { thrBox.style.display = autoCb.checked ? 'flex' : 'none'; });
    if (thrInput) thrInput.addEventListener('input', () => { thrVal.textContent = thrInput.value; });
    if (autoSave) autoSave.addEventListener('click', saveMatchAutopilotSetting);

    // Match-filter
    const msSeg = document.getElementById('matchStatusSeg');
    if (msSeg) msSeg.querySelectorAll('.sr-seg').forEach(b => b.addEventListener('click', () => {
      msSeg.querySelectorAll('.sr-seg').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      matchState.statusFilter = b.dataset.status || 'open';
      matchState.page = 1;
      loadMatches();
    }));
    const mRef = document.getElementById('matchRefresh');
    if (mRef) mRef.addEventListener('click', () => { matchState.page = 1; loadMatches(); });

    // Bulk-acties
    const bulkBtn = document.getElementById('matchBulkRunBtn');
    if (bulkBtn) bulkBtn.addEventListener('click', runBulkMatcher);
    const resyncBtn = document.getElementById('invBulkResyncBtn');
    if (resyncBtn) resyncBtn.addEventListener('click', runBulkInvoiceResync);

    // bankTxModal → factuur koppel-search (debounced 300ms).
    // bankTxModal DOM zelf zit in finance.html; we hangen alleen de input-listener
    // hier omdat _bankTxLinkCurrent in deze module-closure leeft.
    const linkInp = document.getElementById('bankTxLinkSearch');
    if (linkInp) linkInp.addEventListener('input', (e) => {
      const val = e.target.value;
      if (_bankTxLinkSearchTimer) clearTimeout(_bankTxLinkSearchTimer);
      _bankTxLinkSearchTimer = setTimeout(() => bankTxLinkRunSearch(val), 300);
    });
  }

  function applyPerms() {
    // Verberg locked-banner of main per perms.
    if (!_perms.canBankTxView && !_perms.canBankBalanceView) {
      const locked = document.getElementById('camtBankLocked');
      const main = document.getElementById('camtBankMain');
      if (locked) locked.hidden = false;
      if (main) main.hidden = true;
    }
  }

  function mount(opts) {
    const o = opts || {};
    if (!o.host) {
      console.warn('[FinanceViewCamtBank] mount() requires {host}');
      return;
    }
    if (_mountedHost === o.host) {
      // Re-mount op zelfde host: alleen lazy-load triggeren.
      load();
      return;
    }
    _mountedHost = o.host;
    _openInvoiceByIdCb = typeof o.openInvoiceById === 'function' ? o.openInvoiceById : null;
    _perms.canBankBalanceView = !!o.canBankBalanceView;
    _perms.canBankTxView = !!o.canBankTxView;
    o.host.innerHTML = renderHTML();
    wireOnce();
    applyPerms();
    load();
  }

  function load() {
    if (_loadedOnce) return;
    _loadedOnce = true;
    if (_perms.canBankBalanceView) loadCamtBalance();
    if (_perms.canBankTxView) { loadCamtBank(); loadCamtStatementsList(); }
  }

  window.FinanceViewCamtBank = {
    __loaded: true,
    mount,
  };
})();
