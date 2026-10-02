// modules/klanten-v2/views/call-rapport-v2.js
//
// Opvolging → tab Call-rapport. Per dag, per closer: hoeveel calls, hoeveel
// met een uitkomst, de verdeling over de categorieën en welke calls nog geen
// uitkomst hebben. Daaronder hetzelfde per setter.
//
// Eigen bestand naast opvolging-v2.js, op een eigen sleutel in DFO.VIEWS
// ('opvolging/Call-rapport'). Raakt de bestaande vier tabs niet aan.
//
// DIT SCHERM TELT NIETS. Alle getallen komen van /api/call-rapport; dat
// endpoint hergebruikt de regels van het Salesrapport (welke afspraak telt,
// wat is dubbel beeld) en de centrale categorie-mapping. Labels en kleuren
// komen uit window.CallUitkomstCategorie (modules/shared/call-uitkomst-
// categorie.js) — hier staat geen enkel categorielabel hard in. Ontbreekt die
// mapping, dan zegt het scherm dat, in plaats van keys als tekst te tonen.
//
// Rechten: de tab hangt in app-shell.js aan calls.rapport.view (navigatie,
// fail-open); het endpoint controleert strikt op dezelfde sleutel.

(function () {
  'use strict';
  if (!window.DFO) { console.error('[call-rapport-v2] DFO shell niet geladen.'); return; }
  window.DFO.VIEWS = window.DFO.VIEWS || {};

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // De dag in Amsterdam, niet in UTC: rond middernacht scheelt dat een dag.
  const vandaagNL = () => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  /** Kalenderdag + n dagen. Rekent op 12:00 UTC, dus zonder zomertijdgrens. */
  function dagPlus(dag, n) {
    const d = new Date(dag + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  const DAG_RE = /^\d{4}-\d{2}-\d{2}$/;

  function dagLang(dag) {
    try {
      return new Intl.DateTimeFormat('nl-NL', {
        timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      }).format(new Date(dag + 'T12:00:00Z'));
    } catch (_) { return dag; }
  }

  // De ruwe afspraakstatus in gewone woorden. Dit zijn GEEN categorieën (die
  // komen uit de mapping); het is de kolom status, zoals hij in de databank
  // staat. Een onbekende waarde wordt letterlijk getoond.
  const STATUS_WOORD = {
    scheduled: 'gepland', in_progress: 'bezig', completed: 'afgerond',
    no_show: 'no-show', cancelled: 'geannuleerd', verplaatst: 'verzet',
    wacht_op_reschedule: 'wacht op nieuw moment', verwijderd: 'verwijderd',
  };

  // ── Staat ────────────────────────────────────────────────────────────────
  const _cr = {
    dag: null,                 // null = vandaag
    data: null, loading: false, error: null, key: null,
    open: {},                  // 'closer:<id>' / 'alle:<id>' / 'setters' → true
  };

  const mapping = () => {
    const M = window.CallUitkomstCategorie;
    return M && Array.isArray(M.CATEGORIEEN) && typeof M.categorieInfo === 'function' ? M : null;
  };

  const hertekenen = () => { if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render(); };

  async function laad() {
    const dag = _cr.dag || vandaagNL();
    if (_cr.loading || (_cr.key === dag && (_cr.data || _cr.error))) return;
    _cr.loading = true; _cr.error = null; _cr.key = dag;
    try {
      const j = await window.KV.authedJson('/api/call-rapport?dag=' + encodeURIComponent(dag));
      if (j && j.error) { _cr.error = j.error; _cr.data = null; }
      else { _cr.data = j; _cr.error = null; }
    } catch (e) {
      const body = e && e.body;
      _cr.error = (body && body.error) || (e && e.message) || 'Netwerkfout';
      _cr.data = null;
    }
    _cr.loading = false;
    hertekenen();
  }

  function zetDag(dag) {
    _cr.dag = dag;
    _cr.key = null; _cr.data = null; _cr.error = null;
    hertekenen();
  }

  window.__callRapDag = (stap) => {
    const nu = _cr.dag || vandaagNL();
    zetDag(stap === 0 ? null : dagPlus(nu, stap));
  };
  window.__callRapKies = () => {
    const el = document.getElementById('callrap-dag');
    const v = el && el.value;
    if (!v || !DAG_RE.test(v)) return;
    zetDag(v === vandaagNL() ? null : v);
  };
  window.__callRapToggle = (sleutel) => {
    _cr.open[sleutel] = !_cr.open[sleutel];
    hertekenen();
  };
  window.__callRapHerlaad = () => { _cr.key = null; _cr.data = null; _cr.error = null; hertekenen(); };

  // ── Stijl ────────────────────────────────────────────────────────────────
  function stijl() {
    if (document.getElementById('callrap-stijl')) return;
    const el = document.createElement('style');
    el.id = 'callrap-stijl';
    el.textContent = `
.callrap{--cr-line:#e5e7eb;--cr-muted:#6b7280;--cr-ink:#0f1419;--cr-card:#fff;--cr-soft:#f6f7f9;
 color:var(--cr-ink);padding:18px 22px 60px;max-width:1040px;box-sizing:border-box}
.callrap *{box-sizing:border-box}
.callrap .cr-kop{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 14px}
.callrap .cr-kop h2{font-size:18px;margin:0 12px 0 0;flex:1 1 220px}
.callrap .cr-nav{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.callrap .cr-btn{border:1px solid var(--cr-line);background:var(--cr-card);border-radius:8px;padding:7px 11px;
 font:inherit;font-size:13px;cursor:pointer;min-height:36px}
.callrap .cr-btn.p{background:#2f6bff;border-color:#2f6bff;color:#fff}
.callrap input[type=date]{border:1px solid var(--cr-line);border-radius:8px;padding:6px 8px;font:inherit;font-size:16px;min-height:36px}
.callrap .cr-dag{font-size:13px;color:var(--cr-muted);margin:0 0 12px}
.callrap .cr-melding{border-radius:10px;padding:12px 14px;margin:0 0 12px;font-size:14px;line-height:1.45}
.callrap .cr-info{background:#eef4ff;border:1px solid #c9dafc}
.callrap .cr-warn{background:#fff5e6;border:1px solid #f3d29a}
.callrap .cr-fout{background:#fdeced;border:1px solid #f4b8bb}
.callrap .cr-kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin:0 0 14px}
.callrap .cr-cel{background:var(--cr-card);border:1px solid var(--cr-line);border-radius:10px;padding:10px 12px}
.callrap .cr-getal{font-size:22px;font-weight:700;line-height:1.1}
.callrap .cr-label{font-size:12px;color:var(--cr-muted);margin-top:2px}
.callrap .cr-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;margin:0 0 18px}
.callrap .cr-card{background:var(--cr-card);border:1px solid var(--cr-line);border-radius:12px;padding:14px;
 box-shadow:0 1px 2px rgba(16,20,30,.05)}
.callrap .cr-card h3{font-size:15px;margin:0 0 4px}
.callrap .cr-sub{font-size:13px;color:var(--cr-muted);margin:0 0 10px}
.callrap .cr-sub b.rood{color:#e11d48}
.callrap .cr-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}
.callrap .cr-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--cr-line);border-radius:999px;
 padding:3px 10px 3px 8px;font-size:12px;background:var(--cr-soft)}
.callrap .cr-chip i{width:9px;height:9px;border-radius:50%;display:inline-block;flex:none}
.callrap .cr-chip b{font-weight:700}
.callrap .cr-uit{display:block;width:100%;text-align:left;border:0;background:none;padding:6px 0;font:inherit;
 font-size:13px;color:#2f6bff;cursor:pointer}
.callrap .cr-rijen{border-top:1px solid var(--cr-line);margin-top:4px}
.callrap .cr-rij{padding:8px 0;border-bottom:1px solid var(--cr-line);font-size:13px}
.callrap .cr-rij:last-child{border-bottom:0}
.callrap .cr-rij .t{font-weight:600}
.callrap .cr-rij .u{color:var(--cr-muted);margin-top:2px;word-break:break-word}
.callrap .cr-rij .n{margin-top:4px;background:var(--cr-soft);border-radius:6px;padding:6px 8px;white-space:pre-wrap;word-break:break-word}
.callrap .cr-leeg{color:var(--cr-muted);font-size:13px;font-style:italic}
.callrap h4.cr-sectie{font-size:14px;margin:6px 0 10px}
@media (max-width:600px){
 .callrap{padding:12px 16px 48px}
 .callrap .cr-cards{grid-template-columns:1fr}
 .callrap .cr-kop h2{flex-basis:100%}
}`;
    document.head.appendChild(el);
  }

  // ── Bouwstenen ───────────────────────────────────────────────────────────
  const cel = (getal, label) =>
    '<div class="cr-cel"><div class="cr-getal">' + esc(getal) + '</div><div class="cr-label">' + esc(label) + '</div></div>';

  /** De categorieën met een aantal > 0, in de volgorde van de mapping. */
  function chips(M, perCategorie) {
    const per = perCategorie || {};
    const lijst = M.CATEGORIEEN.slice()
      .sort((a, b) => a.volgorde - b.volgorde)
      .filter((c) => per[c.key] > 0);
    if (!lijst.length) return '<div class="cr-leeg">Geen calls.</div>';
    return '<div class="cr-chips">' + lijst.map((c) =>
      '<span class="cr-chip" data-categorie="' + esc(c.key) + '"><i style="background:' + esc(c.kleur) + '"></i>' +
      esc(c.label) + ' <b>' + esc(per[c.key]) + '</b></span>').join('') + '</div>';
  }

  function rijHtml(M, r) {
    const status = STATUS_WOORD[r.status] || r.status;
    const setter = r.setter_naam
      ? 'Setter: ' + esc(r.setter_naam) + (r.setter_via_keten ? ' (via de oorspronkelijke boeking)' : '')
      : 'Setter: onbekend';
    return '<div class="cr-rij" data-appointment="' + esc(r.appointment_id) + '">' +
      '<div class="t">' + esc(r.tijd || '--:--') + ' &middot; ' + esc(r.naam || 'Naamloos') + '</div>' +
      '<div class="u">' + esc(M.categorieInfo(r.categorie).label) + ' &middot; status ' + esc(status) +
      ' &middot; ' + setter + '</div>' +
      (r.snelle_notitie ? '<div class="n">' + esc(r.snelle_notitie) + '</div>' : '') +
      '</div>';
  }

  function uitklap(sleutel, titel, rijen, M) {
    if (!rijen || !rijen.length) return '';
    const open = !!_cr.open[sleutel];
    return '<button class="cr-uit" aria-expanded="' + open + '" onclick="window.__callRapToggle(\'' + esc(sleutel) + '\')">' +
      (open ? '&#9662; ' : '&#9656; ') + esc(titel) + ' (' + rijen.length + ')</button>' +
      (open ? '<div class="cr-rijen">' + rijen.map((r) => rijHtml(M, r)).join('') + '</div>' : '');
  }

  function closerKaart(M, c) {
    const id = c.owner_id || 'geen';
    let h = '<div class="cr-card" data-closer="' + esc(id) + '"><h3>' + esc(c.naam) + '</h3>' +
      '<div class="cr-sub">' + c.calls + ' call' + (c.calls === 1 ? '' : 's') +
      ' &middot; ' + c.vastgelegd + ' met uitkomst' +
      (c.nog_niet_vastgelegd ? ' &middot; <b class="rood">' + c.nog_niet_vastgelegd + ' nog niet vastgelegd</b>' : '') +
      (c.gepland ? ' &middot; ' + c.gepland + ' nog gepland' : '') + '</div>';
    h += chips(M, c.per_categorie);
    h += uitklap('closer:' + id, M.categorieInfo('nog_niet_vastgelegd').label, c.open, M);
    h += uitklap('alle:' + id, 'Alle calls', c.rijen, M);
    if (c.niet_meegeteld && c.niet_meegeteld.aantal) {
      h += uitklap('niet:' + id, 'Niet meegeteld (geannuleerd of verzet zonder uitkomst)', c.niet_meegeteld.rijen, M);
    }
    return h + '</div>';
  }

  function setterKaart(M, s) {
    return '<div class="cr-card" data-setter="' + esc(s.setter_user_id || 'geen') + '"><h3>' + esc(s.naam) + '</h3>' +
      '<div class="cr-sub">' + s.calls + ' call' + (s.calls === 1 ? '' : 's') +
      ' &middot; ' + s.vastgelegd + ' met uitkomst' +
      (s.nog_niet_vastgelegd ? ' &middot; <b class="rood">' + s.nog_niet_vastgelegd + ' nog niet vastgelegd</b>' : '') +
      (s.via_keten ? ' &middot; ' + s.via_keten + ' via een verzette boeking' : '') + '</div>' +
      chips(M, s.per_categorie) + '</div>';
  }

  function kop(dag) {
    const vandaag = vandaagNL();
    return '<div class="cr-kop"><h2>Call-rapport</h2><div class="cr-nav">' +
      '<button class="cr-btn" aria-label="Vorige dag" onclick="window.__callRapDag(-1)">&#8592;</button>' +
      '<input type="date" id="callrap-dag" value="' + esc(dag) + '" onchange="window.__callRapKies()">' +
      '<button class="cr-btn" aria-label="Volgende dag" onclick="window.__callRapDag(1)">&#8594;</button>' +
      '<button class="cr-btn' + (dag === vandaag ? ' p' : '') + '" onclick="window.__callRapDag(0)">Vandaag</button>' +
      '</div></div>' +
      '<div class="cr-dag">' + esc(dagLang(dag)) + '</div>';
  }

  // ── De view ──────────────────────────────────────────────────────────────
  function callRapportView() {
    stijl();
    const dag = _cr.dag || vandaagNL();
    let h = '<div class="callrap">' + kop(dag);

    const M = mapping();
    if (!M) {
      // Geen labels verzinnen: zonder de mapping weten we niet hoe een
      // categorie heet, en een key als 'nog_niet_vastgelegd' is geen tekst.
      return h + '<div class="cr-melding cr-fout"><b>Er ontbreekt een onderdeel.</b> ' +
        'De betekenis van de call-uitkomsten (call-uitkomst-categorie.js) is niet geladen. Herlaad de pagina.</div></div>';
    }

    const klaar = _cr.key === dag && (_cr.data || _cr.error);
    if (!_cr.loading && !klaar) queueMicrotask(laad);
    if (_cr.error && _cr.key === dag) {
      return h + '<div class="cr-melding cr-fout">' + esc(_cr.error) +
        ' <button class="cr-btn" onclick="window.__callRapHerlaad()">Opnieuw</button></div></div>';
    }
    if (!_cr.data || _cr.key !== dag) return h + '<div class="cr-leeg">Laden&hellip;</div></div>';

    const d = _cr.data;
    if (d.voor_startdatum) {
      return h + '<div class="cr-melding cr-info" data-voor-startdatum="1"><b>Vóór de startdatum.</b> ' +
        esc(d.melding || '') + '</div></div>';
    }

    for (const bv of d.blinde_vlekken || []) {
      h += '<div class="cr-melding cr-warn"><b>' + esc(bv.wat) + '</b>' +
        (bv.waarom ? '<div>' + esc(bv.waarom) + '</div>' : '') + '</div>';
    }
    if (d.dag_loopt_nog) {
      h += '<div class="cr-melding cr-info">Deze dag loopt nog. Dit is de stand van nu; calls die nog moeten ' +
        'plaatsvinden staan als <b>' + esc(M.categorieInfo('gepland').label) + '</b> en zijn geen achterstand.</div>';
    }

    const t = d.totaal || { calls: 0, vastgelegd: 0, nog_niet_vastgelegd: 0, gepland: 0, per_categorie: {} };
    h += '<div class="cr-kpi">' +
      cel(t.calls, 'calls') +
      cel(t.vastgelegd, 'met uitkomst') +
      cel(t.nog_niet_vastgelegd, M.categorieInfo('nog_niet_vastgelegd').label.toLowerCase()) +
      cel(t.gepland, M.categorieInfo('gepland').label.toLowerCase()) + '</div>';
    h += chips(M, t.per_categorie);

    for (const dub of d.dubbele_afspraken || []) {
      h += '<div class="cr-melding cr-warn">Er staan ' + esc((dub.tijden || []).length) + ' afspraken voor <b>' +
        esc(dub.naam || 'dezelfde persoon') + '</b> op deze dag' +
        ((dub.tijden || []).length ? ' (' + esc(dub.tijden.join(' en ')) + ')' : '') +
        '. Ze tellen allebei mee; mogelijk een dubbele boeking.</div>';
    }

    h += '<h4 class="cr-sectie">Per closer</h4>';
    h += (d.closers || []).length
      ? '<div class="cr-cards">' + d.closers.map((c) => closerKaart(M, c)).join('') + '</div>'
      : '<div class="cr-leeg">Geen calls op deze dag.</div>';

    if ((d.setters || []).length) {
      h += '<h4 class="cr-sectie">Per setter</h4>' +
        '<div class="cr-cards">' + d.setters.map((s) => setterKaart(M, s)).join('') + '</div>';
    }
    if (t.niet_meegeteld) {
      h += '<div class="cr-leeg">' + t.niet_meegeteld + ' afspraak' + (t.niet_meegeteld === 1 ? '' : 'en') +
        ' op deze dag ' + (t.niet_meegeteld === 1 ? 'is' : 'zijn') + ' geannuleerd of verzet zonder uitkomst en ' +
        (t.niet_meegeteld === 1 ? 'telt' : 'tellen') + ' niet mee; ze staan per closer onder "Niet meegeteld".</div>';
    }
    return h + '</div>';
  }

  window.DFO.VIEWS['opvolging/Call-rapport'] = callRapportView;
  // Voor tests: de staat van buitenaf kunnen zetten zonder netwerk.
  window.__callRapState = _cr;
})();
