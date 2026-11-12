// modules/klanten-v2/views/_commissie-ui.js
//
// Gedeelde bouwstenen voor "mentorcommissie op een sale" (12 nov 2026):
// waarschuwing + keuze in verwijdervensters (regels B en C), de kaart op de
// offertepagina, de chip in lijsten en het openen van de bestaande
// toewijs-wizard (Mentoren → Commissies → "+ Sale toewijzen") met invulling.
//
// Data komt uit GET /api/commissie-annulering (api/_lib/commissie-annulering.js:
// vatSamen). Geen eigen rekenwerk: bedragen = de toezegging in het grootboek
// en de vrijgegeven stukken.
//
// Vensters worden op document.body gemount (los van DFO.render) en sluiten
// alleen via een knop.

(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const eur = (n) => (n == null ? '—' : new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 }).format(Number(n) || 0));
  const eur0 = (n) => new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0));
  const MAAND = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  function datum(iso) {
    if (!iso) return '';
    const d = new Date(String(iso).length <= 10 ? iso + 'T00:00:00' : iso);
    return Number.isNaN(d.getTime()) ? String(iso) : `${d.getDate()} ${MAAND[d.getMonth()]} ${d.getFullYear()}`;
  }
  function kortDatum(iso) {
    if (!iso) return '';
    const d = new Date(String(iso).length <= 10 ? iso + 'T00:00:00' : iso);
    return Number.isNaN(d.getTime()) ? '' : `${d.getDate()}/${d.getMonth() + 1}`;
  }
  const REDEN = { verlenging: 'Verlenging', upsell: 'Upsell', handmatig: 'Handmatig' };

  /** "Event Masterclass · 7 nov 2026" of "Handmatig · verlenging". */
  function bronTekst(c, kort) {
    const b = c && c.bron;
    if (!b) return '';
    if (b.soort === 'event') return kort ? `Event ${kortDatum(b.datum)}`.trim() : `${b.titel || 'Event'}${b.datum ? ' · ' + datum(b.datum) : ''}`;
    return kort ? 'Handmatig' : `Handmatig · ${(REDEN[b.reden] || b.reden || 'handmatig').toLowerCase()}`;
  }
  const mentorNamen = (c, alleenActief) => (c?.mentoren || []).filter((m) => !alleenActief || !m.geannuleerd).map((m) => m.naam);
  const uniek = (arr) => [...new Set(arr)];

  /** Waarschuwingsblok voor verwijdervensters: wie, hoeveel, bron. */
  function waarschuwingHtml(c) {
    if (!c || !c.heeft_commissie) return '';
    const actief = (c.mentoren || []).filter((m) => !m.geannuleerd);
    if (!actief.length) {
      return `<div style="padding:9px 11px;border:1px solid var(--border);background:var(--surface-2);border-radius:8px;font-size:12.5px;margin:8px 0">
        Mentorcommissie op deze offerte is al geannuleerd${c.annulering?.reden ? ` (${esc(c.annulering.reden)})` : ''}.</div>`;
    }
    const rijen = actief.map((m) => `<li><b>${esc(m.naam)}</b> · <span class="mono">${esc(eur(m.bedrag))}</span>${m.vrijgegeven > 0 ? ` <span style="color:var(--emerald)">(${esc(eur(m.vrijgegeven))} al vrijgegeven — blijft staan)</span>` : ''}</li>`).join('');
    return `<div style="padding:10px 12px;border:1px solid var(--amber-line,#fcd34d);background:var(--amber-soft,#fffbeb);border-radius:8px;font-size:12.5px;margin:8px 0;color:var(--text,#111)">
      <div style="font-weight:600;margin-bottom:4px">⚠ Aan deze offerte hangt mentorcommissie</div>
      <div style="color:var(--text-2,#374151)">Bron: <b>${esc(bronTekst(c))}</b>${c.pct != null ? ` · ${esc(c.pct)}% van ${esc(eur(c.basis))} ${c.basis_incl_btw ? 'incl.' : 'excl.'} btw` : ''}</div>
      <ul style="margin:6px 0 0 18px;padding:0">${rijen}</ul>
    </div>`;
  }

  /**
   * Keuzevenster. opties = [{ v, l, d, kleur? }]. Resolve met de gekozen v
   * of null (Annuleren). Niets is vooraf gekozen: de mens kiest.
   */
  function keuze({ titel, intro = '', commissie = null, opties = [], okLabel = 'Doorgaan' }) {
    return new Promise((resolve) => {
      let gekozen = null;
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9650;display:flex;align-items:center;justify-content:center;padding:16px';
      const knoppen = opties.map((o, i) => `
        <label data-i="${i}" style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1.5px solid var(--border,#e5e7eb);border-radius:9px;cursor:pointer;margin-top:8px">
          <input type="radio" name="kv-comm-keuze" value="${esc(o.v)}" style="margin-top:3px">
          <span><b style="font-size:13px">${esc(o.l)}</b>${o.d ? `<br><span style="font-size:12px;color:var(--text-3,#6b7280)">${esc(o.d)}</span>` : ''}</span>
        </label>`).join('');
      wrap.innerHTML = `<div style="background:var(--surface,#fff);color:var(--text,#111);border:1px solid var(--border,#e5e7eb);border-radius:12px;max-width:540px;width:100%;max-height:92vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border,#e5e7eb);font-size:14px;font-weight:600">${esc(titel)}</div>
        <div style="padding:12px 18px;font-size:13px;line-height:1.5">${intro}${waarschuwingHtml(commissie)}
          <div style="font-size:12.5px;font-weight:600;margin-top:10px">Wat gebeurt er met de commissie?</div>${knoppen}</div>
        <div style="padding:11px 18px;border-top:1px solid var(--border,#e5e7eb);display:flex;gap:8px;justify-content:flex-end">
          <button type="button" data-x class="btn btn-ghost">Annuleren</button>
          <button type="button" data-ok class="btn btn-primary" disabled style="opacity:.5">${esc(okLabel)}</button>
        </div></div>`;
      document.body.appendChild(wrap);
      const ok = wrap.querySelector('[data-ok]');
      wrap.querySelectorAll('input[name="kv-comm-keuze"]').forEach((r) => r.addEventListener('change', () => {
        gekozen = r.value; ok.disabled = false; ok.style.opacity = '1';
        wrap.querySelectorAll('label[data-i]').forEach((l) => { l.style.borderColor = l.contains(r) ? 'var(--brand,#0A7490)' : 'var(--border,#e5e7eb)'; });
      }));
      const sluit = (v) => { try { wrap.remove(); } catch (_) {} resolve(v); };
      wrap.querySelector('[data-x]').addEventListener('click', () => sluit(null));
      ok.addEventListener('click', () => { if (gekozen) sluit(gekozen); });
    });
  }

  /** Bericht-venster (één knop). */
  function melding(titel, html) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9650;display:flex;align-items:center;justify-content:center;padding:16px';
      wrap.innerHTML = `<div style="background:var(--surface,#fff);color:var(--text,#111);border-radius:12px;max-width:480px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3)">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border,#e5e7eb);font-size:14px;font-weight:600">${esc(titel)}</div>
        <div style="padding:14px 18px;font-size:13px;line-height:1.55">${html}</div>
        <div style="padding:11px 18px;border-top:1px solid var(--border,#e5e7eb);display:flex;justify-content:flex-end"><button type="button" class="btn btn-primary" data-ok>OK</button></div></div>`;
      document.body.appendChild(wrap);
      wrap.querySelector('[data-ok]').addEventListener('click', () => { wrap.remove(); resolve(); });
    });
  }

  /**
   * Open de bestaande toewijs-wizard (commissies-v2.js) voorgevuld.
   * prefill = { deal_id, mentoren:[uid], pct, basis_incl_btw, reden, note }
   */
  function openToewijzen(prefill) {
    if (typeof window.__commWizOpen === 'function') { window.__commWizOpen(prefill || {}); return true; }
    try { window.DFO.goMod('mentoren'); window.DFO.goTab('Commissies'); } catch (_) { /* fail-soft */ }
    return false;
  }

  /** Statuspil van een sale (vrijgegeven vs toezegging). */
  function status(c, extra = {}) {
    if (!c || !c.heeft_commissie) return { k: 'geen', l: 'Geen commissie', c: 'neutral' };
    if (c.status === 'geannuleerd') return { k: 'geannuleerd', l: 'Geannuleerd', c: 'neutral' };
    if (extra.incasso) return { k: 'incasso', l: 'Incasso', c: 'danger' };
    if (c.totaal > 0 && c.vrijgegeven >= c.totaal - 0.01) return { k: 'volledig', l: 'Volledig vrijgegeven', c: 'ok' };
    if (extra.achterstallig) return { k: 'achterstallig', l: 'Achterstallig', c: 'danger' };
    if (c.vrijgegeven > 0.004) return { k: 'deels', l: 'Deels vrijgegeven', c: 'accent' };
    return { k: 'wacht', l: 'Wacht op betaling', c: 'neutral' };
  }

  window.KV_COMM = { esc, eur, eur0, datum, kortDatum, bronTekst, mentorNamen, uniek, waarschuwingHtml, keuze, melding, openToewijzen, status };
})();
