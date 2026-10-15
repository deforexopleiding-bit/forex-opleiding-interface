// modules/scan/scan-app.js — de scan-pagina (/scan).
//
// Flow (opdracht 2026-10-15, fase 1):
//   /scan                → nieuwe scan (lege intro)
//   /scan?afspraak=<id>  → vooraf ingevuld vanuit een webinar-afspraak; bestaat er
//                          al een scan bij die afspraak, dan gaat hij daarheen
//   /scan?lead=<id>      → vooraf ingevuld vanuit een lead
//   /scan?id=<id>        → bestaande scan verder invullen / bekijken
// "Begin de scan" maakt meteen een concept aan; elke stapwissel slaat tussentijds
// op. Na het laatste onderdeel volgt de analyse-animatie en het voorbeeld van het
// rapport. De assessor kan daar de uitkomst aanpassen (override) en een interne
// notitie toevoegen, en rondt dan af (status 'afgerond'). De server rekent de
// uitkomst altijd zelf opnieuw uit (api/scan.js).

import {
  ONDERDELEN, LIKERT, RODE_VLAGGEN, TOTAAL_VRAGEN, CATEGORIEEN, AANPAKKEN, TRAJECTEN,
  ONDERDEEL_NAMEN, SCORE_ONDERDELEN, berekenUitkomst, normaliseerAntwoorden,
} from './scan-model.js?v=1';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const noMo = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion:reduce)').matches);

const S = {
  id: null, afspraak_id: null, lead_id: null, status: 'concept',
  antwoorden: {}, override: {}, notitie: '',
  assessor: 'Dave', datum: new Date(), stap: 0, dir: 1,
};

// ── Iconen + thema (mockup) ─────────────────────────────────────────────────
const SV = 'stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  motivatie: '<svg viewBox="0 0 24 24" ' + SV + '><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.3"/></svg>',
  tijd: '<svg viewBox="0 0 24 24" ' + SV + '><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
  stijl: '<svg viewBox="0 0 24 24" ' + SV + '><path d="M3 17l5-5 4 3 6-7"/><path d="M14 8h4v4"/></svg>',
  financieel: '<svg viewBox="0 0 24 24" ' + SV + '><rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/></svg>',
  kennis: '<svg viewBox="0 0 24 24" ' + SV + '><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M19 3v18"/></svg>',
  mindset: '<svg viewBox="0 0 24 24" ' + SV + '><path d="M12 3a5 5 0 0 0-5 5c0 2 1 3 1 5v2a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2c0-2 1-3 1-5a5 5 0 0 0-5-5z"/><path d="M9 20h6"/></svg>',
  verwachtingen: '<svg viewBox="0 0 24 24" ' + SV + '><path d="M3 12a9 9 0 1 1 18 0"/><path d="M12 12l4-2"/><circle cx="12" cy="12" r="1.4"/></svg>',
  leerstijl: '<svg viewBox="0 0 24 24" ' + SV + '><circle cx="12" cy="8" r="3.2"/><path d="M5 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5"/></svg>',
};
const SUN = '<svg viewBox="0 0 24 24" ' + SV + '><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" ' + SV + '><path d="M20 14.5A8 8 0 0 1 9.5 4 7 7 0 1 0 20 14.5z"/></svg>';

