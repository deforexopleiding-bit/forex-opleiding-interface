// api/_lib/support-telefoon.js
//
// Het gsm-nummer van de supportwidget (2026-10-21): VERPLICHT, en naar E.164
// met EXACT dezelfde NL/BE-regel als de funnels op deforexopleiding.nl
// (dfo-website lib/lab-scan-funnels.ts › controleerFunnelTelefoon, met
// lib/telefoon.ts als basis):
//   - +31/+32 en 0031/0032 (ook met spaties, (0), streepjes) → E.164;
//   - een 06- of 04[5-9]-gsm bepaalt zelf zijn land, ook zonder de 0;
//   - een vast nummer zonder landcode op lengte: 0 + 9 cijfers → +31,
//     0 + 8 cijfers → +32;
//   - een te kort 06-nummer wordt GEEN Belgisch vast nummer maar een melding;
//   - een ander land kan met + en landcode (8–15 cijfers).
// Dezelfde placeholder en dezelfde hint onder het veld als de funnels.
//
// Het blok tussen TELEFOON-REGEL:BEGIN en :END staat LETTERLIJK ook in
// widget/support.js (de widget is één los script zonder modules). De test
// tests/support-telefoon.test.js bewaakt dat beide kopieën gelijk zijn én dat
// ze dezelfde uitkomsten geven als de website-regel (tests/fixtures/).

