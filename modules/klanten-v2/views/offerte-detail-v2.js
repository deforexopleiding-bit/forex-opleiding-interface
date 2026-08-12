// modules/klanten-v2/views/offerte-detail-v2.js
//
// In-shell READ-view voor 1 offerte. Vervangt de full-page redirect naar
// /modules/offerte-detail.html vanuit de v2-sales-flow.
//
// Entry: window.__odvRenderView(dealId) — returned HTML-string voor
// direct-mount in de sales/Offertes-slot. Bepaalt zelf welk deal_id via
// de URL-param (?deal_id=X). sales-v2.offertesView() checkt de URL en
// delegeert bij aanwezigheid van deal_id naar deze module.
//
// Actie-knoppen:
//   - "Terug naar offertes"   → window.__svOfferteDetailClose()
//   - "Bewerken"              → window.__swOpen({editDealId: X})
//   - "Omzetten naar abonnement" → window.__subwOpen({dealId: X})
//     (guard voor beschikbaarheid; toast als script nog niet geladen)
//
// Fetch: /api/sales-deal-detail?id=X → { deal, customer, line_items,
// traject, entity, totals: {excl, incl}, has_subscription }.
//
// Dormant scaffold: geen writes, geen v1-parity nog compleet (dat komt
// in een volgende ronde). Doel voor NU: de in-shell view die de
// hardcoded /modules/offerte-detail.html-redirect vervangt zodat de
// v2-shell niet meer wordt verlaten.

