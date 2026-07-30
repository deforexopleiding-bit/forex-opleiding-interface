// api/_lib/leadsonderhoud-sjabloon.js
//
// Eén plek die een sjabloon + een lead krijgt en de ingevulde inhoud teruggeeft,
// voor beide kanalen. Mail werkt met {voornaam}, WhatsApp met {{1}} — dezelfde
// bewerking, alleen een ander formaat. Zo hoef je niet in de code te zoeken
// welke variabele op welke plek hoort.

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
    datum:      extra.datum || '',
    tijd:       extra.tijd || '',
    logo:       extra.logo || '',   // logo-URL uit de instelling, niet hardgecodeerd
    ...extra,
  };
}

// Vervang {naam}-tokens (mail). Onbekende tokens laten we staan, zodat een fout
// in een sjabloon zichtbaar blijft in plaats van stilletjes te verdwijnen.
function vulNamen(tekst, vars) {
  return String(tekst || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

/**
 * Vul een sjabloon in voor deze lead.
 *   Mail     -> { kanaal:'mail', onderwerp, html, tekst }   (alle {naam} ingevuld)
 *   WhatsApp -> { kanaal:'whatsapp', meta_template, variabelen }
 *               (variabelen in de volgorde van variabele_volgorde, voor sendTemplate)
 */
export function vulSjabloon(sjabloon, lead, extra = {}) {
  const vars = bouwVariabelen(lead, extra);
  if (sjabloon.kanaal === 'whatsapp') {
    const volgorde = Array.isArray(sjabloon.variabele_volgorde) ? sjabloon.variabele_volgorde : [];
    return {
      kanaal: 'whatsapp',
      meta_template: sjabloon.meta_template || sjabloon.soort,
      variabelen: volgorde.map((naam) => (vars[naam] != null ? String(vars[naam]) : '')),
    };
  }
  return {
    kanaal: 'mail',
    onderwerp: vulNamen(sjabloon.onderwerp, vars),
    html: sjabloon.html ? vulNamen(sjabloon.html, vars) : null,
    tekst: vulNamen(sjabloon.tekst, vars),
  };
}
