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
import { bouwUitgaandeGebeurtenis, bouwAckGebeurtenis, bouwHistoriekBericht, isGroep } from './gebeurtenis.js';
import { maakTellers } from './tellers.js';

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

  // Meten zonder te kijken. Zie lib/tellers.js: alleen aantallen, nooit een
  // nummer en nooit tekst. Dit bestaat omdat een bericht stil gedropt is tussen
  // raakAan() en webhook.duw(), en het privacyfilter maakt dat gat per
  // definitie — wat we niet mogen loggen, kunnen we ook niet terugvinden.
  const tellers = maakTellers();

  const raakAan = () => { staat.laatsteActie = new Date().toISOString(); };

  /**
   * Tellen én, als BRUG_DEBUG aanstaat, één regel loggen.
   *
   * De logregel draagt alleen het event-type en de reden — twee woorden uit een
   * vaste lijst. Geen nummer, geen tekst, geen bericht-id. Dat is de hele reden
   * dat hij mag bestaan: hij vertelt dát er iets afviel en waarom, en verder
   * niets. Standaard uit, want op een drukke dag is dit ruis.
   */
  function negeer(type, reden) {
    tellers.negeer(type, reden);
    if (process.env.BRUG_DEBUG === '1') console.debug('[brug] genegeerd:', type, reden);
  }

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
    tellers.zag('message');
    try {
      const van = msg.from;
      // FILTER EERST. Alles hieronder raakt de tekst aan.
      if (!leadlijst.mag(van)) { negeer('message', 'niet_op_leadlijst'); return; }
      if (isGroep(van)) { negeer('message', 'groep'); return; }
      tellers.liet('message');
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
    tellers.zag('message_create');
    try {
      // Eerst 'is dit van ons'. Dat leest één boolean van de envelop — geen
      // nummer, geen tekst, en er wordt niets van gekopieerd, gelogd of
      // verstuurd. Het moet vóór het filter, want message_create vuurt óók
      // voor binnengekomen berichten, en daar is `to` óns eigen nummer: die
      // zouden anders allemaal als 'niet_op_leadlijst' geteld worden en het
      // beeld vertroebelen precies waar we naar kijken.
      if (msg?.fromMe !== true) { negeer('message_create', 'niet_van_ons'); return; }
      // FILTER, en pas hierna wordt het nummer of de tekst ergens voor gebruikt.
      if (!leadlijst.mag(msg?.to)) { negeer('message_create', 'niet_op_leadlijst'); return; }
      if (isGroep(msg?.to)) { negeer('message_create', 'groep'); return; }
      const g = bouwUitgaandeGebeurtenis(msg);
      if (!g) { negeer('message_create', 'onbruikbaar'); return; }
      tellers.liet('message_create');
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
    tellers.zag('message_ack');
    // Alleen het getal. Zien we uitsluitend 0'en, dan weten we meteen waarom er
    // niets doorkomt zonder ook maar één bericht te hoeven bekijken.
    tellers.ack(ack);
    try {
      const jid = msg?.to || msg?.from;
      if (!leadlijst.mag(jid)) { negeer('message_ack', 'niet_op_leadlijst'); return; }
      if (isGroep(jid)) { negeer('message_ack', 'groep'); return; }
      const g = bouwAckGebeurtenis(msg, ack);
      // ACK_SOORT kent -1 en 0 niet: dat zijn statussen die nog niets zeggen.
      if (!g) { negeer('message_ack', 'geen_ack_soort'); return; }
      tellers.liet('message_ack');
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
    /** De tellers voor /status. Alleen aantallen; zie lib/tellers.js. */
    tellers: () => tellers.status(),
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

    /**
     * De geschiedenis van één gesprek, zoals WhatsApp die naar dit apparaat
     * gesynct heeft.
     *
     * DE BRUG SCHRIJFT NIETS. Ze geeft terug; het CRM beslist wat het bewaart.
     * Zo blijft er één plek waar rijen ontstaan, en die is idempotent op
     * bericht_id.
     *
     * Het filter blijft ook hier de eerste regel: staat het nummer niet op de
     * leadlijst, dan gaat er niets naar de chatstore en komt er niets terug.
     * Er wordt in dat geval ook niets gelogd — of een nummer wel of niet bekend
     * is, is zelf ook informatie.
     *
     * WAT ER TERUGKOMT IS NIET NOODZAKELIJK ALLES. Een gekoppeld apparaat
     * krijgt een beperkt venster van de telefoon gesynct, en fetchMessages
     * haalt alleen ouder werk op zolang de store het aanlevert. Wat Dave op
     * zijn toestel ziet kan dus méér zijn. Daarom geven we `oudste` mee: het
     * CRM kan dan zeggen tot wanneer het gekeken heeft in plaats van te doen
     * alsof dit het volledige gesprek is.
     */
    async historiek(nummer, limiet = 50) {
      if (!staat.verbonden) { const e = new Error('niet verbonden met WhatsApp'); e.code = 'NIET_VERBONDEN'; throw e; }
      if (!leadlijst.mag(nummer)) { const e = new Error('nummer staat niet op de leadlijst'); e.code = 'NIET_TOEGESTAAN'; throw e; }
      const chatId = naarChatId(nummer);
      if (!chatId) { const e = new Error('nummer mist een landcode'); e.code = 'NUMMER_ONGELDIG'; throw e; }

      const n = Math.max(1, Math.min(200, Number(limiet) || 50));
      let chat;
      try {
        chat = await client.getChatById(chatId);
      } catch (e) {
        // Onbekende chat: ChatFactory struikelt over undefined. Dat is geen
        // storing maar 'dit gesprek staat niet op dit apparaat'.
        const err = new Error('geen gesprek gevonden op dit apparaat');
        err.code = 'GEEN_GESPREK';
        throw err;
      }
      if (!chat) { const e = new Error('geen gesprek gevonden op dit apparaat'); e.code = 'GEEN_GESPREK'; throw e; }
      if (chat.isGroup) { const e = new Error('groepen niet'); e.code = 'NIET_TOEGESTAAN'; throw e; }

      const msgs = await chat.fetchMessages({ limit: n });
      raakAan();
      const berichten = (msgs || [])
        .map((m) => bouwHistoriekBericht(m))
        .filter(Boolean)
        .sort((a, b) => (a.tijdstip < b.tijdstip ? -1 : 1));

      return {
        berichten,
        aantal : berichten.length,
        oudste : berichten.length ? berichten[0].tijdstip : null,
        nieuwste: berichten.length ? berichten[berichten.length - 1].tijdstip : null,
        // Kwam de lijst tot aan de grens, dan is er waarschijnlijk méér. Dat is
        // iets anders dan 'dit is alles'.
        mogelijk_meer: berichten.length >= n,
      };
    },
  };
}