/* TELEFOON-REGEL:BEGIN */
function maakTelefoonRegel() {
  var PLACEHOLDER = '06 12 34 56 78 of +32 470 12 34 56';
  var MELDING_LEEG = 'Vul je gsm-nummer in, bv. 06 12 34 56 78.';
  var MELDING_FOUT = 'Dit nummer herkennen we niet. Typ je gsm-nummer, bv. 06 12 34 56 78 (Nederland) of 0470 12 34 56 (België).';
  var MELDING_06_KORT = 'Een Nederlands 06-nummer heeft 10 cijfers, bv. 06 12 34 56 78.';
  var CODES = { NL: '31', BE: '32' };

  function gsmLand(kaal) {
    var n = kaal.charAt(0) === '0' && kaal.slice(0, 2) !== '00' ? kaal.slice(1) : kaal;
    if (n.length !== 9) return null;
    if (/^4[5-9]/.test(n)) return 'BE';
    if (n.charAt(0) === '6') return 'NL';
    return null;
  }
  function nationaalOk(land, n) {
    if (land === 'NL') return n.length === 9;
    return /^4[5-9]/.test(n) ? n.length === 9 : n.length === 8;
  }
  // De gedeelde basisregel (lib/telefoon.ts › controleerTelefoon) voor een
  // gekozen land NL/BE of zonder land (null).
  function basis(tekst, land) {
    var cijfers = tekst.replace(/\D/g, '');
    if (!cijfers) return { ok: false, reden: 'ongeldig' };
    var plus = tekst.charAt(0) === '+';
    var nullen = !plus && cijfers.slice(0, 2) === '00';
    if (plus || nullen) {
      var n = nullen ? cijfers.slice(2) : cijfers;
      if (!n || n.charAt(0) === '0') return { ok: false, reden: 'ongeldig' };
      var gevonden = n.slice(0, 2) === '32' ? 'BE' : n.slice(0, 2) === '31' ? 'NL' : n.length >= 2 ? 'OVERIG' : null;
      if (gevonden === 'BE' || gevonden === 'NL') {
        var nat = n.slice(2).replace(/^0/, '');
        if (!nationaalOk(gevonden, nat)) return { ok: false, reden: 'ongeldig' };
        n = CODES[gevonden] + nat;
      } else if (n.length < 8 || n.length > 15) {
        return { ok: false, reden: 'ongeldig' };
      }
      return { ok: true, e164: '+' + n, land: gevonden || 'OVERIG' };
    }
    var kaal = tekst.replace(/[\s.\-/()]/g, '');
    if (!/^\d+$/.test(kaal)) return { ok: false, reden: 'ongeldig' };
    var nationaal = kaal.replace(/^0/, '');
    if (nationaal.charAt(0) === '0') return { ok: false, reden: 'ongeldig' };
    var gsm = gsmLand(kaal);
    if (gsm) return { ok: true, e164: '+' + CODES[gsm] + nationaal, land: gsm };
    if (land !== 'BE' && land !== 'NL') return { ok: false, reden: cijfers.length >= 8 ? 'geen-landcode' : 'ongeldig' };
    if (!nationaalOk(land, nationaal)) return { ok: false, reden: 'ongeldig' };
    return { ok: true, e164: '+' + CODES[land] + nationaal, land: land };
  }

  /** Invoer → { ok, e164, land, gsm } of { ok:false, reden, melding }. */
  function controleer(ruw) {
    var tekst = String(ruw == null ? '' : ruw).trim();
    if (!tekst) return { ok: false, reden: 'leeg', melding: MELDING_LEEG };
    var b = basis(tekst, null);
    if (b.ok) return { ok: true, e164: b.e164, land: b.land, gsm: b.land === 'OVERIG' || /^\+(316|324[5-9])/.test(b.e164) };
    if (b.reden !== 'geen-landcode') return { ok: false, reden: 'ongeldig', melding: MELDING_FOUT };
    // Vast nummer zonder landcode: op lengte, met precies één trunk-nul.
    var kaal = tekst.replace(/[\s.\-/()]/g, '');
    if (!/^0[1-9]\d+$/.test(kaal)) return { ok: false, reden: 'ongeldig', melding: MELDING_FOUT };
    if (kaal.charAt(1) === '6') return { ok: false, reden: 'ongeldig', melding: MELDING_06_KORT };
    var landen = ['NL', 'BE'];
    for (var i = 0; i < landen.length; i++) {
      var u = basis(kaal, landen[i]);
      if (u.ok) return { ok: true, e164: u.e164, land: landen[i], gsm: false };
    }
    return { ok: false, reden: 'ongeldig', melding: MELDING_FOUT };
  }

  function groepeer(cijfers, patroon) {
    var delen = [], i = 0;
    for (var p = 0; p < patroon.length; p++) {
      if (i >= cijfers.length) break;
      delen.push(cijfers.slice(i, i + patroon[p]));
      i += patroon[p];
    }
    if (i < cijfers.length) delen.push(cijfers.slice(i));
    return delen.join(' ');
  }
  /** +32472223752 → "+32 472 22 37 52", +31612345678 → "+31 6 12345678". */
  function toon(e164) {
    var n;
    if (e164.slice(0, 3) === '+32') {
      n = e164.slice(3);
      if (n.charAt(0) === '4') return '+32 ' + groepeer(n, [3, 2, 2, 2]);
      return '+32 ' + groepeer(n, /^[239]/.test(n) ? [1, 3, 2, 2] : [2, 2, 2, 2]);
    }
    if (e164.slice(0, 3) === '+31') {
      n = e164.slice(3);
      return '+31 ' + (n.charAt(0) === '6' ? groepeer(n, [1, 8]) : groepeer(n, [2, 3, 4]));
    }
    return e164;
  }
  /** De regel onder het veld. Leeg = (nog) niets te melden. */
  function hint(ruw) {
    var u = controleer(ruw);
    if (!u.ok) return '';
    return u.gsm
      ? '\u2713 We sturen je WhatsApp naar ' + toon(u.e164)
      : '\u2713 We bellen je op ' + toon(u.e164) + ' (vast nummer: geen WhatsApp)';
  }

  return { controleer: controleer, hint: hint, toon: toon, PLACEHOLDER: PLACEHOLDER, MELDING_LEEG: MELDING_LEEG, MELDING_FOUT: MELDING_FOUT, MELDING_06_KORT: MELDING_06_KORT };
}
/* TELEFOON-REGEL:END */

const regel = maakTelefoonRegel();
export const controleerSupportTelefoon = regel.controleer;
export const supportTelefoonHint = regel.hint;
export const toonSupportTelefoon = regel.toon;
export const SUPPORT_TEL_PLACEHOLDER = regel.PLACEHOLDER;
export const SUPPORT_TEL_MELDING_LEEG = regel.MELDING_LEEG;
export const SUPPORT_TEL_MELDING_FOUT = regel.MELDING_FOUT;
