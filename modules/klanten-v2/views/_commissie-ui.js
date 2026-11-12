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
    // De wizard leeft in Mentoren → Commissies (commissies-v2.js); eerst daar
    // naartoe, dan openen met de invulling.
    try { window.DFO.goMod('mentoren'); window.DFO.goTab('Commissies'); } catch (_) { /* fail-soft */ }
    if (typeof window.__commWizOpen === 'function') { window.__commWizOpen(prefill || {}); return true; }
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

  // ── Rechten (zelfde als Mentoren → Commissies / toewijzen) ──────────────
  const ADMIN = new Set(['super_admin', 'admin', 'manager']);
  const magToewijzen = () => { try { return ADMIN.has(String(window.DFO?.S?.role || '').toLowerCase()); } catch (_) { return false; } };

  // ── Kleuren zoals in het CRM ────────────────────────────────────────────
  const KLEUR = { ok: 'emerald', accent: 'blue', danger: 'rose', neutral: 'text-3', warn: 'amber' };
  function pil(st) {
    const k = KLEUR[st.c] || 'text-3';
    const bg = k === 'text-3' ? 'var(--surface-2)' : `var(--${k}-soft)`;
    const fg = k === 'text-3' ? 'var(--text-2)' : `var(--${k})`;
    return `<span style="display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;background:${bg};color:${fg};font-size:11.5px;font-weight:600;white-space:nowrap"><span style="width:6px;height:6px;border-radius:50%;background:${fg}"></span>${esc(st.l)}</span>`;
  }
  function avatar(naam) {
    const ini = String(naam || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
    return `<span style="width:26px;height:26px;border-radius:50%;background:var(--violet-soft);color:var(--violet);display:inline-grid;place-items:center;font-size:11px;font-weight:700;flex:none">${esc(ini)}</span>`;
  }
  const bronStip = (c) => (c?.bron?.soort === 'event' ? 'var(--rose,#C22B3E)' : 'var(--blue,#2563eb)');

  // Laatste zicht per deal (voor "Sale toewijzen" met invulling).
  const _cache = new Map();

  /** Prefill voor de toewijs-wizard op deze offerte. */
  function prefillVoor(z) {
    if (!z) return { deal_id: null };
    const v = z.vorige_vervangen;
    if (v) {
      return { deal_id: z.deal_id, mentoren: v.mentoren.map((m) => m.user_id), pct: v.pct, basis_incl_btw: v.basis_incl_btw, reden: 'handmatig',
        note: `Vervangt offerte ${v.vorige_offerte || '(verwijderd)'}${v.bron?.titel ? ' — commissie van ' + v.bron.titel + (v.bron.datum ? ' ' + datum(v.bron.datum) : '') : ''}` };
    }
    const c = z.commissie;
    if (c && c.heeft_commissie) {
      return { deal_id: z.deal_id, mentoren: uniek((c.mentoren || []).map((m) => m.user_id)), pct: c.pct, basis_incl_btw: c.basis_incl_btw, reden: 'handmatig' };
    }
    if (z.verkoper?.is_mentor) return { deal_id: z.deal_id, mentoren: [z.verkoper.user_id], pct: 3, basis_incl_btw: true, reden: 'handmatig', note: 'Verkoper is mentor' };
    return { deal_id: z.deal_id, pct: 3, basis_incl_btw: true };
  }
  window.__kvCommToewijzen = (dealId) => openToewijzen(_cache.has(dealId) ? prefillVoor(_cache.get(dealId)) : { deal_id: dealId });
  window.__kvCommNaarCommissies = () => { try { window.DFO.goMod('mentoren'); window.DFO.goTab('Commissies'); } catch (_) { /* fail-soft */ } };

  /** Chip voor kop / lijsten: "Chesney · Event 7/11 · € 108". */
  function chip(z, { bedrag = true, kort = false } = {}) {
    if (!z) return '';
    const c = z.commissie;
    // kort (lijsten): de tekst kapt af met … zodat de kolom smal blijft; het
    // bedrag (<b>) blijft altijd zichtbaar, de volledige tekst staat in de tooltip.
    const binnen = (tekst) => {
      if (!kort) return tekst;
      const m = /^(.*?)( · <b>.*<\/b>| · <s>.*<\/s>)?$/.exec(tekst) || [null, tekst, ''];
      return `<span style="display:inline-block;max-width:120px;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom">${m[1]}</span>${m[2] || ''}`;
    };
    const box = (bg, fg, stip, tekst, title) => `<span title="${esc(title || '')}" style="display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;background:${bg};color:${fg};font-size:11.5px;font-weight:500;white-space:nowrap">${stip ? `<span style="width:7px;height:7px;border-radius:50%;background:${stip}"></span>` : ''}${binnen(tekst)}</span>`;
    if (c && c.heeft_commissie && c.status === 'geannuleerd') {
      return box('var(--surface-2)', 'var(--text-3)', null, `Geannuleerd${bedrag ? ' · <s>' + esc(eur0(c.totaal_oorspronkelijk)) + '</s>' : ''}`, c.annulering?.reden || 'Geannuleerd');
    }
    if (c && c.heeft_commissie) {
      const namen = uniek(mentorNamen(c, true)).join(', ');
      if (z.incasso && z.incasso.status === 'bij_incasso') return box('var(--rose-soft)', 'var(--rose)', 'var(--rose)', `Incasso · ${esc(namen)}`, z.incasso.label + (z.incasso.sinds ? ' sinds ' + datum(z.incasso.sinds) : ''));
      return box('var(--surface-2)', 'var(--text)', bronStip(c), `${esc(namen)} · ${esc(bronTekst(c, true))}${bedrag ? ' · <b>' + esc(eur0(c.totaal)) + '</b>' : ''}`, `${namen} · ${bronTekst(c)}`);
    }
    if (z.membership) return box('var(--surface-2)', 'var(--text-3)', null, 'Geen · membership', 'Membership: geen mentorcommissie');
    if (z.verkoper?.is_mentor && z.getekend && !z.gearchiveerd) return box('var(--amber-soft)', 'var(--amber)', 'var(--amber)', 'Geen · verkoper is mentor', `Verkoper ${z.verkoper.naam} is mentor — toewijzen?`);
    return '';
  }

  /** Kaart op de offertepagina. z = GET /api/commissie-zicht?deal_id=… → zicht. */
  function kaart(z, { laden = false, fout = null } = {}) {
    const kop = (rechts) => `<div class="odv-card-h" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">Mentorcommissie op deze offerte<span style="margin-left:auto">${rechts || ''}</span></div>`;
    if (laden) return `<div class="odv-card" style="margin-bottom:14px">${kop()}<div class="odv-card-b" style="color:var(--text-3);font-size:12.5px">Commissie laden…</div></div>`;
    if (fout) return `<div class="odv-card" style="margin-bottom:14px">${kop()}<div class="odv-card-b" style="color:var(--text-3);font-size:12.5px">Commissie niet geladen: ${esc(fout)}</div></div>`;
    if (!z) return '';
    _cache.set(z.deal_id, z);
    const c = z.commissie || {};
    const st = z.status || status(c);
    const knopToewijzen = magToewijzen() && z.getekend && !z.gearchiveerd
      ? `<button class="btn btn-ghost" onclick="window.__kvCommToewijzen('${esc(z.deal_id)}')">Sale toewijzen</button>` : '';
    const knopCommissies = magToewijzen() ? `<button class="btn btn-ghost" onclick="window.__kvCommNaarCommissies()">Bekijk in Commissies</button>` : '';
    const v = z.vorige_vervangen;
    const banner = v ? `<div style="padding:10px 12px;border:1px solid var(--blue-line,#bfdbfe);background:var(--blue-soft,#eff6ff);border-radius:9px;font-size:12.5px;margin-bottom:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <div style="flex:1;min-width:220px"><b>Vorige offerte van deze klant had commissie</b> (${esc(v.mentoren.map((m) => m.naam).join(', '))} · ${esc(v.bron?.soort === 'event' ? (v.bron.titel || 'Event') + (v.bron.datum ? ' ' + datum(v.bron.datum) : '') : 'handmatig')} · ${esc(eur(v.bedrag))}) — nog niet gekoppeld.
          <div style="color:var(--text-3);font-size:11.5px">Vervangen op ${esc(datum(v.vervangen_op))}${v.vorige_offerte ? ' · offerte ' + esc(v.vorige_offerte) : ''}${v.vorige_verwijderd ? ' (verwijderd)' : ''}</div></div>
        ${magToewijzen() && z.getekend ? `<button class="btn btn-primary" onclick="window.__kvCommToewijzen('${esc(z.deal_id)}')">Sale toewijzen</button>` : ''}
      </div>` : '';

    if (!c.heeft_commissie) {
      let tekst = 'Geen mentorcommissie op deze offerte.';
      let kleur = 'var(--text-3)';
      if (z.membership) tekst = 'Geen commissie — membership.';
      else if (z.verkoper?.is_mentor) { tekst = `Geen commissie — verkoper ${esc(z.verkoper.naam)} is mentor. Hoort er commissie bij? Wijs de sale toe.`; kleur = 'var(--amber)'; }
      if (!z.getekend && !v) return '';
      return `<div class="odv-card" style="margin-bottom:14px">${kop(pil({ l: 'Geen commissie', c: 'neutral' }))}<div class="odv-card-b">${banner}
        <div style="font-size:12.5px;color:${kleur}">${tekst}</div>
        ${knopToewijzen || knopCommissies ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">${knopToewijzen}${knopCommissies}</div>` : ''}</div></div>`;
    }

    const actief = (c.mentoren || []).filter((m) => !m.geannuleerd);
    const toon = actief.length ? actief : (c.mentoren || []);
    const mentoren = toon.map((m) => `<div style="display:flex;align-items:center;gap:8px;padding:4px 0">${avatar(m.naam)}<div style="flex:1"><b style="font-size:13px">${esc(m.naam)}</b>${m.vrijgegeven > 0 ? `<div style="font-size:11px;color:var(--emerald)">${esc(eur(m.vrijgegeven))} vrijgegeven${m.uitbetaald > 0 ? ' · ' + esc(eur(m.uitbetaald)) + ' uitbetaald' : ''}</div>` : ''}</div><span class="mono" style="font-size:13px${m.geannuleerd ? ';text-decoration:line-through;color:var(--text-3)' : ''}">${esc(eur(m.bedrag))}</span></div>`).join('');
    const totaal = actief.length ? c.totaal : c.totaal_oorspronkelijk;
    const frac = totaal > 0 ? Math.max(0, Math.min(1, (c.vrijgegeven || 0) / totaal)) : 0;
    const bron = c.bron?.soort === 'event'
      ? `<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:7px;height:7px;border-radius:50%;background:${bronStip(c)}"></span>Event · ${esc(c.bron.titel || '')}${c.bron.datum ? ' · ' + esc(datum(c.bron.datum)) : ''}</span>`
      : `<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:7px;height:7px;border-radius:50%;background:${bronStip(c)}"></span>Handmatig toegewezen · ${esc((c.toewijzing?.reden || c.bron?.reden || 'handmatig'))}${c.bron?.datum ? ' · ' + esc(datum(c.bron.datum)) : ''}</span>`;
    const annul = c.status === 'geannuleerd' && c.annulering
      ? `<div style="padding:8px 10px;background:var(--surface-2);border-radius:8px;font-size:12.5px;margin-top:8px">Geannuleerd — <b>${esc(c.annulering.reden || '')}</b>${c.annulering.op ? ' · ' + esc(datum(c.annulering.op)) : ''}${c.vrijgegeven > 0 ? ` · ${esc(eur(c.vrijgegeven))} al vrijgegeven blijft staan` : ''}</div>` : '';
    const inc = z.incasso
      ? `<div style="padding:8px 10px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px;margin-top:8px">${esc(z.incasso.label)}${z.incasso.sinds ? ' sinds ' + esc(datum(z.incasso.sinds)) : ''} — ${z.incasso.status === 'bij_incasso' ? 'commissie staat stil' : z.incasso.status === 'incasso_regeling' ? 'echte betalingen tellen weer' : 'afgesloten'}.</div>` : '';
    const subs = z.abonnementen || [];
    const soorten = subs.map((s) => `${esc(s.soort_label || 'soort niet aangeduid')}${s.status === 'cancelled' ? ' (gestopt)' : ''}`).join(', ');
    const facturen = z.facturen ? `Betaald ${esc(eur(z.facturen.betaald))} van ${esc(eur(z.basis_incl))}${z.facturen.achterstallig > 0 ? ` · <span style="color:var(--rose)">achterstallig ${esc(eur(z.facturen.achterstallig))}</span>` : ''}` : '';
    return `<div class="odv-card" style="margin-bottom:14px">${kop(pil(st))}<div class="odv-card-b">${banner}
      <div style="display:grid;grid-template-columns:minmax(200px,1fr) minmax(220px,1.2fr);gap:16px">
        <div>${mentoren}</div>
        <div style="font-size:12.5px;line-height:1.7">
          <div>${bron}</div>
          <div>${c.pct != null ? esc(c.pct) + '% van ' + esc(eur(c.basis)) + ' ' + (c.basis_incl_btw ? 'incl.' : 'excl.') + ' btw' : ''} = <b class="mono">${esc(eur(totaal))}</b>${toon.length > 1 ? ` <span style="color:var(--text-3)">(${toon.length} mentoren)</span>` : ''}</div>
          <div style="margin-top:6px;height:8px;border-radius:4px;background:var(--surface-2);overflow:hidden"><div style="height:100%;width:${(frac * 100).toFixed(1)}%;background:var(--emerald)"></div></div>
          <div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--text-3)"><span>Vrijgegeven <b class="mono" style="color:var(--emerald)">${esc(eur(c.vrijgegeven))}</b></span><span>Nog te komen <b class="mono">${esc(eur(c.status === 'geannuleerd' ? 0 : Math.max(0, totaal - (c.vrijgegeven || 0))))}</b></span></div>
          ${z.vrijkomen ? `<div style="color:var(--text-3);font-size:11.5px">Komt vrij: ${esc(z.vrijkomen)}</div>` : ''}
          ${facturen ? `<div style="font-size:11.5px">${facturen}</div>` : ''}
        </div>
      </div>
      ${annul}${inc}
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid var(--border);font-size:11.5px;color:var(--text-3)">
        <span>${subs.length} gelinkt${subs.length === 1 ? '' : 'e'} abonnement${subs.length === 1 ? '' : 'en'}${soorten ? ': ' + soorten : ''}</span>
        <span>· Incasso: ${z.incasso ? esc(z.incasso.label) : 'nee'}</span>
        <span style="margin-left:auto;display:flex;gap:8px">${knopCommissies}${knopToewijzen}</span>
      </div></div></div>`;
  }

  window.KV_COMM = { esc, eur, eur0, datum, kortDatum, bronTekst, mentorNamen, uniek, waarschuwingHtml, keuze, melding, openToewijzen, status, chip, kaart, pil, prefillVoor, magToewijzen, onthoud: (z) => { if (z?.deal_id) _cache.set(z.deal_id, z); } };
})();