function zetThema(t) {
  document.documentElement.setAttribute('data-theme', t);
  $('tgl').innerHTML = t === 'light' ? MOON : SUN;
  $('tgl').setAttribute('aria-label', t === 'light' ? 'Donker thema' : 'Licht thema');
  try { localStorage.setItem('dfo-scan-theme', t); } catch (e) { /* geen opslag */ }
}
zetThema(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
$('tgl').addEventListener('click', () => zetThema(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light'));

// ── Schermen ────────────────────────────────────────────────────────────────
function toon(id) {
  ['laden', 'melding', 'intro', 'steps', 'analyse', 'result'].forEach((s) => { $(s).hidden = s !== id; });
  $('dots').hidden = id !== 'steps';
  const werk = ['intro', 'steps', 'analyse', 'result'].includes(id);
  $('bewaarBtn').hidden = !werk || !S.id;
}
function melding(titel, tekst) { $('mTitel').textContent = titel; $('mTekst').textContent = tekst; toon('melding'); }
let toastTimer = null;
function toast(t) {
  const el = $('toast'); el.textContent = t; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3600);
}
function zetAssessor(naam) {
  S.assessor = (String(naam || '').trim().split(/\s+/)[0]) || 'Dave';
  document.querySelectorAll('[data-assessor]').forEach((el) => { el.textContent = S.assessor; });
}

// ── API ─────────────────────────────────────────────────────────────────────
async function api(method, pad, body) {
  const token = await window.AuthShared.getAccessToken();
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(pad, {
      method, signal: ctrl.signal,
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, data };
  } finally { clearTimeout(t); }
}

// ── Opslaan (concept / afgerond) ────────────────────────────────────────────
let rij = Promise.resolve();
let autoTimer = null;
function deelnemer() {
  return { naam: $('naam').value.trim(), email: $('mail').value.trim(), telefoon: $('tel').value.trim() };
}
function statusTekst(s) { return s === 'verstuurd' ? 'Rapport verstuurd' : s === 'afgerond' ? 'Afgerond' : 'Concept'; }
function zetOpslag(tekst, fout) {
  const el = $('opslag'); el.hidden = false; el.textContent = tekst; el.classList.toggle('fout', !!fout);
}
function bewaar(status) {
  clearTimeout(autoTimer);
  const doel = status || (S.status === 'concept' ? 'concept' : 'afgerond');
  const run = async () => {
    zetOpslag('Opslaan…');
    try {
      const r = await api('POST', '/api/scan', {
        id: S.id, afspraak_id: S.afspraak_id, lead_id: S.lead_id, deelnemer: deelnemer(),
        antwoorden: S.antwoorden, override: S.override, dave_notitie: S.notitie, status: doel,
      });
      if (!r.ok || !r.data.scan) {
        zetOpslag('Niet opgeslagen — opnieuw proberen', true);
        return { ok: false, fout: r.data.error || 'Opslaan mislukt' };
      }
      const s = r.data.scan;
      const nieuw = !S.id;
      S.id = s.id; S.status = s.status; S.lead_id = s.lead_id; S.afspraak_id = s.afspraak_id;
      if (nieuw) history.replaceState(null, '', '/scan?id=' + encodeURIComponent(s.id));
      $('bewaarBtn').hidden = false;
      $('bewaarBtn').textContent = S.status === 'concept' ? 'Concept opslaan' : 'Opslaan';
      const tijd = new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
      zetOpslag(statusTekst(S.status) + ' · opgeslagen ' + tijd);
      return { ok: true };
    } catch (e) {
      zetOpslag('Niet opgeslagen — opnieuw proberen', true);
      return { ok: false, fout: 'Geen verbinding' };
    }
  };
  rij = rij.then(run, run);
  return rij;
}
function bewaarStraks() { clearTimeout(autoTimer); if (S.id) autoTimer = setTimeout(() => { bewaar(); }, 1500); }
$('opslag').addEventListener('click', () => { if ($('opslag').classList.contains('fout')) bewaar(); });
$('bewaarBtn').addEventListener('click', async () => {
  const r = await bewaar();
  toast(r.ok ? (S.status === 'concept' ? 'Concept opgeslagen.' : 'Opgeslagen.') : r.fout);
});

// ── Intro ───────────────────────────────────────────────────────────────────
function eersteOnbeantwoordeStap() {
  const a = normaliseerAntwoorden(S.antwoorden);
  const i = ONDERDELEN.findIndex((p) => p.items.some((_, ii) => !(p.k + '_' + ii in a)));
  return i;
}
$('startBtn').addEventListener('click', async () => {
  const d = deelnemer();
  const fout = !d.naam ? 'Vul de naam van de deelnemer in.' : (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email) ? 'Dit e-mailadres klopt niet.' : '');
  $('introFout').hidden = !fout; $('introFout').textContent = fout;
  if (fout) return;
  $('startBtn').disabled = true;
  const r = await bewaar();
  $('startBtn').disabled = false;
  if (!r.ok) { $('introFout').hidden = false; $('introFout').textContent = r.fout; return; }
  const i = eersteOnbeantwoordeStap();
  if (i < 0) runAnalyse(); else ga(i);
});

// ── Stappen ─────────────────────────────────────────────────────────────────
function prog() {
  $('pf').style.width = Math.round(Object.keys(normaliseerAntwoorden(S.antwoorden)).length / TOTAAL_VRAGEN * 100) + '%';
}
function kies(key, waarde, rijEl) {
  S.antwoorden[key] = waarde;
  rijEl.querySelectorAll('[data-w]').forEach((b) => {
    const aan = Number(b.dataset.w) === waarde;
    b.classList.toggle('sel', aan); b.setAttribute('aria-pressed', aan ? 'true' : 'false');
  });
  prog(); bewaarStraks();
}
function renderStap() {
  const p = ONDERDELEN[S.stap];
  $('sIdx').innerHTML = 'Onderdeel ' + String(S.stap + 1).padStart(2, '0') + ' <span class="tot">/ ' + String(ONDERDELEN.length).padStart(2, '0') + '</span>';
  $('sTitle').textContent = p.title; $('sSub').textContent = p.sub;
  $('sIcon').innerHTML = ICONS[p.k] || '';
  $('dots').innerHTML = ONDERDELEN.map((_, i) => '<i class="' + (i === S.stap ? 'cur' : i < S.stap ? 'done' : '') + '"></i>').join('');
  const c = $('sItems'); c.innerHTML = '';
  p.items.forEach((it, ii) => {
    const key = p.k + '_' + ii;
    const huidig = S.antwoorden[key];
    const d = document.createElement('div'); d.className = 'item'; d.style.animationDelay = (ii * 0.07) + 's';
    const q = document.createElement('div'); q.className = 'qt'; q.textContent = it.t; q.id = 'q_' + key; d.appendChild(q);
    const rijEl = document.createElement('div');
    rijEl.setAttribute('role', 'group'); rijEl.setAttribute('aria-labelledby', q.id);
    if (it.type === 'likert') {
      rijEl.className = 'likert';
      for (let s = 1; s <= 5; s++) {
        const b = document.createElement('button'); b.type = 'button'; b.dataset.w = String(s);
        b.className = 'lk' + (huidig === s ? ' sel' : ''); b.setAttribute('aria-pressed', huidig === s ? 'true' : 'false');
        b.setAttribute('aria-label', s + ' — ' + LIKERT[s - 1]);
        b.innerHTML = '<b>' + s + '</b><span>' + (s === 1 ? LIKERT[0] : s === 5 ? LIKERT[4] : '') + '</span>';
        b.addEventListener('click', () => kies(key, s, rijEl));
        rijEl.appendChild(b);
      }
      d.appendChild(rijEl);
      const sc = document.createElement('div'); sc.className = 'lkscale'; sc.innerHTML = '<span>Oneens</span><span>Eens</span>'; d.appendChild(sc);
    } else {
      rijEl.className = 'opts';
      it.opts.forEach((o, oi) => {
        const rood = RODE_VLAGGEN.includes(o[2]);
        const b = document.createElement('button'); b.type = 'button'; b.dataset.w = String(oi);
        b.className = 'opt' + (rood ? ' flag' : '') + (huidig === oi ? ' sel' : ''); b.setAttribute('aria-pressed', huidig === oi ? 'true' : 'false');
        b.innerHTML = '<span class="dot"></span><span>' + esc(o[0]) + '</span>';
        b.addEventListener('click', () => kies(key, oi, rijEl));
        rijEl.appendChild(b);
      });
      d.appendChild(rijEl);
    }
    c.appendChild(d);
  });
  $('backBtn').disabled = S.stap === 0;
  $('nextBtn').textContent = S.stap === ONDERDELEN.length - 1 ? 'Rapport genereren →' : 'Volgende →';
  const sc = $('stepCard'); const a = S.dir < 0 ? 'slideL' : 'slideR';
  sc.classList.remove('slideL', 'slideR'); void sc.offsetWidth; sc.classList.add(a);
  window.scrollTo({ top: 0, behavior: 'auto' });
}
function ga(i) { toon('steps'); S.stap = i; S.dir = 1; renderStap(); prog(); }
$('backBtn').addEventListener('click', () => { if (S.stap > 0) { S.dir = -1; S.stap--; renderStap(); bewaar(); } });
$('nextBtn').addEventListener('click', () => {
  if (S.stap < ONDERDELEN.length - 1) { S.dir = 1; S.stap++; renderStap(); bewaar(); } else { bewaar(); runAnalyse(); }
});

// ── Analyse (animatie) ──────────────────────────────────────────────────────
function runAnalyse() {
  toon('analyse'); window.scrollTo(0, 0);
  const els = [...document.querySelectorAll('.anstep')];
  els.forEach((e, i) => { e.classList.remove('on'); e.querySelector('.ck').textContent = String(i + 1); });
  if (noMo) { toonResultaat(true); return; }
  els.forEach((el, i) => setTimeout(() => { el.classList.add('on'); el.querySelector('.ck').textContent = '✓'; }, 260 + i * 430));
  setTimeout(() => toonResultaat(true), 2150);
}

// ── Resultaat (voorbeeld van het rapport) ───────────────────────────────────
function countUp(el, to, dur, animeer) {
  if (noMo || !animeer) { el.textContent = to; return; }
  let t0 = null;
  const st = (ts) => { if (!t0) t0 = ts; const p = Math.min(1, (ts - t0) / dur); el.textContent = Math.round(p * to); if (p < 1) requestAnimationFrame(st); };
  requestAnimationFrame(st);
}
function datumTekst() { return S.datum.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }); }

