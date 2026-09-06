// api/email-overzicht.js
// GET → read-only overzicht van ALLE e-mails/templates die de flow raakt, in 3
// categorieën, voor de Leadsonderhoud → E-mails-tab.
//
//   1) email_templates      (CRM-DB)          — bewerkbaar via de bestaande
//                                                email_templates-editor (Instellingen).
//   2) onderhoud_sjablonen  (gedeelde Supabase, kanaal='mail') — READ-ONLY hier
//                                                (toelating/afwijzing-mails van dfo-website).
//   3) code                 (statische catalogus) — hardcoded transactionele
//                                                mails; bewerkbaar:false.
//
// Permission: email.module.access. Read-only. Geen writes.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { MOMENTEN, bouwContext } from './_lib/afspraak-berichten.js';
import { annuleringMail, verzetMail } from './_lib/afspraak-status-notify.js';
import { mailBevestigingB } from './_lib/toegang-cron-mails.js';
import { renderCredentialsEmail } from './_lib/onboarding-credentials.js';
import { renderExtendAccessEmail } from './leadsonderhoud-extend-access.js';

// Echte HTML-previews voor code-mails, gerenderd via de bestaande builders met
// voorbeelddata. Puur (geen send/DB/env-afhankelijkheid). Fail-soft per builder:
// een throw → null, zodat één kapotte builder de rest (en de endpoint) niet raakt.
function codePreviews() {
  const html = (fn) => { try { return fn()?.html || null; } catch { return null; } };

  // Afspraak-mails (mail-shell-afspraak) met een voorbeeld-afspraak.
  const afspraak = (() => {
    try {
      const appt = {
        lead_name: 'Paco Voorbeeld',
        scheduled_at: new Date(Date.now() + 2 * 86400000).toISOString(),
        zoom_join_url: 'https://zoom.us/j/12345678',
        afspraak_token: 'voorbeeld-token',
        duration_minutes: 20,
      };
      const c = bouwContext(appt);
      const byKey = {};
      for (const m of MOMENTEN) byKey[m.key] = m;
      return {
        afspraak_bevestiging: html(() => byKey.bevestiging?.mail(appt, c)),
        afspraak_24u:         html(() => byKey.r24?.mail(appt, c)),
        afspraak_2u:          html(() => byKey.r2?.mail(appt, c)),
        afspraak_30m:         html(() => byKey.r30?.mail(appt, c)),
        afspraak_5min:        html(() => byKey.zoom5?.mail(appt, c)),
        afspraak_annulering:  html(() => annuleringMail(c)),
        afspraak_verzet:      html(() => verzetMail(c)),
      };
    } catch { return {}; }
  })();

  return {
    ...afspraak,
    // Welkom/onboarding-cron: representatieve welkom/bevestigings-mail (variant B,
    // zonder geboekte call). De cron rendert 'm via dezelfde pure builder.
    welkom_onboarding_cron: html(() => mailBevestigingB('Paco Voorbeeld')),
    // Onboarding-inloggegevens: exact zoals sendCredentialsEmail 'm verstuurt.
    onboarding_credentials: html(() => renderCredentialsEmail({
      customer: { first_name: 'Paco', email: 'paco@voorbeeld.nl' },
      tempPassword: 'Tijdelijk-AB12',
      loginUrl: 'https://dashboard.deforexopleiding.nl',
    })),
    // Toegang verlengd: exact zoals leadsonderhoud-extend-access.js 'm verstuurt.
    leadsonderhoud_extend: html(() => renderExtendAccessEmail({
      voornaam: 'Paco',
      einddatumNl: '31 december 2026',
    })),
  };
}

// Statische catalogus van code-mails (geen DB-registratie — handmatig bijhouden).
// Functionele categorieën (weergave-volgorde).
const CATEGORIE_LABELS = {
  kennismaking:     'Kennismakingsgesprekken (Zoom-calls)',
  'funnels-toegang':'Funnels & toegang',
  wanbetalers:      'Wanbetalers & incasso',
  events:           'Events',
  overig:           'Overig / systeem',
};

