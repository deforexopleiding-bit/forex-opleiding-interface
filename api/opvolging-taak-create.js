// api/opvolging-taak-create.js
//
// Fase 3a — een taak aanmaken vanuit het afronden van een call.
//
// Tot nu toe ontstonden taken alleen bij het afronden van een event (Punt B in
// api/_lib/events-complete-core.js). Een call die vraagt om een vervolg had
// nergens heen; dit endpoint sluit dat gat.
//
// POST { bron_ref, naam, email?, telefoon?, reden, due?, notitie?, badge_label?, bron?,
//        reden_code?, direct_archiveren?, archief_reden? }
//   reden 'wil_nog_beslissen' → due verplicht, notitie verplicht
//   reden 'no_show_call'      → due = vandaag als hij niet meegegeven is
//
// G2 (6 sep 2026) — `bron` is erbij gekomen, optioneel en met 'call' als
// standaard. Geen enkele bestaande aanroeper stuurt hem mee, dus voor die
// aanroepers verandert er letterlijk niets. Met bron 'handmatig' komt de weg
// erbij die de knop '+ Lead toevoegen' gebruikt: iemand die Dave zelf intypt,
// zonder call en zonder event erachter.
//
// Waarom hier en niet in een tweede endpoint: dit is dezelfde schrijfactie naar
// dezelfde tabel met dezelfde controles. Een kopie zou betekenen dat elke
// volgende regel over een verse taak op twee plekken onderhouden moet worden,
// en dat is precies hoe twee wegen stil uit elkaar gaan lopen.
//
// Schrijft uitsluitend in opvolging_taken en opvolging_pogingen. De
// afspraakrecords en /api/follow-up-appointment-outcome blijven ongemoeid: wat
// er met de afspraak zelf gebeurt is een andere administratie en die verandert
// hier niet.
//
// Idempotent op bron_ref.appointment_id: twee keer afronden levert geen tweede
// kaart op, maar werkt de bestaande bij. Dubbel klikken is geen fout van de
// gebruiker die hem een dubbele bellijst mag opleveren.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { bepaalStartPoging } from './_lib/opvolging-taak-poging.js';
import { normaliseerNummer } from './_lib/whatsapp-brug-nummers.js';

const REDENEN  = new Set(['wil_nog_beslissen', 'no_show_call', 'afgemeld', 'no_show_event', 'niet_ingepland']);
// 'aanmelding' staat wél in de CHECK-constraint maar bewust niet hierin: die
// reden is instroom uit de eventmodule en hoort niet met de hand gezet te
// worden. Zie migratie 2026-09-05-opvolging-aanmelding-en-wacht-verplaatsing.
const BRONNEN  = new Set(['call', 'handmatig']);
const BRON_SOURCE = { call: 'opvolging-call', handmatig: 'opvolging-handmatig' };
// Hoeveel open kaarten we bekijken voor de duplicaat-melding. Ruim boven wat
// deze module in de praktijk draagt (tientallen); de grens staat er zodat een
// uitgelopen tabel dit endpoint niet kan laten hangen.
const DUP_MAX  = 1000;
const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;
const ZONE     = 'Europe/Amsterdam';