function renderRapport(animeer) {
  const u = berekenUitkomst(S.antwoorden, S.override);
  const naam = deelnemer().naam || 'de deelnemer';
  const cls = 'v-' + u.toon;
  $('rName').textContent = naam;
  $('rMeta').innerHTML = esc(datumTekst()) + '<br>Uitgevoerd met ' + esc(S.assessor);
  if (u.doel) { $('goalLine').hidden = false; $('goalLine').innerHTML = '<span aria-hidden="true">🎯</span><span><b>Jouw doel met traden:</b> ' + esc(u.doel) + '</span>'; } else $('goalLine').hidden = true;

  const arc = $('gaugeArc');
  arc.setAttribute('stroke', u.toon === 'ok' ? 'url(#gggr)' : u.toon === 'red' ? '#d4685c' : 'url(#gg)');
  $('gNum').style.color = u.toon === 'ok' ? '#3fb488' : '';
  const doelOffset = 439.8 - 439.8 * u.readiness / 100;
  if (animeer && !noMo) {
    arc.style.transition = 'none'; arc.style.strokeDashoffset = 439.8;
    requestAnimationFrame(() => setTimeout(() => { arc.style.transition = 'stroke-dashoffset 1.1s cubic-bezier(.3,.7,.2,1)'; arc.style.strokeDashoffset = doelOffset; }, 90));
  } else { arc.style.transition = 'none'; arc.style.strokeDashoffset = doelOffset; }
  countUp($('gNum'), u.readiness, 1100, animeer);
  $('vBadge').className = 'vbadge ' + cls; $('vLabel').textContent = u.categorie; $('vText').textContent = u.verdict;

  let rg = '';
  if (u.aanpak) rg += '<div class="reccard"><div class="k">Aanbevolen aanpak</div><div class="t">' + esc(u.aanpak) + '</div><p>' + esc(u.aanpakUitleg) + '</p></div>';
  rg += '<div class="reccard"><div class="k">' + esc(u.trajectKop) + '</div><div class="t">' + esc(u.traject) + '</div><p>' + esc(u.trajectUitleg) + '</p></div>';
  $('recgrid').innerHTML = rg; $('recgrid').classList.toggle('een', !u.aanpak);

  $('bars').innerHTML = SCORE_ONDERDELEN.map((k) => {
    const v = u.scores[k];
    const c = v >= 70 ? 'linear-gradient(90deg,#46b98d,#5fd0a3)' : v >= 50 ? 'linear-gradient(90deg,#c9a23f,#e0bd5f)' : 'linear-gradient(90deg,#d4685c,#e39a90)';
    return '<div class="pb"><div class="top"><span class="nm">' + esc(ONDERDEEL_NAMEN[k]) + '</span><span class="sc"><span class="n" data-v="' + v + '">' + (animeer ? 0 : v) + '</span><span style="color:var(--muted);font-size:11px"> / 100</span></span></div>'
      + '<div class="track"><div class="fill" style="width:' + v + '%;background:' + c + (animeer ? '' : ';animation:none') + '"></div></div></div>';
  }).join('');
  if (animeer) document.querySelectorAll('#bars .n').forEach((n) => countUp(n, +n.dataset.v, 950, true));

  $('samenvatting').textContent = u.samenvatting;
  $('duiding').innerHTML = u.opvallend.map((x) => '<div class="duid"><span class="tag ' + (x.soort === 's' ? 'tg-s' : 'tg-a') + '">' + esc(x.label) + '</span><span>' + esc(x.tekst) + '</span></div>').join('');
  $('advies').textContent = u.advies;

  const vs = u.volgendeStap;
  $('sellCard').hidden = !vs;
  if (vs) {
    $('sellTitle').textContent = vs.titel; $('sellLead').textContent = vs.lead;
    $('benefits').innerHTML = vs.voordelen.map((b) => '<li><span class="bk" aria-hidden="true">' + b[0] + '</span><span><b>' + esc(b[1]) + '</b> — ' + esc(b[2]) + '</span></li>').join('');
    $('sellScarce').textContent = vs.schaars;
  }
  $('certnaam').textContent = naam;
  $('certdatum').innerHTML = (u.doel ? 'Doel: ' + esc(u.doel) + '<br>' : '') + esc(datumTekst()) + ' · De Forex Opleiding';
  return u;
}