const CODE_CATALOG = [
  { key: 'afspraak_bevestiging',   categorie: 'kennismaking',     naam: 'Afspraak — bevestiging',        doel: 'Bevestiging kennismakingsgesprek', trigger: 'cron-afspraak-reminders (zodra Zoom-link binnen)', mailbox: 'welkom@',     bestand: 'api/_lib/afspraak-berichten.js' },
  { key: 'afspraak_24u',           categorie: 'kennismaking',     naam: 'Afspraak — reminder 24u',       doel: 'Herinnering 24u vooraf',           trigger: 'cron-afspraak-reminders',                          mailbox: 'welkom@',     bestand: 'api/_lib/afspraak-berichten.js' },
  { key: 'afspraak_2u',            categorie: 'kennismaking',     naam: 'Afspraak — reminder 2u',        doel: 'Herinnering 2u vooraf',            trigger: 'cron-afspraak-reminders',                          mailbox: 'welkom@',     bestand: 'api/_lib/afspraak-berichten.js' },
  { key: 'afspraak_30m',           categorie: 'kennismaking',     naam: 'Afspraak — reminder 30m',       doel: 'Herinnering 30m vooraf',           trigger: 'cron-afspraak-reminders',                          mailbox: 'welkom@',     bestand: 'api/_lib/afspraak-berichten.js' },
  { key: 'afspraak_5min',          categorie: 'kennismaking',     naam: 'Afspraak — join (5 min)',       doel: 'Join-link vlak vooraf',            trigger: 'cron-afspraak-reminders',                          mailbox: 'welkom@',     bestand: 'api/_lib/afspraak-berichten.js' },
  { key: 'afspraak_annulering',    categorie: 'kennismaking',     naam: 'Afspraak — annulering',         doel: 'Bevestiging annulering',           trigger: 'public-afspraak-annuleren / setter-annuleer',      mailbox: 'welkom@',     bestand: 'api/_lib/afspraak-status-notify.js' },
  { key: 'afspraak_verzet',        categorie: 'kennismaking',     naam: 'Afspraak — verzet',             doel: 'Bevestiging verzetting',           trigger: 'public-afspraak-verzetten / setter-wijzig',        mailbox: 'welkom@',     bestand: 'api/_lib/afspraak-status-notify.js' },
  { key: 'dunning_brief',          categorie: 'wanbetalers',      naam: 'Dunning — WIK-brief',           doel: '14-dagenbrief (PDF)',              trigger: 'UI/actie',                                         mailbox: 'administratie@', bestand: 'api/dunning-brief-email-send.js' },
  { key: 'dunning_bulk',           categorie: 'wanbetalers',      naam: 'Dunning — bulk',                doel: 'Bulk wanbetalers (tekst uit dunning-templates)', trigger: 'cron-dunning-bulk-send',              mailbox: 'administratie@', bestand: 'api/cron-dunning-bulk-send.js' },
  { key: 'incasso_dossier',        categorie: 'wanbetalers',      naam: 'Incassodossier',                doel: 'Dossier naar incassobureau (PDF)', trigger: 'UI',                                               mailbox: 'info@',       bestand: 'api/incasso-dossier-email.js' },
  { key: 'welkom_onboarding_cron', categorie: 'funnels-toegang',  naam: 'Welkom / onboarding-cron',      doel: 'Welkom + laatste-dag',             trigger: 'cron-toegang-aanvragen',                           mailbox: 'welkom@',     bestand: 'api/cron-toegang-aanvragen.js' },
  { key: 'onboarding_credentials', categorie: 'funnels-toegang',  naam: 'Onboarding — inloggegevens',    doel: 'Credentials-mail',                 trigger: 'onboarding-flow',                                  mailbox: 'onboarding@', bestand: 'api/_lib/onboarding-credentials.js' },
  { key: 'first_call_payment',     categorie: 'funnels-toegang',  naam: 'Eerste-call betaalreminder',    doel: 'Betaalreminder 24u vóór 1e call',  trigger: 'cron/first-call-payment-reminder',                 mailbox: 'onboarding@', bestand: 'api/cron/first-call-payment-reminder.js' },
  { key: 'events_mails',           categorie: 'events',           naam: 'Events — invites/vragenlijst/automations', doel: 'Event-mails',           trigger: 'UI + cron-events-automations',                     mailbox: 'events@',     bestand: 'api/_lib/events-send.js' },
  { key: 'lead_melding',           categorie: 'overig',           naam: 'Interne nieuwe-lead-melding',   doel: 'Interne melding bij nieuwe lead',  trigger: 'api/lead-melding.js (na lead)',                    mailbox: 'welkom@',     bestand: 'api/lead-melding.js' },
  // Volledigheid-ronde: lead/klant-gerichte verzenders die eerder ontbraken.
  { key: 'gesprek_mailantwoord',   categorie: 'kennismaking',     naam: 'Gesprek — handmatig mailantwoord', doel: 'Persoonlijk antwoord in de gesprekken-draad (vrije tekst)', trigger: 'UI (leadsonderhoud-gesprek → beantwoorden)',   mailbox: 'welkom@',     bestand: 'api/leadsonderhoud-gesprek-mailantwoord.js' },
  { key: 'leadsonderhoud_drip',    categorie: 'funnels-toegang',  naam: 'Leadsonderhoud — drip-motor',   doel: 'Opvolgmails per traject/warmte (sjablonen)', trigger: 'cron-leadsonderhoud (elk kwartier)',               mailbox: 'welkom@',     bestand: 'api/cron-leadsonderhoud.js' },
  { key: 'leadsonderhoud_bulk',    categorie: 'funnels-toegang',  naam: 'Leadsonderhoud — bulk-broadcast', doel: 'Bulk-mail/WA naar leadselectie', trigger: 'cron-leadsonderhoud-bulk-send (3-min tick, LIVE=1)', mailbox: 'welkom@',     bestand: 'api/cron-leadsonderhoud-bulk-send.js' },
  { key: 'leadsonderhoud_extend',  categorie: 'funnels-toegang',  naam: 'Toegang verlengd',              doel: 'Bevestiging verlengde cursustoegang', trigger: 'UI (leadsonderhoud → toegang verlengen)',      mailbox: 'info@',       bestand: 'api/leadsonderhoud-extend-access.js' },
  { key: 'onboarding_automations', categorie: 'overig',           naam: 'Onboarding — automation-mails', doel: 'Geconfigureerde automation-stappen (mail + interne melding)', trigger: 'cron onboarding-automations (enroll + stepper)', mailbox: 'onboarding@ / info@', bestand: 'api/_lib/onboarding-automation-engine.js' },
];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'email.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (email.module.access)' });
  }

  try {
    // 1) email_templates (CRM-DB, bewerkbaar).
    let dbTemplates = [];
    try {
      const { data: et } = await supabaseAdmin
        .from('email_templates')
        .select('id, name, subject, category, is_active, updated_at, body_html')
        .order('name', { ascending: true });
      dbTemplates = (et || []).map((t) => ({
        id: t.id,
        naam: t.name,
        categorie: 'overig',
        doel: t.category || 'algemeen',
        subject: t.subject || null,
        mailbox: 'compose (per verzending)',
        bron: 'email_templates',
        bewerkbaar: true,
        actief: t.is_active !== false,
        trigger: 'Compose-picker in de E-mail-module',
        preview_html: t.body_html || '',
      }));
    } catch (e) { console.warn('[email-overzicht] email_templates:', e?.message || e); }

    // 2) onderhoud_sjablonen (gedeelde Supabase, kanaal='mail', read-only).
    let sjablonen = [];
    try {
      const { data: os } = await supabaseAdmin
        .from('onderhoud_sjablonen')
        .select('id, soort, traject_slug, kanaal, onderwerp, html, actief')
        .eq('kanaal', 'mail')
        .order('soort', { ascending: true });
      const triggerVoor = (soort) => soort === 'toelating' ? 'Toelatingsmail (na WhatsApp-bevestiging, dfo-website)'
        : soort === 'afwijzing' ? 'Afwijzingsmail (na lead-quiz, dfo-website)'
        : 'Leadsonderhoud-mail (dfo-website)';
      sjablonen = (os || []).map((s) => ({
        id: s.id,
        naam: `${s.soort} · ${s.traject_slug}`,
        categorie: (s.soort === 'toelating' || s.soort === 'afwijzing' || s.soort === 'verlopen') ? 'funnels-toegang' : 'overig',
        doel: s.soort,
        subject: s.onderwerp || null,
        mailbox: 'Strato (dfo-website)',
        bron: 'onderhoud_sjablonen',
        bewerkbaar: false,
        actief: s.actief !== false,
        trigger: triggerVoor(s.soort),
        preview_html: s.html || '',
      }));
    } catch (e) { console.warn('[email-overzicht] onderhoud_sjablonen:', e?.message || e); }

    // 3) code-catalogus (statisch, read-only). Afspraak-mails krijgen een echte
    // HTML-preview via de gedeelde builders (voorbeelddata); overige code-mails
    // hebben geen veilige statische preview (inline/data-afhankelijk) → null.
    const previews = codePreviews();
    const code = CODE_CATALOG.map((c) => ({
      id: c.key, naam: c.naam, categorie: c.categorie, doel: c.doel, subject: null,
      mailbox: c.mailbox, bron: 'code', bewerkbaar: false, actief: true,
      trigger: c.trigger, bestand: c.bestand, preview_html: previews[c.key] || null,
    }));

    return res.status(200).json({
      ok: true,
      generated_at: new Date().toISOString(),
      categorie_labels: CATEGORIE_LABELS,
      categories: { email_templates: dbTemplates, onderhoud_sjablonen: sjablonen, code },
      totalen: { email_templates: dbTemplates.length, onderhoud_sjablonen: sjablonen.length, code: code.length },
    });
  } catch (e) {
    console.error('[email-overzicht]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Overzicht laden mislukt' });
  }
}
