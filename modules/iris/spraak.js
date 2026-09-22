// modules/iris/spraak.js
//
// DE MICROFOON, ZONDER TWEEDE LEVERANCIER.
//
// Maxim gebruikt alleen Anthropic. De Anthropic-API doet geen spraak naar
// tekst — Claude kan een opname niet beluisteren. Dus luistert de browser mee:
// Chrome en Edge hebben de Web Speech API ingebouwd. Gratis, geen sleutel, en
// voor Nederlands goed genoeg. Wat eruit komt gaat daarna gewoon naar Claude,
// precies zoals eerst; alleen de eerste stap verhuist van de server naar het
// toetsenbord.
//
// ── WAT HIER WEL EN NIET IN ZIT ──────────────────────────────────────────────
// Zuivere keuzes en een dunne schil om SpeechRecognition heen. Geen fetch,
// geen opmaak, geen verwijzing naar de staat van Iris. Zo is de keuzelogica na
// te rekenen zonder browser, en de schil te beproeven met een nagemaakte
// herkenner.
//
// ── DRIE DINGEN DIE EEN NAÏEVE IMPLEMENTATIE FOUT DOET ───────────────────────
//
// 1. GEEN TUSSENSTAND TONEN. Zonder `interimResults` zie je niets tot je stopt,
//    en dan blijkt dat de microfoon de verkeerde was. Je moet kunnen meelezen
//    terwijl je praat.
//
// 2. STOPPEN BIJ DE EERSTE STILTE. Chrome beëindigt een herkenning na een paar
//    seconden zonder spraak, ook met `continuous`. Het lampje gaat uit, de
//    gebruiker praat door, en er komt niets meer binnen. Daarom starten we
//    opnieuw zolang er niet met de hand gestopt is — met een bovengrens, want
//    een herkenner die meteen weer eindigt zou anders een lus worden.
//
// 3. DE FOUTCODE LATEN ZIEN. 'not-allowed' zegt een gebruiker niets;
//    "je browser geeft geen toegang tot de microfoon" wel. En 'no-speech' is
//    helemaal geen fout — dat is gewoon stilte.

