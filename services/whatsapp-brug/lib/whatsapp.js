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

const { Client, LocalAuth } = pkg;

// De ack-codes van whatsapp-web.js naar iets leesbaars. -1 (fout) en 0 (nog
// bezig) leveren geen gebeurtenis op: daar valt in de opvolging niets mee.
const ACK_SOORT = { 1: 'verzonden', 2: 'afgeleverd', 3: 'gelezen', 4: 'gelezen' };

export function maakWhatsapp({ cfg, leadlijst, webhook }) {
  const staat = {
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

  // ── Statusveranderingen op wat wij verstuurden ───────────────────────────
  client.on('message_ack', async (msg, ack) => {
    raakAan();
    try {
      const soort = ACK_SOORT[ack];
      if (!soort) return;
      const naar = msg.to || msg.from;
      if (!leadlijst.mag(naar)) return;
      await webhook.duw({
        soort,
        nummer    : normaliseerNummer(naar),
        tijdstip  : new Date().toISOString(),
        bericht_id: msg.id?._serialized || null,
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
