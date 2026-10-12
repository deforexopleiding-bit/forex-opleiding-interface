// api/inbox-uitgesteld.js
//
// Een geparkeerd bericht nú versturen, of terughalen.
//
//   POST { id, actie: 'nu' }        → verstuur meteen
//   POST { id, actie: 'annuleer' }  → haal terug, en geef de tekst terug
//
// ── WIE ROEPT WAT AAN ────────────────────────────────────────────────────────
// 'nu' wordt door het scherm aangeroepen op twee momenten: als de dertig
// seconden om zijn (het normale geval — daarom is het venster exact dertig
// seconden en niet "ergens in de volgende minuut"), en als iemand op "Nu
// versturen" drukt omdat hij niet wil wachten.
//
// 'annuleer' is de knop "Toch niet". Die geeft de tekst terug, zodat het scherm
// hem terug in het veld kan zetten — je had hem net getypt, het zou raar zijn
// als hij verdwijnt omdat je je bedacht.
//
// ── WAT ER NOOIT GEBEURT ─────────────────────────────────────────────────────
// Twee keer versturen. Beide acties gaan via een claim die alleen slaagt als de
// rij nog op 'gepland' staat én nog van niemand is. Drukt het scherm op 'nu'
// terwijl de cron hem net oppakte, dan krijgt er één een rij en de ander niets —
// en die ander zegt eerlijk wat er aan de hand is.
//
// Annuleren ná de claim lukt niet, en dat is met opzet: op dat moment is het
// bericht ónderweg. Een knop die zegt dat hij het tegenhield terwijl de klant
// het al heeft, is erger dan een knop die zegt dat het te laat is.
//
// En er is geen actie om een mislukte of onbekende rij opnieuw te laten
// versturen. Die rij is een EINDSTAND. Wil je het bericht alsnog sturen, dan
// zet het scherm de tekst terug in het veld en doe je het als nieuw bericht —
// met je ogen open, en bij 'onbekend' nadat je de draad hebt nagekeken. Zie de
// uitleg bij sluitHangendeClaimsAf() in _lib/inbox-uitgesteld.js.

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';
import { gesprekkenV2Aan } from './_lib/gesprekken-vlag.js';
import { UUID_RE } from './_lib/inbox-verzendopdracht.js';
import { verstuurInGesprek } from './_lib/inbox-verzenden.js';
import {
  claim, annuleer, uitWachtrij,
  markeerMetaAangeroepen, markeerVerstuurd, markeerMislukt, markeerOnbekend,
} from './_lib/inbox-uitgesteld.js';

