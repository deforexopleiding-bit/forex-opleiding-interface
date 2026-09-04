// modules/shared/mentor-payout-render.js
//
// BP3 v29 (2026-09-03) — gedeelde render-helper voor mentor-payout-detail.
// Wordt hergebruikt in:
//   - modules/mentor-payouts-admin.html  (admin-CRUD; mode='admin')
//   - modules/mentor-dashboard.html      (mentor read-only; mode='mentor')
//
// Extractie-uitgangspunt: de HTML-output voor mode='admin' is BYTE-identiek
// aan de vorige inline-render in mentor-payouts-admin.html (renderDetail()).
// Voor mode='mentor' is het de bestaande inline-render uit mentor-dashboard
// (renderPayoutDetail()). Verschillen:
//   - mode='admin' toont Categorie/Aantal/Tarief-incl/Bedrag-incl/Bedrag-excl
//     kolommen + bonus-breakdown-toggle (via opts.bonusBreakdownHtml) + een
//     APARTE Handmatige-posten-tabel met Bewerken/Verwijderen-knoppen.
//   - mode='mentor' toont Omschrijving/Aantal (qty × tarief)/Excl/Incl kolommen
//     + tfoot met subtotaal/btw/totaal, met handmatige posten INLINE in de
//     lines-tabel (geen aparte adjustments-tabel).
//
// Callers geven hun eigen `esc` + `fmtEUR` (kleine helpers, verschillende
// pages hebben verschillende implementaties). Dit voorkomt cross-page
// coupling en houdt de helper puur.

