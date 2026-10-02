// api/_lib/opvolging-brug-ververs.js
//
// De WhatsApp-brug vragen zijn leadlijst NU te verversen.
//
// De brug haalt de lijst met toegestane nummers elke vijf minuten op. Een kaart
// die net gemaakt is staat er dus nog niet op, en dan weigert de brug het
// versturen (NIET_TOEGESTAAN). De route POST /leadlijst/ververs op de brug laat
// hem meteen opnieuw ophalen. Die route bestaat pas nadat de brug op de VPS
// bijgewerkt is; tot dan geeft hij 404 — en dat is hier geen fout.
//
// FAIL-SOFT, ALTIJD. Het verversen is een dienst; de kaart of het bericht is de
// hoofdzaak. Geeft { ok, aantal?, reden? } terug, gooit nooit.

import { brugFetch } from './whatsapp-brug-client.js';

export async function brugLeadlijstVerversen() {
  try {
    const data = await brugFetch('/leadlijst/ververs', { method: 'POST', body: {}, timeoutMs: 5000 });
    return { ok: true, aantal: data && typeof data.aantal === 'number' ? data.aantal : null };
  } catch (e) {
    const reden = e?.code === 'BRUG_FOUT' && e.status === 404 ? 'route_ontbreekt' : (e?.code || 'fout');
    if (reden !== 'route_ontbreekt' && reden !== 'GEEN_CONFIG') {
      console.warn('[opvolging-brug-ververs] (soft):', reden, e?.message || e);
    }
    return { ok: false, reden };
  }
}