const ACTIES = ['nu', 'annuleer'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const hasFinanceSend    = await requirePermission(req, 'finance.inbox.send');
  const hasSimoneUse      = hasFinanceSend ? true : await requirePermission(req, 'events.simone.use');
  const hasOnboardingSend = (hasFinanceSend || hasSimoneUse)
    ? true : await requirePermission(req, 'onboarding.inbox.send');
  if (!hasFinanceSend && !hasSimoneUse && !hasOnboardingSend) {
    return res.status(403).json({ error: 'Geen rechten (finance.inbox.send, events.simone.use of onboarding.inbox.send)' });
  }

  if (!gesprekkenV2Aan()) {
    return res.status(404).json({ error: 'Uitgesteld versturen staat uit (GESPREKKEN_V2)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const id = String(body.id || '').trim();
  const actie = String(body.actie || '').trim().toLowerCase();
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });
  if (!ACTIES.includes(actie)) {
    return res.status(400).json({ error: `actie moet '${ACTIES.join("' of '")}' zijn` });
  }

  // Of de claim gelukt is. Bepaalt wat de catch hieronder nog mag doen: een rij
  // die nooit geclaimd werd, is niet van ons om af te sluiten.
  let geclaimd = false;
  // Of de stempel "wij gaan nu aanbieden" staat. Bepaalt of een onverwachte
  // fout 'mislukt' (zeker niets vertrokken) of niets mag zeggen.
  let aangeboden = false;

  try {
    if (actie === 'annuleer') {
      const teruggehaald = await annuleer(id, `teruggehaald door ${user.id}`);
      if (!teruggehaald) {
        // Al geclaimd, al verstuurd, of al geannuleerd. In alle drie de
        // gevallen is "het is teruggehaald" een onwaarheid.
        return res.status(409).json({
          error: 'te_laat',
          message: 'Dit bericht is al onderweg of al afgehandeld — terughalen kan niet meer.',
        });
      }
      return res.status(200).json({
        ok: true,
        // De tekst terug, zodat het scherm 'm in het veld kan zetten.
        mode: teruggehaald.mode,
        body: teruggehaald.body || '',
        template_name: teruggehaald.template_name || null,
      });
    }

    // actie === 'nu'
    const rij = await claim(id);
    if (!rij) {
      return res.status(409).json({
        error: 'al_opgepakt',
        message: 'Dit bericht wordt al verstuurd of is al afgehandeld.',
      });
    }
    geclaimd = true;

    const uitkomst = await verstuurInGesprek(
      uitWachtrij(rij),
      { hasFinanceSend, hasSimoneUse, hasOnboardingSend },
      rij.aangemaakt_door || user.id,
      {
        ip: getClientIp(req),
        // Vlak voor de transportlaag: leg vast dat we het gaan aanbieden.
        // Lukt dat niet, dan bieden we het ook niet aan — dan is "er is niets
        // vertrokken" nog een waarheid die we kunnen opschrijven.
        voorAflevering: async () => {
          aangeboden = await markeerMetaAangeroepen(id);
          return aangeboden;
        },
      },
    );

    if (uitkomst.ok) {
      await markeerVerstuurd(id, uitkomst.payload?.meta_wamid || null);
      return res.status(200).json({ ok: true, ...uitkomst.payload });
    }

    // Niet gelukt. WELKE eindstand hangt af van wat we weten — en dat is de
    // hele reden dat leverAfBijMeta een `zekerheid` meegeeft.
    //
    //   'geweigerd' -> mislukt : een duidelijke weigering (4xx met een echte
    //                            providercode: 131047 buiten het venster,
    //                            131026 niet bezorgbaar, 100 ongeldig), of een
    //                            weigering van ons zelf vóór het aanbieden.
    //                            Er is niets vertrokken; opnieuw sturen is
    //                            veilig.
    //   'onzeker'   -> onbekend: timeout, netwerkfout, 5xx, of een 4xx zonder
    //                            leesbare code. Het verzoek kan de overkant
    //                            wél bereikt hebben. 'mislukt' zeggen zou een
    //                            zekerheid beweren die we niet hebben.
    const reden = uitkomst.payload?.message || uitkomst.payload?.error || 'onbekende fout';
    if (uitkomst.zekerheid === 'onzeker') {
      await markeerOnbekend(id, `Het versturen gaf geen duidelijk antwoord (${reden}). Wij weten NIET of de klant dit bericht heeft gekregen — kijk de draad na voordat je het opnieuw stuurt.`);
    } else {
      await markeerMislukt(id, reden);
    }
    return res.status(uitkomst.http).json(uitkomst.payload);
  } catch (e) {
    console.error('[inbox-uitgesteld]', actie, id, e?.message || e);
    // Een uitzondering nádat we hebben aangeboden is precies het geval waarvoor
    // 'onbekend' bestaat: wij weten niet wat de transportlaag ermee deed. Die
    // rij laten we met rust — de opruimer in de cron sluit hem over vijf
    // minuten af als 'onbekend', en dan staat er in het scherm wat er aan de
    // hand is. Hem hier op 'mislukt' zetten zou een zekerheid beweren die we
    // niet hebben, en iemand uitnodigen het nog eens te sturen.
    if (geclaimd && !aangeboden) {
      try { await markeerMislukt(id, e?.message || 'onbekende fout'); } catch (_) { /* al gemeld */ }
    }
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
