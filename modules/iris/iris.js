// modules/iris/iris.js  —  v=1
//
// Iris in de schil: Post · Opdrachten · Belrij · Dossiers · Instellingen · Logboek.
//
// ── WAAR DIT WOONT ───────────────────────────────────────────────────────────
// De code staat in modules/iris/ zoals de opdracht vraagt, maar registreert
// zich als schil-weergave (DFO.VIEWS['iris/']). Een losse pagina zou navigatie,
// rechten en uiterlijk opnieuw moeten bouwen; nu erft Iris die van de schil.
// Zolang 'iris' niet in V2_ACTIVE_ALLOWLIST staat, is dit scherm alleen
// bereikbaar via ?v2preview=iris. Dat is met opzet: eerst kijken, dan
// vrijgeven.
//
// ── WAT DEZE VERSIE DOET ─────────────────────────────────────────────────────
// Lezen. De Post-lijst met filters, één gesprek met zijn berichten, en de
// dossierkaart ernaast. Schrijven en versturen komen in fase 4; de knoppen
// daarvoor staan er nog niet, want een knop die niets doet is erger dan geen
// knop.
//
// ── DE VIER DINGEN DIE HIER ANDERS ZIJN DAN IN HET BESTAANDE SCHERM ──────────
// Ze komen rechtstreeks uit de gaten in docs/iris/02-gesprekken-audit.md:
//
//   G3  het venster telt af — "venster open nog 6u12", niet pas "verlopen"
//   G9  elk bericht draagt zijn verzendstatus, mislukt inbegrepen
//   G5  filters op de vragen die iemand 's ochtends stelt
//   G8  paginering, en een poll van dertig seconden in plaats van zes
//
// ── DE POLL ──────────────────────────────────────────────────────────────────
// Het bestaande scherm haalt elke zes seconden de volledige lijst op: bij 115
// gesprekken ongeveer 54 MB per uur per tabblad. Hier is het dertig seconden
// over vijftig rijen. Dat is ruwweg vijftig keer minder verkeer, en voor een
// postbus waar een paar berichten per uur binnenkomen is dertig seconden ruim
// snel genoeg. De teller wordt bij elke montage eerst gewist en bij het
// verlaten van het scherm gestopt — lesson learned 20 over dubbel pollen.