(function () {
  if (!window.DFO) { console.error('[odv-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[odv-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg } = window.DFO;
  const H = window.KV_V2.helpers;

  const asArr = (x) => Array.isArray(x) ? x : [];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const eur = (n) => (Number(n) || 0).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 });
  const dstr = (iso) => { if (!iso) return '—'; try { const d = new Date(iso); return d.toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch { return '—'; } };
  const dstrLong = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }); } catch { return '—'; } };

  // ── State per dealId (kleine cache; refetch bij dealId-wisseling) ────
  const _odv = { dealId: null, loading: false, error: null, data: null };

  async function _tryFetch(label, url, timeoutMs = 8000) {
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) { console.warn('[odv-v2] fetch fail:', label, e?.message); return null; }
  }

  async function _fetchDeal(id) {
    _odv.loading = true; _odv.error = null; _odv.data = null;
    _odv.dealId = id;
    window.DFO?.render && window.DFO.render();
    const j = await _tryFetch('sales-deal-detail', '/api/sales-deal-detail?id=' + encodeURIComponent(id));
    if (_odv.dealId !== id) return; // race-guard bij snelle wisseling
    _odv.loading = false;
    if (!j) { _odv.error = 'Kon offerte niet laden'; }
    else if (j.error) { _odv.error = j.error; }
    else { _odv.data = j; }
    window.DFO?.render && window.DFO.render();
  }

  // Public entry — sales-v2 mount deze wanneer URL ?deal_id=X aanwezig is.
  window.__odvRenderView = function (dealId) {
    if (!dealId) return _emptyState('Geen deal-id opgegeven.');
    if (_odv.dealId !== dealId || (!_odv.loading && !_odv.data && !_odv.error)) {
      queueMicrotask(() => _fetchDeal(dealId));
    }
    if (_odv.loading || (!_odv.data && !_odv.error)) return _loadingState(dealId);
    if (_odv.error) return _errorState(dealId, _odv.error);
    return _renderDeal(_odv.data);
  };

  function _emptyState(msg) {
    return `<div class="odv-wrap">
      <div class="odv-top">
        <button class="btn btn-ghost" onclick="__svOfferteDetailClose()">${svg(I.arrLeft || I.up)} Terug naar offertes</button>
      </div>
      <div class="sv-empty" style="margin:24px 22px">${esc(msg)}</div>
    </div>`;
  }
  function _loadingState(dealId) {
    return `<div class="odv-wrap">
      <div class="odv-top">
        <button class="btn btn-ghost" onclick="__svOfferteDetailClose()">${svg(I.arrLeft || I.up)} Terug naar offertes</button>
        <div class="odv-title-skel">Offerte laden…</div>
      </div>
      <div style="padding:24px 22px;color:var(--text-3);font-style:italic">Offerte ${esc(String(dealId).slice(0, 8))}… laden…</div>
    </div>`;
  }
  function _errorState(dealId, err) {
    return `<div class="odv-wrap">
      <div class="odv-top">
        <button class="btn btn-ghost" onclick="__svOfferteDetailClose()">${svg(I.arrLeft || I.up)} Terug naar offertes</button>
      </div>
      <div class="sv-empty" style="margin:24px 22px;background:var(--rose-soft,#FBEAED);color:var(--rose,#C22B3E);border:1px solid var(--rose-line,#F1B4BE)">
        ⚠ Kon offerte niet laden (${esc(String(dealId).slice(0, 8))}): ${esc(err)}
      </div>
    </div>`;
  }

  const STATUS_PILL = {
    draft:      ['neutral', 'Concept'],
    sent:       ['info',    'Verzonden'],
    accepted:   ['ok',      'Geaccepteerd'],
    declined:   ['warn',    'Afgewezen'],
    cancelled:  ['neutral', 'Geannuleerd'],
    signed:     ['ok',      'Getekend'],
  };

  function _renderDeal(payload) {
    const d = payload.deal || {};
    const c = payload.customer || {};
    const items = asArr(payload.line_items);
    const totals = payload.totals || { excl: 0, incl: 0 };
    const traject = payload.traject || null;
    const entity = payload.entity || null;
    const hasSubscription = !!payload.has_subscription;
    const canOpenSubw = typeof window.__subwOpen === 'function';

    const custName = c.is_company
      ? (c.company_name || '—')
      : `${c.first_name || ''} ${c.last_name || ''}`.trim() || '—';
    const [pillC, pillL] = STATUS_PILL[d.tl_quotation_status] || ['neutral', d.tl_quotation_status || 'Onbekend'];

    // Reken-helper: per regel excl/incl/btw net als in server.
    const factor = 1 - (Number(d.discount_percentage) || 0) / 100;
    const zeroVat = d.sale_type && d.sale_type !== 'domestic';
    const rowsHtml = items.map((l) => {
      const qty = Number(l.quantity) || 0;
      const unit = Number(l.unit_price) || 0;
      const vatN = Number(l.vat_percentage);
      const vat = zeroVat ? 0 : ((vatN != null && !Number.isNaN(vatN)) ? vatN : 21);
      const rate = vat / 100;
      const gross = qty * unit;
      const excl = (l.price_includes_vat ? gross / (1 + rate) : gross) * factor;
      const incl = excl * (1 + rate);
      return `<tr>
        <td>${esc(l.description || l.product_name || 'Regel')}</td>
        <td class="mono r">${qty}</td>
        <td class="mono r">${eur(unit)}</td>
        <td class="mono r">${vat}%</td>
        <td class="mono r">${eur(excl)}</td>
        <td class="mono r">${eur(incl)}</td>
      </tr>`;
    }).join('');

    return `<div class="odv-wrap">
      <div class="odv-top">
        <button class="btn btn-ghost" onclick="__svOfferteDetailClose()">${svg(I.arrLeft || I.up)} Terug naar offertes</button>
        <div class="odv-title">${esc(d.quote_reference || '#' + String(d.id || '').slice(0, 8))} — ${esc(custName)}</div>
        <div class="odv-pill">${H.pill(pillC, pillL)}</div>
        <div style="flex:1"></div>
        <button class="btn" onclick="__svOfferteEdit('${esc(d.id)}')" title="Bewerk deze offerte in de v2-wizard">${svg(I.edit || I.plus)} Bewerken</button>
        <button class="btn btn-primary" onclick="__odvConvertToSub('${esc(d.id)}')" ${canOpenSubw ? '' : 'disabled title="Abonnement-wizard nog niet geladen"'}>${svg(I.repeat || I.plus)} Omzetten naar abonnement</button>
      </div>

      <div class="odv-body">
        <div class="odv-col">
          <div class="odv-card">
            <div class="odv-card-head">Klant</div>
            <div class="odv-card-body">
              <div class="odv-kv"><span>Naam</span><b>${esc(custName)}</b></div>
              <div class="odv-kv"><span>E-mail</span><span>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '—'}</span></div>
              <div class="odv-kv"><span>Telefoon</span><span>${esc(c.phone || '—')}</span></div>
              ${c.is_company ? `
                <div class="odv-kv"><span>KvK</span><span class="mono">${esc(c.kvk_number || '—')}</span></div>
                <div class="odv-kv"><span>BTW-nr</span><span class="mono">${esc(c.vat_number || '—')}</span></div>
              ` : ''}
              <div class="odv-kv"><span>Adres</span><span>${esc([c.address_street, c.address_number].filter(Boolean).join(' ') || '—')}${c.address_postal || c.address_city ? '<br>' + esc([c.address_postal, c.address_city].filter(Boolean).join(' ')) : ''}${c.address_country ? ' · ' + esc(c.address_country) : ''}</span></div>
            </div>
          </div>

          <div class="odv-card">
            <div class="odv-card-head">Offerte</div>
            <div class="odv-card-body">
              <div class="odv-kv"><span>Referentie</span><b>${esc(d.quote_reference || '—')}</b></div>
              <div class="odv-kv"><span>Status</span>${H.pill(pillC, pillL)}</div>
              <div class="odv-kv"><span>Entiteit</span><span>${esc(entity || '—')}</span></div>
              <div class="odv-kv"><span>Traject</span><span>${esc(traject?.label || '—')}</span></div>
              <div class="odv-kv"><span>Sale-type</span><span>${esc(d.sale_type || 'domestic')}${zeroVat ? ' <span style="color:var(--amber)">(0% BTW)</span>' : ''}</span></div>
              <div class="odv-kv"><span>Startdatum</span><span>${dstrLong(d.start_date)}</span></div>
              <div class="odv-kv"><span>Aangemaakt</span><span>${dstrLong(d.created_at)}</span></div>
              ${d.tl_quotation_accepted_at ? `<div class="odv-kv"><span>Geaccepteerd op</span><span>${dstrLong(d.tl_quotation_accepted_at)}</span></div>` : ''}
              ${d.tl_quotation_signed_at ? `<div class="odv-kv"><span>Getekend op</span><span>${dstrLong(d.tl_quotation_signed_at)}</span></div>` : ''}
              ${hasSubscription ? `<div class="odv-kv"><span>Abonnement</span><span style="color:var(--emerald)">✓ Al aangemaakt</span></div>` : ''}
            </div>
          </div>

          ${(d.payment_downpayment_amount || d.payment_term_count) ? `
            <div class="odv-card">
              <div class="odv-card-head">Betalingsvoorwaarden</div>
              <div class="odv-card-body">
                ${d.payment_downpayment_amount ? `<div class="odv-kv"><span>Aanbetaling</span><b>${eur(d.payment_downpayment_amount)}</b></div>` : ''}
                ${d.payment_downpayment_date ? `<div class="odv-kv"><span>Aanbetaling-datum</span><span>${dstrLong(d.payment_downpayment_date)}</span></div>` : ''}
                ${d.payment_term_count ? `<div class="odv-kv"><span>Termijnen</span><b>${d.payment_term_count}× ${eur(d.payment_term_amount || 0)}</b></div>` : ''}
                ${d.payment_term_start_date ? `<div class="odv-kv"><span>Eerste termijn</span><span>${dstrLong(d.payment_term_start_date)}</span></div>` : ''}
              </div>
            </div>
          ` : ''}
        </div>

        <div class="odv-col odv-col-wide">
          <div class="odv-card">
            <div class="odv-card-head">Producten ${items.length ? `<span style="color:var(--text-3);font-weight:normal">· ${items.length} regel${items.length === 1 ? '' : 's'}</span>` : ''}</div>
            <div class="odv-card-body" style="padding:0">
              ${items.length ? `<div class="tbl-wrap"><table class="odv-lines">
                <thead><tr><th>Omschrijving</th><th class="r">Aantal</th><th class="r">Prijs</th><th class="r">BTW</th><th class="r">Excl.</th><th class="r">Incl.</th></tr></thead>
                <tbody>${rowsHtml}</tbody>
              </table></div>` : '<div style="padding:20px;color:var(--text-3)">Geen regels op deze offerte.</div>'}
              <div class="odv-totals">
                ${d.discount_percentage ? `<div class="odv-total-row"><span>Korting</span><b>${Number(d.discount_percentage)}%</b></div>` : ''}
                <div class="odv-total-row"><span>Subtotaal excl.</span><b class="mono">${eur(totals.excl)}</b></div>
                <div class="odv-total-row"><span>BTW</span><b class="mono">${eur((Number(totals.incl) || 0) - (Number(totals.excl) || 0))}</b></div>
                <div class="odv-total-row odv-total-grand"><span>Totaal incl.</span><b class="mono">${eur(totals.incl)}</b></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }

  // ── Handlers ────────────────────────────────────────────────────────
  // "Omzetten naar abonnement": subw-v2 is via #1282 op main; script is
  // geladen op /modules/klanten-v2/. Guard voor het geval iemand
  // handmatig een oudere shell-versie draait.
  window.__odvConvertToSub = (dealId) => {
    if (!dealId) return;
    try { if (typeof window.__swLog === 'function') window.__swLog('odv:convert-to-sub', { dealId, has: typeof window.__subwOpen === 'function' }); } catch (_) {}
    if (typeof window.__subwOpen === 'function') {
      window.__subwOpen({ dealId: String(dealId) });
    } else {
      try { window.KV?.toast?.('Abonnement-wizard niet geladen — herlaad de pagina.'); } catch (_) {}
    }
  };

  // Expose een reset zodat sales-v2 na terugklik of nieuwe navigatie
  // kan garanderen dat de volgende open een verse fetch doet.
  window.__odvReset = () => { _odv.dealId = null; _odv.data = null; _odv.error = null; _odv.loading = false; };

  console.debug('[odv-v2] loaded — window.__odvRenderView(dealId) beschikbaar');
})();
