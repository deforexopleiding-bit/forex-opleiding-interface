// services/whatsapp-brug/lib/leadlijst.js
//
// De lijst met bekende leadnummers, elke vijf minuten opgehaald bij het CRM.
// Dit is de bron van het privacyfilter: staat een nummer hier niet in, dan
// bestaat dat gesprek voor deze service niet.
//
// Bij een mislukte ophaal blijft de vórige lijst staan — een storing bij het
// CRM mag geen leads laten wegvallen. Is er nog nooit een lijst binnengekomen,
// dan is de lijst leeg en laat het filter dus niets door. Dat is de goede kant
// om fout te gaan: liever een uur niets dan één privégesprek.

import { bouwToegestaan, isToegestaan } from './nummers.js';

export function maakLeadlijst(cfg) {
  let toegestaan = bouwToegestaan([]);
  let laatsteOphaal = null;
  let laatsteFout = null;
  let timer = null;

  async function ververs() {
    const url = cfg.crmBase + cfg.nummersPad;
    try {
      const res = await fetch(url, {
        method : 'GET',
        headers: { 'X-Brug-Secret': cfg.secret, Accept: 'application/json' },
        signal : AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error('CRM antwoordde ' + res.status);
      const data = await res.json();
      const nummers = Array.isArray(data?.nummers) ? data.nummers : null;
      if (!nummers) throw new Error('antwoord zonder nummers-lijst');
      toegestaan = bouwToegestaan(nummers);
      laatsteOphaal = new Date().toISOString();
      laatsteFout = null;
      // Alleen het aantal loggen, nooit de nummers zelf.
      console.log('[brug] leadlijst ververst:', toegestaan.aantal, 'nummers');
    } catch (e) {
      laatsteFout = e?.message || String(e);
      console.warn('[brug] leadlijst ophalen faalde (vorige lijst blijft staan):', laatsteFout);
    }
  }

  return {
    start() {
      ververs();
      timer = setInterval(ververs, cfg.nummersIntervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    ververs,
    /** Het privacyfilter. Standaard nee. */
    mag(nummer) { return isToegestaan(nummer, toegestaan); },
    status() {
      return { aantal: toegestaan.aantal, laatste_ophaal: laatsteOphaal, laatste_fout: laatsteFout };
    },
  };
}
