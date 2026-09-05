// services/whatsapp-brug/lib/whatsapp.js
//
// De WhatsApp-client zelf: whatsapp-web.js met LocalAuth, zodat de ingelogde
// sessie op schijf blijft staan en een herstart geen nieuwe QR vraagt.
//
// HET PRIVACYFILTER ZIT HIER, ZO VROEG MOGELIJK
// Elke binnenkomende gebeurtenis wordt eerst tegen de leadlijst gehouden. Valt
// het nummer daarbuiten, dan keren we meteen terug: niet doorsturen, niet
// loggen, niets onthouden. Daves privécontacten lopen over dezelfde telefoon,
// en die mogen deze service niet verlaten. Er is bewust geen enkele plek waar
// een tekst langskomt vóór die controle.

import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode';
import { normaliseerNummer, naarChatId } from './nummers.js';
// De vorm van elke gebeurtenis staat apart en dependency-vrij, zodat hij te
// testen is zonder puppeteer of een gekoppelde telefoon.
import { bouwUitgaandeGebeurtenis, bouwAckGebeurtenis } from './gebeurtenis.js';

const { Client, LocalAuth } = pkg;

export function maakWhatsapp({ cfg, leadlijst, webhook }) {
  const staat = {
    // Deze brug ziet uitgaande berichten (message_create) én hun type. Het CRM
    // leest dit uit /status om te weten of het spraakberichten-blok echte
    // cijfers kan tonen of moet zeggen dat er nog niets gemeten wordt. Een
    // oudere brug op de VPS stuurt deze vlag niet mee, en dan blijft dat blok
    // leeg in plaats van nul te tonen alsof het gemeten is.
    ziet_uitgaand: true,
    verbonden   : false,
    nummer      : null,
    laatsteActie: null,      // wanneer zag ze voor het laatst iets
    qrDataUrl   : null,      // alleen gevuld zolang er nog niet gekoppeld is
    qrSindsIso  : null,
    laatsteFout : null,
  };

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: cfg.sessiePad }),
    puppeteer: {
      headless: true,
      ...(cfg.chromiumPad ? { executablePath: cfg.chromiumPad } : {}),
      // Zonder deze twee valt Chromium op een kale VPS om: geen sandbox-
      // rechten in een container, en /dev/shm is er standaard te klein.
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
      ],
    },
  });

  const raakAan = () => { staat.laatsteActie = new Date().toISOString(); };

  client.on('qr', async (qr) => {
    try {
      staat.qrDataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 320 });
      staat.qrSindsIso = new Date().toISOString();
      console.log('[brug] nieuwe QR beschikbaar — koppel via het CRM-scherm');
    } catch (e) {
      staat.laatsteFout = 'QR renderen faalde: ' + (e?.message || e);
      console.warn('[brug]', staat.laatsteFout);
    }
  });

  client.on('ready', () => {
    staat.verbonden = true;
    staat.qrDataUrl = null;      // gekoppeld; de QR is nergens meer goed voor
    staat.qrSindsIso = null;
    staat.laatsteFout = null;
    staat.nummer = normaliseerNummer(client.info?.wid?.user || client.info?.me?.user || '');
    raakAan();
    console.log('[brug] verbonden als', staat.nummer || '(nummer onbekend)');
  });

  client.on('authenticated', () => { staat.laatsteFout = null; raakAan(); });
  client.on('auth_failure', (m) => {
    staat.verbonden = false;
    staat.laatsteFout = 'authenticatie mislukt: ' + m;
    console.error('[brug] authenticatie mislukt — sessie mogelijk verlopen, scan opnieuw');
  });
  client.on('disconnected', (reden) => {
    staat.verbonden = false;
    staat.laatsteFout = 'verbinding verbroken: ' + reden;
    console.warn('[brug] verbinding verbroken:', reden);
  });

  // ── Binnenkomend antwoord ────────────────────────────────────────────────
  client.on('message', async (msg) => {
    raakAan();
    try {
      const van = msg.from;
      // FILTER EERST. Alles hieronder raakt de tekst aan.
      if (!leadlijst.mag(van)) return;
      await webhook.duw({
        soort    : 'antwoord_ontvangen',
        nummer   : normaliseerNummer(van),
        tijdstip : new Date((msg.timestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
        tekst    : typeof msg.body === 'string' ? msg.body.slice(0, 4000) : '',
        // Een ingesproken bericht telt in de opvolging als spraakbericht, niet
        // als WhatsApp-tekst — dat is een ander soort moeite.
        media_type: msg.type || null,
        bericht_id: msg.id?._serialized || null,
      });
    } catch (e) {
      console.warn('[brug] inkomend bericht verwerken faalde:', e?.message || e);
    }
  });

  // ── Uitgaand: wat Dave zélf stuurt ───────────────────────────────────────
  // Het 'message'-event hierboven ziet dit NIET. whatsapp-web.js doet in
  // Client.js `if (msg.id.fromMe) return;` vlak voor het emit — eigen berichten
  // worden daar bewust overgeslagen. Alleen 'message_create' krijgt ze, en dat
  // geldt ook voor berichten die Dave vanaf zijn eigen telefoon stuurt: de hook
  // hangt aan de berichtenstore van het gekoppelde apparaat, en die synct mee.
  //
  // Dit is het enige pad waarlangs een spraakbericht dat hij zelf inspreekt
  // meetbaar wordt. Zonder deze handler is 'heeft deze lead vanmorgen een
  // spraakbericht gehad?' een vraag die het systeem niet kan beantwoorden.
  //
  // Let op het tijdstip: we nemen msg.timestamp, het moment van versturen. De
  // ack-events hieronder weten dat niet — die stempelen het moment waarop de
  // ontvangstbevestiging binnenkomt, en dat kan uren later zijn. Voor een
  // deadline van 09:00 is dat verschil het hele verhaal.
  client.on('message_create', async (msg) => {
    raakAan();
    try {
      // FILTER EERST, net als bij inkomend: het nummer waar dit heen gaat moet
      // op de leadlijst staan. Groepen vallen daar ook al op af.
      if (!leadlijst.mag(msg?.to)) return;
      const g = bouwUitgaandeGebeurtenis(msg);
      if (!g) return;                        // niet van ons, groep, of onbruikbaar
      await webhook.duw({
        soort     : g.soort,
        nummer    : normaliseerNummer(g.jid),
        tijdstip  : g.tijdstip,
        // De tekst gaat mee zodat het gesprek in het CRM van twee kanten te
        // lezen is. Dit staat NA leadlijst.mag() hierboven — dat is de grens,
        // en die blijft de eerste regel.
        tekst     : g.tekst,
        media_type: g.media_type,            // 'ptt' of 'audio' = spraakbericht
        bericht_id: g.bericht_id,
      });
    } catch (e) {
      console.warn('[brug] uitgaand bericht verwerken faalde:', e?.message || e);
    }
  });

  // ── Statusveranderingen op wat wij verstuurden ───────────────────────────
  client.on('message_ack', async (msg, ack) => {
    raakAan();
    try {
      if (!leadlijst.mag(msg?.to || msg?.from)) return;
      const g = bouwAckGebeurtenis(msg, ack);
      if (!g) return;
      await webhook.duw({
        soort     : g.soort,
        nummer    : normaliseerNummer(g.jid),
        // Het moment van de bevestiging, niet van het bericht.
        tijdstip  : g.tijdstip,
        media_type: g.media_type,
        bericht_id: g.bericht_id,
      });
    } catch (e) {
      console.warn('[brug] ack verwerken faalde:', e?.message || e);
    }
  });

  return {
    staat,
    start() {
      console.log('[brug] WhatsApp-client starten…');
      client.initialize().catch((e) => {
        staat.laatsteFout = 'starten faalde: ' + (e?.message || e);
        console.error('[brug]', staat.laatsteFout);
      });
    },
    async stop() { try { await client.destroy(); } catch (_) {} },

    /**
     * Versturen. Ook hier geldt het filter: een nummer dat niet op de leadlijst
     * staat krijgt niets van ons, ook niet als het CRM erom vraagt.
     */
    async stuur(nummer, tekst) {
      if (!staat.verbonden) { const e = new Error('niet verbonden met WhatsApp'); e.code = 'NIET_VERBONDEN'; throw e; }
      if (!leadlijst.mag(nummer)) { const e = new Error('nummer staat niet op de leadlijst'); e.code = 'NIET_TOEGESTAAN'; throw e; }
      const chatId = naarChatId(nummer);
      if (!chatId) { const e = new Error('nummer mist een landcode'); e.code = 'NUMMER_ONGELDIG'; throw e; }
      const res = await client.sendMessage(chatId, String(tekst));
      raakAan();
      return { bericht_id: res?.id?._serialized || null };
    },
  };
}