function opties(sel, lijst, auto) {
  sel.innerHTML = '<option value="">Berekend: ' + esc(auto || 'n.v.t.') + '</option>' + lijst.map((x) => '<option>' + esc(x) + '</option>').join('');
}
function vulPaneel() {
  const ov = S.override;
  const basis = berekenUitkomst(S.antwoorden, {});
  opties($('oCat'), CATEGORIEEN, basis.berekend.categorie); $('oCat').value = ov.categorie || '';
  opties($('oAanpak'), AANPAKKEN, basis.berekend.aanpak || basis.aanpak); $('oAanpak').value = ov.aanpak || '';
  opties($('oTraject'), TRAJECTEN, basis.berekend.traject); $('oTraject').value = ov.traject || '';
  $('oVerdict').value = ov.verdict || ''; $('oSamen').value = ov.samenvatting || ''; $('oAdvies').value = ov.advies || '';
  $('oNotitie').value = S.notitie || '';
  plaatshouders();
}
function plaatshouders() {
  // Plaatshouder = de berekende tekst bij de huidige keuzes (zonder tekst-overrides).
  const { categorie, aanpak, traject } = S.override;
  const u = berekenUitkomst(S.antwoorden, { categorie, aanpak, traject });
  $('oVerdict').placeholder = u.verdict; $('oSamen').placeholder = u.samenvatting; $('oAdvies').placeholder = u.advies;
  const n = u.beantwoord;
  $('dHint').textContent = n + ' van ' + u.totaal + ' vragen beantwoord'
    + (n < u.totaal ? ' — onbeantwoorde vragen tellen als neutraal.' : '.')
    + ' Leeg laten = de berekende tekst.';
}
function leesPaneel() {
  const o = {};
  if ($('oCat').value) o.categorie = $('oCat').value;
  if ($('oAanpak').value) o.aanpak = $('oAanpak').value;
  if ($('oTraject').value) o.traject = $('oTraject').value;
  if ($('oVerdict').value.trim()) o.verdict = $('oVerdict').value.trim();
  if ($('oSamen').value.trim()) o.samenvatting = $('oSamen').value.trim();
  if ($('oAdvies').value.trim()) o.advies = $('oAdvies').value.trim();
  S.override = o; S.notitie = $('oNotitie').value;
}
['oCat', 'oAanpak', 'oTraject', 'oVerdict', 'oSamen', 'oAdvies', 'oNotitie'].forEach((id) => {
  $(id).addEventListener(id.startsWith('o') && $(id).tagName === 'SELECT' ? 'change' : 'input', () => {
    leesPaneel(); renderRapport(false); plaatshouders(); bewaarStraks();
  });
});
$('herstelBtn').addEventListener('click', () => { S.override = {}; vulPaneel(); renderRapport(false); bewaarStraks(); toast('Berekende uitkomst hersteld.'); });
$('conceptBtn').addEventListener('click', async () => { const r = await bewaar(); toast(r.ok ? 'Opgeslagen.' : r.fout); });

