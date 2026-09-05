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
import { maakTellers, jidVorm } from './tellers.js';
import { maakLidkaart } from './lidkaart.js';

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

  // ── Wat kan de whatsapp-web.js die hier daadwerkelijk draait? ────────────
  // Niet aannemen. De vorige ronde bouwde op getCurrentLid(wid) en die leverde
  // 0 van 28 op, zónder fout — dan weet je nog steeds niets: bestond de functie
  // niet, of gaf ze niets terug? Vandaar dat hier nu de FUNCTIENAMEN worden
  // opgesomd. Dat zijn namen uit een library, geen gegevens van iemand, dus die
  // mogen gewoon in het log en in /status.
  const kunde = {
    onderzocht: false,
    fout: null,
    modules: {},          // welke Store-onderdelen bestaan
    lidutils_keys: [],    // de functienamen die LidUtils aanbiedt
    contact_keys: [],     // idem voor ContactMethods
  };

  async function tastKundeAf() {
    if (kunde.onderzocht) return kunde;
    try {
      const uit = await client.pupPage.evaluate(() => {
        const namen = (o) => {
          try {
            const uit = [];
            for (const k in o) { try { if (typeof o[k] === 'function') uit.push(k); } catch (_) {} }
            return uit.sort();
          } catch (_) { return []; }
        };
        const S = window.Store || {};
        return {
          modules: {
            LidUtils      : !!S.LidUtils,
            ContactMethods: !!S.ContactMethods,
            WidFactory    : typeof S.WidFactory?.createWid === 'function',
            WidToJid      : typeof S.WidToJid?.widToUserJid === 'function',
            QueryExist    : typeof S.QueryExist === 'function',
            Contact       : typeof S.Contact?.getModelsArray === 'function',
            Chat          : typeof S.Chat?.getModelsArray === 'function',
            NumberInfo    : !!S.NumberInfo,
          },
          lidutils_keys: namen(S.LidUtils),
          contact_keys : namen(S.ContactMethods),
        };
      });
      Object.assign(kunde, uit, { onderzocht: true, fout: null });
      // Functienamen van een library — dit mag in het log, en het is precies
      // wat we de vorige ronde hadden willen zien.
      console.log('[brug] LidUtils biedt:', kunde.lidutils_keys.join(', ') || '(niets)');
      console.log('[brug] Store-onderdelen:',
        Object.entries(kunde.modules).filter(([, v]) => v).map(([k]) => k).join(', ') || '(niets)');
    } catch (e) {
      kunde.onderzocht = true;
      kunde.fout = 'aftasten faalde: ' + (e?.message || 'onbekend');
      console.warn('[brug]', kunde.fout);
    }
    return kunde;
  }

  /**
   * De LID die WhatsApp aan dit telefoonnummer hangt — via getCurrentLid.
   *
   * Deze weg leverde 0 van 28 op. Hij blijft staan omdat hij op een andere
   * versie wél kan werken, maar hij is niet langer de enige: bouwLidkaart()
   * valt terug op de contactenlijst als hier niets uit komt.
   *
   * De wid-variant die voor de hand ligt is wat hier al draait: createWid()
   * en dan het wid-object doorgeven, niet de string. Voor de zekerheid
   * probeert dit nu allebei, en de teller zegt welke iets opleverde.
   */
  async function zoekLidVoor(nummer) {
    const chatId = naarChatId(nummer);
    if (!chatId) return null;
    await tastKundeAf();
    if (!kunde.modules.LidUtils || typeof kunde.lidutils_keys?.includes !== 'function') return null;
    if (!kunde.lidutils_keys.includes('getCurrentLid')) return null;
    return client.pupPage.evaluate((id) => {
      const uitpakken = (v) => {
        if (!v) return null;
        if (typeof v === 'string') return v;
        return v._serialized || v.user || null;
      };
      try {
        const S = window.Store;
        // Eerst het wid-object, dan de kale string. Welke van de twee werkt is
        // niet uit de bron af te leiden, dus proberen we ze allebei.
        try {
          const wid = S.WidFactory.createWid(id);
          const uit = uitpakken(S.LidUtils.getCurrentLid(wid));
          if (uit) return uit;
        } catch (_) { /* volgende vorm */ }
        try {
          const uit = uitpakken(S.LidUtils.getCurrentLid(id));
          if (uit) return uit;
        } catch (_) { /* op */ }
        return null;
      } catch (_) { return null; }
    }, chatId);
  }

  /**
   * TWEEDE WEG: de koppelingen uit de contactenlijst halen.
   *
   * Als WhatsApp geen functie aanbiedt die nummer naar LID vertaalt, dan staat
   * die koppeling misschien gewoon op de contact-modellen zelf — een contact
   * dat onder een LID bekend is draagt vaak ook zijn telefoonnummer, of
   * omgekeerd.
   *
   * DE LEADLIJST BLIJFT DE GRENS, en dat is hier geen formaliteit: de
   * contactenlijst bevat álle contacten van dat toestel, dus ook Daves
   * privécontacten. Daarom gebeurt het filteren BINNEN de pagina: de lijst met
   * toegestane nummers gaat erin, en er komen alleen paren uit waarvan het
   * telefoonnummer daarop staat. Over wie er niet op staat komt niets terug —
   * niet als paar, niet als naam, niet als aantal per persoon. Alleen een
   * totaaltelling van hoeveel contacten er bekeken zijn.
   */
  async function zoekLidsUitContacten(nummers) {
    await tastKundeAf();
    if (!kunde.modules.Contact) return { paren: [], bekeken: 0, met_lid: 0 };
    return client.pupPage.evaluate((toegestaan) => {
      const toestaan = new Set(toegestaan);
      const cijfers = (v) => String(v == null ? '' : v).replace(/\D/g, '');
      const deel = (v) => {
        if (!v) return { user: '', server: '' };
        if (typeof v === 'string') {
          const st = v.split('@');
          return { user: cijfers(st[0]), server: (st[1] || '').toLowerCase() };
        }
        return { user: cijfers(v.user), server: String(v.server || '').toLowerCase() };
      };
      const paren = [];
      let bekeken = 0, metLid = 0;
      try {
        for (const c of window.Store.Contact.getModelsArray()) {
          bekeken += 1;
          const eigen = deel(c?.id);
          // Wat er nog meer aan identiteit op het model hangt. Verschillende
          // versies noemen dat anders, dus we kijken naar alle drie.
          const ander = deel(c?.lid || c?.phoneNumber || c?.altId || null);
          let telefoon = eigen.server === 'c.us' ? eigen.user : (ander.server === 'c.us' ? ander.user : '');
          let lid      = eigen.server === 'lid'  ? eigen.user : (ander.server === 'lid'  ? ander.user : '');
          if (lid) metLid += 1;
          if (!telefoon || !lid) continue;
          // HIER is de grens: alleen wat op de leadlijst staat verlaat de pagina.
          if (!toestaan.has(telefoon)) continue;
          paren.push([telefoon, lid]);
        }
      } catch (_) { /* wat we hebben, hebben we */ }
      return { paren, bekeken, met_lid: metLid };
    }, nummers);
  }

  /**
   * De probe: wat levert élke variant op voor één bekend nummer?
   *
   * Dit is het gereedschap dat we de vorige twee rondes misten. In plaats van
   * één weg te kiezen en te hopen, draait dit ze allemaal en zegt per stuk of
   * er iets uit kwam en hoe lang dat was. Geen waarden, alleen vormen — precies
   * dezelfde afspraak als bij de tellers.
   *
   * Het nummer MOET op de leadlijst staan. Anders zou deze route een manier
   * worden om over een willekeurig nummer iets te weten te komen, en dat is
   * exact wat het filter moet voorkomen.
   */
  async function probeerLid(nummer) {
    const n = normaliseerNummer(nummer);
    if (!n) { const e = new Error('nummer onleesbaar'); e.code = 'NUMMER_ONGELDIG'; throw e; }
    if (!leadlijst.mag(n)) { const e = new Error('niet op de leadlijst'); e.code = 'NIET_TOEGESTAAN'; throw e; }
    if (!staat.verbonden) { const e = new Error('niet verbonden'); e.code = 'NIET_VERBONDEN'; throw e; }
    await tastKundeAf();

    const chatId = naarChatId(n);
    const paginaUit = await client.pupPage.evaluate((id) => {
      const S = window.Store || {};
      const vorm = (v) => {
        if (v === null || v === undefined) return 'niets';
        if (typeof v === 'string') {
          const st = v.split('@');
          return (st[1] || 'geen_domein') + '/' + String(st[0]).replace(/\D/g, '').length;
        }
        if (typeof v === 'object') {
          const server = String(v.server || v._serialized?.split('@')[1] || 'onbekend');
          const user = String(v.user || v._serialized?.split('@')[0] || '').replace(/\D/g, '');
          return server + '/' + user.length;
        }
        return typeof v;
      };
      const poging = (naam, fn) => {
        try { return { naam, uit: vorm(fn()) }; }
        catch (e) { return { naam, uit: 'fout' }; }
      };

      const pogingen = [];
      let wid = null;
      try { wid = S.WidFactory.createWid(id); } catch (_) { /* dan zonder */ }

      pogingen.push(poging('getCurrentLid(wid)', () => S.LidUtils.getCurrentLid(wid)));
      pogingen.push(poging('getCurrentLid(string)', () => S.LidUtils.getCurrentLid(id)));
      pogingen.push(poging('Contact.get(wid).id', () => S.Contact.get(wid)?.id));
      pogingen.push(poging('Contact.get(wid).lid', () => S.Contact.get(wid)?.lid));
      pogingen.push(poging('Contact.get(wid).phoneNumber', () => S.Contact.get(wid)?.phoneNumber));
      pogingen.push(poging('Chat.get(wid).id', () => S.Chat.get(wid)?.id));
      pogingen.push(poging('ContactMethods.getUserid', () => S.ContactMethods.getUserid(S.Contact.get(wid))));

      // Alle sleutels op het contact-model waar 'lid' in voorkomt. Namen van
      // velden, geen waarden.
      let veldnamen = [];
      try {
        const c = S.Contact.get(wid);
        if (c) {
          for (const k in c) { try { if (/lid|phone|number/i.test(k)) veldnamen.push(k); } catch (_) {} }
          veldnamen = [...new Set(veldnamen)].sort();
        }
      } catch (_) { /* laat maar */ }

      return { pogingen, contact_veldnamen: veldnamen, contact_gevonden: (() => {
        try { return !!S.Contact.get(wid); } catch (_) { return false; }
      })() };
    }, chatId);

    return { kunde: { ...kunde }, ...paginaUit };
  }

  /** De kaart opnieuw opbouwen. Fail-soft: een fout laat de vorige kaart staan. */

  async function bouwLidkaart() {
    if (!staat.verbonden) return;
    try {
      const nummers = typeof leadlijst.nummers === 'function' ? leadlijst.nummers() : [];
      await tastKundeAf();

      // Weg 1: de functie die WhatsApp ervoor heeft. Leverde op deze versie
      // 0 van 28 op, maar hij blijft eerst omdat hij het meest direct is.
      const uit = await lidkaart.bouw(nummers, zoekLidVoor);
      kaartBron = uit.gevonden > 0 ? 'getCurrentLid' : null;

      // Weg 2: de contactenlijst. Alleen als weg 1 niets opleverde — anders
      // lopen we elke ronde onnodig door alle contacten.
      let scan = null;
      if (uit.gevonden === 0) {
        scan = await zoekLidsUitContacten(nummers);
        if (scan.paren.length > 0) {
          const kaart = new Map(scan.paren);
          const tweede = await lidkaart.bouw(nummers, async (n) => kaart.get(n) || null);
          if (tweede.gevonden > 0) kaartBron = 'contactenlijst';
        }
      }

      // Alleen aantallen. Nooit een nummer of een LID.
      console.log('[brug] lidkaart:', lidkaart.status().koppelingen, 'van', nummers.length,
        'nummers gekoppeld via', kaartBron || 'geen enkele weg');
      if (scan) {
        console.log('[brug] contactenlijst bekeken:', scan.bekeken, 'contacten,',
          scan.met_lid, 'met een lid-identiteit,', scan.paren.length, 'op de leadlijst');
        laatsteScan = { bekeken: scan.bekeken, met_lid: scan.met_lid, op_leadlijst: scan.paren.length };
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
      // Eerst weten WIE dit is — een jid is niet altijd een telefoonnummer —
      // en dan pas filteren. Zie bepaalNummer(): dit leest de envelop, en het
      // filter staat nog altijd vóór elk gebruik van nummer of tekst.
      const nummer = await bepaalNummer(van);
      // FILTER. Alles hieronder raakt de tekst aan.
      if (!leadlijst.mag(nummer)) { negeer('message', 'niet_op_leadlijst', van); return; }
      tellers.liet('message');
      await webhook.duw({
        soort    : 'antwoord_ontvangen',
        nummer,
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
      if (msg?.fromMe !== true) { negeer('message_create', 'niet_van_ons', msg?.to); return; }
      if (isGroep(msg?.to)) { negeer('message_create', 'groep', msg?.to); return; }
      // Eerst de identiteit oplossen, dan filteren. Zonder deze stap filteren we
      // op de cijfers van een LID, en die staan nergens op de leadlijst.
      const nummer = await bepaalNummer(msg?.to);
      // FILTER, en pas hierna wordt het nummer of de tekst ergens voor gebruikt.
      if (!leadlijst.mag(nummer)) { negeer('message_create', 'niet_op_leadlijst', msg?.to); return; }
      const g = bouwUitgaandeGebeurtenis(msg);
      if (!g) { negeer('message_create', 'onbruikbaar', msg?.to); return; }
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
      const g = bouwAckGebeurtenis(msg, ack);
      // ACK_SOORT kent -1 en 0 niet: dat zijn statussen die nog niets zeggen.
      if (!g) { negeer('message_ack', 'geen_ack_soort', jid); return; }
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
    lidkaartStatus: () => lidkaart.status(),
    /** Wat de geïnstalleerde whatsapp-web.js blijkt te kunnen. Functienamen. */
    lidKunde: () => ({ ...kunde }),
    /** Langs welke weg de kaart gevuld is, en wat de contactscan zag. */
    lidBron: () => ({ bron: kaartBron, scan: laatsteScan }),
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
      const chatId = chatIdVoor(nummer);
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
      // Eerst de chat waar we dit nummer echt gezien hebben (kan een LID zijn),
      // daarna pas de gewone @c.us-vorm. Andersom zou een LID-gesprek altijd
      // 'geen gesprek gevonden' opleveren terwijl het er gewoon is.
      // Alle vormen waaronder dit gesprek kan staan, in volgorde van
      // betrouwbaarheid: wat we bij een echt bericht zagen, de LID uit de
      // kaart, en de gewone @c.us-vorm.
      const lid = lidkaart.lidVoorNummer(normaliseerNummer(nummer));
      const kandidaten = [...new Set([
        chatIdVoor(nummer),
        lid ? lid + '@lid' : null,
        naarChatId(nummer),
      ].filter(Boolean))];
      if (kandidaten.length === 0) { const e = new Error('nummer mist een landcode'); e.code = 'NUMMER_ONGELDIG'; throw e; }

      const n = Math.max(1, Math.min(200, Number(limiet) || 50));
      let chat = null;
      for (const kandidaat of kandidaten) {
        try { chat = await client.getChatById(kandidaat); if (chat) break; } catch (_) { /* volgende */ }
      }
      // Geen van de kandidaten leverde een chat op. Dat is geen storing maar
      // 'dit gesprek staat niet op dit apparaat' — ChatFactory struikelt bij een
      // onbekende chat over undefined, en dat vangt de lus hierboven al af.
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
