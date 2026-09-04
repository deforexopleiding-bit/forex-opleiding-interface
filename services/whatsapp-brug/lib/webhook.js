// services/whatsapp-brug/lib/webhook.js
//
// Gebeurtenissen naar het CRM duwen. Eén poging plus twee herkansingen met
// oplopende wachttijd; daarna geven we het op en blijft er een regel in de log
// achter. Dit is telemetrie, geen betaling: een gemiste levering mag de brug
// niet laten vastlopen of berichten laten opstapelen.

const POGINGEN = 3;

export function maakWebhook(cfg) {
  let verstuurd = 0;
  let mislukt = 0;
  let laatste = null;

  async function duw(gebeurtenis) {
    const url = cfg.crmBase + cfg.webhookPad;
    for (let poging = 1; poging <= POGINGEN; poging++) {
      try {
        const res = await fetch(url, {
          method : 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Brug-Secret': cfg.secret },
          body   : JSON.stringify(gebeurtenis),
          signal : AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new Error('CRM antwoordde ' + res.status);
        verstuurd += 1;
        laatste = new Date().toISOString();
        return true;
      } catch (e) {
        if (poging === POGINGEN) {
          mislukt += 1;
          // Het soort en het tijdstip loggen, NOOIT de tekst van het bericht.
          console.warn('[brug] webhook opgegeven na', POGINGEN, 'pogingen —',
            gebeurtenis?.soort, gebeurtenis?.tijdstip, ':', e?.message || e);
          return false;
        }
        await new Promise((r) => setTimeout(r, poging * 2000));
      }
    }
    return false;
  }

  return { duw, status: () => ({ verstuurd, mislukt, laatste }) };
}
