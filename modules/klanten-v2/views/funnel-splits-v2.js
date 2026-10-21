// modules/klanten-v2/views/funnel-splits-v2.js
//
// Funnel-split-test (2026-10-21) — Leadsonderhoud → Funnels:
//   window.DFOFunnelSplits.renderKoppelen(registry)   subtab "Funnels koppelen"
//   window.DFOFunnelSplits.renderVergelijk()          blok in "Funnelstatistieken"
// Data: /api/funnel-splits (GET overzicht + cijfers, POST wijzigingen).
// De vaste instaplink (/go/<slug>) staat in Meta; hier stel je de verdeling in.
// Gewicht = relatief; "Maak winnaar" zet 100/0 maar laat de andere varianten AAN
// (terugkerende bezoekers blijven sticky, alles blijft gemeten).

(function () {
  window.DFO = window.DFO || {};
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmtPct = (v) => (v == null ? '—' : String(v).replace('.', ',') + '%');
  const num = (v) => (v == null ? '—' : String(v));

  const st = {
    data: null, loading: false, fetched: false, error: null, bezig: false, melding: null,
    dagen: 30, nieuw: null,            // nieuw = formulier voor een nieuwe instaplink
    toevoegen: {},                      // split_id → { bron, gewicht }
  };
  const rerender = () => { if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render(); };

  function periode() {
    const nl = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    const tot = nl(new Date());
    const van = nl(new Date(Date.now() - (st.dagen - 1) * 86400000));
    return { van, tot };
  }

  async function laad(force) {
    if (st.loading || (!force && st.fetched && !st.error)) return;
    st.loading = true; rerender();
    try {
      const p = periode();
      st.data = await window.KV.authedJson('/api/funnel-splits?van=' + p.van + '&tot=' + p.tot);
      st.error = null;
    } catch (e) {
      st.error = e && e.status === 403 ? 'Geen rechten om de funnel-splits te zien (leads.view).' : 'Kon de funnel-splits niet laden.';
      console.error('[funnel-splits] laden mislukt', e?.status, e?.body || e?.message);
    }
    st.loading = false; st.fetched = true; rerender();
  }

  async function post(body, ok) {
    if (st.bezig) return;
    st.bezig = true; st.melding = null; rerender();
    try {
      await window.KV.authedJson('/api/funnel-splits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (ok) ok();
      st.bezig = false;
      await laad(true);
      if (window.KV.toast) window.KV.toast('Opgeslagen · binnen ~30 s live op de link');
    } catch (e) {
      st.bezig = false;
      st.melding = (e && e.body && e.body.error) || (e && e.status === 403 ? 'Geen rechten om te wijzigen (leads.update).' : 'Opslaan mislukt.');
      rerender();
    }
  }

  const splitOp = (id) => ((st.data && st.data.splits) || []).find((s) => s.id === id);
  const varOp = (id) => { for (const s of (st.data && st.data.splits) || []) for (const v of s.varianten) if (v.id === id) return { s, v }; return null; };
  const padVan = (route) => { try { return new URL(route).pathname; } catch { return null; } };

  // ── Acties (globaal, vanuit onclick) ─────────────────────────────────────
  window.__fsDagen = (n) => { st.dagen = n; laad(true); };
  window.__fsKopieer = (id, btn) => {
    const s = splitOp(id); if (!s) return;
    try { navigator.clipboard.writeText(s.link); if (btn) { const t = btn.textContent; btn.textContent = 'Gekopieerd ✓'; setTimeout(() => { btn.textContent = t; }, 1300); } }
    catch (_) { window.prompt('Kopieer de link:', s.link); }
  };
  window.__fsNieuw = (open) => { st.nieuw = open ? { naam: '', slug: '', fallback_pad: '' } : null; st.melding = null; rerender(); };
  window.__fsNieuwVeld = (veld, el) => {
    if (!st.nieuw) return;
    st.nieuw[veld] = el.value;
    if (veld === 'naam' && !st.nieuw._slugAangeraakt) {
      st.nieuw.slug = el.value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 41);
      const s = document.getElementById('fs-nieuw-slug'); if (s) s.value = st.nieuw.slug;
    }
    if (veld === 'slug') st.nieuw._slugAangeraakt = true;
  };
  window.__fsNieuwOpslaan = () => {
    const n = st.nieuw; if (!n) return;
    post({ actie: 'split_opslaan', naam: n.naam, slug: n.slug, fallback_pad: n.fallback_pad || null, actief: true }, () => { st.nieuw = null; });
  };
  window.__fsSplitActief = (id, aan) => {
    const s = splitOp(id); if (!s) return;
    post({ actie: 'split_opslaan', id, naam: s.naam, slug: s.slug, fallback_pad: s.fallback_pad, actief: !!aan });
  };
  window.__fsTerugval = (id, el) => {
    const s = splitOp(id); if (!s) return;
    post({ actie: 'split_opslaan', id, naam: s.naam, slug: s.slug, fallback_pad: el.value || null, actief: s.actief });
  };
  window.__fsVariant = (id, veld, el) => {
    const r = varOp(id); if (!r) return;
    const v = { ...r.v };
    if (veld === 'gewicht') {
      const g = Math.round(Number(el.value));
      if (!Number.isFinite(g) || g < 0 || g > 100) { st.melding = 'Gewicht moet tussen 0 en 100 liggen.'; rerender(); return; }
      v.gewicht = g;
    } else if (veld === 'actief') v.actief = !!el.checked;
    post({ actie: 'variant_opslaan', id: v.id, split_id: r.s.id, bron: v.bron, pad: v.pad, gewicht: v.gewicht, actief: v.actief, volgorde: v.volgorde });
  };
  window.__fsWinnaar = (splitId, variantId) => {
    const r = varOp(variantId); if (!r) return;
    if (!window.confirm(`"${r.v.bron}" als winnaar zetten? Nieuwe bezoekers gaan dan 100% naar deze variant. De andere varianten blijven aan op 0% (terugkerende bezoekers houden hun variant, alles blijft gemeten).`)) return;
    post({ actie: 'winnaar', split_id: splitId, variant_id: variantId });
  };
  window.__fsGelijk = (splitId) => post({ actie: 'gelijk', split_id: splitId });
  window.__fsVerwijder = (variantId) => {
    const r = varOp(variantId); if (!r) return;
    if (!window.confirm(`Variant "${r.v.bron}" loskoppelen van deze link? Bezoekers die hem al kregen worden opnieuw verdeeld. De cijfers in het log blijven bewaard.`)) return;
    post({ actie: 'variant_verwijderen', id: variantId });
  };
  window.__fsToevoegVeld = (splitId, veld, el) => { st.toevoegen[splitId] = { ...(st.toevoegen[splitId] || {}), [veld]: el.value }; };
  window.__fsToevoegen = (splitId, registryJsonIdx) => {
    const s = splitOp(splitId); if (!s) return;
    const keuze = st.toevoegen[splitId] || {};
    const reg = (window.__fsRegistry || []).find((r) => r.bron === keuze.bron);
    if (!reg) { st.melding = 'Kies eerst een funnel-variant.'; rerender(); return; }
    const pad = padVan(reg.route);
    if (!pad || pad === '/') { st.melding = 'Deze funnel heeft geen eigen pagina om naartoe te sturen.'; rerender(); return; }
    // Eerste twee varianten: 50/50. Daarna een uitdager: standaard 10%.
    const standaard = s.varianten.length < 2 ? 50 : 10;
    const g = keuze.gewicht === undefined || keuze.gewicht === '' ? standaard : Math.round(Number(keuze.gewicht));
    post({ actie: 'variant_opslaan', split_id: splitId, bron: reg.bron, pad, gewicht: g, actief: true, volgorde: s.varianten.length }, () => { delete st.toevoegen[splitId]; });
  };

  // ── Render ───────────────────────────────────────────────────────────────
  function statusRegel(s, v) {
    const sx = v.stats || {};
    const aan = s.actief && v.actief;
    const stip = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${aan ? (v.verkeer_pct > 0 ? 'var(--emerald)' : 'var(--amber)') : 'var(--text-3)'};margin-right:6px"></span>`;
    const staat = !v.actief ? 'uit' : !s.actief ? 'link uit' : v.verkeer_pct > 0 ? 'gekoppeld · actief' : 'gekoppeld · 0% (blijft meten)';
    return `${stip}${esc(staat)} · ${esc(fmtPct(v.verkeer_pct))} · ${esc(num(sx.bezoekers))} bezoekers · opt-in ${esc(fmtPct(sx.optin_pct))} · ${esc(num(sx.leads))} leads`;
  }

  function variantRij(s, v, beste) {
    const sx = v.stats || {};
    const winnaar = v.verkeer_pct === 100;
    const besteOptin = beste && sx.optin_pct != null && sx.optin_pct === beste;
    return `<tr class="fs-var" data-bron="${esc(v.bron)}" style="border-bottom:1px solid var(--border)">
      <td style="padding:8px 10px;min-width:180px">
        <label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer">
          <input type="checkbox" ${v.actief ? 'checked' : ''} ${st.bezig ? 'disabled' : ''} onchange="window.__fsVariant('${esc(v.id)}','actief',this)" style="margin-top:3px;width:16px;height:16px">
          <span style="min-width:0"><b>${esc(regNaam(v.bron))}</b>${winnaar ? ' <span style="font-size:10px;font-weight:700;background:var(--emerald-soft);color:var(--emerald);padding:1px 7px;border-radius:999px">WINNAAR</span>' : ''}
            <div style="font-size:10.5px;color:var(--text-3);font-family:var(--mono,monospace)">${esc(v.bron)} · ${esc(v.pad)}</div>
            <div class="fs-status" style="font-size:11px;color:var(--text-2);margin-top:2px">${statusRegel(s, v)}</div></span>
        </label>
      </td>
      <td style="padding:8px 10px;white-space:nowrap">
        <input type="number" min="0" max="100" step="5" value="${esc(v.gewicht)}" ${st.bezig ? 'disabled' : ''} onchange="window.__fsVariant('${esc(v.id)}','gewicht',this)"
          aria-label="Gewicht ${esc(v.bron)}" style="width:68px;padding:5px 6px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:16px">
        <div style="font-size:10.5px;color:var(--text-3);margin-top:2px">${esc(fmtPct(v.verkeer_pct))} verkeer</div>
      </td>
      <td class="fs-num" style="padding:8px 10px;text-align:right">${esc(num(sx.bezoekers))}</td>
      <td class="fs-num" style="padding:8px 10px;text-align:right">${esc(num(sx.opt_in))}<div style="font-size:11px;${besteOptin ? 'color:var(--emerald);font-weight:700' : 'color:var(--text-3)'}">${esc(fmtPct(sx.optin_pct))}</div></td>
      <td class="fs-num" style="padding:8px 10px;text-align:right">${esc(num(sx.leads))}<div style="font-size:11px;color:var(--text-3)">${esc(fmtPct(sx.lead_pct))}</div></td>
      <td class="fs-num" style="padding:8px 10px;text-align:right">${esc(num(sx.geboekt))}<div style="font-size:11px;color:var(--text-3)">${esc(fmtPct(sx.geboekt_pct))}</div></td>
      <td style="padding:8px 10px;white-space:nowrap;text-align:right">
        ${winnaar ? '' : `<button class="btn btn-ghost btn-sm" style="font-size:11px;padding:3px 9px" ${st.bezig ? 'disabled' : ''} onclick="window.__fsWinnaar('${esc(s.id)}','${esc(v.id)}')">Maak winnaar</button>`}
        <button class="btn btn-ghost btn-sm" title="Loskoppelen" aria-label="Loskoppelen" style="font-size:11px;padding:3px 8px;color:var(--rose)" ${st.bezig ? 'disabled' : ''} onclick="window.__fsVerwijder('${esc(v.id)}')">✕</button>
      </td>
    </tr>`;
  }

  function regNaam(bron) { const r = (window.__fsRegistry || []).find((x) => x.bron === bron); return r ? r.naam : bron; }

  function splitKaart(s, registry) {
    const gekoppeld = new Set(s.varianten.map((v) => v.bron));
    const opties = registry.filter((r) => r.bron !== 'website' && !gekoppeld.has(r.bron) && padVan(r.route) && padVan(r.route) !== '/')
      .map((r) => `<option value="${esc(r.bron)}" ${(st.toevoegen[s.id] || {}).bron === r.bron ? 'selected' : ''}>${esc(r.naam)} (${esc(r.bron)})</option>`).join('');
    const terugval = ['<option value="">— startpagina (/) —</option>'].concat(registry.filter((r) => padVan(r.route) && padVan(r.route) !== '/')
      .map((r) => `<option value="${esc(padVan(r.route))}" ${s.fallback_pad === padVan(r.route) ? 'selected' : ''}>${esc(r.naam)}</option>`)).join('');
    const beste = Math.max(-1, ...s.varianten.filter((v) => v.actief).map((v) => (v.stats && v.stats.optin_pct != null ? v.stats.optin_pct : -1)));
    const standaardGewicht = s.varianten.length < 2 ? 50 : 10;
    const rijen = s.varianten.map((v) => variantRij(s, v, beste >= 0 ? beste : null)).join('');
    return `<section class="fs-split" data-slug="${esc(s.slug)}" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px;margin-bottom:14px;min-width:0">
      <div style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap;justify-content:space-between">
        <div style="min-width:0">
          <div style="font-size:15px;font-weight:700">${esc(s.naam)}</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px">
            <code class="fs-link" style="font-size:12.5px;background:var(--surface-2);padding:5px 9px;border-radius:6px;word-break:break-all">${esc(s.link)}</code>
            <button class="btn btn-primary btn-sm" style="color:#fff;font-size:11.5px;padding:4px 11px" onclick="window.__fsKopieer('${esc(s.id)}', this)">Kopieer link</button>
          </div>
          <div style="font-size:11px;color:var(--text-3);margin-top:4px">Deze link komt in de advertentie. De verdeling hieronder kun je altijd aanpassen zonder iets in Meta te wijzigen.</div>
        </div>
        <label style="display:flex;gap:7px;align-items:center;font-size:12.5px;cursor:pointer;white-space:nowrap">
          <input type="checkbox" ${s.actief ? 'checked' : ''} ${st.bezig ? 'disabled' : ''} onchange="window.__fsSplitActief('${esc(s.id)}', this.checked)" style="width:16px;height:16px"> Link actief
        </label>
      </div>
      <div style="overflow-x:auto;margin-top:12px;border:1px solid var(--border);border-radius:var(--r-sm)">
        <table style="width:100%;border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums">
          <thead><tr style="text-align:left;color:var(--text-3);border-bottom:1px solid var(--border);background:var(--surface-2)">
            <th style="padding:7px 10px">Variant</th><th style="padding:7px 10px">Gewicht</th>
            <th style="padding:7px 10px;text-align:right">Bezoekers</th><th style="padding:7px 10px;text-align:right">Opt-in</th>
            <th style="padding:7px 10px;text-align:right">Leads</th><th style="padding:7px 10px;text-align:right">Call</th><th></th>
          </tr></thead>
          <tbody>${rijen || '<tr><td colspan="7" style="padding:14px;text-align:center;color:var(--text-3)">Nog geen varianten gekoppeld — de link stuurt nu naar de terugvalpagina.</td></tr>'}</tbody>
        </table>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px">
        <select aria-label="Funnel-variant toevoegen" onchange="window.__fsToevoegVeld('${esc(s.id)}','bron',this)" style="padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:16px;max-width:100%">
          <option value="">+ Variant (of uitdager) koppelen…</option>${opties}
        </select>
        <input type="number" min="0" max="100" step="5" placeholder="${standaardGewicht}" aria-label="Gewicht nieuwe variant" oninput="window.__fsToevoegVeld('${esc(s.id)}','gewicht',this)" style="width:72px;padding:6px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:16px">
        <button class="btn btn-sm" style="font-size:11.5px;padding:5px 11px" ${st.bezig ? 'disabled' : ''} onclick="window.__fsToevoegen('${esc(s.id)}')">Koppelen</button>
        <button class="btn btn-ghost btn-sm" style="font-size:11.5px;padding:5px 11px" ${st.bezig || s.varianten.length < 2 ? 'disabled' : ''} onclick="window.__fsGelijk('${esc(s.id)}')">Gelijk verdelen</button>
        <label style="font-size:11.5px;color:var(--text-3);display:flex;gap:6px;align-items:center;margin-left:auto">Terugval
          <select onchange="window.__fsTerugval('${esc(s.id)}', this)" ${st.bezig ? 'disabled' : ''} style="padding:5px 6px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:16px;max-width:200px">${terugval}</select></label>
      </div>
      <div style="font-size:11px;color:var(--text-3);margin-top:6px">Gewicht is relatief (50/50, 90/10 = winnaar + uitdager, 100/0 = winnaar). Een bezoeker houdt zijn variant zolang die aan staat; het gewicht stuurt alleen nieuwe bezoekers. Cijfers: alleen verkeer via deze link, laatste ${esc(st.dagen)} dagen.</div>
    </section>`;
  }

  function nieuwFormulier(registry) {
    if (!st.nieuw) return `<button class="btn btn-primary btn-sm" style="color:#fff;font-size:12px;padding:6px 13px" onclick="window.__fsNieuw(true)">+ Nieuwe instaplink</button>`;
    const n = st.nieuw;
    const terugval = ['<option value="">— startpagina (/) —</option>'].concat(registry.filter((r) => padVan(r.route) && padVan(r.route) !== '/')
      .map((r) => `<option value="${esc(padVan(r.route))}">${esc(r.naam)}</option>`)).join('');
    const veld = 'padding:7px 9px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:16px;width:100%';
    return `<div class="fs-nieuw" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px;margin-bottom:14px;max-width:640px">
      <div style="font-weight:700;margin-bottom:10px">Nieuwe instaplink</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:10px">
        <label style="font-size:12px;color:var(--text-2)">Naam<input value="${esc(n.naam)}" oninput="window.__fsNieuwVeld('naam',this)" placeholder="Mini-cursus test" style="${veld}"></label>
        <label style="font-size:12px;color:var(--text-2)">Link (deforexopleiding.nl/go/…)<input id="fs-nieuw-slug" value="${esc(n.slug)}" oninput="window.__fsNieuwVeld('slug',this)" placeholder="minicursus" style="${veld};font-family:var(--mono,monospace)"></label>
        <label style="font-size:12px;color:var(--text-2)">Terugval (als de test uit staat)<select onchange="window.__fsNieuwVeld('fallback_pad',this)" style="${veld}">${terugval}</select></label>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-primary btn-sm" style="color:#fff;font-size:12px;padding:6px 13px" ${st.bezig ? 'disabled' : ''} onclick="window.__fsNieuwOpslaan()">Aanmaken</button>
        <button class="btn btn-ghost btn-sm" style="font-size:12px;padding:6px 13px" onclick="window.__fsNieuw(false)">Annuleren</button>
      </div>
      <div style="font-size:11px;color:var(--text-3);margin-top:8px">Daarna koppel je de varianten. Nieuwe funnel testen voor hetzelfde aanbod? Koppel 'm aan de bestaande link — de advertentie blijft gewoon staan.</div>
    </div>`;
  }

  function dagenChips() {
    return [7, 30, 90].map((n) => `<button class="chip ${st.dagen === n ? 'on' : ''}" style="font-size:11.5px;padding:4px 10px" onclick="window.__fsDagen(${n})">${n} dagen</button>`).join('');
  }

  function renderKoppelen(registry) {
    window.__fsRegistry = registry || [];
    if (!st.fetched && !st.loading) (typeof queueMicrotask === 'function' ? queueMicrotask : (f) => Promise.resolve().then(f))(() => laad(false));
    const d = st.data || {};
    const splits = Array.isArray(d.splits) ? d.splits : [];
    const kop = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
      <div style="font-size:15px;font-weight:700;margin-right:auto">Funnels koppelen <span style="font-weight:400;font-size:12px;color:var(--text-3)">· vaste instaplink → verdeling over varianten</span></div>
      ${dagenChips()}
    </div>`;
    const fout = st.error ? `<div style="padding:10px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:10px">${esc(st.error)}</div>` : '';
    const melding = st.melding ? `<div role="alert" style="padding:10px 12px;background:var(--amber-soft);color:var(--amber);border-radius:6px;font-size:12px;margin-bottom:10px">${esc(st.melding)}</div>` : '';
    if (d.migratie_nodig) {
      return `<div class="fs-root">${kop}<div style="padding:12px 14px;background:var(--amber-soft);color:var(--amber);border:1px solid var(--amber-line);border-radius:var(--r-sm);font-size:12.5px">De tabellen voor de funnel-splits bestaan nog niet. Draai eerst de migratie <code>2026-10-21-funnel-splits.sql</code>.</div></div>`;
    }
    const lijst = splits.map((s) => splitKaart(s, window.__fsRegistry)).join('');
    const leeg = st.fetched && !st.loading && !splits.length && !st.error
      ? '<div style="padding:18px;text-align:center;color:var(--text-3);border:1px dashed var(--border);border-radius:var(--r);margin-bottom:14px">Nog geen instaplinks. Maak er één aan en koppel de varianten die je wilt testen.</div>' : '';
    return `<div class="fs-root">${kop}${fout}${melding}${st.loading && !st.data ? '<div style="color:var(--text-3);font-size:12px;margin-bottom:10px">Laden…</div>' : ''}${nieuwFormulier(window.__fsRegistry)}${leeg}${lijst}</div>`;
  }

  /** In "Funnelstatistieken": per test de varianten naast elkaar (alleen testverkeer). */
  function renderVergelijk(registry) {
    if (Array.isArray(registry)) window.__fsRegistry = registry;
    if (!st.fetched && !st.loading) (typeof queueMicrotask === 'function' ? queueMicrotask : (f) => Promise.resolve().then(f))(() => laad(false));
    const splits = ((st.data && st.data.splits) || []).filter((s) => s.varianten.length);
    if (!splits.length) return '';
    const blokken = splits.map((s) => {
      const beste = Math.max(-1, ...s.varianten.map((v) => (v.stats && v.stats.optin_pct != null ? v.stats.optin_pct : -1)));
      const kolommen = s.varianten.map((v) => {
        const sx = v.stats || {};
        const top = beste >= 0 && sx.optin_pct === beste;
        return `<div class="fs-kolom" style="flex:1 1 160px;min-width:0;border:1px solid ${top ? 'var(--emerald)' : 'var(--border)'};border-radius:var(--r-sm);padding:10px;background:var(--surface)">
          <div style="font-size:12px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(regNaam(v.bron))}">${esc(regNaam(v.bron))}</div>
          <div style="font-size:10.5px;color:var(--text-3)">${esc(fmtPct(v.verkeer_pct))} verkeer${v.actief ? '' : ' · uit'}</div>
          <div style="font-size:22px;font-weight:800;margin-top:6px;${top ? 'color:var(--emerald)' : ''}">${esc(fmtPct(sx.optin_pct))}</div>
          <div style="font-size:10.5px;color:var(--text-3)">opt-in</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 8px;font-size:11px;margin-top:6px;font-variant-numeric:tabular-nums">
            <span style="color:var(--text-3)">Bezoekers</span><b style="text-align:right">${esc(num(sx.bezoekers))}</b>
            <span style="color:var(--text-3)">Leads</span><b style="text-align:right">${esc(num(sx.leads))} <span style="font-weight:400;color:var(--text-3)">${esc(fmtPct(sx.lead_pct))}</span></b>
            <span style="color:var(--text-3)">Calls</span><b style="text-align:right">${esc(num(sx.geboekt))} <span style="font-weight:400;color:var(--text-3)">${esc(fmtPct(sx.geboekt_pct))}</span></b>
          </div>
        </div>`;
      }).join('');
      return `<div class="fs-vergelijk" data-slug="${esc(s.slug)}" style="margin-bottom:12px">
        <div style="font-size:12.5px;font-weight:700;margin-bottom:6px">${esc(s.naam)} <span style="font-weight:400;color:var(--text-3);font-family:var(--mono,monospace);font-size:11px">/go/${esc(s.slug)}</span></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${kolommen}</div>
      </div>`;
    }).join('');
    return `<section style="margin-bottom:22px">
      <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <div style="font-size:15px;font-weight:700">Split-tests</div>
        <div style="font-size:11.5px;color:var(--text-3)">per instaplink · alleen verkeer via de link · laatste ${esc(st.dagen)} dagen · groen = hoogste opt-in</div>
      </div>${blokken}</section>`;
  }

  window.DFOFunnelSplits = { renderKoppelen, renderVergelijk, state: st, laad };
})();
