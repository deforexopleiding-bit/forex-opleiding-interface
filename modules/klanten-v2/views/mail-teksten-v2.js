// modules/klanten-v2/views/mail-teksten-v2.js
//
// GEDEELD: teksten die eerst goedgekeurd moeten worden, met een hoofdschakelaar
// (28 okt 2026). Gebruikt door Onboarding › Herinneringen en
// Studentencheck-in › Mails — dezelfde regel (een gewijzigde tekst is weer
// concept), dezelfde knoppen (Bewaren · Testmail naar mij · Goedkeuren).
//
//   const mt = window.KVMailTeksten.maak({ api, sleutel, codeUitleg });
//   mt.schakelaar(d, { titel, uitleg, waarschuwingen })  → HTML
//   mt.teksten(d)                                       → HTML
//   d = { instellingen, soorten:[{soort,label}], rechten:{goedkeuren, bewerk?} }
// De endpoints kennen: POST {actie:'tekst'|'goedkeuren'|'test', soort, …} en
// {actie:'schakelaar', aan}. Na elke actie roept het `opnieuw()` aan.

(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const moment = (iso) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('nl-BE', { timeZone: 'Europe/Brussels', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (_) { return '—'; }
  };
  const toast = (m) => { if (window.KV && typeof window.KV.toast === 'function') window.KV.toast(m); else alert(m); };
  const foutTekst = (e, standaard) => (e && e.body && e.body.error) || (e && e.message) || standaard;
  const rerender = () => { if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render(); };

  function pill(kleur, tekst) {
    const k = { ok: 'var(--emerald)', warn: 'var(--amber,#B7791F)', neutral: 'var(--text-3)', danger: 'var(--rose,#b42318)' }[kleur] || 'var(--text-3)';
    return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid ${k};color:${k};font-size:11.5px;font-weight:600">${esc(tekst)}</span>`;
  }
  function knop(label, onclick, { p = false, uit = false, titel = '' } = {}) {
    return `<button type="button" class="btn ${p ? 'btn-primary' : 'btn-ghost'} btn-sm" ${uit ? 'disabled' : ''} title="${esc(titel)}" onclick="${onclick}">${esc(label)}</button>`;
  }

  /**
   * @param {{api: string, sleutel: string, codeUitleg: string, data: () => object, zetInstellingen: (i) => void, opnieuw?: () => void}} o
   *   sleutel = unieke naam voor de globale handlers (bv. 'oh', 'cm').
   */
  function maak(o) {
    const st = { bezig: null, concept: {} };
    const G = '__mt_' + o.sleutel;
    async function post(body, bezig) {
      st.bezig = bezig; rerender();
      try { return await window.KV.authedJson(o.api, { method: 'POST', body: JSON.stringify(body) }); }
      finally { st.bezig = null; rerender(); }
    }
    window[G] = {
      veld: (soort, veld, waarde) => { st.concept[soort] = { ...(st.concept[soort] || {}), [veld]: waarde }; },
      bewaar: async (soort) => {
        const t = o.data().instellingen.teksten[soort];
        const c = st.concept[soort] || {};
        try {
          const j = await post({ actie: 'tekst', soort, onderwerp: c.onderwerp ?? t.onderwerp, tekst: c.tekst ?? t.tekst }, 'bewaar:' + soort);
          delete st.concept[soort]; o.zetInstellingen(j.instellingen);
          toast('Bewaard. De tekst staat weer op concept tot hij goedgekeurd is.');
        } catch (e) { toast(foutTekst(e, 'Bewaren mislukt.')); }
      },
      goed: async (soort) => {
        if (st.concept[soort]) return toast('Bewaar eerst je wijziging.');
        try { const j = await post({ actie: 'goedkeuren', soort }, 'goed:' + soort); o.zetInstellingen(j.instellingen); toast('Goedgekeurd.'); }
        catch (e) { toast(foutTekst(e, 'Goedkeuren mislukt.')); }
      },
      test: async (soort) => {
        if (st.concept[soort]) return toast('Bewaar eerst je wijziging; de testmail gebruikt de bewaarde tekst.');
        try { const j = await post({ actie: 'test', soort }, 'test:' + soort); toast('Testmail verstuurd naar ' + j.naar + (j.versies > 1 ? ' (' + j.versies + ' versies: 1-op-1 en membership).' : '.')); }
        catch (e) { toast(foutTekst(e, 'Testmail mislukt.')); }
      },
      schakel: async (aan) => {
        if (aan && !confirm(st.bevestig || 'Aanzetten?')) return;
        try { const j = await post({ actie: 'schakelaar', aan }, 'schakelaar'); o.zetInstellingen(j.instellingen); toast(aan ? 'Staat AAN.' : 'Staat UIT.'); if (o.opnieuw) o.opnieuw(); }
        catch (e) { toast(foutTekst(e, 'Mislukt.')); }
      },
    };

    function schakelaar(d, { titel, uitleg, bevestig, waarschuwingen = [] }) {
      const i = d.instellingen;
      const mag = d.rechten && d.rechten.goedkeuren;
      const goed = d.soorten.filter((s) => i.teksten[s.soort].goedgekeurd).length;
      st.bevestig = bevestig;
      let h = `<div class="card" style="margin-bottom:12px"><div class="card-body" style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap"><div style="flex:1;min-width:240px">`;
      h += `<div style="display:flex;gap:8px;align-items:center"><div style="font-size:16px;font-weight:700">${esc(titel)}</div>${i.aan ? pill('ok', 'AAN') : pill('neutral', 'UIT')}</div>`;
      h += `<div style="font-size:12.5px;color:var(--text-2);margin-top:6px;line-height:1.5">${uitleg} Alleen goedgekeurde teksten vertrekken (${goed}/${d.soorten.length} goedgekeurd).</div>`;
      if (i.aan && i.aan_op) h += `<div style="font-size:12px;color:var(--text-3);margin-top:4px">Aangezet op ${esc(moment(i.aan_op))}${i.aan_door ? ' door ' + esc(i.aan_door) : ''}.</div>`;
      for (const w of waarschuwingen) h += `<div style="margin-top:8px;padding:8px 10px;border-radius:8px;background:${w.ernst === 'rood' ? 'var(--rose-soft,#fdecee)' : 'var(--amber-soft,#fdf6e7)'};font-size:12.5px">${w.html}</div>`;
      h += `</div><div>`;
      const geenRecht = 'Alleen met het goedkeur-recht (super_admin).';
      h += i.aan
        ? knop(st.bezig === 'schakelaar' ? 'Bezig…' : 'Zet UIT', `window.${G}.schakel(false)`, { uit: !mag || !!st.bezig, titel: mag ? '' : geenRecht })
        : knop(st.bezig === 'schakelaar' ? 'Bezig…' : 'Zet AAN', `window.${G}.schakel(true)`, { p: true, uit: !mag || !!st.bezig || !goed, titel: !mag ? geenRecht : (!goed ? 'Keur eerst minstens één tekst goed.' : '') });
      return h + `</div></div></div>`;
    }

    function tekstKaart(d, s) {
      const t = d.instellingen.teksten[s.soort];
      const c = st.concept[s.soort] || {};
      const mag = d.rechten && d.rechten.goedkeuren;
      const magBewerk = !d.rechten || d.rechten.bewerk !== false;
      const gewijzigd = !!st.concept[s.soort];
      let h = `<div class="card" style="margin-bottom:10px" data-testid="mt-tekst-${esc(s.soort)}"><div class="card-body">`;
      h += `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px"><b>${esc(s.label)}</b>`;
      h += t.goedgekeurd ? pill('ok', 'Goedgekeurd') : pill('warn', 'Concept');
      if (t.goedgekeurd) h += `<span style="font-size:11.5px;color:var(--text-3)">door ${esc(t.goedgekeurd_door || '?')} op ${esc(moment(t.goedgekeurd_op))}</span>`;
      else if (t.gewijzigd_op) h += `<span style="font-size:11.5px;color:var(--text-3)">gewijzigd door ${esc(t.gewijzigd_door || '?')} op ${esc(moment(t.gewijzigd_op))}</span>`;
      h += `</div>`;
      h += `<input type="text" value="${esc(c.onderwerp ?? t.onderwerp)}" ${magBewerk ? '' : 'disabled'} oninput="window.${G}.veld('${s.soort}','onderwerp',this.value)" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:inherit;font-weight:600;margin-bottom:6px" aria-label="Onderwerp">`;
      h += `<textarea rows="9" ${magBewerk ? '' : 'disabled'} oninput="window.${G}.veld('${s.soort}','tekst',this.value)" style="width:100%;padding:8px 9px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:inherit;font-family:inherit;font-size:13px;line-height:1.45" aria-label="Tekst">${esc(c.tekst ?? t.tekst)}</textarea>`;
      h += `<div style="font-size:11.5px;color:var(--text-3);margin:4px 0 8px">${o.codeUitleg}</div>`;
      h += `<div style="display:flex;gap:6px;flex-wrap:wrap">`;
      h += knop(st.bezig === 'bewaar:' + s.soort ? 'Bezig…' : 'Bewaren', `window.${G}.bewaar('${s.soort}')`, { uit: !magBewerk || !!st.bezig });
      h += knop(st.bezig === 'test:' + s.soort ? 'Bezig…' : 'Testmail naar mij', `window.${G}.test('${s.soort}')`, { uit: !magBewerk || !!st.bezig || gewijzigd, titel: 'Stuurt deze tekst naar jouw eigen adres, met een voorbeeldcode. Nooit naar een student.' });
      h += knop(st.bezig === 'goed:' + s.soort ? 'Bezig…' : 'Goedkeuren', `window.${G}.goed('${s.soort}')`, { p: true, uit: !mag || t.goedgekeurd || gewijzigd || !!st.bezig, titel: mag ? '' : 'Alleen met het goedkeur-recht (super_admin).' });
      return h + `</div></div></div>`;
    }

    function teksten(d) {
      return `<div style="font-weight:700;margin:16px 0 8px">Teksten</div>${d.soorten.map((s) => tekstKaart(d, s)).join('')}`;
    }

    return { schakelaar, teksten, bezig: () => st.bezig };
  }

  window.KVMailTeksten = { maak, pill, knop, esc, moment };
})();
