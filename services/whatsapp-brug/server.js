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

const cfg = laadConfig();
const leadlijst = maakLeadlijst(cfg);
const webhook = maakWebhook(cfg);
const wa = maakWhatsapp({ cfg, leadlijst, webhook });

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
    console.error('[brug] versturen faalde:', e?.message || e);
    res.status(500).json({ error: 'Versturen mislukt' });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'Onbekende route' }));

leadlijst.start();
wa.start();

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