const dagInZone = (ms) => new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(ms));

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const allowed = await requirePermission(req, 'opvolging.module.access');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (opvolging.module.access)' });

  const b = req.body || {};
  const naam = String(b.naam || '').trim();
  if (!naam) return res.status(400).json({ error: 'naam ontbreekt' });

  const reden = String(b.reden || '').trim();
  if (!REDENEN.has(reden)) return res.status(400).json({ error: 'onbekende reden' });

  // Zonder meegestuurde bron blijft alles precies zoals het was.
  const bron = b.bron != null ? String(b.bron).trim() : 'call';
  if (!BRONNEN.has(bron)) return res.status(400).json({ error: 'onbekende bron' });
  const handmatig = bron === 'handmatig';

  const notitie = b.notitie != null ? String(b.notitie).trim().slice(0, 2000) : '';
  // Bij 'wil nog beslissen' is de notitie het enige dat de volgende beller
  // vertelt waaróm er nog getwijfeld wordt. Zonder die zin is de taak een naam
  // en een datum, en begint het gesprek weer bij nul.
  if (reden === 'wil_nog_beslissen' && !notitie) {
    return res.status(400).json({ error: 'notitie is verplicht bij wil_nog_beslissen' });
  }
  // Bij een handmatige lead is de notitie het enige wat er staat. Er is geen
  // call aan voorafgegaan en geen event dat de context draagt; zonder die zin
  // is de kaart een naam en een nummer, en weet niemand — Dave over drie weken
  // incluis — waar dit vandaan kwam.
  if (handmatig && !notitie) {
    return res.status(400).json({ error: 'notitie is verplicht bij een handmatige lead' });
  }

  const vandaag = dagInZone(Date.now());
  let due = b.due != null ? String(b.due).trim() : '';
  if (due && !DATUM_RE.test(due)) return res.status(400).json({ error: 'due moet YYYY-MM-DD zijn' });
  if (reden === 'wil_nog_beslissen' && !due) {
    return res.status(400).json({ error: 'due is verplicht bij wil_nog_beslissen' });
  }
  if (handmatig && !due) {
    return res.status(400).json({ error: 'due is verplicht bij een handmatige lead' });
  }
  if (!due) due = vandaag;

  // Een handmatige lead zonder telefoonnummer is een kaart die niets kan: deze
  // module belt en stuurt WhatsApp, en allebei hangen ze aan het nummer. Bij de
  // andere bronnen blijft het optioneel — daar komt het nummer uit de afspraak
  // of het event, en een ontbrekend nummer is dáár een gegeven, geen invoerfout.
  const telefoon = b.telefoon ? String(b.telefoon).trim() : '';
  if (handmatig && !telefoon) {
    return res.status(400).json({ error: 'telefoon is verplicht bij een handmatige lead' });
  }

  const bronRef = (b.bron_ref && typeof b.bron_ref === 'object' && !Array.isArray(b.bron_ref)) ? b.bron_ref : {};
  const appointmentId = bronRef.appointment_id ? String(bronRef.appointment_id) : null;

  try {
    // Bestaat er al een open kaart voor deze afspraak? Dan bijwerken in plaats
    // van een tweede maken. Gearchiveerde kaarten zijn geschiedenis en tellen
    // hier niet mee — die blokkeren een nieuwe niet.
    let bestaandeId = null;
    if (appointmentId) {
      const { data, error } = await supabaseAdmin
        .from('opvolging_taken')
        .select('id')
        .neq('status', 'gearchiveerd')
        .filter('bron_ref->>appointment_id', 'eq', appointmentId)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) throw new Error('zoeken: ' + error.message);
      if (data && data[0]) bestaandeId = data[0].id;
    }

    // Q (6 sep 2026) — een kaart die meteen dicht mag.
    //
    // Bij 'geen interesse' na een Zoomcall hoeft er niets meer te gebeuren,
    // maar Daves reden moet wél bewaard blijven: die tekst is nu het enige wat
    // verloren gaat, en het rapport over zijn werk moet 'm straks kunnen lezen.
    // Zonder deze weg zou er een OPEN kaart ontstaan die morgen weer om
    // aandacht vraagt voor iemand die net nee gezegd heeft.
    const directArchiveren = b.direct_archiveren === true;
    const archiefReden = b.archief_reden != null ? String(b.archief_reden).trim().slice(0, 2000) : '';
    if (directArchiveren && !archiefReden) {
      return res.status(400).json({ error: 'archief_reden is verplicht bij direct_archiveren' });
    }

    const velden = {
      naam,
      email      : b.email ? String(b.email).trim() : null,
      telefoon   : telefoon || null,
      reden,
      bron,
      bron_ref   : { ...bronRef, source: BRON_SOURCE[bron] },
      badge_label: b.badge_label ? String(b.badge_label).slice(0, 200) : null,
      reden_code : b.reden_code ? String(b.reden_code).slice(0, 60) : null,
      due,
      later      : false,
      status     : directArchiveren ? 'gearchiveerd' : 'open',
      ...(directArchiveren ? {
        archief_reden  : archiefReden,
        gearchiveerd_at: new Date().toISOString(),
      } : {}),
      notitie    : notitie || null,
      eigenaar_id: null,   // RLS is is_crm_staff(); zonder eigenaar is de kaart van het team
    };

    let taakId = bestaandeId;
    if (bestaandeId) {
      const { error } = await supabaseAdmin.from('opvolging_taken')
        .update({ ...velden, updated_at: new Date().toISOString() })
        .eq('id', bestaandeId);
      if (error) throw new Error('bijwerken: ' + error.message);
    } else {
      const { data, error } = await supabaseAdmin.from('opvolging_taken')
        .insert(velden).select('id').single();
      if (error) throw new Error('aanmaken: ' + error.message);
      taakId = data.id;
    }

    // Krijgt deze taak meteen een belpoging mee? De regel staat in
    // _lib/opvolging-taak-poging.js — hier, en niet alleen in het scherm, zodat
    // een oud tabblad hem niet kan omzeilen. Kort: 'wil nog beslissen' wel (dat
    // gesprek is gevoerd), een no-show niet (er is niet gebeld).
    // Fail-soft: de taak is de actie, de poging is de historiek.
    const startPoging = bepaalStartPoging({ taakId, reden, resultaat: b.poging_resultaat });
    if (startPoging) {
      try {
        const { error } = await supabaseAdmin.from('opvolging_pogingen').insert(startPoging);
        if (error) throw new Error(error.message);
      } catch (e) {
        console.warn('[opvolging-taak-create] poging (soft):', e?.message || e);
      }
    }

    // Staat deze persoon er al? Melden, niet blokkeren.
    //
    // Twee keer dezelfde lead intypen is de voor de hand liggende misstap bij
    // een knop als deze, en die kost Dave een dubbele belronde. Tegenhouden is
    // hier tóch de verkeerde keuze: soms is er een echte tweede reden om
    // iemand terug te zetten, en een scherm dat 'nee' zegt zonder dat je kunt
    // zien waarom is erger dan een dubbele kaart. Dus: aanmaken, en erbij
    // zeggen wat er al stond.
    //
    // Fail-soft — de kaart is de actie, deze melding is een dienst.
    let duplicaat = null;
    if (handmatig && telefoon) {
      try {
        const staart = normaliseerNummer(telefoon);
        if (staart && staart.length >= 9) {
          const { data, error } = await supabaseAdmin
            .from('opvolging_taken')
            .select('id,naam,due,telefoon')
            .neq('status', 'gearchiveerd')
            .neq('id', taakId)
            .not('telefoon', 'is', null)
            .limit(DUP_MAX);
          if (error) throw new Error(error.message);
          // Vergelijken op de laatste negen cijfers: het CRM heeft nummers in
          // elke notatie die ooit is ingetypt, met en zonder landcode.
          const eind = staart.slice(-9);
          const hits = (data || []).filter((t) => {
            const c = normaliseerNummer(t.telefoon);
            return c && c.length >= 9 && c.slice(-9) === eind;
          });
          if (hits.length) {
            duplicaat = {
              aantal: hits.length,
              namen : hits.slice(0, 3).map((t) => t.naam),
              // Zaten we tegen de grens, dan hebben we niet alles gezien. Dat
              // hoort erbij te staan: 'geen dubbele gevonden' zou dan een
              // bewering zijn die we niet kunnen doen.
              volledig: (data || []).length < DUP_MAX,
            };
          }
        }
      } catch (e) {
        console.warn('[opvolging-taak-create] duplicaatcheck (soft):', e?.message || e);
      }
    }

    return res.status(200).json({ success: true, taak_id: taakId, hergebruikt: !!bestaandeId, duplicaat });
  } catch (e) {
    console.error('[opvolging-taak-create]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}
