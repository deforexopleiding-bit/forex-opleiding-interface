// api/_lib/leadsonderhoud-sjabloon.js
//
// Eén plek die een sjabloon + een lead krijgt en de ingevulde inhoud teruggeeft,
// voor beide kanalen. Mail werkt met {voornaam}, WhatsApp met {{1}} — dezelfde
// bewerking, alleen een ander formaat. Zo hoef je niet in de code te zoeken
// welke variabele op welke plek hoort.

// app_settings.value is een jsonb-kolom. Via supabase-js komt een jsonb-string
// meestal al als gewone JS-string binnen, maar we normaliseren defensief: niet-
// strings naar string, en één laag omringende JSON-quotes eraf. Zo belandt een
// URL nooit mét aanhalingstekens in de HTML (waardoor het logo niet zou laden).
export function instelWaarde(row) {
  let v = row && row.value;
  if (v == null) return '';
  if (typeof v !== 'string') v = String(v);
  const m = v.match(/^"([\s\S]*)"$/);
  return m ? m[1] : v;
}

// Alle variabelen die een sjabloon kan gebruiken, afgeleid uit de lead/wachtrij-
// rij plus wat de motor aanreikt (inloglink, gespreksdatum/-tijd).
export function bouwVariabelen(lead, extra = {}) {
  const l = lead || {};
  return {
    voornaam:   l.voornaam || '',
    dagen_over: l.dagen_over != null ? String(l.dagen_over) : '',
    dag:        l.dag != null ? String(l.dag) : '',
    lessen:     l.lessen_gezien != null ? String(l.lessen_gezien)
              : (l.lessen != null ? String(l.lessen) : ''),
    trades:     l.trades != null ? String(l.trades) : '',
    score:      l.score != null ? String(l.score) : '',
    agendalink: extra.agendalink || l.agenda_link || '',
    inloglink:  extra.inloglink || '',
    datum:      extra.datum || l.gesprek_datum || '',
    // tijd: eerst uit extra (motor-side lookup), anders uit de view-kolom
    // gesprek_tijd (of legacy 'tijd'). Zo hoeft de motor geen aparte
    // follow_up_appointments-fetch te doen als de view die info al levert.
    tijd:       extra.tijd || l.gesprek_tijd || l.tijd || '',
    logo:       extra.logo || '',   // logo-URL uit de instelling, niet hardgecodeerd
    ...extra,
  };
}

// Vervang {naam}-tokens (mail). Onbekende tokens laten we staan, zodat een fout
// in een sjabloon zichtbaar blijft in plaats van stilletjes te verdwijnen.
function vulNamen(tekst, vars) {
  return String(tekst || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

// Resolve een mapping-key naar een waarde. 'lead.<kolom>' leest rechtstreeks uit
// de wachtrij-rij (de bron waar de motor mee werkt); elke andere key valt terug
// op de bouwVariabelen-namen (legacy 'voornaam','lessen','tijd',...).
function keyWaarde(key, lead, vars) {
  const m = /^lead\.(\w+)$/.exec(String(key || ''));
  if (m) {
    const v = (lead || {})[m[1]];
    return v == null ? '' : String(v);
  }
  return vars[key] != null ? String(vars[key]) : '';
}

/**
 * Vul een sjabloon in voor deze lead.
 *   Mail     -> { kanaal:'mail', onderwerp, html, tekst }   (alle {naam} ingevuld)
 *   WhatsApp -> { kanaal:'whatsapp', meta_template, variabelen, namen }
 *
 * WhatsApp — positional-volgorde, ÉÉN bron van waarheid:
 *   1) metaMapping = meta_param_mapping.body van het goedgekeurde Meta-template
 *      (bv. { "1":"lead.voornaam", "2":"lead.gesprek_tijd" }). Dit is exact de
 *      body-volgorde die Meta heeft vastgelegd, dus manager en motor kunnen niet
 *      driften. De waarden komen rechtstreeks uit de wachtrij-rij.
 *   2) Ontbreekt die (bootstrap/legacy): terugval op variabele_volgorde.
 * `namen` bevat de gebruikte keys in volgorde (voor diagnostiek bij lege params).
 */
export function vulSjabloon(sjabloon, lead, extra = {}, metaMapping = null) {
  const vars = bouwVariabelen(lead, extra);
  if (sjabloon.kanaal === 'whatsapp') {
    const posities = metaMapping && typeof metaMapping === 'object'
      ? Object.keys(metaMapping).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b))
      : [];
    let namen;
    let variabelen;
    if (posities.length) {
      namen = posities.map((p) => metaMapping[p]);
      variabelen = namen.map((key) => keyWaarde(key, lead, vars));
    } else {
      namen = Array.isArray(sjabloon.variabele_volgorde) ? sjabloon.variabele_volgorde : [];
      variabelen = namen.map((naam) => (vars[naam] != null ? String(vars[naam]) : ''));
    }
    return {
      kanaal: 'whatsapp',
      meta_template: sjabloon.meta_template || sjabloon.soort,
      variabelen,
      namen,
    };
  }
  return {
    kanaal: 'mail',
    onderwerp: vulNamen(sjabloon.onderwerp, vars),
    html: sjabloon.html ? vulNamen(sjabloon.html, vars) : null,
    tekst: vulNamen(sjabloon.tekst, vars),
  };
}
