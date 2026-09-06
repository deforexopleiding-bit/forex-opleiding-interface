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
import { bouwUitgaandeGebeurtenis, bouwAckGebeurtenis, bouwHistoriekBericht, isGroep, isEchtGesprek } from './gebeurtenis.js';
import { maakTellers, jidVorm } from './tellers.js';
import { maakLidkaart } from './lidkaart.js';
import { maakLandcodeZoeker, isLokaalGenoteerd, NIET_MEETBAAR } from './landcode.js';
import { berichtIdVan, berichtIdVorm } from './berichtid.js';
import { probeer, leegPerStatus, GELUKT, ONBRUIKBAAR, BESTAAT_NIET, FOUT } from './uitkomst.js';
import { createRequire } from 'node:module';

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
  function negeer(type, reden, jid) {
    tellers.negeer(type, reden, jid);
    if (process.env.BRUG_DEBUG === '1') {
      // Alleen het type, de reden en de VORM van de identiteit — een domein en
      // een lengte. Nooit de jid zelf.
      console.debug('[brug] genegeerd:', type, reden, jidVorm(jid));
    }
  }

  // ── Wie is de tegenpartij? ────────────────────────────────────────────────
  // WhatsApp levert de tegenpartij niet altijd als telefoonnummer aan. In
  // sommige chats staat er een LID: 'iets@lid' met een getal dat niets met een
  // telefoonnummer te maken heeft. normaliseerNummer strijkt daar de cijfers
  // van af, en die staan uiteraard nergens op de leadlijst — dus viel alles
  // stil weg onder 'niet_op_leadlijst' terwijl het event, fromMe en de
  // aflevering alle drie klopten.
  //
  // Je kunt niet filteren op een nummer dat je niet kent. Vandaar dat de
  // identiteit hier wordt opgelost VOORDAT het filter draait.
  //
  // WAAROM DAT DE GRENS NIET VERPLAATST: dit leest de envelop, niet de inhoud —
  // dezelfde categorie als de fromMe-boolean. Er wordt niets gelogd, niets
  // onthouden en niets doorgestuurd voor wie niet op de lijst staat; het filter
  // staat nog altijd vóór elk gebruik van nummer of tekst. Het enige verschil
  // is dat het filter nu de juiste vraag krijgt.
  //
  // De nummerkaart onthoudt welke jid bij welk nummer hoort, zodat versturen en
  // historiek-ophalen dezelfde chat vinden. Alleen in geheugen: na een herstart
  // is hij leeg en vult hij zich vanzelf weer bij het eerste bericht.
  const nummerkaart = new Map();

  // ── De LID-kaart, opgebouwd uit de leadlijst ──────────────────────────────
  // Zie lib/lidkaart.js. Kort: we vragen per BEKEND nummer welke identiteit
  // WhatsApp eraan hangt, in plaats van per binnenkomend bericht te vragen wie
  // de afzender is. Dat laatste vroeg ook iets op over mensen die géén lead
  // zijn; deze kant op wordt er niets gevraagd over wie niet op de lijst staat.
  const lidkaart = maakLidkaart();
  let lidTimer = null;
  // Welke van de twee wegen de koppelingen opleverde, en wat de scan zag.
  // Alleen een woord en aantallen.
  let kaartBron = null;
  let laatsteScan = null;
  // De sleutelnamen en domeinen die we op het laatste ruwe bericht zagen. Namen
  // en achtervoegsels — protocolnamen, geen persoonsgegevens.
  let laatsteBerichtvormen = null;
  // Welke vorm het gesprek opleverde bij het ophalen van historiek. Alleen
  // aantallen per vorm, zodat zichtbaar blijft dat de @c.us-weg nog werkt voor
  // de leads zonder LID.
  const historiekVormen = {};

  // ── Welke bibliotheek draait hier eigenlijk? ─────────────────────────────
  // Dit had er vanaf het begin moeten staan. package.json zegt ^1.26.0, dus npm
  // kan elke 1.x geïnstalleerd hebben, en de interne opbouw verschilt daar sterk
  // tussen. Alle metingen tot nu toe zijn gedaan tegen de bron van 1.26.0 —
  // zonder te weten of dát is wat er draait.
  //
  // De probe wees uit dat window.Store vanuit onze evaluate niet bestaat, terwijl
  // versturen (dat óók via pupPage.evaluate loopt, maar dan naar window.WWebJS)
  // gewoon werkt. Dat past bij een nieuwere versie die Store niet meer als
  // globale variabele achterlaat. Vandaar dat we vanaf nu uitsluitend de
  // publieke API gebruiken: die werkt aantoonbaar, ongeacht waar de bibliotheek
  // haar interne opslag bewaart.
  const kunde = {
    onderzocht: false,
    fout: null,
    bibliotheek: null,     // versie uit node_modules
    wweb: null,            // versie van WhatsApp Web zelf
    globals: {},           // welke globals de pagina heeft
    wwebjs_keys: [],       // functienamen op window.WWebJS
    api: {},               // welke publieke methodes de client aanbiedt
  };

  async function tastKundeAf() {
    if (kunde.onderzocht) return kunde;
    kunde.onderzocht = true;

    // 1. De versie van de bibliotheek zelf, uit haar eigen package.json. Zonder
    //    dit blijven we bron lezen die misschien niet draait.
    try {
      const eis = createRequire(import.meta.url);
      kunde.bibliotheek = eis('whatsapp-web.js/package.json')?.version || null;
    } catch (_) { kunde.bibliotheek = 'onbekend'; }

    // 2. Welke publieke methodes bestaan er op de client? Dit is wat we vanaf nu
    //    gebruiken, dus dit is wat we moeten weten.
    for (const naam of ['getContacts', 'getChats', 'getNumberId', 'getContactById',
                        'getChatById', 'sendMessage', 'getWWebVersion']) {
      kunde.api[naam] = typeof client[naam] === 'function';
    }

    try {
      kunde.wweb = kunde.api.getWWebVersion ? await client.getWWebVersion() : null;
    } catch (_) { kunde.wweb = null; }

    // 3. En wat er in de pagina staat. Alleen namen — dit is de meting die
    //    vorige ronde 'alles false' opleverde, en die nu ook laat zien wát er
    //    dán wél is.
    try {
      const uit = await client.pupPage.evaluate(() => {
        const namen = (o) => {
          try {
            const uit = [];
            for (const k in o) { try { if (typeof o[k] === 'function') uit.push(k); } catch (_) {} }
            return uit.sort();
          } catch (_) { return []; }
        };
        return {
          globals: {
            Store  : typeof window.Store !== 'undefined',
            WWebJS : typeof window.WWebJS !== 'undefined',
            require: typeof window.require === 'function',
          },
          wwebjs_keys: namen(window.WWebJS),
        };
      });
      Object.assign(kunde, uit);
    } catch (e) {
      kunde.fout = 'pagina aftasten faalde: ' + (e?.message || 'onbekend');
    }

    console.log('[brug] bibliotheek:', kunde.bibliotheek, '· WhatsApp Web:', kunde.wweb || 'onbekend');
    console.log('[brug] globals in de pagina:',
      Object.entries(kunde.globals).filter(([, v]) => v).map(([k]) => k).join(', ') || '(geen)');
    console.log('[brug] publieke API:',
      Object.entries(kunde.api).filter(([, v]) => v).map(([k]) => k).join(', ') || '(geen)');
    return kunde;
  }

  // ── De wegen naar de koppeling, elk met een eigen teller ─────────────────
  // Elke weg houdt bij: hoe vaak geprobeerd, hoe vaak gelukt, en of hij
  // überhaupt beschikbaar is. Daarmee is 'stilte' onmogelijk geworden: na één
  // testbericht staat er welke weg werkte, en welke niet bestond.
  // ── Het bericht-id, en langs welk pad het gevonden werd ──────────────────
  // De vorm gaat naar /status: padnaam en lengte, nooit de waarde. In zo'n id
  // zit het nummer van de tegenpartij verwerkt.
  const berichtIdVormen = {};
  function bidVanEnTel(msg) {
    const uit = berichtIdVan(msg);
    telBerichtIdVorm(uit.pad, uit.id);
    return uit.id;
  }

  /** Padnaam plus lengte. Nooit de waarde. */
  function telBerichtIdVorm(pad, id) {
    const vorm = berichtIdVorm({ pad: pad || 'geen', id });
    berichtIdVormen[vorm] = (berichtIdVormen[vorm] || 0) + 1;
  }

  /**
   * Weiger wat geen gesprek is, en tel WELK type dat was.
   *
   * Staat op elk van de drie paden NA leadlijst.mag(): de privacyvolgorde
   * verschuift niet. Het filter blijft de eerste regel; dit is de tweede.
   */
  function isSysteemBericht(eventType, msg, jid) {
    if (isEchtGesprek(msg?.type)) return false;
    tellers.systeemtype(msg?.type);
    negeer(eventType, 'systeemtype', jid);
    return true;
  }

  const WEGEN = ['getNumberId', 'getChatById', 'getChats', 'getMessageById', 'msg_getchat',
                 'chat_contact', 'contact_data', 'msg_data'];
  const wegen = Object.fromEntries(WEGEN.map((w) => [w, { geprobeerd: 0, gelukt: 0, beschikbaar: null, statussen: {}, laatste_fout: null }]));
  const noteer = (weg, res) => {
    const t = wegen[weg];
    if (!t) return;
    t.geprobeerd += 1;
    // DE STATUS ZELF BEWAREN, niet alleen 'gelukt ja of nee'. Dit was een eigen
    // fout die een hele ronde kostte: probeer() rekent al uit óf iets niet
    // bestond, niets teruggaf, iets onbruikbaars gaf of wierp — en deze teller
    // gooide dat weg. Dan staat er 'geprobeerd 2, gelukt 0' en weet je nog
    // steeds niets. Precies de stilte die uitkomst.js moest wegnemen.
    if (res.status) t.statussen[res.status] = (t.statussen[res.status] || 0) + 1;
    // De foutmelding van de bibliotheek bewaren. Zonder die tekst is 'fout×2'
    // opnieuw een stilte — en dat is precies waar deze hele avond aan opging.
    if (res.status === FOUT && res.melding) t.laatste_fout = String(res.melding).slice(0, 300);
    if (res.status === GELUKT) t.gelukt += 1;
    if (res.status === BESTAAT_NIET) t.beschikbaar = false;
    else if (t.beschikbaar === null) t.beschikbaar = true;
  };

  /** De cijfers en het domein uit een wid, string of object. */
  function deelWid(v) {
    if (!v) return { user: '', server: '' };
    if (typeof v === 'string') {
      const st = v.split('@');
      return { user: String(st[0]).replace(/\D/g, ''), server: (st[1] || '').toLowerCase() };
    }
    const ser = v._serialized ? String(v._serialized).split('@') : null;
    return {
      user  : String(v.user || (ser ? ser[0] : '')).replace(/\D/g, ''),
      server: String(v.server || (ser ? ser[1] : '') || '').toLowerCase(),
    };
  }

  /**
   * WEG A — client.getNumberId(nummer).
   *
   * Letterlijk 'welke WhatsApp-identiteit hoort bij dit telefoonnummer'. Draait
   * de LID-migratie, dan is dit precies wat we zoeken. De kortste weg, en hij
   * staat gewoon in de publieke API.
   */
  // ── Lokaal genoteerde nummers ────────────────────────────────────────────
  // Zes van de 33 leads staan als 0472223752 of 06 57340618 in het CRM. Die
  // passeren het leadlijst-filter (staart-ingang op negen cijfers) maar
  // naarChatId() geeft er null op, en dan faalt zowel de lidkaart als het
  // versturen. We raden de landcode niet: we stellen de kandidaten op en laten
  // getNumberId beslissen, en accepteren alleen bij precies één treffer.
  //
  // Eén zoeker voor allebei de plekken, met één cache — zie lib/landcode.js.
  const landcodeTellers = { gevonden: 0, geen: 0, meerdere: 0, niet_lokaal: 0, mislukt: 0, niet_meetbaar: 0 };
  const landcode = maakLandcodeZoeker({
    bevestig: async (kandidaat) => {
      // 'deze bibliotheek kan het niet' is iets anders dan 'WhatsApp kent dit
      // nummer niet'. Zou dit false teruggeven, dan waren die twee niet uit
      // elkaar te houden — precies het onderscheid waar de hele LID-zoektocht
      // op is stukgelopen, en waar lib/uitkomst.js voor bestaat.
      if (!kunde.api.getNumberId) { const e = new Error('getNumberId bestaat niet'); e.code = NIET_MEETBAAR; throw e; }
      const w = await client.getNumberId(kandidaat + '@c.us');
      return !!(w && (w._serialized || w.user));
    },
    onMeting: (status, kandidaten, treffers) => {
      if (landcodeTellers[status] !== undefined) landcodeTellers[status] += 1;
      // Alleen woorden en aantallen; nooit het nummer of de kandidaat.
      console.log('[brug] landcode:', status, '·', treffers, 'van', kandidaten, 'kandidaten bevestigd');
    },
  });

  /**
   * Het nummer in internationale vorm, of null.
   *
   * Al internationaal → ongewijzigd terug. Lokaal → via de zoeker hierboven.
   * Niets bevestigd → null, en de aanroeper hoort dat als 'dit nummer kunnen we
   * niet gebruiken' te behandelen, niet als 'de brug is stuk'.
   */
  async function internationaal(nummer) {
    const r = await landcode.zoek(nummer);
    if (r.status === 'niet_lokaal') return r.nummer;
    return r.status === 'gevonden' ? r.nummer : null;
  }

  async function lidViaNumberId(nummer) {
    const chatId = naarChatId(nummer);
    const res = await probeer({
      bestaat : kunde.api.getNumberId,
      invoerOk: !!chatId,
      haal    : () => client.getNumberId(chatId),
      bruikbaar: (v) => deelWid(v).server === 'lid',
    });
    noteer('getNumberId', res);
    if (res.status !== GELUKT) return null;
    // De volledige serialisatie teruggeven, niet alleen de cijfers: die id
    // gebruiken we straks om de chat op te zoeken, en zelf iets heropbouwen is
    // precies waar het ophalen op stukliep.
    const w = res.waarde;
    return w?._serialized || (deelWid(w).user ? deelWid(w).user + '@' + deelWid(w).server : null);
  }

  /**
   * WEG B — client.getChatById(nummer + '@c.us') en dan chat.id uitlezen.
   *
   * Bewaart WhatsApp het gesprek onder een LID, dan geeft deze aanroep het
   * gesprek terug mét zijn echte id — en dan hebben we het paar zonder ook maar
   * iets van de interne store aan te raken.
   *
   * Een ontbrekend gesprek is hier geen storing maar 'nooit mee gechat'. Dat
   * onderscheid staat in de status: GEEN_RESULTAAT, niet FOUT.
   */
  async function lidViaChat(nummer) {
    const chatId = naarChatId(nummer);
    const res = await probeer({
      bestaat : kunde.api.getChatById,
      invoerOk: !!chatId,
      haal   : async () => {
        try { return await client.getChatById(chatId); } catch (_) { return null; }
      },
      bruikbaar: (c) => !!c,
    });
    noteer('getChatById', res);
    if (res.status !== GELUKT) return null;
    const chat = res.waarde;

    const eigen = deelWid(chat?.id);
    if (eigen.server === 'lid' && eigen.user) return eigen.user;

    // Het contact VAN HET GESPREK is altijd de tegenpartij — in beide
    // richtingen. Dat is het verschil met de contact-getter op het BERICHT: die
    // doet getContactById(author || from) en levert bij een uitgaand bericht
    // ons eigen nummer op. Die val zat er al in.
    const cres = await probeer({
      bestaat: typeof chat?.getContact === 'function',
      haal   : () => chat.getContact(),
      bruikbaar: (c) => !!c,
    });
    noteer('chat_contact', cres);
    if (cres.status !== GELUKT) return null;
    return lidUitContact(cres.waarde);
  }

  /**
   * Het LID op een contact — óók uit de ruwe laag.
   *
   * De Contact-klasse geeft maar een handvol velden door; `_data` draagt de
   * volledige serialisatie van het model. Bij een LID-contact staat het
   * telefoonnummer daar vaak gewoon in.
   */
  function lidUitContact(contact) {
    const kandidaten = [contact?.id, contact?.lid, contact?.phoneNumber, contact?.altId];
    const rauw = contact?._data;
    if (rauw && typeof rauw === 'object') {
      for (const k of Object.keys(rauw)) {
        if (/lid|phone|pn$|number/i.test(k)) kandidaten.push(rauw[k]);
      }
      kandidaten.push(rauw.id);
    }
    const res = { status: kandidaten.some(Boolean) ? GELUKT : ONBRUIKBAAR, waarde: null, lengte: null };
    noteer('contact_data', res);
    for (const k of kandidaten) {
      const d = deelWid(k);
      if (d.server === 'lid' && d.user) return d.user;
    }
    return null;
  }

  /**
   * WEG C — de RUWE gegevens op een binnenkomend bericht.
   *
   * De LID-migratie voegt daar velden aan toe zodat clients kunnen koppelen
   * (senderPn, recipientPn, participantPn en dergelijke). Zit daar het echte
   * nummer in, dan is het in één regel opgelost.
   *
   * Wat hiervan naar buiten gaat is uitsluitend de SLEUTELNAAM en, voor waarden
   * met een apenstaart, het achtervoegsel. Sleutelnamen zijn protocolnamen, geen
   * persoonsgegevens.
   */
  function bekijkRuweBericht(msg) {
    const rauw = msg && msg._data;
    if (!rauw || typeof rauw !== 'object') {
      noteer('msg_data', { status: BESTAAT_NIET });
      return null;
    }
    const vorm = {};
    let gevonden = null;
    for (const k of Object.keys(rauw)) {
      const v = rauw[k];
      const d = deelWid(v && (typeof v === 'string' || typeof v === 'object') ? v : null);
      if (d.server) vorm[k] = d.server + '/' + d.user.length;
      if (!gevonden && d.server === 'c.us' && d.user && /pn$|phone|number/i.test(k)) {
        gevonden = d.user;
      }
    }
    // BEWAREN GEBEURT NIET HIER. De vormen worden pas onthouden als het bericht
    // door het filter is — anders zou /status de opbouw van een bericht van een
    // privécontact tonen. Sleutelnamen zijn protocolnamen, maar dát er een
    // bericht was is dat niet.
    noteer('msg_data', { status: gevonden ? GELUKT : ONBRUIKBAAR });
    return { nummer: gevonden, vorm };
  }

  /** De vormen onthouden. Alleen aanroepen ná leadlijst.mag(). */
  function bewaarBerichtvormen(vorm) {
    if (vorm && Object.keys(vorm).length) laatsteBerichtvormen = vorm;
  }

  /**
   * De koppelingen voor de hele leadlijst, langs de wegen hierboven.
   *
   * De leadlijst blijft de grens: we lopen alleen de nummers af die er al op
   * staan, en vragen niets op over wie er niet op staat.
   */
  async function koppelingenUitApi(nummers) {
    await tastKundeAf();
    const paren = [];
    let bekeken = 0;
    for (const nummer of (Array.isArray(nummers) ? nummers : [])) {
      bekeken += 1;
      try {
        // Staat dit nummer lokaal genoteerd, dan eerst uitzoeken welk
        // internationaal nummer WhatsApp kent. Zonder deze stap krijgt
        // getNumberId een chatId van null en faalt hij — precies de zes leads
        // die bij 21 van de 28 buiten de boot vielen.
        const bruikbaar = (await internationaal(nummer)) || nummer;
        const viaA = await lidViaNumberId(bruikbaar);
        // De kaart wordt bevraagd met het nummer zoals het in het CRM staat,
        // dus die kant blijft het ORIGINEEL. Alleen de vraag aan WhatsApp gaat
        // met het internationale nummer.
        if (viaA) { paren.push([nummer, viaA]); continue; }
        const viaB = await lidViaChat(bruikbaar);
        if (viaB) { paren.push([nummer, viaB]); continue; }
      } catch (_) { /* volgende nummer; één lead mag de rest niet ophouden */ }
    }
    return { paren, bekeken };
  }

  // ── De gesprekkenlijst, één keer opgehaald ────────────────────────────────
  // getChatById is dood in 1.34.7: 8 pogingen, 0 gelukt, ongeacht welke vorm we
  // hem voerden. getChats() loopt via window.WWebJS — dezelfde laag waar het
  // versturen langs gaat en die dus aantoonbaar werkt.
  //
  // Het is een zwaardere aanroep, dus we onthouden het resultaat en verversen
  // pas als er niets gevonden wordt. Een nieuw gesprek is precies het geval
  // waarin een miss betekent 'de lijst is verouderd'.
  let chatsCache = null;
  let chatsCacheAt = null;
  let chatsGeprobeerdAt = null;
  let chatsStatus = null;
  let chatsFout = null;

  async function haalChats(ververs = false) {
    if (chatsCache && !ververs) return chatsCache;
    const res = await probeer({
      bestaat: kunde.api.getChats,
      haal   : () => client.getChats(),
      bruikbaar: (v) => Array.isArray(v),
    });
    noteer('getChats', res);
    // Het moment van de póging, niet van het succes. Stond dit alleen op de
    // gelukte tak, dan zag een mislukte ronde eruit als 'nooit geprobeerd'.
    chatsGeprobeerdAt = new Date().toISOString();
    chatsStatus = res.status;

    chatsFout = res.melding || null;
    if (res.status !== GELUKT) {
      console.log('[brug] getChats:', res.status, '—', chatsFout || 'geen gesprekkenlijst gekregen');
      return chatsCache || [];
    }
    chatsCache = res.waarde;
    chatsCacheAt = chatsGeprobeerdAt;
    // Een AANTAL. Dat is de vraag die openstond: kwam de lijst leeg terug, of
    // ging het zoeken erin mis? Nul betekent dat dit gekoppelde apparaat geen
    // gesprekkenlijst heeft en er niets op te halen valt.
    console.log('[brug] getChats: gelukt —', chatsCache.length, 'gesprekken');
    return chatsCache;
  }

  /**
   * Het gesprek zoeken in de lijst, op elke vorm die we van dit nummer kennen.
   *
   * Vergelijkt op de volledige serialisatie én op de cijfers, zodat het niet
   * uitmaakt of WhatsApp het gesprek onder een LID of onder het nummer bewaart.
   */
  function zoekChatIn(chats, vormen) {
    const gezocht = new Set();
    for (const v of vormen) {
      if (!v) continue;
      gezocht.add(String(v));
      gezocht.add(String(v).split('@')[0].replace(/\D/g, ''));
    }
    for (const chat of (chats || [])) {
      const id = chat?.id;
      const ser = String(id?._serialized || '');
      const user = String(id?.user || ser.split('@')[0] || '').replace(/\D/g, '');
      if (ser && gezocht.has(ser)) return chat;
      if (user && gezocht.has(user)) return chat;
    }
    return null;
  }

  /**
   * De chat via een bericht dat we al kennen.
   *
   * LET OP — dit is niet de zekerheid die het lijkt. In de bron die ik kan lezen
   * (1.26.0) is Message.getChat() letterlijk
   * `this.client.getChatById(this._getChatId())`, dus dan loopt hij door
   * dezelfde dode deur. Op 1.34.7 kan dat anders liggen; daarom staat hij hier
   * mét een eigen teller in plaats van als aanname. Levert hij niets op, dan
   * zegt de teller dat en weten we het.
   */
  async function chatViaBericht(berichtId) {
    if (!berichtId) return null;
    const msg = await probeer({
      bestaat: typeof client.getMessageById === 'function',
      haal   : () => client.getMessageById(String(berichtId)),
      bruikbaar: (m) => !!m,
    });
    noteer('getMessageById', msg);
    if (msg.status !== GELUKT) return null;
    const chat = await probeer({
      bestaat: typeof msg.waarde.getChat === 'function',
      haal   : () => msg.waarde.getChat(),
      bruikbaar: (c) => !!c,
    });
    noteer('msg_getchat', chat);
    return chat.status === GELUKT ? chat.waarde : null;
  }

  /**
   * De probe, nu uitsluitend op de publieke API.
   *
   * Elke bron krijgt een eigen status. Dat is de hele les van de vorige twee
   * rondes: 'bestaat niet', 'gaf niets terug' en 'gaf iets onbruikbaars' zagen
   * er allemaal uit als null, en dus zaten we te raden. Nu staat er wat het is.
   *
   * Waarden komen er niet uit — alleen een status en een cijferlengte.
   *
   * Het nummer moet op de leadlijst staan, anders wordt dit een manier om over
   * een willekeurig nummer iets te weten te komen.
   */
  async function probeerLid(nummer) {
    const n = normaliseerNummer(nummer);
    if (!n) { const e = new Error('nummer onleesbaar'); e.code = 'NUMMER_ONGELDIG'; throw e; }
    if (!leadlijst.mag(n)) { const e = new Error('niet op de leadlijst'); e.code = 'NIET_TOEGESTAAN'; throw e; }
    if (!staat.verbonden) { const e = new Error('niet verbonden'); e.code = 'NIET_VERBONDEN'; throw e; }
    await tastKundeAf();

    const kort = (r) => ({ status: r.status, lengte: r.lengte });
    const pogingen = {};

    // getContactById op het nummer: welke id-vorm krijgen we terug, en welke
    // VELDNAMEN hangen er aan — inclusief die op de ruwe laag `_data`, want de
    // Contact-klasse geeft maar een handvol velden door.
    const contact = await probeer({
      bestaat: kunde.api.getContactById,
      haal   : () => client.getContactById(naarChatId(n)),
      bruikbaar: (c) => !!c,
    });
    pogingen['getContactById'] = { status: contact.status };
    if (contact.status === GELUKT) {
      const c = contact.waarde;
      pogingen['getContactById'].id_server = deelWid(c?.id).server || null;
      const namen = [];
      for (const k in c) { try { if (/lid|phone|number/i.test(k)) namen.push(k); } catch (_) {} }
      pogingen['getContactById'].veldnamen = [...new Set(namen)].sort();
      const rauw = c?._data;
      pogingen['getContactById'].heeft_data = !!rauw;
      if (rauw && typeof rauw === 'object') {
        // Sleutelnamen, en per waarde met een apenstaart alleen het domein.
        const vormen = {};
        for (const k of Object.keys(rauw)) {
          const d = deelWid(rauw[k] && typeof rauw[k] !== 'number' ? rauw[k] : null);
          if (d.server) vormen[k] = d.server + '/' + d.user.length;
        }
        pogingen['getContactById'].data_veldnamen = Object.keys(rauw).sort();
        pogingen['getContactById'].data_vormen = vormen;
      }
    }

    // De twee wegen los, voor dit ene nummer.
    pogingen['weg_A_getNumberId'] = { gevonden: !!(await lidViaNumberId(n)) };
    pogingen['weg_B_getChatById'] = { gevonden: !!(await lidViaChat(n)) };

    return {
      kunde: { ...kunde },
      pogingen,
      wegen: JSON.parse(JSON.stringify(wegen)),
      laatste_berichtvormen: laatsteBerichtvormen,
    };
  }

  /** De kaart opnieuw opbouwen. Fail-soft: een fout laat de vorige kaart staan. */

  async function bouwLidkaart() {
    if (!staat.verbonden) return;
    try {
      const nummers = typeof leadlijst.nummers === 'function' ? leadlijst.nummers() : [];
      const uit = await koppelingenUitApi(nummers);

      if (uit.paren.length > 0) {
        const kaart = new Map(uit.paren);
        await lidkaart.bouw(nummers, async (n) => kaart.get(n) || null);
        // Welke weg het deed staat in de tellers; hier alleen dát er een was.
        kaartBron = Object.keys(wegen).filter((w) => wegen[w].gelukt > 0).join(' + ') || 'onbekend';
      } else {
        kaartBron = null;
      }
      laatsteScan = { bekeken: uit.bekeken, koppelingen: lidkaart.status().koppelingen };

      // Alleen aantallen en wegnamen. Nooit een nummer, nooit een LID.
      console.log('[brug] lidkaart:', lidkaart.status().koppelingen, 'van', uit.bekeken,
        'nummers gekoppeld via', kaartBron || 'geen enkele weg');
      for (const w of WEGEN) {
        const t = wegen[w];
        console.log('[brug] weg', w + ':', 'geprobeerd', t.geprobeerd, '· gelukt', t.gelukt,
          '· beschikbaar', t.beschikbaar === null ? 'onbekend' : (t.beschikbaar ? 'ja' : 'nee'));
      }
    } catch (e) {
      console.warn('[brug] lidkaart opbouwen faalde:', e?.message || e);
    }
  }



  const isTelefoonJid = (jid) => typeof jid === 'string' && /@(c\.us|s\.whatsapp\.net)$/i.test(jid);

  function onthoud(nummer, jid) {
    if (nummer && jid) nummerkaart.set(nummer, jid);
  }

  /**
   * Het echte telefoonnummer achter een jid.
   *
   * Is de jid al een telefoonnummer, dan is er niets op te lossen. Anders vragen
   * we WhatsApp wie dit is. Mislukt dat — en dat is een netwerk-achtige oproep
   * naar de browser, dus het kán mislukken — dan vallen we terug op de cijfers
   * van de jid zelf. Dat is precies het gedrag van vóór deze wijziging, dus een
   * mislukte oplossing maakt het nooit slechter dan het was.
   */
  async function bepaalNummer(jid) {
    if (!jid) { tellers.oplossing('geen_jid'); return null; }
    if (isTelefoonJid(jid)) {
      const n = normaliseerNummer(jid);
      onthoud(n, jid);
      tellers.oplossing('jid', n);
      return n;
    }

    // Eerst de kaart uit de leadlijst. Die is opgebouwd uit nummers die we al
    // mogen kennen, kost geen oproep per bericht, en is de enige weg die een
    // LID écht naar een telefoonnummer vertaalt — WhatsApp biedt alleen de
    // richting nummer → LID, niet omgekeerd.
    const cijfers = String(jid).split('@')[0].replace(/\D/g, '');
    const viaKaart = lidkaart.nummerVoorLid(cijfers);
    if (viaKaart) {
      onthoud(viaKaart, jid);
      tellers.oplossing('lidkaart', viaKaart);
      return viaKaart;
    }

    // Terugval: vragen wie dit is. Die weg gaf bij een LID het LID terug in
    // plaats van een nummer — de teller opgelost_vorm laat dat zien — maar hij
    // blijft staan voor identiteiten die géén LID zijn en die we hier nog niet
    // kennen.
    try {
      const contact = await client.getContactById(jid);
      const kandidaat = contact?.number || contact?.id?.user || null;
      const n = normaliseerNummer(kandidaat);
      if (n) { onthoud(n, jid); tellers.oplossing('contact', n); return n; }
      tellers.oplossing('contact_zonder_nummer');
    } catch (e) {
      // Geen tekst, geen jid in het log — alleen dát het niet lukte.
      tellers.oplossing('mislukt');
      if (process.env.BRUG_DEBUG === '1') console.debug('[brug] contact oplossen faalde');
    }
    return normaliseerNummer(jid);   // terugval op msg.to, zoals het was
  }

  /** De chat waar dit nummer onder bekend staat, of de gewone @c.us-vorm. */
  function chatIdVoor(nummer) {
    const n = normaliseerNummer(nummer);
    if (!n) return naarChatId(nummer);
    // Wat we bij een echt bericht gezien hebben is het meest betrouwbaar; daarna
    // de LID uit de kaart; en anders de gewone @c.us-vorm.
    const gezien = nummerkaart.get(n);
    if (gezien) return gezien;
    const lid = lidkaart.lidVoorNummer(n);
    if (lid) return lid + '@lid';
    return naarChatId(nummer);
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
    // Eerst aftasten wát deze versie aanbiedt, en dat meteen loggen. Dit stond
    // eerder verstopt in de kaartopbouw, dus het was pas gevuld nádat er een
    // poging gedaan was — precies het gegeven dat had moeten vertellen of de
    // functie überhaupt bestond vóór we hem gingen gebruiken.
    tastKundeAf();
    // De LID-kaart hoort er te staan vóór het eerste bericht binnenkomt, en
    // daarna mee te lopen met de leadlijst: een nieuwe lead heeft ook een
    // koppeling nodig. Fail-soft — mislukt het, dan blijft de terugval per
    // bericht gewoon werken.
    bouwLidkaart();
    if (!lidTimer) {
      lidTimer = setInterval(bouwLidkaart, cfg.nummersIntervalMs);
      if (typeof lidTimer.unref === 'function') lidTimer.unref();
    }
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
      if (isGroep(van)) { negeer('message', 'groep', van); return; }
      // Eerst weten WIE dit is — een jid is niet altijd een telefoonnummer — en
      // dan pas filteren. Weg C kijkt op de ruwe laag van het bericht: draagt
      // WhatsApp daar het echte nummer mee, dan is er niets op te zoeken.
      // Levert dat niets op, dan de omweg via de kaart en het contact.
      //
      // Allebei lezen ze de envelop, niet de inhoud; het filter staat nog altijd
      // vóór elk gebruik van nummer of tekst.
      const ruw = bekijkRuweBericht(msg);
      const nummer = ruw.nummer || await bepaalNummer(van);
      // FILTER. Alles hieronder raakt de tekst aan, en pas hierna wordt er iets
      // van dit bericht onthouden.
      if (!leadlijst.mag(nummer)) { negeer('message', 'niet_op_leadlijst', van); return; }
      // WhatsApp stuurt over deze stroom ook dingen die geen bericht zijn. Een
      // e2e_notification is een ververste sleutel, geen antwoord van de lead —
      // en het CRM maakte er een poging 'antwoord ontvangen' van. Zie
      // isEchtGesprek() in lib/gebeurtenis.js.
      if (isSysteemBericht('message', msg, van)) return;
      bewaarBerichtvormen(ruw.vorm);
      tellers.liet('message');
      await webhook.duw({
        soort    : 'antwoord_ontvangen',
        nummer,
        tijdstip : new Date((msg.timestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
        tekst    : typeof msg.body === 'string' ? msg.body.slice(0, 4000) : '',
        // Een ingesproken bericht telt in de opvolging als spraakbericht, niet
        // als WhatsApp-tekst — dat is een ander soort moeite.
        media_type: msg.type || null,
        bericht_id: bidVanEnTel(msg),
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
      if (msg?.fromMe !== true) { negeer('message_create', 'niet_van_ons', msg?.to); return; }
      if (isGroep(msg?.to)) { negeer('message_create', 'groep', msg?.to); return; }
      // Eerst de identiteit oplossen, dan filteren. Zonder deze stap filteren we
      // op de cijfers van een LID, en die staan nergens op de leadlijst.
      const ruw = bekijkRuweBericht(msg);
      const nummer = ruw.nummer || await bepaalNummer(msg?.to);
      // FILTER, en pas hierna wordt het nummer of de tekst ergens voor gebruikt.
      if (!leadlijst.mag(nummer)) { negeer('message_create', 'niet_op_leadlijst', msg?.to); return; }
      if (isSysteemBericht('message_create', msg, msg?.to)) return;
      bewaarBerichtvormen(ruw.vorm);
      const g = bouwUitgaandeGebeurtenis(msg);
      if (!g) { negeer('message_create', 'onbruikbaar', msg?.to); return; }
      telBerichtIdVorm(g.bericht_id_pad, g.bericht_id);
      tellers.liet('message_create');
      await webhook.duw({
        soort     : g.soort,
        nummer,
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
      if (isGroep(jid)) { negeer('message_ack', 'groep', jid); return; }
      const nummer = await bepaalNummer(jid);
      if (!leadlijst.mag(nummer)) { negeer('message_ack', 'niet_op_leadlijst', jid); return; }
      // Een ack op een e2e_notification is net zo min een verstuurd bericht als
      // die notification zelf er een was.
      if (isSysteemBericht('message_ack', msg, jid)) return;
      const g = bouwAckGebeurtenis(msg, ack);
      // ACK_SOORT kent -1 en 0 niet: dat zijn statussen die nog niets zeggen.
      if (!g) { negeer('message_ack', 'geen_ack_soort', jid); return; }
      telBerichtIdVorm(g.bericht_id_pad, g.bericht_id);
      tellers.liet('message_ack');
      await webhook.duw({
        soort     : g.soort,
        nummer,
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
    /** Hoeveel nummer↔jid-koppelingen we geleerd hebben. Alleen het aantal. */
    nummerkaartAantal: () => nummerkaart.size,
    /** De LID-kaart: aantallen en een tijdstip, nooit de koppelingen zelf. */
    lidkaartStatus: () => ({
      ...lidkaart.status(),
      historiek_vormen: { ...historiekVormen },
      // Drie velden in plaats van één, want 'null' betekende hier drie dingen
      // tegelijk: nooit geprobeerd, mislukt, of leeg teruggekregen.
      chats_in_cache    : chatsCache ? chatsCache.length : null,
      chats_opgehaald   : chatsCacheAt,
      chats_geprobeerd  : chatsGeprobeerdAt,
      chats_status      : chatsStatus,
      chats_fout        : chatsFout,
      // Lokaal genoteerde nummers: hoeveel er opgelost zijn, en hoeveel er niet
      // te bepalen waren. Alleen aantallen.
      landcode          : { ...landcodeTellers, onthouden: landcode.aantalOnthouden() },
      // Langs welk pad het bericht-id gevonden werd, en hoe lang hij was.
      // 'geen/0' betekent dat er geen id was — en dan kan er niet ontdubbeld
      // worden, wat precies de oorzaak was van twaalf rijen voor zes
      // gebeurtenissen.
      bericht_id_vormen : { ...berichtIdVormen },
    }),
    /** Wat de geïnstalleerde whatsapp-web.js blijkt te kunnen. Functienamen. */
    lidKunde: () => ({ ...kunde }),
    /** Langs welke weg de kaart gevuld is, en wat de contactscan zag. */
    lidBron: () => ({
      bron: kaartBron,
      scan: laatsteScan,
      wegen: JSON.parse(JSON.stringify(wegen)),
      laatste_berichtvormen: laatsteBerichtvormen,
    }),
    /** De probe: wat levert elke variant op voor één bekend nummer? */
    lidProbe: probeerLid,
    /** Handmatig opnieuw opbouwen, voor de /lidkaart-route. */
    herbouwLidkaart: bouwLidkaart,
    start() {
      console.log('[brug] WhatsApp-client starten…');
      client.initialize().catch((e) => {
        staat.laatsteFout = 'starten faalde: ' + (e?.message || e);
        console.error('[brug]', staat.laatsteFout);
      });
    },
    async stop() {
      if (lidTimer) { clearInterval(lidTimer); lidTimer = null; }
      try { await client.destroy(); } catch (_) {}
    },

    /**
     * Versturen. Ook hier geldt het filter: een nummer dat niet op de leadlijst
     * staat krijgt niets van ons, ook niet als het CRM erom vraagt.
     */
    async stuur(nummer, tekst) {
      if (!staat.verbonden) { const e = new Error('niet verbonden met WhatsApp'); e.code = 'NIET_VERBONDEN'; throw e; }
      if (!leadlijst.mag(nummer)) { const e = new Error('nummer staat niet op de leadlijst'); e.code = 'NIET_TOEGESTAAN'; throw e; }
      // Staat dit gesprek onder een LID, dan is '<nummer>@c.us' niet de chat
      // waar de draad in zit. chatIdVoor() pakt de jid die we bij dit nummer
      // gezien hebben, en valt anders terug op de gewone vorm.
      let chatId = chatIdVoor(nummer);
      if (!chatId) {
        // Zelfde regel als bij de lidkaart: kandidaten proberen, WhatsApp laten
        // beslissen, alleen bij precies één treffer accepteren. Zonder dit gooit
        // versturen NUMMER_ONGELDIG op zes van de 33 leads — de knop staat er,
        // het venster opent, en pas bij verzenden blijkt het niet te kunnen.
        const intl = await internationaal(nummer);
        if (intl) chatId = naarChatId(intl);
      }
      if (!chatId) {
        // De melding moet zeggen wát er aan de hand is. 'Ongeldig nummer' laat
        // Dave denken dat de brug stuk is, terwijl hij het nummer moet
        // aanvullen.
        const lokaal = isLokaalGenoteerd(nummer);
        const e = new Error(lokaal
          ? 'het nummer staat lokaal genoteerd en WhatsApp herkent geen van de landcodes die we geprobeerd hebben'
          : 'nummer mist een landcode');
        e.code = lokaal ? 'LANDCODE_ONBEKEND' : 'NUMMER_ONGELDIG';
        throw e;
      }
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
    async historiek(nummer, limiet = 50, berichtId = null) {
      if (!staat.verbonden) { const e = new Error('niet verbonden met WhatsApp'); e.code = 'NIET_VERBONDEN'; throw e; }
      if (!leadlijst.mag(nummer)) { const e = new Error('nummer staat niet op de leadlijst'); e.code = 'NIET_TOEGESTAAN'; throw e; }
      // ── De vormen waaronder dit gesprek kan staan ────────────────────────
      const n0 = normaliseerNummer(nummer);
      const viaKaart = lidkaart.jidVoorNummer(n0);
      const viaBericht = n0 ? nummerkaart.get(n0) : null;
      const gewoon = naarChatId(nummer);
      const vormen = [viaKaart, viaBericht, gewoon].filter(Boolean);

      // 'Geen kandidaten' en 'kandidaten geprobeerd, niets gevonden' zijn twee
      // verschillende dingen. Ze zagen er allebei uit als {geen: 1}, en dat
      // maakte de vorige meting onleesbaar. Nu staat het er apart.
      if (vormen.length === 0) {
        historiekVormen.geen_kandidaten = (historiekVormen.geen_kandidaten || 0) + 1;
        const e = new Error('geen enkele vorm bekend voor dit nummer');
        e.code = 'GEEN_KOPPELING';
        e.kandidaten = 0;
        throw e;
      }

      const n = Math.max(1, Math.min(200, Number(limiet) || 50));

      // ── Weg 1: de gesprekkenlijst ────────────────────────────────────────
      // getChatById is dood in deze versie (8 pogingen, 0 gelukt), dus die weg
      // is er helemaal uit. getChats() loopt via window.WWebJS, de laag waar
      // ook het versturen langs gaat.
      let chat = zoekChatIn(await haalChats(false), vormen);
      let gebruikteVorm = chat ? 'getchats_cache' : null;

      // Niets gevonden? Dan is de lijst mogelijk verouderd — precies het geval
      // van een gesprek dat pas net bestaat. Eén keer opnieuw ophalen.
      if (!chat) {
        chat = zoekChatIn(await haalChats(true), vormen);
        if (chat) gebruikteVorm = 'getchats_vers';
      }

      // ── Weg 2: via een bericht dat we al kennen ──────────────────────────
      if (!chat && berichtId) {
        chat = await chatViaBericht(berichtId);
        if (chat) gebruikteVorm = 'via_bericht';
      }

      historiekVormen[gebruikteVorm || 'niets_gevonden'] =
        (historiekVormen[gebruikteVorm || 'niets_gevonden'] || 0) + 1;

      if (!chat) {
        const e = new Error('de chat bestaat niet op dit apparaat');
        e.code = 'GEEN_GESPREK';
        e.kandidaten = vormen.length;
        e.chats_bekeken = (chatsCache || []).length;
        throw e;
      }
      if (chat.isGroup) { const e = new Error('groepen niet'); e.code = 'NIET_TOEGESTAAN'; throw e; }

      const msgs = await chat.fetchMessages({ limit: n });
      raakAan();
      const berichten = (msgs || [])
        .map((m) => bouwHistoriekBericht(m))
        .filter(Boolean)
        .sort((a, b) => (a.tijdstip < b.tijdstip ? -1 : 1));

      return {
        berichten,
        // De chat bestaat en is gevonden, maar draagt niets. Dat is iets anders
        // dan 'niet gevonden': hier is niets misgegaan, er is alleen niets
        // gesynchroniseerd naar dit apparaat.
        leeg   : berichten.length === 0,
        vorm   : gebruikteVorm,
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