(function () {
  /** Vlaams-Nederlands. Maxim en Dave zitten in België; 'nl-NL' hoort er anders. */
  const TAAL = 'nl-BE';

  /** Hoe vaak we na een stilte opnieuw mogen beginnen binnen één opname. */
  const MAX_HERSTARTS = 30;

  /**
   * Welke weg neemt deze klik?
   *
   * @param {{openai?: boolean, browserKan?: boolean}} stand
   * @returns {'openai'|'browser'|'geen'}
   *
   * De sleutel wint. Niet omdat de browser slecht is, maar omdat een ingestelde
   * sleutel een uitgesproken keuze is: iemand heeft 'em erin gezet, dus is hij
   * daar om gebruikt te worden. En hij werkt in élke browser, ook de twee die
   * geen Web Speech hebben.
   */
  function kiesRoute(stand) {
    const s = (stand && typeof stand === 'object') ? stand : {};
    if (s.openai === true) return 'openai';
    if (s.browserKan === true) return 'browser';
    return 'geen';
  }

  /** Heeft deze browser de Web Speech API? Chrome en Edge wel, Safari en Firefox niet. */
  function browserKanSpraak(win) {
    const w = win || (typeof window !== 'undefined' ? window : null);
    if (!w) return false;
    const K = w.SpeechRecognition || w.webkitSpeechRecognition;
    return typeof K === 'function';
  }

  /**
   * Een foutcode van de Web Speech API, in gewone taal.
   *
   * `null` betekent: dit is geen fout die je moet melden. 'no-speech' is
   * stilte, en 'aborted' is de gebruiker die zelf stopte.
   */
  function foutTekst(code) {
    switch (String(code || '')) {
      case 'not-allowed':
      case 'service-not-allowed':
        return 'De browser geeft geen toegang tot de microfoon. Typen kan wel.';
      case 'audio-capture':
        return 'Geen microfoon gevonden. Typen kan wel.';
      case 'network':
        return 'De spraakherkenning kon het netwerk niet bereiken. Typen kan wel.';
      case 'language-not-supported':
        return 'Deze browser kent het Nederlands niet voor spraak. Typen kan wel.';
      case 'no-speech':
      case 'aborted':
        return null;              // geen fout: stilte, of zelf gestopt
      default:
        return code ? ('Spraakherkenning gaf een fout: ' + code) : null;
    }
  }

  /**
   * Zet de losse uitkomsten van één gebeurtenis om in twee stukken tekst.
   *
   * De API levert een groeiende lijst; `resultIndex` zegt waar het nieuwe deel
   * begint. Wat definitief is hoort bij de tekst die blijft staan, de rest is
   * de tussenstand die bij de volgende gebeurtenis weer overschreven wordt.
   * Ze door elkaar halen levert tekst op die zichzelf herhaalt.
   *
   * @returns {{definitief: string, tussentijds: string}}
   */
  function leesUitkomsten(gebeurtenis) {
    const r = gebeurtenis && gebeurtenis.results;
    if (!r || typeof r.length !== 'number') return { definitief: '', tussentijds: '' };
    const vanaf = Number.isFinite(gebeurtenis.resultIndex) ? gebeurtenis.resultIndex : 0;
    let definitief = '';
    let tussentijds = '';
    for (let i = vanaf; i < r.length; i++) {
      const rij = r[i];
      if (!rij) continue;
      const tekst = String((rij[0] && rij[0].transcript) || '').trim();
      if (!tekst) continue;
      if (rij.isFinal) definitief += (definitief ? ' ' : '') + tekst;
      else tussentijds += (tussentijds ? ' ' : '') + tekst;
    }
    return { definitief, tussentijds };
  }

  /** Twee stukken tekst aan elkaar, zonder dubbele of ontbrekende spatie. */
  function voegSamen(a, b) {
    const x = String(a || '').trim();
    const y = String(b || '').trim();
    if (!x) return y;
    if (!y) return x;
    return x + ' ' + y;
  }

  /**
   * Een herkenner die blijft luisteren tot je 'em stopzet.
   *
   * @param {Window} win
   * @param {{taal?: string, maxHerstarts?: number}} opties
   * @returns {{start: Function, stop: Function, bezig: Function,
   *            onTekst: Function, onFout: Function, onEinde: Function}}
   *
   * `onTekst(alles, tussentijds)` wordt bij elke gebeurtenis aangeroepen:
   * `alles` is wat er tot nu toe definitief verstaan is, `tussentijds` wat er
   * op dit moment nog aan het vormen is. Het scherm kan die twee achter elkaar
   * tonen zodat je meeleest terwijl je praat.
   */
  function maakHerkenner(win, opties) {
    const w = win || (typeof window !== 'undefined' ? window : null);
    const K = w && (w.SpeechRecognition || w.webkitSpeechRecognition);
    if (typeof K !== 'function') return null;

    const o = (opties && typeof opties === 'object') ? opties : {};
    const maxHerstarts = Number.isFinite(o.maxHerstarts) ? o.maxHerstarts : MAX_HERSTARTS;

    const rec = new K();
    rec.lang = String(o.taal || TAAL);
    rec.continuous = true;
    rec.interimResults = true;

    let alles = '';
    let loopt = false;
    let gestopt = false;
    let klaar = false;
    let herstarts = 0;
    const haken = { tekst: null, fout: null, einde: null };

    rec.onresult = (e) => {
      const { definitief, tussentijds } = leesUitkomsten(e);
      if (definitief) alles = voegSamen(alles, definitief);
      if (haken.tekst) haken.tekst(alles, tussentijds);
    };

    rec.onerror = (e) => {
      const tekst = foutTekst(e && e.error);
      // 'no-speech' is stilte en geen fout; die mag de herstart niet blokkeren.
      if (tekst && haken.fout) haken.fout(tekst, e && e.error);
      if (String(e && e.error) === 'not-allowed' || String(e && e.error) === 'service-not-allowed') {
        gestopt = true;   // zonder toestemming heeft opnieuw beginnen geen zin
      }
    };

    rec.onend = () => {
      loopt = false;
      // Chrome stopt uit zichzelf na een stilte. Zolang de gebruiker niet zelf
      // gestopt is, gaan we door — met een bovengrens, want een herkenner die
      // meteen weer eindigt zou anders een lus worden die de tab vastzet.
      if (!gestopt && herstarts < maxHerstarts) {
        herstarts++;
        try { rec.start(); loopt = true; return; } catch (_) { /* valt door naar einde */ }
      }
      // Eén keer einde per opname. `onend` kan meer dan eens langskomen als
      // een herstart zelf ook meteen eindigt, en een scherm dat twee keer te
      // horen krijgt dat het klaar is, verwerkt de tekst twee keer.
      if (klaar) return;
      klaar = true;
      if (haken.einde) haken.einde(alles);
    };

    return {
      start() {
        if (loopt) return;
        gestopt = false;
        klaar = false;
        herstarts = 0;
        alles = '';
        try { rec.start(); loopt = true; }
        catch (e) { if (haken.fout) haken.fout('De microfoon kon niet starten. Typen kan wel.', 'start'); }
      },
      stop() {
        gestopt = true;
        try { rec.stop(); } catch (_) {}
      },
      bezig() { return loopt; },
      onTekst(fn) { haken.tekst = fn; },
      onFout(fn) { haken.fout = fn; },
      onEinde(fn) { haken.einde = fn; },
    };
  }

  const API = {
    TAAL, MAX_HERSTARTS,
    kiesRoute, browserKanSpraak, foutTekst, leesUitkomsten, voegSamen, maakHerkenner,
  };

  if (typeof window !== 'undefined') window.IRIS_SPRAAK = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
