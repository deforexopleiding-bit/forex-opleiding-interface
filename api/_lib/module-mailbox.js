// api/_lib/module-mailbox.js
//
// Welke mailbox hoort bij welke module? Eén map, drie gebruikers.
//
// ── WAAROM DIT EEN EIGEN BESTAND IS ─────────────────────────────────────────
// Deze map stond in tweevoud, met in `inbox-email-mark-read.js` dit erboven:
//
//     // Zelfde map als in email-unread-per-customer.js — bewust NIET
//     // geëxporteerd via die module om de import-boundary klein te houden.
//     // Bij uitbreiding (nieuwe module) update BEIDE files.
//
// Dat was verdedigbaar bij twee kopieën. Met de derde (de gesprekkenlijst heeft
// het short label nu ook nodig) wordt "update beide files" een opdracht die
// iemand een keer half uitvoert, en dan telt één module zijn ongelezen mail in
// de verkeerde mailbox — zonder foutmelding, want elke waarde is een geldige
// mailboxnaam.
//
// ── TWEE NAMEN PER MAILBOX, EN DAT IS DE VAL ────────────────────────────────
//   `user`  — het volledige adres, voor de IMAP-login
//   `label` — het SHORT label, wat in `email_messages.mailbox` staat
//
// finance heet daar `administratie`, niet `finance` en niet
// `administratie@deforexopleiding.nl`. Een filter met het verkeerde van de twee
// geeft geen fout maar nul rijen, en nul ongelezen mail ziet eruit als goed
// nieuws.

export const MODULE_MAILBOX = Object.freeze({
  finance: Object.freeze({
    user: 'administratie@deforexopleiding.nl',
    label: 'administratie',
    passEnv: 'IMAP_PASS_ADMINISTRATIE',
  }),
  onboarding: Object.freeze({
    user: 'onboarding@deforexopleiding.nl',
    label: 'onboarding',
    passEnv: 'IMAP_PASS_ONBOARDING',
  }),
  events: Object.freeze({
    user: 'events@deforexopleiding.nl',
    label: 'events',
    passEnv: 'IMAP_PASS_EVENTS',
  }),
});

/** De modules die een eigen mailbox hebben. */
export const MAILBOX_MODULES = Object.freeze(Object.keys(MODULE_MAILBOX));

/** De mailbox van een module, of null. Null betekent: deze module heeft er geen. */
export function mailboxVoorModule(module) {
  const m = String(module || '').trim().toLowerCase();
  return MODULE_MAILBOX[m] || null;
}

/** Het short label zoals het in `email_messages.mailbox` staat, of null. */
export function mailboxLabel(module) {
  return mailboxVoorModule(module)?.label || null;
}