(function () {
  if (!window.DFO) { console.error('[iris] schil niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[iris] helpers niet geladen.'); return; }

  const { I, svg } = window.DFO;
  const esc = (window.KV && window.KV.esc) || ((s) => String(s == null ? '' : s));
  const toast = (m, t) => { try { window.KV && window.KV.toast && window.KV.toast(m, t ? { tone: t } : undefined); } catch (_) {} };

  const POLL_MS = 30_000;
  const TABS = [
    ['post', 'Post', I.mail],
    ['opdrachten', 'Opdrachten', I.list || I.doc],
    ['belrij', 'Belrij', I.phone || I.user],
    ['dossiers', 'Dossiers', I.user],
    ['instellingen', 'Instellingen', I.settings || I.cog],
    ['logboek', 'Logboek', I.doc],
  ];

  const FILTER_LABELS = {
    wacht_op_ons: 'Wacht op ons',
    wacht_op_klant: 'Wacht op klant',
    venster_bijna_dicht: 'Venster bijna dicht',
    niet_gekoppeld: 'Niet gekoppeld',
    belofte_vandaag: 'Belofte vandaag',
    alles: 'Alles',
  };

  const CATEGORIE_LABELS = {
    facturatie: 'Facturatie',
    betaalafspraak: 'Betaalafspraak',
    wanbetaling_reactie: 'Reactie op aanmaning',
    lms_toegang: 'LMS-toegang',
    lms_support: 'LMS-support',
    planning_mentor: 'Mentor & planning',
    opzeg_klacht_juridisch: 'Opzegging of klacht',
    bounce_systeem: 'Systeembericht',
    overig: 'Overig',
    spam: 'Spam',
  };

  /* ── Toestand ─────────────────────────────────────────────────────────── */

  const S = {
    tab: 'post',
    filter: 'wacht_op_ons',
    categorie: null,
    zoek: '',
    vanaf: 0,
    lijst: { bezig: false, fout: null, items: [], totaal: 0, meer: false, opgehaald: false },
    gekozen: null,
    gesprek: { bezig: false, fout: null, data: null, voorId: null },
    dossier: { bezig: false, fout: null, data: null, voorId: null },
    instellingen: { bezig: false, fout: null, data: null, opgehaald: false },
    pollTimer: null,
    _seq: 0,

    // De schrijfbalk. Eén stand per gesprek zodat wisselen niets kwijtmaakt.
    schrijf: {
      instructie: {},      // per gesprek: wat de medewerker insprak of typte
      concept: {},         // per gesprek: het concept dat klaarstaat
      bezig: null,         // gesprek waarvoor Iris nu schrijft
      fout: {},            // per gesprek
      opname: null,        // gesprek waarvoor de microfoon aan staat
      recorder: null,      // de MediaRecorder zelf
      stukken: [],         // de opgenomen brokken
      verstuurt: null,     // gesprek waarvoor een verzending loopt
    },

    // Het ongedaan-venster. Eén tegelijk: er kan er maar één aftellen.
    ongedaan: null,        // { conceptId, gesprekId, tot, timer }
  };

  function hertekenen() { if (window.DFO?.render) window.DFO.render(); }

  async function haal(url) {
    if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
    return await window.KV.authedJson(url);
  }

  /* ── Ophalen ──────────────────────────────────────────────────────────── */

  async function haalLijst() {
    const st = S.lijst;
    if (st.bezig) return;
    st.bezig = true;
    st.fout = null;
    const seq = ++S._seq;
    try {
      const q = new URLSearchParams({
        actie: 'lijst',
        filter: S.filter,
        limiet: '50',
        vanaf: String(S.vanaf),
      });
      if (S.categorie) q.set('categorie', S.categorie);
      if (S.zoek.trim()) q.set('zoek', S.zoek.trim());
      const j = await haal('/api/iris-post?' + q.toString());
      if (seq !== S._seq) return; // een nieuwere opvraging was ons voor
      st.items = Array.isArray(j.items) ? j.items : [];
      st.totaal = j.totaal || 0;
      st.meer = !!j.meer;
      st.opgehaald = true;
    } catch (e) {
      if (seq !== S._seq) return;
      st.fout = e?.message || 'Lijst niet opgehaald';
      st.opgehaald = true;
    } finally {
      if (seq === S._seq) { st.bezig = false; hertekenen(); }
    }
  }

  async function haalGesprek(id) {
    if (!id) return;
    S.gesprek.bezig = true;
    S.gesprek.fout = null;
    try {
      const j = await haal('/api/iris-post?actie=gesprek&id=' + encodeURIComponent(id));
      if (S.gekozen !== id) return;
      S.gesprek.data = j;
      S.gesprek.voorId = id;
    } catch (e) {
      if (S.gekozen !== id) return;
      S.gesprek.fout = e?.message || 'Gesprek niet opgehaald';
    } finally {
      if (S.gekozen === id) { S.gesprek.bezig = false; hertekenen(); }
    }
  }

  async function haalDossier(gesprekId) {
    if (!gesprekId) return;
    S.dossier.bezig = true;
    S.dossier.fout = null;
    try {
      const j = await haal('/api/iris-dossier?gesprek_id=' + encodeURIComponent(gesprekId));
      if (S.gekozen !== gesprekId) return;
      S.dossier.data = j.dossier || null;
      S.dossier.voorId = gesprekId;
    } catch (e) {
      if (S.gekozen !== gesprekId) return;
      S.dossier.fout = e?.message || 'Dossier niet opgehaald';
    } finally {
      if (S.gekozen === gesprekId) { S.dossier.bezig = false; hertekenen(); }
    }
  }

  async function haalInstellingen() {
    if (S.instellingen.bezig) return;
    S.instellingen.bezig = true;
    try {
      S.instellingen.data = await haal('/api/iris-instellingen');
      S.instellingen.fout = null;
    } catch (e) {
      S.instellingen.fout = e?.message || 'Instellingen niet opgehaald';
    } finally {
      S.instellingen.bezig = false;
      S.instellingen.opgehaald = true;
      hertekenen();
    }
  }

  /* ── Poll ─────────────────────────────────────────────────────────────── */

  function startPoll() {
    stopPoll();
    S.pollTimer = setInterval(() => {
      // Is het scherm weg, dan stopt de teller zichzelf. Zonder deze controle
      // blijft hij draaien na het wisselen van module.
      if (!document.getElementById('irisLijst')) { stopPoll(); return; }
      if (document.hidden) return; // een tabblad op de achtergrond hoeft niets
      S.lijst.opgehaald = false;
      haalLijst();
    }, POLL_MS);
  }
  function stopPoll() {
    if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
  }
  window.addEventListener('beforeunload', stopPoll);

  /* ── Handelingen ──────────────────────────────────────────────────────── */

  window.__irisTab = (t) => {
    S.tab = t;
    if (t === 'instellingen' && !S.instellingen.opgehaald) haalInstellingen();
    hertekenen();
  };

  window.__irisFilter = (f) => {
    S.filter = f;
    S.vanaf = 0;
    S.lijst.opgehaald = false;
    haalLijst();
    hertekenen();
  };

  window.__irisCategorie = (c) => {
    S.categorie = c || null;
    S.vanaf = 0;
    S.lijst.opgehaald = false;
    haalLijst();
    hertekenen();
  };

  window.__irisZoek = (v) => {
    S.zoek = String(v || '');
    S.vanaf = 0;
    clearTimeout(window.__irisZoekTimer);
    window.__irisZoekTimer = setTimeout(() => { S.lijst.opgehaald = false; haalLijst(); }, 350);
  };

  window.__irisPagina = (richting) => {
    const nieuw = Math.max(0, S.vanaf + richting * 50);
    if (nieuw === S.vanaf) return;
    S.vanaf = nieuw;
    S.lijst.opgehaald = false;
    haalLijst();
    hertekenen();
  };

  window.__irisKies = (id) => {
    if (S.gekozen === id) return;
    S.gekozen = id;
    S.gesprek = { bezig: true, fout: null, data: null, voorId: null };
    S.dossier = { bezig: true, fout: null, data: null, voorId: null };
    hertekenen();
    haalGesprek(id);
    haalDossier(id);
  };

  /* ── Schrijven, inspreken, versturen ──────────────────────────────────── */

  async function haalRuw(url, opties) {
    const token = await (window.AuthShared && window.AuthShared.getAccessToken
      ? window.AuthShared.getAccessToken() : Promise.resolve(null));
    const r = await fetch(url, {
      ...opties,
      headers: { ...(opties?.headers || {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.uitleg || j?.error || ('Fout ' + r.status));
    return j;
  }

  window.__irisInstructie = (v) => {
    if (!S.gekozen) return;
    S.schrijf.instructie[S.gekozen] = String(v || '');
    // Met opzet GEEN hertekening: dat zou de cursor uit het tekstvak gooien.
    // Dezelfde val die _shared-v2.js met stableSearch oplost.
  };

  /**
   * De microfoon.
   *
   * MediaRecorder neemt op in de browser; de ruwe brok gaat als body naar
   * /api/iris-transcribe. Geen base64: dat maakt een opname een derde groter
   * en moet aan twee kanten omgezet worden.
   *
   * Gaat er iets mis — geen toestemming, geen microfoon, geen sleutel — dan
   * blijft typen gewoon werken. Spraak is een versnelling, geen voorwaarde.
   */
  window.__irisMicrofoon = async () => {
    const gesprek = S.gekozen;
    if (!gesprek) return;

    // Al bezig? Dan stoppen we, en dat is de hele knop.
    if (S.schrijf.opname === gesprek && S.schrijf.recorder) {
      try { S.schrijf.recorder.stop(); } catch (_) {}
      return;
    }

    if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined') {
      toast('Deze browser kan niet opnemen. Typen kan wel.', 'warn');
      return;
    }

    let stroom;
    try {
      stroom = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      toast('Geen toegang tot de microfoon. Typen kan wel.', 'warn');
      return;
    }

    const soort = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    const recorder = new MediaRecorder(stroom, soort ? { mimeType: soort } : undefined);
    S.schrijf.recorder = recorder;
    S.schrijf.opname = gesprek;
    S.schrijf.stukken = [];
    hertekenen();

    recorder.ondataavailable = (e) => { if (e.data && e.data.size) S.schrijf.stukken.push(e.data); };

    recorder.onstop = async () => {
      // De microfoon uitzetten is geen bijzaak: een lampje dat blijft branden
      // is precies het soort ding waar mensen een programma om wantrouwen.
      try { stroom.getTracks().forEach((t) => t.stop()); } catch (_) {}
      S.schrijf.opname = null;
      S.schrijf.recorder = null;
      const brok = new Blob(S.schrijf.stukken, { type: recorder.mimeType || 'audio/webm' });
      S.schrijf.stukken = [];
      hertekenen();

      if (!brok.size) { toast('Er is niets opgenomen.', 'warn'); return; }

      S.schrijf.bezig = gesprek;
      hertekenen();
      try {
        const j = await haalRuw('/api/iris-transcribe?taal=nl', {
          method: 'POST',
          headers: { 'Content-Type': (recorder.mimeType || 'audio/webm').split(';')[0] },
          body: brok,
        });
        if (j.leeg || !j.tekst) { toast('Er is niets verstaan.', 'warn'); return; }
        const huidig = S.schrijf.instructie[gesprek] || '';
        S.schrijf.instructie[gesprek] = huidig ? huidig + ' ' + j.tekst : j.tekst;
        // Meteen doorschrijven: inspreken en dan nóg een keer klikken is
        // precies de handeling die we wilden weghalen.
        await schrijfNu(gesprek, 'spraak');
      } catch (e) {
        S.schrijf.fout[gesprek] = e?.message || 'Transcriptie mislukt';
        toast(S.schrijf.fout[gesprek], 'error');
      } finally {
        if (S.schrijf.bezig === gesprek) S.schrijf.bezig = null;
        hertekenen();
      }
    };

    recorder.start();
  };

  async function schrijfNu(gesprek, bron) {
    const instructie = S.schrijf.instructie[gesprek] || '';
    S.schrijf.bezig = gesprek;
    S.schrijf.fout[gesprek] = null;
    hertekenen();
    try {
      const bestaand = S.schrijf.concept[gesprek];
      const j = await haalRuw('/api/iris-schrijf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gesprek_id: gesprek,
          instructie,
          instructie_bron: bron || 'tekst',
          // Een herformulering overschrijft het bestaande concept. Anders staat
          // de lijst na drie pogingen vol met concepten die niemand meer wil.
          concept_id: bestaand?.concept?.id || undefined,
        }),
      });
      S.schrijf.concept[gesprek] = j;
      if (j.mens_nodig) toast('Dit gaat over een opzegging of klacht — Iris schrijft hier niets.', 'warn');
    } catch (e) {
      S.schrijf.fout[gesprek] = e?.message || 'Schrijven mislukt';
    } finally {
      if (S.schrijf.bezig === gesprek) S.schrijf.bezig = null;
      hertekenen();
    }
  }

  window.__irisSchrijf = () => { if (S.gekozen) schrijfNu(S.gekozen, 'tekst'); };

  /**
   * Verstuur, met het ongedaan-venster.
   *
   * De server zet het concept op 'goedgekeurd' met een verstuur_na dertig
   * seconden verderop en plant de verzending zelf in. Hier telt alleen de
   * knop af. Het venster is dus geen uitstel dat de browser verzint — de
   * server houdt het bericht echt tegen, ook als dit tabblad dichtgaat.
   */
  window.__irisVerstuur = async () => {
    const gesprek = S.gekozen;
    const bundel = gesprek && S.schrijf.concept[gesprek];
    const concept = bundel?.concept;
    if (!concept?.id) return;
    if (S.schrijf.verstuurt) return;

    S.schrijf.verstuurt = gesprek;
    hertekenen();
    try {
      const j = await haalRuw('/api/iris-verstuur', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actie: 'goedkeuren', concept_id: concept.id }),
      });
      startOngedaan(concept.id, gesprek, j.ongedaan_seconden || 30);
      if (Array.isArray(j.waarschuwingen) && j.waarschuwingen.length) {
        toast(j.waarschuwingen[0], 'warn');
      }
    } catch (e) {
      S.schrijf.fout[gesprek] = e?.message || 'Versturen mislukt';
      toast(S.schrijf.fout[gesprek], 'error');
    } finally {
      S.schrijf.verstuurt = null;
      hertekenen();
    }
  };

  function startOngedaan(conceptId, gesprekId, seconden) {
    stopOngedaan();
    S.ongedaan = { conceptId, gesprekId, tot: Date.now() + seconden * 1000, timer: null };
    S.ongedaan.timer = setInterval(() => {
      if (!S.ongedaan) { stopOngedaan(); return; }
      if (Date.now() >= S.ongedaan.tot) {
        const g = S.ongedaan.gesprekId;
        stopOngedaan();
        // Weg is weg. Het concept en de instructie ruimen we op, zodat het
        // scherm niet de indruk wekt dat er nog iets klaarstaat.
        delete S.schrijf.concept[g];
        delete S.schrijf.instructie[g];
        S.gesprek.data = null;
        haalGesprek(g);
        S.lijst.opgehaald = false;
        haalLijst();
      }
      hertekenen();
    }, 1000);
    hertekenen();
  }

  function stopOngedaan() {
    if (S.ongedaan?.timer) clearInterval(S.ongedaan.timer);
    S.ongedaan = null;
  }
  window.addEventListener('beforeunload', stopOngedaan);

  window.__irisOngedaan = async () => {
    const o = S.ongedaan;
    if (!o) return;
    stopOngedaan();
    hertekenen();
    try {
      await haalRuw('/api/iris-verstuur', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actie: 'ongedaan', concept_id: o.conceptId }),
      });
      toast('Tegengehouden. Het bericht is niet verstuurd.', 'success');
    } catch (e) {
      // Te laat is een echt antwoord, geen fout die je wegmoffelt.
      toast(e?.message || 'Terughalen lukte niet', 'warn');
      S.lijst.opgehaald = false;
      haalLijst();
    }
    hertekenen();
  };

  /* ── Opmaak: kleine stukjes ───────────────────────────────────────────── */

  const NIETS = (tekst) => `<div style="padding:48px 16px;text-align:center;color:var(--text-3);font-size:12.5px">${esc(tekst)}</div>`;

  function skelet(n) {
    return Array.from({ length: n }, () =>
      `<div style="height:52px;margin:6px 10px;border-radius:8px;background:var(--surface-2);opacity:.55"></div>`
    ).join('');
  }

  function foutBlok(tekst) {
    return `<div style="margin:12px;padding:11px 13px;border:1px solid var(--rose-line,var(--border));background:var(--rose-soft,var(--surface-2));border-radius:8px;font-size:12px;color:var(--rose)">
      ⚠ ${esc(tekst)}</div>`;
  }

  /**
   * Het venster als merkteken — gat G3.
   *
   * Drie toestanden met drie kleuren, want dat is de enige manier waarop dit
   * werkt: je moet in een oogopslag zien of je nog vrij kunt schrijven.
   */
  function vensterMerk(v) {
    if (!v) return '';
    if (!v.open) {
      return `<span title="Buiten het servicevenster van 24 uur mag alleen een goedgekeurde template."
        style="font-size:10.5px;padding:2px 7px;border-radius:9px;background:var(--surface-2);color:var(--text-3);white-space:nowrap">venster dicht</span>`;
    }
    const kleur = v.bijna_dicht ? 'var(--amber)' : 'var(--emerald)';
    const achter = v.bijna_dicht ? 'var(--amber-soft,var(--surface-2))' : 'var(--emerald-soft,var(--surface-2))';
    return `<span title="Binnen het servicevenster kun je vrij schrijven."
      style="font-size:10.5px;padding:2px 7px;border-radius:9px;background:${achter};color:${kleur};white-space:nowrap;font-weight:600">${esc(v.tekst || '')}</span>`;
  }

  /** De verzendstatus van één bericht — gat G9. */
  function statusMerk(s) {
    if (!s) return '';
    if (s.status === 'failed' || s.fout) {
      return `<span title="${esc(s.fout || 'onbekende fout')}" style="color:var(--rose);font-weight:600">✕ mislukt</span>`;
    }
    if (s.gelezen_op) return `<span style="color:var(--brand)" title="Gelezen">✓✓ gelezen</span>`;
    if (s.afgeleverd_op) return `<span style="color:var(--text-3)" title="Afgeleverd">✓✓ afgeleverd</span>`;
    if (s.verzonden_op) return `<span style="color:var(--text-3)" title="Verzonden">✓ verzonden</span>`;
    return `<span style="color:var(--text-3)">in wachtrij</span>`;
  }

  function koppelMerk(rij) {
    if (rij.koppelstatus === 'gekoppeld') return '';
    const tekst = rij.koppelstatus === 'te_bevestigen' ? 'te bevestigen' : 'niet gekoppeld';
    return `<span title="${esc(rij.koppel_reden || '')}"
      style="font-size:10px;padding:1px 6px;border-radius:8px;background:var(--amber-soft,var(--surface-2));color:var(--amber);white-space:nowrap">${tekst}</span>`;
  }

  function tijdKort(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const nu = new Date();
    const zelfdeDag = d.getFullYear() === nu.getFullYear() && d.getMonth() === nu.getMonth() && d.getDate() === nu.getDate();
    return zelfdeDag
      ? d.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('nl-BE', { day: '2-digit', month: '2-digit' });
  }

  const eur = (n) => '€ ' + (Number(n) || 0).toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /* ── Opmaak: de drie kolommen ─────────────────────────────────────────── */

  function filterBalk() {
    const pil = (v) => `<button class="chip ${S.filter === v ? 'on' : ''}" style="font-size:11.5px;padding:4px 11px"
      onclick="__irisFilter('${v}')">${esc(FILTER_LABELS[v])}</button>`;
    const cats = ['', ...Object.keys(CATEGORIE_LABELS)].map((c) =>
      `<option value="${esc(c)}" ${S.categorie === (c || null) ? 'selected' : ''}>${c ? esc(CATEGORIE_LABELS[c]) : 'Alle categorieën'}</option>`
    ).join('');
    return `<div style="padding:10px 12px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;gap:5px;flex-wrap:wrap">${Object.keys(FILTER_LABELS).map(pil).join('')}</div>
      <div style="display:flex;gap:6px;align-items:center">
        <input type="search" placeholder="Zoek op naam of e-mailadres…" value="${esc(S.zoek)}"
          oninput="__irisZoek(this.value)"
          style="flex:1;min-width:0;font-size:12px;padding:5px 9px;border:1px solid var(--border);border-radius:6px;background:var(--surface-2);color:var(--text-1)" />
        <select onchange="__irisCategorie(this.value)"
          style="font-size:11.5px;padding:5px 7px;border:1px solid var(--border);border-radius:6px;background:var(--surface-2);color:var(--text-1);max-width:150px">${cats}</select>
      </div>
    </div>`;
  }

  function lijstKolom() {
    const st = S.lijst;
    let binnen;
    if (!st.opgehaald && st.bezig) binnen = skelet(8);
    else if (st.fout) binnen = foutBlok(st.fout);
    else if (!st.items.length) binnen = NIETS(S.zoek ? 'Niets gevonden.' : 'Geen gesprekken in dit filter.');
    else binnen = st.items.map(lijstRij).join('');

    const pagina = (st.totaal > 50 || S.vanaf > 0)
      ? `<div style="padding:8px 12px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;font-size:11.5px;color:var(--text-3)">
          <button class="btn btn-ghost btn-sm" style="font-size:11px;padding:3px 9px" onclick="__irisPagina(-1)" ${S.vanaf === 0 ? 'disabled' : ''}>← vorige</button>
          <span>${S.vanaf + 1}–${S.vanaf + st.items.length} van ${st.totaal}</span>
          <button class="btn btn-ghost btn-sm" style="font-size:11px;padding:3px 9px" onclick="__irisPagina(1)" ${st.meer ? '' : 'disabled'}>volgende →</button>
        </div>`
      : '';

    return `<div style="display:flex;flex-direction:column;height:100%;border-right:1px solid var(--border);min-width:0">
      ${filterBalk()}
      <div id="irisLijst" style="flex:1;overflow-y:auto">${binnen}</div>
      ${pagina}
    </div>`;
  }

  function lijstRij(r) {
    const gekozen = S.gekozen === r.id;
    const kanaal = r.kanaal === 'email' ? '✉' : '💬';
    const cat = r.categorie ? `<span style="font-size:10px;color:var(--text-3)">${esc(CATEGORIE_LABELS[r.categorie] || r.categorie)}</span>` : '';
    const onzeker = (r.zekerheid !== null && r.zekerheid < 0.5)
      ? `<span title="Iris weet het niet zeker (${Math.round(r.zekerheid * 100)}%)" style="font-size:10px;color:var(--amber)">?</span>` : '';
    return `<div onclick="__irisKies('${esc(r.id)}')"
      style="padding:9px 12px;border-bottom:1px solid var(--border);cursor:pointer;background:${gekozen ? 'var(--surface-2)' : 'transparent'};border-left:3px solid ${gekozen ? 'var(--brand)' : 'transparent'}">
      <div style="display:flex;gap:7px;align-items:baseline;margin-bottom:3px">
        <span style="font-size:12px">${kanaal}</span>
        <b style="font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1">${esc(r.naam)}</b>
        ${r.ongelezen ? `<span style="font-size:10px;background:var(--brand);color:#fff;border-radius:9px;padding:1px 6px;font-weight:700">${r.ongelezen}</span>` : ''}
        <span style="font-size:10.5px;color:var(--text-3);white-space:nowrap">${tijdKort(r.laatste_inbound)}</span>
      </div>
      <div style="font-size:11.5px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:4px">
        ${esc(r.samenvatting || r.voorbeeld || '—')}
      </div>
      <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap">
        ${vensterMerk(r.venster)}${koppelMerk(r)}${cat}${onzeker}
      </div>
    </div>`;
  }

  function draadKolom() {
    if (!S.gekozen) return NIETS('Kies een gesprek links.');
    const st = S.gesprek;
    if (st.bezig && !st.data) return `<div style="padding:14px">${skelet(6)}</div>`;
    if (st.fout) return foutBlok(st.fout);
    if (!st.data) return NIETS('Geen gesprek geladen.');

    const g = st.data.gesprek || {};
    const v = st.data.venster || {};
    const verzenden = st.data.verzenden || {};

    const kop = `<div style="padding:10px 14px;border-bottom:1px solid var(--border);background:var(--surface-2);display:flex;gap:9px;align-items:center;flex-wrap:wrap">
      <b style="font-size:13px">${esc(g.naam || 'Onbekend')}</b>
      ${vensterMerk(v)}
      <span style="font-size:11px;color:var(--text-3)">${esc(g.status || '')}</span>
      <div style="flex:1"></div>
      ${g.categorie ? `<span style="font-size:11px;color:var(--text-3)">${esc(CATEGORIE_LABELS[g.categorie] || g.categorie)}</span>` : ''}
    </div>`;

    const berichten = (st.data.berichten || []);
    const draad = berichten.length
      ? berichten.map(bericht).join('')
      : NIETS('Nog geen berichten in dit gesprek.');

    const voet = schrijfbalk(S.gekozen, verzenden);

    return `<div style="display:flex;flex-direction:column;height:100%;min-width:0">
      ${kop}
      <div style="flex:1;overflow-y:auto;padding:12px 14px">${draad}</div>
      ${voet}
    </div>`;
  }

  function bericht(b) {
    const uit = b.richting === 'uit';
    const s = statusMerk(b.verzendstatus);
    const onzeker = (b.zekerheid !== null && b.zekerheid !== undefined && b.zekerheid < 0.5 && b.categorie)
      ? `<span title="Iris weet het niet zeker" style="color:var(--amber)"> · ${Math.round(b.zekerheid * 100)}%</span>` : '';
    return `<div style="display:flex;justify-content:${uit ? 'flex-end' : 'flex-start'};margin-bottom:9px">
      <div style="max-width:78%;padding:8px 11px;border-radius:10px;background:${uit ? 'var(--brand-soft,var(--surface-2))' : 'var(--surface-2)'};border:1px solid var(--border)">
        <div style="font-size:12.5px;white-space:pre-wrap;word-break:break-word">${esc(b.tekst_kort || '—')}</div>
        <div style="font-size:10px;color:var(--text-3);margin-top:5px;display:flex;gap:7px;align-items:center;flex-wrap:wrap">
          <span>${esc(b.bron === 'email' ? 'mail' : 'WhatsApp')}</span>
          <span>${tijdKort(b.ontvangen_op)}</span>
          ${s}
          ${b.categorie ? `<span>${esc(CATEGORIE_LABELS[b.categorie] || b.categorie)}${onzeker}</span>` : ''}
          ${b.verwerk_fout ? `<span style="color:var(--amber)" title="${esc(b.verwerk_fout)}">nog niet ingedeeld</span>` : ''}
        </div>
      </div>
    </div>`;
  }

  /**
   * De schrijfbalk.
   *
   * Eén beweging: inspreken of typen wat je wil, Iris schrijft het, jij kiest
   * Verstuur. Dat is de hele belofte van deze module, en alles wat hier staat
   * is ondergeschikt aan die drie stappen.
   *
   * Loopt er een ongedaan-venster, dan verdwijnt de balk en staat er alleen
   * de aftelling met één knop. Dat is met opzet: zolang er nog iets terug kan,
   * hoort er niets anders aandacht te vragen.
   */
  function schrijfbalk(gesprekId, verzenden) {
    const o = S.ongedaan;
    if (o && o.gesprekId === gesprekId) {
      const over = Math.max(0, Math.ceil((o.tot - Date.now()) / 1000));
      return `<div style="border-top:1px solid var(--border);background:var(--emerald-soft,var(--surface-2));padding:12px 14px;display:flex;align-items:center;gap:12px">
        <span style="font-size:12.5px;color:var(--emerald);font-weight:600">Verstuurd over ${over}s</span>
        <div style="flex:1;height:3px;background:var(--border);border-radius:2px;overflow:hidden">
          <div style="height:100%;width:${Math.round((over / 30) * 100)}%;background:var(--emerald);transition:width 1s linear"></div>
        </div>
        <button class="btn btn-ghost btn-sm" style="font-size:12px;padding:5px 14px;font-weight:600" onclick="__irisOngedaan()">Toch niet</button>
      </div>`;
    }

    const bundel = S.schrijf.concept[gesprekId];
    const bezig = S.schrijf.bezig === gesprekId;
    const neemtOp = S.schrijf.opname === gesprekId;
    const verstuurt = S.schrijf.verstuurt === gesprekId;
    const fout = S.schrijf.fout[gesprekId];
    const instructie = S.schrijf.instructie[gesprekId] || '';

    const vensterRegel = verzenden?.vorm === 'template'
      ? `<div style="font-size:11px;color:var(--amber);margin-bottom:7px">
          🔒 Het venster is dicht. Een antwoord gaat als goedgekeurde template — Iris kiest hem, jij ziet welke.
        </div>`
      : '';

    // Het concept, als er een is.
    let conceptBlok = '';
    if (bundel?.concept?.tekst || bundel?.mens_nodig) {
      const c = bundel.concept || {};
      const blokkades = (bundel.blokkades || []);
      const waarschuwingen = (bundel.waarschuwingen || []);
      const magWeg = bundel.mag_verstuurd_worden && !bundel.mens_nodig;

      conceptBlok = `<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:9px;background:var(--surface-2)">
        ${c.onderwerp ? `<div style="font-size:11.5px;font-weight:600;margin-bottom:5px">${esc(c.onderwerp)}</div>` : ''}
        <div style="font-size:12.5px;white-space:pre-wrap;word-break:break-word">${esc(c.tekst || '—')}</div>
        ${bundel.toelichting ? `<div style="font-size:11px;color:var(--text-3);margin-top:7px;font-style:italic">${esc(bundel.toelichting)}</div>` : ''}
        ${blokkades.map((b) => `<div style="font-size:11.5px;color:var(--rose);margin-top:6px">⛔ ${esc(b)}</div>`).join('')}
        ${waarschuwingen.map((w) => `<div style="font-size:11.5px;color:var(--amber);margin-top:6px">⚠ ${esc(w)}</div>`).join('')}
        ${(bundel.ontbrekende_gegevens || []).length
          ? `<div style="font-size:11px;color:var(--amber);margin-top:6px">Iris miste: ${esc(bundel.ontbrekende_gegevens.join(', '))}</div>`
          : ''}
        <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" style="font-size:11.5px;padding:5px 11px" onclick="__irisSchrijf()" ${bezig ? 'disabled' : ''}>Opnieuw</button>
          <button class="btn btn-primary btn-sm" style="font-size:11.5px;padding:5px 15px" onclick="__irisVerstuur()"
            ${magWeg && !verstuurt ? '' : 'disabled'}
            title="${magWeg ? 'Gaat weg na 30 seconden — je kunt het nog tegenhouden.' : 'Er staat nog iets in de weg.'}">
            ${verstuurt ? 'Bezig…' : 'Verstuur'}</button>
        </div>
      </div>`;
    }

    const micKleur = neemtOp ? 'var(--rose)' : 'var(--text-2)';
    const micTitel = neemtOp ? 'Stoppen met opnemen' : 'Spreek in wat je wil antwoorden';

    return `<div style="border-top:1px solid var(--border);background:var(--surface);padding:11px 14px">
      ${vensterRegel}
      ${conceptBlok}
      ${fout ? `<div style="font-size:11.5px;color:var(--rose);margin-bottom:7px">⚠ ${esc(fout)}</div>` : ''}
      <div style="display:flex;gap:7px;align-items:flex-end">
        <textarea id="irisInstructie" rows="2" placeholder="Wat wil je antwoorden? Spreek het in of typ het."
          oninput="__irisInstructie(this.value)"
          style="flex:1;min-width:0;font-size:12.5px;padding:8px 10px;border:1px solid var(--border);border-radius:7px;background:var(--surface-2);color:var(--text-1);resize:vertical;font-family:inherit;box-sizing:border-box">${esc(instructie)}</textarea>
        <button class="btn btn-ghost btn-sm" title="${micTitel}" onclick="__irisMicrofoon()"
          style="font-size:16px;padding:7px 11px;color:${micKleur};${neemtOp ? 'animation:irisPuls 1.2s ease-in-out infinite' : ''}">${neemtOp ? '⏹' : '🎙'}</button>
        <button class="btn btn-primary btn-sm" style="font-size:11.5px;padding:7px 14px;white-space:nowrap"
          onclick="__irisSchrijf()" ${bezig ? 'disabled' : ''}>${bezig ? 'Bezig…' : 'Schrijf'}</button>
      </div>
      ${neemtOp ? `<div style="font-size:11px;color:var(--rose);margin-top:6px">● Aan het opnemen — klik nog eens om te stoppen.</div>` : ''}
    </div>
    <style>@keyframes irisPuls{0%,100%{opacity:1}50%{opacity:.45}}</style>`;
  }

  function dossierKolom() {
    if (!S.gekozen) return '';
    const st = S.dossier;
    if (st.bezig && !st.data) return `<div style="padding:14px">${skelet(5)}</div>`;
    if (st.fout) return foutBlok(st.fout);
    const d = st.data;
    if (!d) return NIETS('Geen dossier.');
    if (!d.contact) {
      return `<div style="padding:16px;font-size:12px">
        <div style="font-weight:700;margin-bottom:7px">Nog geen persoon</div>
        <div style="color:var(--text-2);font-size:11.5px">${esc(d.reden || 'Dit gesprek hangt nog niet aan iemand.')}</div>
      </div>`;
    }

    const c = d.contact;
    const t = d.totalen || {};

    const kopje = (tekst) => `<div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3);font-weight:700;margin:14px 0 6px">${esc(tekst)}</div>`;

    // Een bron die niet gelezen kon worden krijgt zijn eigen regel. Dat is het
    // hele punt: "geen open facturen" en "we konden niet kijken" mogen er nooit
    // hetzelfde uitzien.
    const bron = (b, leegTekst, opmaak) => {
      if (!b) return `<div style="font-size:11.5px;color:var(--text-3)">—</div>`;
      if (b.gelezen === false) {
        return `<div style="font-size:11.5px;color:var(--amber)">⚠ niet gelezen${b.reden ? ' — ' + esc(b.reden) : ''}</div>`;
      }
      const items = b.items || [];
      if (!items.length && !b.student && !b.fase) return `<div style="font-size:11.5px;color:var(--text-3)">${esc(leegTekst)}</div>`;
      return opmaak(b);
    };

    const facturen = bron(d.facturen, 'Geen open facturen.', (b) =>
      b.items.map((f) => `<div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px dashed var(--border);font-size:11.5px">
        <span style="font-family:'IBM Plex Mono',monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.nummer || f.id.slice(0, 8))}
          ${f.te_laat ? `<span style="color:var(--rose);font-size:10px"> +${f.dagen_te_laat}d</span>` : ''}</span>
        <span style="font-family:'IBM Plex Mono',monospace;font-weight:600">${eur(f.bedrag_open)}</span>
      </div>`).join('')
    );

    const motor = bron(d.aanmaanmotor, 'Niet in de aanmaanmotor.', (b) =>
      `<div style="font-size:11.5px">Fase <b>${esc(b.fase)}</b>${b.fase_sinds ? ` <span style="color:var(--text-3)">sinds ${tijdKort(b.fase_sinds)}</span>` : ''}</div>`
    );

    const lms = bron(d.lms, 'Geen student gevonden.', (b) => b.student
      ? `<div style="font-size:11.5px">
          <div>Toegang tot <b>${esc(b.student.toegang_tot || '—')}</b>
            ${b.student.toegang_geldig === false ? '<span style="color:var(--rose)"> (verlopen)</span>' : ''}</div>
          ${b.student.product ? `<div style="color:var(--text-3)">${esc(b.student.product)}</div>` : ''}
          ${b.student.no_shows ? `<div style="color:var(--amber)">${b.student.no_shows}× niet op komen dagen</div>` : ''}
        </div>`
      : `<div style="font-size:11.5px;color:var(--text-3)">${esc(b.reden || 'Geen student gevonden.')}</div>`
    );

    const belofte = d.beloftes?.actief
      ? `<div style="font-size:11.5px;padding:7px 9px;border-radius:7px;background:var(--amber-soft,var(--surface-2));color:var(--amber)">
          Belofte: ${eur(d.beloftes.actief.bedrag)} op ${esc(d.beloftes.actief.datum)}
          <div style="font-size:10.5px;margin-top:3px;opacity:.85">Let op: de automatische aanmaningen lopen nog door.</div>
        </div>`
      : bron(d.beloftes, 'Geen belofte.', () => `<div style="font-size:11.5px;color:var(--text-3)">Geen lopende belofte.</div>`);

    const signalen = bron(d.signalen, 'Geen mentorsignalen.', (b) =>
      b.items.slice(0, 3).map((s) => `<div style="font-size:11.5px;padding:3px 0">
        <b>${esc(s.type)}</b>${s.mentor_naam ? ` <span style="color:var(--text-3)">— ${esc(s.mentor_naam)}</span>` : ''}
        ${s.toelichting ? `<div style="color:var(--text-2);font-size:11px">${esc(s.toelichting)}</div>` : ''}
      </div>`).join('')
    );

    const pogingen = bron(d.belpogingen, 'Nog niet gebeld.', (b) =>
      `<div style="font-size:11.5px">${b.aantal_echt} poging(en)${b.laatste_contact ? ` · laatst gesproken ${tijdKort(b.laatste_contact)}` : ''}</div>`
    );

    return `<div style="height:100%;overflow-y:auto;padding:0 0 20px">
      <div style="padding:14px;border-bottom:1px solid var(--border);background:var(--surface-2)">
        <div style="font-weight:700;font-size:13px;margin-bottom:3px">${esc(c.naam || d.klant?.name || 'Onbekend')}</div>
        ${(c.emails || []).map((e) => `<div style="font-size:11.5px;color:var(--text-2);word-break:break-all">✉ ${esc(e)}</div>`).join('')}
        ${(c.telefoons || []).map((p) => `<div style="font-size:11.5px;color:var(--text-2)">📞 ${esc(p)}</div>`).join('')}
        ${c.koppelstatus !== 'gekoppeld'
          ? `<div style="font-size:11px;color:var(--amber);margin-top:6px">⚠ ${esc(c.koppelstatus === 'te_bevestigen' ? 'Koppeling te bevestigen' : 'Niet gekoppeld')}${c.koppel_reden ? ' — ' + esc(c.koppel_reden) : ''}</div>`
          : ''}
        ${t.aantal_open ? `<div style="margin-top:8px;font-size:12px"><b style="font-family:'IBM Plex Mono',monospace;color:var(--rose)">${eur(t.open_bedrag)}</b>
          <span style="color:var(--text-3);font-size:11px"> open${t.oudste_dagen_te_laat ? ` · oudste ${t.oudste_dagen_te_laat}d te laat` : ''}</span></div>` : ''}
      </div>
      <div style="padding:0 14px">
        ${kopje('Open facturen')}${facturen}
        ${kopje('Aanmaanmotor')}${motor}
        ${kopje('LMS')}${lms}
        ${kopje('Belofte')}${belofte}
        ${kopje('Mentorsignalen')}${signalen}
        ${kopje('Bellen')}${pogingen}
      </div>
    </div>`;
  }

  /* ── De andere tabbladen ──────────────────────────────────────────────── */

  function instellingenTab() {
    const st = S.instellingen;
    if (st.bezig && !st.data) return `<div style="padding:20px">${skelet(6)}</div>`;
    if (st.fout) return foutBlok(st.fout);
    const d = st.data;
    if (!d) return NIETS('Geen instellingen geladen.');

    const inst = d.instellingen || {};
    const aut = inst.autonomie || {};
    const nooitZelf = new Set(d.nooit_zelf || []);

    const rij = (cat) => {
      const stand = aut[cat] || 'uit';
      const kleur = stand === 'zelf' ? 'var(--emerald)' : stand === 'concept' ? 'var(--amber)' : 'var(--text-3)';
      return `<tr>
        <td style="padding:6px 10px;font-size:12px">${esc(CATEGORIE_LABELS[cat] || cat)}</td>
        <td style="padding:6px 10px;font-size:12px;color:${kleur};font-weight:600">${esc(stand)}</td>
        <td style="padding:6px 10px;font-size:11px;color:var(--text-3)">${nooitZelf.has(cat) ? 'kan nooit op "zelf" — gaat altijd langs een mens' : ''}</td>
      </tr>`;
    };

    return `<div style="padding:20px;max-width:860px">
      <div style="padding:12px 14px;border-radius:8px;border:1px solid ${d.aan ? 'var(--emerald-line,var(--border))' : 'var(--amber-line,var(--border))'};
        background:${d.aan ? 'var(--emerald-soft,var(--surface-2))' : 'var(--amber-soft,var(--surface-2))'};margin-bottom:18px;font-size:12.5px">
        <b>${d.aan ? 'Iris staat aan' : 'Iris staat uit'}</b>
        <div style="font-size:11.5px;margin-top:4px;opacity:.9">
          ${d.aan
            ? 'De hoofdschakelaar staat aan. Wat er per categorie gebeurt, staat hieronder.'
            : 'De hoofdschakelaar IRIS_AAN staat uit. Iris leest en deelt in, maar verstuurt niets — wat er hieronder ook staat.'}
        </div>
      </div>
      ${!inst.gelezen ? foutBlok('De instellingen konden niet gelezen worden. Wat hieronder staat is de standaard, niet wat er ingesteld is.') : ''}
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3);font-weight:700;margin-bottom:8px">Autonomie per categorie</div>
      <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:var(--surface-2)">
            <th style="text-align:left;padding:7px 10px;font-size:11px;color:var(--text-3)">Categorie</th>
            <th style="text-align:left;padding:7px 10px;font-size:11px;color:var(--text-3)">Stand</th>
            <th style="text-align:left;padding:7px 10px;font-size:11px;color:var(--text-3)"></th>
          </tr></thead>
          <tbody>${(d.categorieen || []).map(rij).join('')}</tbody>
        </table>
      </div>
      <div style="margin-top:16px;font-size:11.5px;color:var(--text-3)">
        Wijzigen kan zodra de bediening er staat. Tot die tijd via
        <code style="font-size:11px">POST /api/iris-instellingen</code>, met het recht <code style="font-size:11px">iris.instellingen</code>.
      </div>
      <div style="margin-top:18px;font-size:11.5px;color:var(--text-2)">
        <div>Stille uren: ${esc(inst.stille_uren?.van || '—')}–${esc(inst.stille_uren?.tot || '—')}${inst.stille_uren?.zondag_stil ? ', en niet op zondag' : ''}</div>
        <div>Escalatie: na ${esc(String(inst.escalatie?.pogingen ?? '—'))} pogingen op ${esc(String(inst.escalatie?.dagen ?? '—'))} dagen</div>
        <div>Ongedaan maken kan ${esc(String(inst.ongedaan_seconden ?? '—'))} seconden</div>
      </div>
    </div>`;
  }

  function nogNiet(wat, fase) {
    return `<div style="padding:48px 20px;text-align:center;color:var(--text-3);max-width:520px;margin:0 auto">
      <div style="font-size:26px;opacity:.4;margin-bottom:10px">⏳</div>
      <div style="font-size:13px;font-weight:600;color:var(--text-2);margin-bottom:6px">${esc(wat)}</div>
      <div style="font-size:12px">Komt in fase ${esc(fase)}. Er staat hier met opzet nog geen knop —
        een knop die niets doet is erger dan geen knop.</div>
    </div>`;
  }

  /* ── Het scherm ───────────────────────────────────────────────────────── */

  function irisView() {
    // Eerste keer: haal de lijst op. Via queueMicrotask zodat we niet midden
    // in een teken-ronde een nieuwe teken-ronde aftrappen.
    if (S.tab === 'post' && !S.lijst.opgehaald && !S.lijst.bezig) {
      queueMicrotask(() => { haalLijst(); startPoll(); });
    }

    const tabs = TABS.map(([v, label]) =>
      `<button class="chip ${S.tab === v ? 'on' : ''}" style="font-size:12px;padding:5px 13px" onclick="__irisTab('${v}')">${esc(label)}</button>`
    ).join('');

    let binnen;
    if (S.tab === 'post') {
      binnen = `<div style="display:grid;grid-template-columns:minmax(260px,320px) minmax(0,1fr) minmax(240px,300px);height:calc(100vh - 168px);min-height:420px;border-top:1px solid var(--border)">
        ${lijstKolom()}
        <div style="min-width:0;border-right:1px solid var(--border)">${draadKolom()}</div>
        <div style="min-width:0">${dossierKolom()}</div>
      </div>`;
    } else if (S.tab === 'instellingen') {
      binnen = instellingenTab();
    } else if (S.tab === 'opdrachten') {
      binnen = nogNiet('Iris, regel dit', '5');
    } else if (S.tab === 'belrij') {
      binnen = nogNiet('De belrij', '7');
    } else if (S.tab === 'dossiers') {
      binnen = nogNiet('Dossiers per persoon', '3 (vervolg)');
    } else {
      binnen = nogNiet('Het logboek', '12');
    }

    return `<div style="display:flex;flex-direction:column;min-height:0">
      <div style="padding:14px 20px 10px">
        <div style="font-size:18px;font-weight:700;margin-bottom:3px">Iris</div>
        <div style="font-size:12px;color:var(--text-3);margin-bottom:11px">
          Leest mee met de post, koppelt aan een dossier en zet antwoorden klaar.
        </div>
        <div style="display:flex;gap:5px;flex-wrap:wrap">${tabs}</div>
      </div>
      ${binnen}
    </div>`;
  }

  window.DFO.VIEWS['iris/'] = irisView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('iris');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('iris');
  console.debug('[iris] v=1 — Post leest mee. Bereikbaar via ?v2preview=iris tot de vlag omgaat.');
})();