function toonResultaat(animeer) {
  vulPaneel();
  renderRapport(animeer);
  $('pf').style.width = '100%';
  toon('result');
  $('result').classList.remove('fade'); void $('result').offsetWidth; if (animeer) $('result').classList.add('fade');
  zetAfrondKnop();
  window.scrollTo(0, 0);
}
function zetAfrondKnop() {
  $('afrondBtn').textContent = S.status === 'concept' ? 'Afronden & opslaan →' : 'Wijzigingen opslaan';
}
$('aanpasBtn').addEventListener('click', () => ga(0));
$('afrondBtn').addEventListener('click', async () => {
  leesPaneel();
  $('afrondBtn').disabled = true;
  const r = await bewaar(S.status === 'concept' ? 'afgerond' : undefined);
  $('afrondBtn').disabled = false;
  if (!r.ok) { toast(r.fout); return; }
  zetAfrondKnop();
  toast(S.status === 'verstuurd' ? 'Opgeslagen (rapport was al verstuurd).' : 'Scan afgerond en opgeslagen.');
});
['naam', 'mail', 'tel'].forEach((id) => $(id).addEventListener('input', bewaarStraks));

// ── Laden ───────────────────────────────────────────────────────────────────
function vulDeelnemer(p) {
  $('naam').value = p.naam || ''; $('mail').value = p.email || ''; $('tel').value = p.telefoon || '';
}
function laadScan(s) {
  S.id = s.id; S.status = s.status; S.lead_id = s.lead_id; S.afspraak_id = s.afspraak_id;
  S.antwoorden = normaliseerAntwoorden(s.antwoorden); S.override = s.override || {}; S.notitie = s.dave_notitie || '';
  S.datum = s.aangemaakt ? new Date(s.aangemaakt) : new Date();
  if (s.assessor_naam) zetAssessor(s.assessor_naam);
  vulDeelnemer({ naam: s.deelnemer_naam, email: s.deelnemer_email, telefoon: s.deelnemer_telefoon });
  zetOpslag(statusTekst(s.status));
  $('bewaarBtn').textContent = s.status === 'concept' ? 'Concept opslaan' : 'Opslaan';
  prog();
  if (s.status !== 'concept') { toonResultaat(false); return; }
  $('startBtn').textContent = Object.keys(S.antwoorden).length ? 'Verder met de scan →' : 'Begin de scan →';
  toon('intro');
}

