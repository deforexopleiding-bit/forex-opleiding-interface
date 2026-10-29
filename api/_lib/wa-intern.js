// api/_lib/wa-intern.js
//
// Interne WhatsApp-nummers (2026-10-29) — vangnet tegen nurture naar ons eigen
// nummer. Jeffrey's meldingsnummer zat als lead in de opvolgflows en kreeg daar
// marketingtemplates. Meta begrenst marketingberichten PER ONTVANGER; toen die
// grens op dat nummer bereikt was, hield Meta ook de lead-melding tegen (die stond
// op MARKETING). Nu: naar een intern nummer gaan alleen nog INTERNE templates
// (meldingen aan het team). Elk ander template wordt hier geweigerd, nog vóór Meta.
//
// Interne nummers: het meldingsnummer (+31 6 55270212, of env LEAD_MELDING_NUMMER)
// plus env INTERNE_WA_NUMMERS (komma-gescheiden). Interne templates: de vaste set
// hieronder plus env INTERNE_WA_TEMPLATES (komma-gescheiden), bv. als het
// dagrapport-template een andere naam krijgt.
// PURE (alleen env lezen); gebruikt door sendTemplate in meta-whatsapp.js.

export const STANDAARD_INTERN_NUMMER = '+31655270212';

export const INTERNE_TEMPLATES = Object.freeze([
  'interne_nieuwe_lead_nl',      // lead-melding (UTILITY)
  'nieuwe_lead',                 // oude lead-melding (terugval tot het nieuwe template goedgekeurd is)
  'interne_nieuwe_afspraak_nl',  // afspraak-melding
  'dfo_dagrapport',              // dagrapport
]);

const lijst = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const laatste9 = (tel) => String(tel || '').replace(/\D/g, '').slice(-9);

/** Laatste 9 cijfers van alle interne nummers. */
export function interneNummers(env = process.env) {
  const alle = [STANDAARD_INTERN_NUMMER, env.LEAD_MELDING_NUMMER, ...lijst(env.INTERNE_WA_NUMMERS)];
  return new Set(alle.map(laatste9).filter((x) => x.length === 9));
}

export function isInternNummer(tel, env = process.env) {
  const l9 = laatste9(tel);
  return l9.length === 9 && interneNummers(env).has(l9);
}

/** Mag dit template naar dit nummer? -> { ok:true } | { ok:false, reden } */
export function magTemplateNaar(tel, templateName, env = process.env) {
  if (!isInternNummer(tel, env)) return { ok: true };
  const toegestaan = new Set([...INTERNE_TEMPLATES, ...lijst(env.INTERNE_WA_TEMPLATES)]);
  if (toegestaan.has(String(templateName || ''))) return { ok: true };
  return { ok: false, reden: `intern nummer krijgt alleen interne meldingen (template '${templateName}' overgeslagen)` };
}

export class WaInternNummerError extends Error {
  constructor(reden) {
    super(`WhatsApp niet verstuurd: ${reden}`);
    this.name = 'WaInternNummerError';
    this.code = 'WA_INTERN_NUMMER';
  }
}
