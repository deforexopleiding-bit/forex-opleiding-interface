// services/whatsapp-brug/server.js
//
// De WhatsApp-brug voor de opvolgmodule.
//
// Draait NIET op Vercel. Dit is een zelfstandige service op een eigen VPS,
// omdat whatsapp-web.js een echte browser en een blijvende sessie nodig heeft —
// allebei onmogelijk in een serverless functie die na elke aanvraag verdwijnt.
// Zie README.md voor de installatie.
//
// Endpoints, allemaal achter het gedeelde geheim (en een IP-allowlist als die
// gezet is):
//   GET  /status  — verbonden ja of nee, welk nummer, wanneer laatst iets gezien
//   GET  /qr      — de actuele QR als dataURL, zolang er nog niet gekoppeld is
//   POST /send    — { nummer, tekst }
//
// En de brug duwt zelf gebeurtenissen naar het CRM: verzonden, afgeleverd,
// gelezen, antwoord ontvangen.
//
// PRIVACY
// Elke vijf minuten haalt de brug bij het CRM de lijst met bekende leadnummers
// op. Elk gesprek met een nummer dat daar niet in staat wordt genegeerd: niet
// doorgestuurd, niet gelogd, niet onthouden. Daves privécontacten lopen over
// dezelfde telefoon en die mogen deze service niet verlaten. Het filter staat
// in lib/whatsapp.js, vóór de eerste regel die een tekst aanraakt.

import express from 'express';
import { laadConfig } from './lib/config.js';
import { maakAuth } from './lib/auth.js';
import { maakLeadlijst } from './lib/leadlijst.js';
import { maakWebhook } from './lib/webhook.js';
import { maakWhatsapp } from './lib/whatsapp.js';
import { maakHartslag } from './lib/hartslag.js';

const cfg = laadConfig();
const leadlijst = maakLeadlijst(cfg);
const webhook = maakWebhook(cfg);
const wa = maakWhatsapp({ cfg, leadlijst, webhook });

// ── De hartslag ────────────────────────────────────────────────────────────
// De brug meldt zelf dat hij leeft, in plaats van te wachten tot iemand het
// hem vraagt. Alleen het feit dat hij leeft plus tellingen — nooit een nummer
// en nooit berichttekst. Zie lib/hartslag.js.
const hartslag = maakHartslag({
  duw  : (g) => webhook.duwNaar(cfg.hartslagPad, g),
  stand: () => {
    const t = wa.tellers ? wa.tellers() : {};
    const som = (o) => Object.values(o || {}).reduce((n, v) => n + (Number(v) || 0), 0);
    return {
      verbonden  : wa.staat.verbonden,
      gezien     : som(t.gezien),
      doorgelaten: som(t.doorgelaten),
      sinds      : wa.staat.laatsteActie || null,
      herverbinden: wa.herverbindStand ? wa.herverbindStand() : null,
    };
  },
  intervalMs: cfg.hartslagIntervalMs,
  log: (...a) => console.warn(...a),
});
// Zodat een verbroken verbinding op het moment zelf gemeld wordt.
wa.zetMelder((soort, extra) => hartslag.meld(soort, extra));

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

const auth = maakAuth(cfg);

// Losse levenscheck zonder geheim, zodat een monitor of systemd kan zien dat
// het proces draait. Verklapt niets: geen nummer, geen status, geen QR.
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