(async function start() {
  try {
    await window._authSharedReady;
    const profiel = await window.AuthShared.requireAuth();
    if (!profiel) return; // requireAuth stuurt door naar de login
    if (profiel.full_name) zetAssessor(profiel.full_name);
    const q = new URLSearchParams(location.search);
    let pad = '/api/scan';
    if (q.get('id')) pad += '?id=' + encodeURIComponent(q.get('id'));
    else if (q.get('afspraak')) pad += '?afspraak=' + encodeURIComponent(q.get('afspraak'));
    else if (q.get('lead')) pad += '?lead=' + encodeURIComponent(q.get('lead'));
    const r = await api('GET', pad);
    if (r.status === 401) { await window.AuthShared.requireAuth(); return; }
    if (r.status === 403) { melding('Geen toegang', 'De strategie-scan is alleen beschikbaar voor de assessor en admins.'); return; }
    if (!r.ok) { melding('Scan niet gevonden', r.data.error || 'Probeer het opnieuw vanuit het overzicht.'); return; }
    if (r.data.gebruiker && r.data.gebruiker.naam) zetAssessor(r.data.gebruiker.naam);
    if (r.data.bestaande_id) { location.replace('/scan?id=' + encodeURIComponent(r.data.bestaande_id)); return; }
    if (r.data.scan) { laadScan(r.data.scan); return; }
    if (r.data.prefill) {
      vulDeelnemer(r.data.prefill);
      S.afspraak_id = r.data.prefill.afspraak_id || null; S.lead_id = r.data.prefill.lead_id || null;
    }
    toon('intro');
  } catch (e) {
    melding('Er ging iets mis', 'De scan kon niet geladen worden. Ververs de pagina.');
  }
})();

// ── Ambient gouden stofjes (mockup) ─────────────────────────────────────────
(function () {
  const c = $('bg'); if (!c || noMo) return;
  const x = c.getContext('2d'); let w; let h;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  function maat() { w = c.width = innerWidth * dpr; h = c.height = innerHeight * dpr; }
  maat(); addEventListener('resize', maat);
  const parts = Array.from({ length: 40 }, () => ({ x: Math.random() * w, y: Math.random() * h, r: (Math.random() * 1.4 + 0.4) * dpr, s: (Math.random() * 0.22 + 0.05) * dpr, o: Math.random() * 0.3 + 0.06 }));
  (function loop() {
    x.clearRect(0, 0, w, h);
    for (const p of parts) { p.y -= p.s; if (p.y < -12) { p.y = h + 12; p.x = Math.random() * w; } x.beginPath(); x.arc(p.x, p.y, p.r, 0, 7); x.fillStyle = 'rgba(201,162,63,' + p.o + ')'; x.fill(); }
    requestAnimationFrame(loop);
  })();
})();
