// modules/klanten-v2/views/_inlog-opnieuw.js
//
// "Inloggegevens opnieuw versturen" — ÉÉN popup, gedeeld door drie plekken:
//   - Leads → detail → Meer acties            (leads-v2.js)
//   - Leadsonderhoud → Contacten → rij-actie   (leadsonderhoud-v2.js)
//   - Leadsonderhoud → Gesprekken → kop        (leadsonderhoud-v2.js)
//
// Praat met /api/lead-welkom-resend:
//   GET  → geregistreerd inlogadres, toegangsstatus, of het adres gewijzigd mag
//   POST → verse inloglink naar dat adres, of (optioneel) eerst het BESTAANDE
//          account naar een ander adres verplaatsen en dáárheen sturen.
// Er wordt nooit een tweede account aangemaakt en toegang wordt niet verlengd.
//
// De popup hangt rechtstreeks aan document.body (net als de Gesprekken-modals)
// en NIET aan DFO.render: leadsonderhoud rendert elke 20 s opnieuw, en een
// popup in de view-HTML zou dan het tekstveld onder je vingers vervangen.
//
// Zet niets op window.KV (klanten-v2.js vervangt dat object na de views) —
// alleen window.InlogOpnieuw.

(function () {
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const ROOT_ID = 'inlogOpnieuwRoot';
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  let st = null; // { leadId, naam, laden, laadFout, info, anders, alt, bezig, fout, onKlaar }

  function isGeldigEmail(s) { return EMAIL_RE.test(String(s || '').trim()); }

  function fmtDatum(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    try { return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (_) { return String(iso).slice(0, 10); }
  }

  /**
   * Vertaal het antwoord van POST /api/lead-welkom-resend naar een melding.
   * Puur (getest in tests/lead-inlog-opnieuw.test.js).
   * @returns {{ ok: boolean, tekst: string }}
   */
  function bouwMelding(status, j) {
    if (status >= 200 && status < 300 && j && j.ok) {
      const gew = j.email_gewijzigd && j.email_gewijzigd.naar
        ? ' · inlogadres gewijzigd van ' + (j.email_gewijzigd.van || '—') + ' naar ' + j.email_gewijzigd.naar
        : '';
      const herstel = j.toegang_hersteld === false ? ' · let op: toegangsvenster kon niet worden teruggezet' : '';
      if (j.sent) return { ok: true, tekst: 'Inloglink verstuurd naar ' + (j.doel_email || '—') + gew + herstel };
      return { ok: false, tekst: 'Inloglink versturen mislukt (' + (j.reden || 'onbekend') + ')' + gew + herstel };
    }
    if (status === 409 && j && j.code === 'GEEN_ACCOUNT') {
      return { ok: false, tekst: j.error || 'Deze lead heeft nog geen LMS-account. Gebruik "Geef toegang".' };
    }
    return { ok: false, tekst: (j && j.error) || ('Versturen mislukt (HTTP ' + status + ')') };
  }

  /** Eén zin over de toegang, of '' als er niets zinnigs te melden is. */
  function toegangRegel(acc) {
    if (!acc) return '';
    if (acc.onbeperkt) return 'Toegang: onbeperkt.';
    if (acc.verlopen === true) {
      return '<span style="color:var(--rose,#C22B3E);font-weight:600">Toegang verlopen sinds ' + esc(fmtDatum(acc.toegang_tot)) +
        '.</span> De lead kan inloggen maar ziet de cursus niet; verlengen gaat via "Verlengen" in Leadsonderhoud → Contacten.';
    }
    if (acc.verlopen === false && acc.toegang_tot) return 'Toegang tot ' + esc(fmtDatum(acc.toegang_tot)) + '.';
    return '';
  }

  function toast(msg, ok) {
    try { if (window.KV && typeof window.KV.toast === 'function') window.KV.toast(msg, { duration: ok ? 4000 : 8000 }); } catch (_) { /* noop */ }
  }

  function knopUit() {
    if (!st) return true;
    if (st.bezig || st.laden || st.laadFout || !st.info || !st.info.account) return true;
    if (st.anders) {
      const alt = String(st.alt || '').trim().toLowerCase();
      if (!isGeldigEmail(alt)) return true;
      if (alt === String(st.info.account.email || '').trim().toLowerCase()) return true;
    }
    return false;
  }

  function voetHtml() {
    const heeftAccount = !!(st && st.info && st.info.account);
    if (!heeftAccount) {
      return '<button class="btn btn-ghost btn-sm" data-io-actie="sluit">Sluiten</button>';
    }
    const uit = knopUit();
    const naar = st.anders ? String(st.alt || '').trim() : st.info.account.email;
    return '<button class="btn btn-ghost btn-sm" data-io-actie="sluit"' + (st.bezig ? ' disabled' : '') + '>Annuleren</button>' +
      '<button class="btn btn-primary btn-sm" data-io-actie="verstuur"' + (uit ? ' disabled style="opacity:.5;cursor:not-allowed"' : '') + '>' +
      (st.bezig ? 'Versturen…' : 'Verstuur inloglink' + (naar ? ' naar ' + esc(naar) : '')) + '</button>';
  }

  function hintHtml() {
    if (!st || !st.anders) return '';
    const alt = String(st.alt || '').trim();
    if (!alt) return '';
    if (!isGeldigEmail(alt)) return '<span style="color:var(--rose,#C22B3E)">Ongeldig e-mailadres.</span>';
    if (alt.toLowerCase() === String(st.info.account.email || '').toLowerCase()) return 'Dit is al het geregistreerde adres.';
    return '';
  }

  function bodyHtml() {
    if (st.laden) return '<div style="color:var(--text-3)">Gegevens laden…</div>';
    if (st.laadFout) return '<div style="color:var(--rose,#C22B3E)">⚠ ' + esc(st.laadFout) + '</div>';
    const info = st.info || {};
    const acc = info.account;
    if (!acc) {
      return '<div style="padding:10px 12px;background:var(--amber-soft,#FFF4E0);border-radius:6px;line-height:1.55">' +
        'Deze lead heeft nog <b>geen LMS-account</b>. Gebruik <b>Geef toegang</b> (Leadsonderhoud → Contacten) om er een aan te maken — de inlogmail gaat dan automatisch mee.' +
        '</div>';
    }
    const regel = toegangRegel(acc);
    const mag = !!info.mag_adres_wijzigen;
    return '' +
      '<div style="margin-bottom:10px">Geregistreerd inlogadres: <b>' + esc(acc.email || '—') + '</b></div>' +
      (regel ? '<div style="margin-bottom:10px;font-size:12.5px">' + regel + '</div>' : '') +
      '<div style="margin-bottom:12px;font-size:12px;color:var(--text-3)">Er gaat een verse inloglink per e-mail' +
        (info.soort ? ' (sjabloon: ' + esc(info.soort) + ')' : '') +
        '. Er wordt geen nieuw account aangemaakt en de toegang wordt niet verlengd.</div>' +
      '<label style="display:flex;gap:8px;align-items:center;cursor:' + (mag ? 'pointer' : 'not-allowed') + ';margin-bottom:8px"' +
        (mag ? '' : ' title="Adres wijzigen vereist het recht leads.update"') + '>' +
        '<input type="checkbox" data-io-veld="anders"' + (st.anders ? ' checked' : '') + (mag && !st.bezig ? '' : ' disabled') + '>' +
        '<span>Naar een ander e-mailadres sturen' + (mag ? '' : ' <span style="color:var(--text-3)">(geen recht)</span>') + '</span>' +
      '</label>' +
      (st.anders ? (
        '<input type="email" data-io-veld="alt" value="' + esc(st.alt) + '" placeholder="nieuw@voorbeeld.nl"' + (st.bezig ? ' disabled' : '') +
          ' style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--surface);color:var(--text-1)">' +
        '<div data-io-hint style="font-size:11.5px;margin-top:5px;min-height:14px">' + hintHtml() + '</div>' +
        '<div style="margin-top:6px;padding:8px 12px;background:var(--amber-soft,#FFF4E0);color:var(--text-2);border-radius:6px;font-size:12px;line-height:1.5">' +
          '⚠ Het bestaande LMS-account wordt naar dit adres <b>verplaatst</b> (ook het e-mailadres van de lead wordt aangepast). ' +
          'Het oude adres werkt daarna niet meer om in te loggen.</div>'
      ) : '') +
      (st.fout ? '<div style="margin-top:10px;padding:8px 12px;background:var(--rose-soft,#FDECEE);color:var(--rose,#C22B3E);border-radius:6px;font-size:12px">' + esc(st.fout) + '</div>' : '');
  }

  function render() {
    const root = document.getElementById(ROOT_ID);
    if (!root || !st) return;
    const box = root.querySelector('[data-io-box]');
    if (!box) return;
    box.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border)">' +
        '<div style="flex:1;min-width:0"><div style="font-weight:600;font-size:15px">Inloggegevens opnieuw versturen</div>' +
        '<div style="font-size:12px;color:var(--text-3);margin-top:2px">' + esc(st.naam || 'Lead') + '</div></div>' +
        '<button class="btn btn-ghost btn-sm" data-io-actie="sluit" aria-label="Sluiten"' + (st.bezig ? ' disabled' : '') + '>✕</button>' +
      '</div>' +
      '<div style="padding:16px 18px;font-size:13px;line-height:1.5">' + bodyHtml() + '</div>' +
      '<div data-io-voet style="display:flex;gap:8px;justify-content:flex-end;padding:12px 18px;border-top:1px solid var(--border)">' + voetHtml() + '</div>';
  }

  /** Alleen hint + knoppen bijwerken tijdens typen (focus blijft in het veld). */
  function repaintVoet() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    const voet = root.querySelector('[data-io-voet]');
    if (voet) voet.innerHTML = voetHtml();
    const hint = root.querySelector('[data-io-hint]');
    if (hint) hint.innerHTML = hintHtml();
  }

  function onKey(e) { if (e.key === 'Escape' && st && !st.bezig) { e.preventDefault(); sluit(); } }

  function sluit() {
    const root = document.getElementById(ROOT_ID);
    if (root) root.remove();
    document.removeEventListener('keydown', onKey, true);
    st = null;
  }

  async function laadInfo(leadId) {
    try {
      if (!window.KV || typeof window.KV.authedFetch !== 'function') throw new Error('KV.authedFetch niet beschikbaar');
      const resp = await window.KV.authedFetch('/api/lead-welkom-resend?lead_id=' + encodeURIComponent(leadId));
      let j = null;
      try { j = await resp.json(); } catch (_) { j = null; }
      if (!st || st.leadId !== leadId) return;
      if (!resp.ok) throw new Error((j && j.error) || ('HTTP ' + resp.status));
      st.info = j || {};
      if (!st.naam && j && j.lead && j.lead.naam) st.naam = j.lead.naam;
    } catch (e) {
      if (!st || st.leadId !== leadId) return;
      st.laadFout = 'Kon gegevens niet laden: ' + ((e && e.message) || 'onbekende fout');
    }
    st.laden = false;
    render();
  }

  async function verstuur() {
    if (!st || knopUit()) return;
    const body = { lead_id: st.leadId };
    if (st.anders) body.email = String(st.alt || '').trim();
    st.bezig = true; st.fout = null; render();
    let status = 0; let j = null;
    try {
      const resp = await window.KV.authedFetch('/api/lead-welkom-resend', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      status = resp.status;
      try { j = await resp.json(); } catch (_) { j = null; }
    } catch (e) {
      j = { error: 'Netwerkfout: ' + ((e && e.message) || e) };
    }
    if (!st) return;
    const m = bouwMelding(status, j);
    toast(m.tekst, m.ok);
    const klaar = st.onKlaar;
    if (status >= 200 && status < 300 && j && j.ok) {
      // Ook bij een mislukte mail: een gewijzigd adres is wél doorgevoerd →
      // laat de view verversen en sluit (de toast vertelt wat er misging).
      sluit();
      try { if (typeof klaar === 'function') klaar(j); } catch (_) { /* noop */ }
      return;
    }
    st.bezig = false; st.fout = m.tekst; render();
  }

  /**
   * Open de popup.
   * @param {{ leadId: string, naam?: string, onKlaar?: (resultaat: object) => void }} opts
   */
  function open(opts) {
    const leadId = opts && opts.leadId ? String(opts.leadId) : '';
    if (!leadId) return;
    sluit();
    st = {
      leadId, naam: (opts && opts.naam) || '', laden: true, laadFout: null, info: null,
      anders: false, alt: '', bezig: false, fout: null, onKlaar: opts && opts.onKlaar,
    };
    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);padding:20px';
    root.innerHTML = '<div data-io-box role="dialog" aria-modal="true" style="background:var(--surface);border:1px solid var(--border);border-radius:12px;width:min(500px,100%);max-height:calc(100vh - 60px);overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.35)"></div>';
    root.addEventListener('click', (e) => {
      if (e.target === root) { if (st && !st.bezig) sluit(); return; }
      const knop = e.target.closest ? e.target.closest('[data-io-actie]') : null;
      if (!knop || knop.disabled) return;
      const actie = knop.getAttribute('data-io-actie');
      if (actie === 'sluit' && st && !st.bezig) sluit();
      else if (actie === 'verstuur') verstuur();
    });
    root.addEventListener('change', (e) => {
      if (!st || !e.target || e.target.getAttribute('data-io-veld') !== 'anders') return;
      st.anders = !!e.target.checked;
      st.fout = null;
      render();
      if (st.anders) {
        const veld = root.querySelector('[data-io-veld="alt"]');
        if (veld) veld.focus();
      }
    });
    root.addEventListener('input', (e) => {
      if (!st || !e.target || e.target.getAttribute('data-io-veld') !== 'alt') return;
      st.alt = String(e.target.value || '');
      repaintVoet();
    });
    document.body.appendChild(root);
    document.addEventListener('keydown', onKey, true);
    render();
    laadInfo(leadId);
  }

  window.InlogOpnieuw = { open, sluit, bouwMelding, isGeldigEmail, toegangRegel };
})();