app.get('/status', auth, (_req, res) => {
  res.json({
    verbonden      : wa.staat.verbonden,
    // Ziet deze brug uitgaande berichten en hun type? Het CRM gebruikt dit om
    // te bepalen of het spraakberichten-blok echte cijfers heeft. Ontbreekt de
    // vlag, dan draait er een oudere brug en toont het CRM 'nog niet gemeten'.
    ziet_uitgaand  : wa.staat.ziet_uitgaand === true,
    nummer         : wa.staat.nummer,
    laatste_actie  : wa.staat.laatsteActie,
    wacht_op_qr    : !wa.staat.verbonden && !!wa.staat.qrDataUrl,
    laatste_fout   : wa.staat.laatsteFout,
    leadlijst      : leadlijst.status(),
    webhook        : webhook.status(),
    // Meten zonder te kijken: aantallen per gebeurtenis en per reden waarom er
    // iets afvalt. Nooit een nummer, nooit tekst. Zie lib/tellers.js.
    gebeurtenissen : wa.tellers(),
    // Hoeveel gesprekken we onder een andere identiteit dan een telefoonnummer
    // kennen. Alleen een aantal — de kaart zelf blijft binnen.
    nummerkaart    : wa.nummerkaartAantal(),
    // De LID-kaart uit de leadlijst, en wat de geïnstalleerde whatsapp-web.js
    // blijkt te kunnen. Aantallen en booleans; nooit een nummer of een LID.
    lidkaart       : wa.lidkaartStatus(),
    lid_kunde      : wa.lidKunde(),
    lid_bron       : wa.lidBron(),
  });
});

app.get('/qr', auth, (_req, res) => {
  if (wa.staat.verbonden) return res.json({ gekoppeld: true, qr: null });
  if (!wa.staat.qrDataUrl) {
    return res.status(503).json({ gekoppeld: false, qr: null, melding: 'Nog geen QR — de client start op. Probeer het over enkele seconden opnieuw.' });
  }
  res.json({ gekoppeld: false, qr: wa.staat.qrDataUrl, sinds: wa.staat.qrSindsIso });
});

app.post('/send', auth, async (req, res) => {
  const nummer = req.body?.nummer;
  const tekst  = req.body?.tekst;
  if (!nummer) return res.status(400).json({ error: 'nummer ontbreekt' });
  if (typeof tekst !== 'string' || !tekst.trim()) return res.status(400).json({ error: 'tekst ontbreekt' });
  try {
    const uit = await wa.stuur(nummer, tekst);
    res.json({ ok: true, ...uit });
  } catch (e) {
    // Het nummer staat niet op de leadlijst → 403, en met opzet zonder verdere
    // uitleg: of een nummer wel of niet bekend is, is zelf ook informatie.
    if (e?.code === 'NIET_TOEGESTAAN')  return res.status(403).json({ error: 'Niet toegestaan' });
    if (e?.code === 'NIET_VERBONDEN')   return res.status(503).json({ error: 'De brug is niet verbonden met WhatsApp' });
    if (e?.code === 'NUMMER_ONGELDIG')  return res.status(400).json({ error: 'Nummer mist een landcode' });
    // Anders dan NUMMER_ONGELDIG: dit nummer IS geprobeerd. De kandidaten zijn
    // aan WhatsApp voorgelegd en geen ervan bestaat daar. Dat is iets wat Dave
    // kan oplossen door het nummer aan te vullen, en dat moet de melding zeggen
    // — 'ongeldig nummer' laat hem denken dat de brug stuk is.
    if (e?.code === 'LANDCODE_ONBEKEND') return res.status(400).json({
      error: 'Dit nummer staat lokaal genoteerd (zonder landcode) en WhatsApp herkent ' +
             'geen van de landcodes die we geprobeerd hebben. Vul het nummer aan met de ' +
             'juiste landcode, dan kan er weer verstuurd worden.',
      code : 'LANDCODE_ONBEKEND',
    });
    console.error('[brug] versturen faalde:', e?.message || e);
    res.status(500).json({ error: 'Versturen mislukt' });
  }
});

