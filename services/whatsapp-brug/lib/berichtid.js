// services/whatsapp-brug/lib/berichtid.js
//
// HET ID VAN EEN BERICHT — EN WAAROM DAT ER NIET WAS.
//
// De ontdubbeling in het CRM hangt aan `bericht_id`. Die stond in productie
// overal op NULL, bij alle berichten, en daardoor heeft de hele ontdubbeling er
// wel gestaan maar nog nooit gewerkt: message_create en de ack maakten allebei
// hun eigen poging-rij, terwijl ze juist een sleutel hoorden te delen. Vandaar
// 'verstuurd' om 11.29.56 én om 11.29.57.
//
// WAT DE BRON VAN 1.34.7 ZEGT (gelezen, niet geraden)
// Het object dat van de browser naar Node oversteekt is
// `WWebJS.getMessageModel(msg)` = `msg.serialize()`. Dat gaat via puppeteer
// door JSON heen, en JSON neemt alleen EIGEN, opsombare eigenschappen mee.
// `_serialized` op WhatsApp's MsgKey is een getter op het prototype, en die
// overleeft die oversteek dus niet — precies zoals `window.Store` en `getChats`
// eerder al bleken te verdwijnen bij deze combinatie.
//
// Wat wél oversteekt zijn de eigen velden van de sleutel: `fromMe`, `remote` en
// `id`. De bibliotheek normaliseert `remote` zelfs expliciet (Utils.js r831),
// wat bevestigt dat `msg.id` als gewoon object aankomt.
//
// DIT IS GEEN VERVANGENDE SLEUTEL UIT TIJDSTIP PLUS NUMMER. `id.id` ís het
// bericht-id dat WhatsApp zelf heeft toegekend; we zetten hem alleen terug in
// het formaat dat de bibliotheek er zelf van maakt (`fromMe_remote_id`). Kan
// dat niet, dan is het antwoord null en geen bijna-sleutel — die zou later stil
// verkeerd ontdubbelen, en dat is erger dan niet ontdubbelen.
//
// EN HET BLIJFT EEN METING. De volgorde hieronder is een hypothese uit de bron;
// welk pad het op de VPS daadwerkelijk doet, staat in /status als
// `bericht_id_vormen` — alleen het padnaam en de lengte, nooit de waarde. In
// zo'n id zit het nummer van de tegenpartij verwerkt.

/** De paden die we proberen, in volgorde. Naam → functie. */
export const PADEN = [
  ['id._serialized', (m) => (typeof m?.id?._serialized === 'string' ? m.id._serialized : null)],
  ['id.triple',      (m) => tripleVan(m?.id)],
  ['id.string',      (m) => (typeof m?.id === 'string' && m.id ? m.id : null)],
  ['data.id._serialized', (m) => (typeof m?._data?.id?._serialized === 'string' ? m._data.id._serialized : null)],
  ['data.id.triple', (m) => tripleVan(m?._data?.id)],
];

/**
 * De sleutel zoals whatsapp-web.js hem zelf schrijft: `fromMe_remote_id`.
 *
 * `remote` kan een Wid-object zijn of al een string; allebei komen voor,
 * afhankelijk van waar het bericht vandaan komt.
 */
function tripleVan(sleutel) {
  if (!sleutel || typeof sleutel !== 'object') return null;
  const id = typeof sleutel.id === 'string' ? sleutel.id : null;
  if (!id) return null;
  const remote = typeof sleutel.remote === 'string'
    ? sleutel.remote
    : (typeof sleutel.remote?._serialized === 'string' ? sleutel.remote._serialized : null);
  if (!remote) return null;
  const fromMe = sleutel.fromMe === true ? 'true' : 'false';
  return fromMe + '_' + remote + '_' + id;
}

/**
 * Het bericht-id, plus langs welk pad het gevonden is.
 *
 * → { id, pad } of { id: null, pad: 'geen' }
 *
 * De aanroeper gebruikt `id` en geeft `pad` aan de tellers. Nooit andersom.
 */
export function berichtIdVan(msg) {
  for (const [naam, haal] of PADEN) {
    let waarde = null;
    try { waarde = haal(msg); } catch (_) { waarde = null; }
    if (typeof waarde === 'string' && waarde.length > 0) return { id: waarde, pad: naam };
  }
  return { id: null, pad: 'geen' };
}

/**
 * De VORM van de uitkomst, voor /status: pad plus lengte.
 *
 * Nooit de waarde. In een bericht-id zit het nummer van de tegenpartij
 * verwerkt, en een teller is geen plek voor gegevens van iemand.
 */
export function berichtIdVorm({ id, pad }) {
  return pad + '/' + (typeof id === 'string' ? id.length : 0);
}