(function () {
  const R = {};

  // Map line.kind → NL-label. Gedeeld door beide modes; mentor gebruikt 'em
  // als fallback wanneer l.label leeg is.
  R.kindLabel = function (kind) {
    switch (kind) {
      case 'bonus':            return 'Event-bonus';
      case 'coaching_1on1':    return 'Coaching · 1-op-1';
      case 'coaching_team':    return 'Coaching · teamtraining';
      case 'coaching_noshow':  return 'Coaching · no-show';
      case 'coaching_funded':  return 'Coaching · funded';
      case 'reiskosten':       return 'Reiskosten';
      case 'vast':             return 'Vaste maandpost';
      case 'handmatig':        return 'Handmatige correctie';
      default:                 return kind || '—';
    }
  };

  // Render de Regels-tabel (mode='admin' of 'mentor').
  //
  // opts.mode                  — 'admin' | 'mentor'.
  // opts.esc                   — HTML-escape fn (verplicht).
  // opts.fmtEUR                — euro-format fn (verplicht).
  // opts.bonusBreakdownHtml    — (admin) HTML-string voor bonus-breakdown-rij;
  //                              als aanwezig krijgt de bonus-rij een chevron-
  //                              toggle. Als null/undefined: geen toggle.
  R.renderLinesTableHtml = function (payout, opts) {
    const o = opts || {};
    const mode = o.mode === 'mentor' ? 'mentor' : 'admin';
    const esc = o.esc; const fmtEUR = o.fmtEUR;
    if (typeof esc !== 'function' || typeof fmtEUR !== 'function') {
      return '<em style="color:#b91c1c">MentorPayoutRender: esc + fmtEUR vereist.</em>';
    }
    const p = payout || {};
    const lines = Array.isArray(p.lines) ? p.lines : [];

    if (mode === 'admin') {
      const bonusBreakdownHtml = typeof o.bonusBreakdownHtml === 'string' ? o.bonusBreakdownHtml : null;
      const rows = lines.length === 0
        ? `<tr><td colspan="5" style="text-align:center;color:var(--text-faint);padding:14px">Geen regels.</td></tr>`
        : lines.map((l, li) => {
            const qty       = (l.qty == null) ? '—' : String(l.qty);
            const unitIncl  = (l.unit_incl == null) ? '—' : fmtEUR(l.unit_incl);
            const isBonus   = l.kind === 'bonus' && !!bonusBreakdownHtml;
            const chevron   = isBonus ? '<span class="bonus-chevron" style="display:inline-block;transition:transform 0.15s;margin-right:6px">▸</span>' : '';
            const clickable = isBonus ? ' data-bonus-toggle="' + li + '" style="cursor:pointer"' : '';
            const rowMain = `
              <tr${clickable}>
                <td>${chevron}${esc(l.label || l.kind || '—')}</td>
                <td class="num">${esc(qty)}</td>
                <td class="num">${esc(unitIncl)}</td>
                <td class="num">${fmtEUR(l.amount_incl)}</td>
                <td class="num">${fmtEUR(l.amount_excl)}</td>
              </tr>`;
            const rowBreakdown = isBonus ? `
              <tr class="bonus-breakdown-row" data-bonus-row="${li}" style="display:none">
                <td colspan="5" style="padding:6px 10px 10px">${bonusBreakdownHtml}</td>
              </tr>` : '';
            return rowMain + rowBreakdown;
          }).join('');
      return `<table class="lines-table">
        <thead>
          <tr>
            <th>Categorie</th>
            <th class="num">Aantal</th>
            <th class="num">Tarief incl</th>
            <th class="num">Bedrag incl</th>
            <th class="num">Bedrag excl</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td colspan="3" style="text-align:right">Totaal</td>
            <td class="num">${fmtEUR(p.total)}</td>
            <td class="num">${fmtEUR(p.total_excl)}</td>
          </tr>
        </tfoot>
      </table>`;
    }

    // mode === 'mentor' — read-only, adjustments inline in dezelfde tabel.
    const adjustments = Array.isArray(p.adjustments) ? p.adjustments : [];
    const hasHandmatigInLines = lines.some((l) => l.kind === 'handmatig');
    const lineRows = lines.map((l) => {
      const qtyTxt = (l.qty != null && l.qty !== '' && l.unit_incl != null)
        ? `${esc(String(l.qty))} × ${fmtEUR(l.unit_incl)}`
        : '';
      const labelTxt = l.label || R.kindLabel(l.kind);
      return `
        <tr>
          <td>${esc(labelTxt)}</td>
          <td class="num">${esc(qtyTxt)}</td>
          <td class="num">${fmtEUR(l.amount_excl)}</td>
          <td class="num">${fmtEUR(l.amount_incl)}</td>
        </tr>`;
    }).join('');
    const adjRows = (!hasHandmatigInLines && adjustments.length > 0)
      ? adjustments.map((a) => `
          <tr>
            <td>${esc(a.label || 'Handmatige correctie')}</td>
            <td class="num"></td>
            <td class="num">${fmtEUR(a.amount_excl)}</td>
            <td class="num">${fmtEUR(a.amount_incl)}</td>
          </tr>`).join('')
      : '';
    const allRows = (lineRows + adjRows) ||
      `<tr><td colspan="4" style="text-align:center;color:var(--text-faint);padding:14px">Geen regels.</td></tr>`;
    return `<table class="data-table" style="background:var(--bg-elev)">
      <thead>
        <tr>
          <th>Omschrijving</th>
          <th class="num" style="white-space:nowrap;width:1%">Aantal</th>
          <th class="num">Excl. btw</th>
          <th class="num">Incl. btw</th>
        </tr>
      </thead>
      <tbody>${allRows}</tbody>
      <tfoot>
        <tr>
          <td colspan="2" style="text-align:right;font-size:11.5px;color:var(--text-dim)">Subtotaal excl. btw</td>
          <td class="num" style="font-size:11.5px;color:var(--text-dim)">${fmtEUR(p.total_excl)}</td>
          <td class="num"></td>
        </tr>
        <tr>
          <td colspan="2" style="text-align:right;font-size:11.5px;color:var(--text-dim)">BTW 21%</td>
          <td class="num" style="font-size:11.5px;color:var(--text-dim)">${fmtEUR(p.btw_amount)}</td>
          <td class="num"></td>
        </tr>
        <tr style="background:rgba(10,47,99,0.06)">
          <td colspan="3" style="text-align:right;font-weight:700">Totaal incl.</td>
          <td class="num" style="font-weight:700">${fmtEUR(p.total)}</td>
        </tr>
      </tfoot>
    </table>`;
  };

  // Render Handmatige-posten-tabel (Label / Bedrag / Acties).
  // Alleen zinvol voor mode='admin' — mentor-view integreert adjustments in
  // renderLinesTableHtml. Voor mode='mentor' retourneert deze fn een lege
  // string zodat caller 'em gewoon kan concatten.
  //
  // opts.esc, opts.fmtEUR — verplicht.
  // opts.idx              — data-idx-attribuut voor per-rij delete/edit-binding.
  R.renderAdjustmentsTableHtml = function (payout, opts) {
    const o = opts || {};
    const mode = o.mode === 'mentor' ? 'mentor' : 'admin';
    if (mode !== 'admin') return '';
    const esc = o.esc; const fmtEUR = o.fmtEUR;
    if (typeof esc !== 'function' || typeof fmtEUR !== 'function') {
      return '<em style="color:#b91c1c">MentorPayoutRender: esc + fmtEUR vereist.</em>';
    }
    const p = payout || {};
    const idx = (o.idx != null) ? o.idx : 0;
    const adjustments = Array.isArray(p.adjustments) ? p.adjustments : [];
    const rows = adjustments.length === 0
      ? `<tr><td colspan="3" style="text-align:center;color:var(--text-faint);padding:10px">Nog geen handmatige posten.</td></tr>`
      : adjustments.map((a) => `
          <tr>
            <td>${esc(a.label || 'Handmatige post')}</td>
            <td class="num" style="${(Number(a.amount_incl)||0) < 0 ? 'color:#b91c1c' : ''}">${fmtEUR(a.amount_incl)}</td>
            <td class="num">
              <button type="button" class="adj-edit" data-adj-id="${esc(a.id)}" data-payout-id="${esc(p.id)}" data-idx="${esc(idx)}">Bewerken</button>
              <button type="button" class="adj-del"  data-adj-id="${esc(a.id)}" data-payout-id="${esc(p.id)}" data-idx="${esc(idx)}">Verwijderen</button>
            </td>
          </tr>`).join('');
    return `<table class="lines-table" style="margin-top:6px">
      <thead>
        <tr>
          <th>Label</th>
          <th class="num">Bedrag (incl)</th>
          <th class="num">Acties</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  };

  window.MentorPayoutRender = R;
})();