// De geschiedenis van één gesprek, zoals WhatsApp die naar dit apparaat heeft
// gesynct. LEZEN, niet schrijven: de brug geeft terug en het CRM beslist wat
// het bewaart. Zo blijft er één plek waar rijen ontstaan.
//
// Het filter zit in wa.historiek() en staat daar vóór de chatstore aangeraakt
// wordt. Een nummer buiten de leadlijst krijgt 403 zonder verdere uitleg — net
// als bij /send, want of een nummer bekend is, is zelf ook informatie.
app.get('/historiek', auth, async (req, res) => {
  const nummer = req.query?.nummer;
  if (!nummer) return res.status(400).json({ error: 'nummer ontbreekt' });
  try {
    // bericht_id is optioneel: het CRM kent van dit nummer al een bericht en
    // geeft dat mee, zodat de brug de chat ook langs die weg kan vinden.
    const uit = await wa.historiek(nummer, req.query?.limiet, req.query?.bericht_id || null);
    res.json({ ok: true, ...uit });
  } catch (e) {
    if (e?.code === 'NIET_TOEGESTAAN') return res.status(403).json({ error: 'Niet toegestaan' });
    if (e?.code === 'NIET_VERBONDEN')  return res.status(503).json({ error: 'De brug is niet verbonden met WhatsApp' });
    if (e?.code === 'NUMMER_ONGELDIG') return res.status(400).json({ error: 'Nummer mist een landcode' });
    // Drie uitkomsten die iets heel anders betekenen; alleen de laatste is een
    // echte fout. Ze delen daarom niet langer één code.
    if (e?.code === 'GEEN_KOPPELING') {
      return res.status(404).json({
        error: 'Dit nummer heeft geen LID-koppeling, en onder het nummer zelf bestaat er geen gesprek op dit apparaat',
        code : 'GEEN_KOPPELING',
        kandidaten: e.kandidaten ?? null,
      });
    }
    if (e?.code === 'GEEN_GESPREK') {
      return res.status(404).json({
        error: 'Het gesprek bestaat niet op dit apparaat',
        code : 'GEEN_GESPREK',
        kandidaten   : e.kandidaten ?? null,
        chats_bekeken: e.chats_bekeken ?? null,
      });
    }
    console.error('[brug] historiek ophalen faalde:', e?.message || e);
    res.status(500).json({ error: 'Ophalen mislukt' });
  }
});

// De LID-kaart nu opnieuw opbouwen, zonder te wachten op de volgende ronde.
// Handig direct na een herstart of nadat er leads bijgekomen zijn. Geeft alleen
// aantallen terug.
app.post('/lidkaart/herbouw', auth, async (_req, res) => {
  try {
    await wa.herbouwLidkaart();
    res.json({ ok: true, lidkaart: wa.lidkaartStatus(), lid_kunde: wa.lidKunde() });
  } catch (e) {
    console.error('[brug] lidkaart herbouwen faalde:', e?.message || e);
    res.status(500).json({ error: 'Herbouwen mislukt' });
  }
});

// De probe: draai alle varianten voor één nummer en zeg per stuk wat eruit
// kwam. Alleen vormen — een domein en een lengte — nooit een waarde.
//
// Het nummer moet op de leadlijst staan; anders zou deze route een manier
// worden om over een willekeurig nummer iets te weten te komen.
app.get('/lid/probe', auth, async (req, res) => {
  const nummer = req.query?.nummer;
  if (!nummer) return res.status(400).json({ error: 'nummer ontbreekt' });
  try {
    res.json({ ok: true, ...(await wa.lidProbe(nummer)) });
  } catch (e) {
    if (e?.code === 'NIET_TOEGESTAAN') return res.status(403).json({ error: 'Niet toegestaan' });
    if (e?.code === 'NIET_VERBONDEN')  return res.status(503).json({ error: 'De brug is niet verbonden met WhatsApp' });
    if (e?.code === 'NUMMER_ONGELDIG') return res.status(400).json({ error: 'Nummer onleesbaar' });
    console.error('[brug] lid-probe faalde:', e?.message || e);
    res.status(500).json({ error: 'Probe mislukt' });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'Onbekende route' }));

leadlijst.start();
wa.start();
hartslag.start();

const server = app.listen(cfg.port, cfg.bind, () => {
  console.log(`[brug] luistert op ${cfg.bind}:${cfg.port}`);
  console.log('[brug] CRM:', cfg.crmBase);
  console.log('[brug] IP-allowlist:', cfg.toegestaneIps.length ? cfg.toegestaneIps.join(', ') : '(uit)');
});

// Netjes afsluiten, zodat LocalAuth zijn sessie op schijf kan wegschrijven en
// een herstart geen nieuwe QR vraagt.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    console.log('[brug]', sig, 'ontvangen — afsluiten');
    leadlijst.stop();
    server.close();
    await wa.stop();
    process.exit(0);
  });
}
