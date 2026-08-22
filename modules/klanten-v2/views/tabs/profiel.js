// modules/klanten-v2/views/tabs/profiel.js
//
// Profiel-tab van klanten-v2 (PR-B2). 35 items uit de INVENTARIS:
// sidebar 13 + main-content 22. Read-only — de bewerken-flow (create/
// edit/archive/tag-edit) komt in PR-C via de gedeelde modal-primitive.
//
// Data-bronnen (uit /api/customer?id=X, gecached in detail.js):
//   dossier.customer         — klant-object (alle NAW + bedrijf + tags[] +
//                              status derived + notes_count + audit_count)
//   dossier.linked_company   — als customer.is_company=false: gekoppeld
//                              bedrijf-object (of null)
//   dossier.linked_persons   — als customer.is_company=true: array van
//                              personen die aan dit bedrijf hangen
//
// Onboarding + Abonnement preview-cards: lightweight CTAs naar hun eigen
// tabs (PR-B5 / mentor-onboarding). Data-fetches komen in die PR's; nu
// staat er alleen een "Bekijk in …-tab" link.

import { openEditCustomerModal }  from '../modals/edit-customer.js';
import { openLinkCompanyModal }   from '../modals/link-company.js';
import { openTagEditModal }       from '../modals/tag-edit.js';
import { resetDetailCache }       from '../detail.js';

const K = () => window.KV;

// ── Formatters ──────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch (_) { return ''; }
}
function fmtDateLong(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch (_) { return ''; }
}
function fmtDateTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (_) { return ''; }
}
function safe(v) {
  const s = String(v ?? '').trim();
  return s || '—';
}

// ── Sidebar cards ───────────────────────────────────────────────────────────

function customerFullName(c) {
  if (!c) return '';
  if (c.is_company && c.company_name) return c.company_name;
  return [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.email || '';
}

function statusPill(status) {
  const map = {
    active:     { cls: 'ds-pill-ok',      label: 'Actief' },
    archived:   { cls: 'ds-pill-neutral', label: 'Gearchiveerd' },
    anonymized: { cls: 'ds-pill-violet',  label: 'Geanonimiseerd' },
  };
  const m = map[status] || { cls: 'ds-pill-neutral', label: status || '—' };
  return `<span class="ds-pill ${m.cls}">${K().esc(m.label)}</span>`;
}

function renderSidebarCards(customer) {
  const name    = customerFullName(customer);
  const initials = K().initials(name);
  const email   = customer?.email || '';
  const phone   = customer?.phone || '';
  const isCompany = !!customer?.is_company;
  const risk    = !!customer?.risk_tag_auto;

  // WhatsApp deep-link — strip alles behalve digits
  const waHref  = phone ? `https://wa.me/${String(phone).replace(/[^0-9]/g, '')}` : '';

  const tags = Array.isArray(customer?.tags) ? customer.tags : [];
  const tagChips = tags.length
    ? tags.map(t => `<span class="kv-prof-tag" style="background:${K().esc(t.color || 'var(--surface-3)')}20; border-color:${K().esc(t.color || 'var(--border)')}; color:${K().esc(t.color || 'var(--text-2)')};">${K().esc(t.label || t.slug)}</span>`).join(' ')
    : '<span class="kv-prof-empty">Geen tags</span>';

  return `
    <div class="kv-prof-side">

      <!-- Sidebar card 1: identiteit -->
      <div class="kv-prof-card kv-prof-side-identity">
        <div class="ds-avatar-lg" style="background:linear-gradient(140deg,#0EA271,#076B4A);width:64px;height:64px;font-size:22px;margin:0 auto 10px;">${K().esc(initials)}</div>
        <div class="kv-prof-side-name">${K().esc(name || 'Onbekend')}</div>
        <div class="kv-prof-side-pills">
          <span class="ds-pill ${isCompany ? 'ds-pill-accent' : 'ds-pill-neutral'} nodot">${isCompany ? 'Bedrijf' : 'Particulier'}</span>
          ${statusPill(customer?.status)}
          ${risk ? '<span class="ds-pill ds-pill-danger">Risico</span>' : ''}
        </div>
        ${customer?.created_at
          ? `<div class="kv-prof-side-since">Klant sinds ${K().esc(fmtDate(customer.created_at))}</div>`
          : ''
        }
      </div>

      <!-- Sidebar card 2: contact + softphone + WA -->
      <div class="kv-prof-card">
        <div class="kv-prof-card-title">Contact</div>
        ${email
          ? `<a class="kv-prof-contact-link" href="mailto:${K().esc(email)}">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="m4 4 8 8 8-8"/></svg>
               <span>${K().esc(email)}</span>
             </a>`
          : `<div class="kv-prof-contact-link disabled"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="m4 4 8 8 8-8"/></svg><span>Geen e-mailadres</span></div>`
        }
        ${phone
          ? `<a class="kv-prof-contact-link" href="tel:${K().esc(phone)}">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7 12.8 12.8 0 0 0 .7 2.8 2 2 0 0 1-.4 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4 12.8 12.8 0 0 0 2.8.7 2 2 0 0 1 1.7 2z"/></svg>
               <span>${K().esc(phone)}</span>
             </a>`
          : `<div class="kv-prof-contact-link disabled"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7 12.8 12.8 0 0 0 .7 2.8 2 2 0 0 1-.4 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4 12.8 12.8 0 0 0 2.8.7 2 2 0 0 1 1.7 2z"/></svg><span>Geen telefoonnummer</span></div>`
        }
        ${phone
          ? `<button type="button" class="kv-prof-contact-link kv-prof-call-btn" data-kv-softphone data-phone="${K().esc(phone)}" data-name="${K().esc(name)}" data-customer-id="${K().esc(customer?.id || '')}">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7 12.8 12.8 0 0 0 .7 2.8 2 2 0 0 1-.4 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4 12.8 12.8 0 0 0 2.8.7 2 2 0 0 1 1.7 2z"/><path d="M15 11a3 3 0 0 1 3 3"/><path d="M15 7a7 7 0 0 1 7 7"/></svg>
               <span>Bel via softphone</span>
             </button>`
          : ''
        }
        ${waHref
          ? `<a class="kv-prof-contact-link" href="${K().esc(waHref)}" target="_blank" rel="noopener">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
               <span>WhatsApp openen</span>
             </a>`
          : ''
        }
      </div>

      <!-- Sidebar card 3: tags -->
      <div class="kv-prof-card">
        <div class="kv-prof-card-title kv-prof-card-title-row">
          <span>Tags</span>
          <button type="button" class="ds-icon-btn" data-kv-tags-edit title="Bewerken (PR-C)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
          </button>
        </div>
        <div class="kv-prof-tags">${tagChips}</div>
      </div>

    </div>`;
}

// ── Main content ────────────────────────────────────────────────────────────

function kvRow(label, val) {
  return `
    <div class="kv-prof-kv">
      <span class="kv-prof-kv-l">${K().esc(label)}</span>
      <span class="kv-prof-kv-v">${K().esc(safe(val))}</span>
    </div>`;
}

function renderClientDataCard(customer, dossier) {
  const isCompany = !!customer?.is_company;
  const linkedCompany = dossier?.linked_company;

  return `
    <div class="kv-prof-card">
      <div class="kv-prof-card-title kv-prof-card-title-row">
        <span>Klantgegevens</span>
        <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-kv-action-inline="edit" title="Bewerken (PR-C)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
          Bewerken
        </button>
      </div>

      <div class="kv-prof-section-h">Persoonlijk</div>
      ${kvRow('Voornaam',      customer?.first_name)}
      ${kvRow('Achternaam',    customer?.last_name)}
      ${kvRow('Geboortedatum', customer?.date_of_birth ? fmtDateLong(customer.date_of_birth) : '')}
      ${isCompany ? kvRow('Bedrijfsnaam', customer?.company_name) : ''}
      ${isCompany ? kvRow('KvK-nummer',   customer?.kvk_number)   : ''}
      ${isCompany ? kvRow('BTW-nummer',   customer?.vat_number)   : ''}

      <div class="kv-prof-divider"></div>
      <div class="kv-prof-section-h">Contact</div>
      ${kvRow('Email',    customer?.email)}
      ${kvRow('Telefoon', customer?.phone)}
      ${!isCompany
        ? `<div class="kv-prof-kv kv-prof-kv-with-action">
             <span class="kv-prof-kv-l">Bedrijf</span>
             <span class="kv-prof-kv-v">
               ${K().esc(linkedCompany
                 ? (linkedCompany.company_name || linkedCompany.email || 'Onbekend bedrijf')
                 : 'Geen bedrijf gekoppeld')}
               <button type="button" class="ds-icon-btn kv-prof-inline-btn" data-kv-link-company title="Koppel of ontkoppel bedrijf">
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
               </button>
             </span>
           </div>`
        : ''}

      <div class="kv-prof-divider"></div>
      <div class="kv-prof-section-h">Adres</div>
      ${kvRow('Straat + nr.',    [customer?.address_street, customer?.address_number].filter(Boolean).join(' '))}
      ${kvRow('Postcode + plaats', [customer?.address_postal, customer?.address_city].filter(Boolean).join(' '))}
    </div>`;
}

// ── Abonnement + Onboarding preview-cards: live data ─────────────────────────
// Bron abonnementen = /api/sales-customer-subscriptions (IDENTIEK aan de
// Abonnementen-tab; geen nieuwe query-definitie). Bron onboarding =
// /api/onboarding-by-customer (per-klant lees-endpoint). Beide worden async
// gevuld ná de eerste render (wire → fill*), met een nette lege staat als er
// geen data is.

const EUR = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtEur(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return EUR.format(Number(n));
}

// Subscription-status → pill. Zelfde termen als tabs/abonnementen.js.
const SUB_STATUS = {
  active:      { label: 'Actief',      cls: 'ds-pill-ok'      },
  running:     { label: 'Actief',      cls: 'ds-pill-ok'      },
  paused:      { label: 'Gepauzeerd',  cls: 'ds-pill-warn'    },
  overdue:     { label: 'Achterstand', cls: 'ds-pill-danger'  },
  cancelled:   { label: 'Beëindigd',   cls: 'ds-pill-neutral' },
  deactivated: { label: 'Beëindigd',   cls: 'ds-pill-neutral' },
  stopped:     { label: 'Gestopt',     cls: 'ds-pill-neutral' },
};
function subStatusPill(st) {
  const m = SUB_STATUS[String(st || '').toLowerCase()] || { label: st || '—', cls: 'ds-pill-neutral' };
  return `<span class="ds-pill ${m.cls}">${K().esc(m.label)}</span>`;
}
function subIsActive(s) {
  const k = String(s?.status || '').toLowerCase();
  return k === 'active' || k === 'running';
}
// Bedrag incl. BTW per termijn — lokale kopie van tabs/abonnementen.js:inclPerTerm
// (die helper is niet ge-exporteerd; deze kopie houdt kaart == tab-bedrag).
function inclPerTerm(sub) {
  const lines = Array.isArray(sub?.line_items) ? sub.line_items : [];
  if (lines.length) {
    return lines.reduce((s, li) => {
      const excl = Number(li.amount) || 0;
      const vat  = li.vat_percentage != null ? Number(li.vat_percentage) : 21;
      return s + excl * (1 + vat / 100);
    }, 0);
  }
  const excl = Number(sub?.amount) || 0;
  const vat  = sub?.vat_percentage != null && Number(sub.vat_percentage) > 0 ? Number(sub.vat_percentage) : 21;
  return excl * (1 + vat / 100);
}

// NB: de databron kent geen "volgende factuurdatum"-veld; net als de
// Abonnementen-tab tonen we de einddatum als "loopt t/m" (Hernieuwingsdatum).
function renderAboSummary(subs) {
  const list = Array.isArray(subs) ? subs : [];
  const link = `<span class="kv-prof-preview-link">Bekijk details →</span>`;
  if (!list.length) {
    return `<div class="kv-prof-empty">Geen abonnement voor deze klant.</div>${link}`;
  }
  const actives = list.filter(subIsActive);
  if (!actives.length) {
    return `<div class="kv-prof-empty">Geen actief abonnement (${list.length} historisch).</div>${link}`;
  }
  const sorted = [...actives].sort((a, b) => inclPerTerm(b) - inclPerTerm(a));
  const shown = sorted.slice(0, 2);
  const extra = sorted.length - shown.length;
  const rows = shown.map((s) => `
    <div class="kv-prof-abo-row">
      <div class="kv-prof-abo-row-top">
        <span class="kv-prof-abo-name">${K().esc(s.description || 'Abonnement')}</span>
        ${subStatusPill(s.status)}
      </div>
      <div class="kv-prof-abo-row-sub">
        <span class="mono">${K().esc(fmtEur(inclPerTerm(s)))}</span> / termijn incl. BTW${s.end_date ? ` · loopt t/m ${K().esc(fmtDate(s.end_date))}` : ''}
      </div>
    </div>`).join('');
  const more = extra > 0 ? `<div class="kv-prof-abo-more">en ${extra} meer</div>` : '';
  const totalLine = actives.length > 1
    ? `<div class="kv-prof-abo-total">Totaal termijnbedrag: <span class="mono">${K().esc(fmtEur(actives.reduce((a, s) => a + inclPerTerm(s), 0)))}</span> / termijn</div>`
    : '';
  return `<div class="kv-prof-abo-list">${rows}${more}</div>${totalLine}${link}`;
}

// Onboarding-status → pill. Vocabulaire uit api/onboarding-*.
const OB_STATUS = {
  aangemeld:    { label: 'Aangemeld',    cls: 'ds-pill-neutral' },
  bezig:        { label: 'Bezig',        cls: 'ds-pill-ok'      },
  afgerond:     { label: 'Afgerond',     cls: 'ds-pill-accent'  },
  geannuleerd:  { label: 'Geannuleerd',  cls: 'ds-pill-danger'  },
  gearchiveerd: { label: 'Gearchiveerd', cls: 'ds-pill-neutral' },
};
function obStatusPill(st) {
  const m = OB_STATUS[String(st || '').toLowerCase()] || { label: st || '—', cls: 'ds-pill-neutral' };
  return `<span class="ds-pill ${m.cls}">${K().esc(m.label)}</span>`;
}
function renderOnboardingSummary(ob) {
  if (!ob) return `<div class="kv-prof-empty">Geen onboarding voor deze klant.</div>`;
  const mentor  = ob.mentor_name || (ob.mentor_user_id ? 'Toegewezen' : 'Nog geen mentor');
  const started = ob.start_date || ob.started_at;
  const trajectBits = [
    ob.traject_label,
    ob.duur_maanden != null ? `${ob.duur_maanden} mnd` : null,
    ob.calls != null ? `${ob.calls} calls` : null,
  ].filter(Boolean).join(' · ');
  const showStep = ob.current_step != null && String(ob.status).toLowerCase() === 'bezig';
  return `
    <div class="kv-prof-ob">
      <div class="kv-prof-ob-top">
        ${obStatusPill(ob.status)}
        ${showStep ? `<span class="kv-prof-ob-step">Stap ${K().esc(String(ob.current_step))}</span>` : ''}
      </div>
      ${trajectBits ? `<div class="kv-prof-ob-traject">${K().esc(trajectBits)}</div>` : ''}
      <div class="kv-prof-ob-meta">
        <span>Mentor: <b>${K().esc(mentor)}</b></span>
        ${started ? `<span>Gestart: <b>${K().esc(fmtDate(started))}</b></span>` : ''}
      </div>
    </div>`;
}

// Async vullers — draaien ná wire(); falen fail-soft naar een lege staat.
async function fillAbonnementCard(rootEl, customerId) {
  const host = rootEl.querySelector('[data-kv-abo-body]');
  if (!host || !customerId) return;
  try {
    const j = await K().authedJson(`/api/sales-customer-subscriptions?customer_id=${encodeURIComponent(customerId)}`);
    host.innerHTML = renderAboSummary(Array.isArray(j?.subscriptions) ? j.subscriptions : []);
  } catch (_) {
    host.innerHTML = `<div class="kv-prof-empty">Kon abonnement niet laden.</div>`;
  }
}
async function fillOnboardingCard(rootEl, customerId) {
  const host = rootEl.querySelector('[data-kv-onboarding-body]');
  if (!host || !customerId) return;
  try {
    const j = await K().authedJson(`/api/onboarding-by-customer?customer_id=${encodeURIComponent(customerId)}`);
    host.innerHTML = renderOnboardingSummary(j?.onboarding || null);
  } catch (_) {
    host.innerHTML = `<div class="kv-prof-empty">Kon onboarding niet laden.</div>`;
  }
}

function renderPreviewCards() {
  // Onboarding + Abonnement preview-cards. De bodies worden async gevuld
  // (fillOnboardingCard / fillAbonnementCard) ná de eerste render; hier alleen
  // een laad-placeholder. De Abonnement-card blijft klikbaar (data-kv-goto-tab)
  // naar de Abonnementen-tab.
  return `
    <div class="kv-prof-grid-2">
      <div class="kv-prof-card kv-prof-preview">
        <div class="kv-prof-preview-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m19 8 2 2 4-4"/></svg>
          Onboarding
        </div>
        <div class="kv-prof-preview-body" data-kv-onboarding-body>
          <div class="kv-prof-empty">Onboarding laden…</div>
        </div>
      </div>
      <div class="kv-prof-card kv-prof-preview" data-kv-goto-tab="abonnementen" title="Naar abonnementen">
        <div class="kv-prof-preview-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>
          Abonnement
        </div>
        <div class="kv-prof-preview-body" data-kv-abo-body>
          <div class="kv-prof-empty">Abonnement laden…</div>
        </div>
      </div>
    </div>`;
}

function renderLinkedPersonsCard(dossier) {
  if (!dossier?.customer?.is_company) return '';
  const persons = Array.isArray(dossier?.linked_persons) ? dossier.linked_persons : [];
  const count = persons.length;
  return `
    <div class="kv-prof-card">
      <div class="kv-prof-card-title kv-prof-card-title-row">
        <span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:4px"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/></svg>
          Gekoppelde personen
        </span>
        <span class="kv-prof-count">${count}</span>
      </div>
      ${count
        ? `<ul class="kv-prof-linked-list">${persons.map(p => `
            <li>
              <a href="?id=${K().esc(p.id)}" data-kv-linked-person="${K().esc(p.id)}" class="kv-prof-linked-link">
                <span class="kv-prof-linked-name">${K().esc([p.first_name, p.last_name].filter(Boolean).join(' ') || p.email || 'Onbekend')}</span>
                ${p.email ? `<span class="kv-prof-linked-sub">${K().esc(p.email)}</span>` : ''}
              </a>
            </li>`).join('')}</ul>`
        : '<div class="kv-prof-empty">Geen personen gekoppeld aan dit bedrijf.</div>'
      }
    </div>`;
}

function renderMetadataCard(customer) {
  // 7 read-only metadata-velden (verkoper/updated/tl/avg/created/ghl/risk).
  // Sommige komen uit joined data die de basic /api/customer nog niet levert
  // (bv. verkoper-naam) — dan tonen we de raw ID / een neutrale placeholder.
  const items = [
    ['Verkoper',        customer?.owner_id ? `#${String(customer.owner_id).slice(0, 8)}…` : ''],
    ['Laatst bijgewerkt', fmtDateTime(customer?.updated_at)],
    ['Teamleader ID',   customer?.tl_contact_id],
    ['AVG',             customer?.anonymized_at ? `Geanonimiseerd op ${fmtDate(customer.anonymized_at)}` : 'Actief'],
    ['Klant sinds',     fmtDate(customer?.created_at)],
    ['GoHighLevel',     customer?.ghl_contact_id],
    ['Risico-tag',      customer?.risk_tag_auto ? 'Auto (openstaande facturen)' : 'Geen'],
  ];
  return `
    <div class="kv-prof-card kv-prof-meta">
      <div class="kv-prof-section-h" style="margin-top:0">Metadata</div>
      <div class="kv-prof-meta-grid">
        ${items.map(([lbl, val]) => `
          <div class="kv-prof-kv kv-prof-kv-sm">
            <span class="kv-prof-kv-l">${K().esc(lbl)}</span>
            <span class="kv-prof-kv-v">${K().esc(safe(val))}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

function renderMainCards(customer, dossier) {
  return `
    <div class="kv-prof-main">
      ${renderClientDataCard(customer, dossier)}
      ${renderPreviewCards()}
      ${renderLinkedPersonsCard(dossier)}
      ${renderMetadataCard(customer)}
    </div>`;
}

// ── Wiring ──────────────────────────────────────────────────────────────────

function wire(rootEl, customer, dossier) {
  // Softphone-knop → gedeelde KlxSoftphone.open() (PR 0-E). Optioneel: als
  // klx-softphone.js niet is geladen (v2 draait nog zonder /modules/shared/
  // klx-softphone.js op de HTML) tonen we een toast; klanten-v2 kan straks
  // in een aparte PR de <script>-tag toevoegen aan index.html.
  rootEl.querySelectorAll('[data-kv-softphone]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!window.KlxSoftphone || typeof window.KlxSoftphone.open !== 'function') {
        K().toast('Softphone niet geladen (klx-softphone.js ontbreekt op deze page).');
        return;
      }
      window.KlxSoftphone.open({
        phone:      btn.dataset.phone || '',
        name:       btn.dataset.name  || '',
        customerId: btn.dataset.customerId || '',
        source:     'klanten-v2.profiel',
      });
    });
  });

  // Inline "Bewerken" op klantgegevens-card → opent klant-bewerken-modal
  // (PR-C1). onSuccess: DFO re-triggert via popstate/render — hier reload
  // we door hard via location (voor de klant-content in de tab is dat de
  // eenvoudigste weg naar verse state zonder detail-cache override).
  rootEl.querySelectorAll('[data-kv-action-inline="edit"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openEditCustomerModal({
        customer,
        onSuccess: () => {
          // Simpelste refresh: opnieuw navigeren naar dezelfde ?id=&tab=,
          // waarbij DFO.render() de detail-view opnieuw laadt (cache is
          // gereset door detail.js).
          if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render();
        },
      });
    });
  });
  // Tags-edit (PR-C5) → opent tag-beheer-modal. onSuccess: cache-reset
  // + DFO.render() zodat de tags-chips in de sidebar én de tags-filter
  // in de list-view (bij terug-navigatie) actueel zijn.
  rootEl.querySelectorAll('[data-kv-tags-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openTagEditModal({
        customer,
        onSuccess: () => {
          resetDetailCache();
          if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render();
        },
      });
    });
  });

  // Link-company btn (PR-C4) → opent bedrijf-koppelmodal. Alleen op
  // persoon-klanten (button wordt sowieso niet gerenderd voor bedrijven).
  // Bij success: navigeren we door DFO.render() zodat dossier-cache
  // opnieuw fetcht en de nieuwe koppeling zichtbaar wordt in Bedrijf-rij.
  rootEl.querySelectorAll('[data-kv-link-company]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openLinkCompanyModal({
        person:        customer,
        linkedCompany: dossier?.linked_company || null,
        onSuccess: () => {
          // Cache invalidate: dossier.linked_company is gemuteerd; zonder
          // reset zou detail.js zijn oude cached object blijven gebruiken.
          resetDetailCache();
          if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render();
        },
      });
    });
  });

  // Abonnement-preview-card → activeer Abonnementen-tab
  rootEl.querySelectorAll('[data-kv-goto-tab]').forEach((card) => {
    card.addEventListener('click', () => {
      const target = card.getAttribute('data-kv-goto-tab');
      if (target) K().navigate({ tab: target });
    });
  });

  // Gekoppelde persoon-link → open die klant (id-switch)
  rootEl.querySelectorAll('[data-kv-linked-person]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const pid = a.getAttribute('data-kv-linked-person');
      if (pid) K().navigate({ id: pid, tab: 'profiel' });
    });
  });
}

// ── Public entry ────────────────────────────────────────────────────────────

export async function renderProfielTab(rootEl, { customer, dossier, profile } = {}) {
  if (!customer) {
    rootEl.innerHTML = `
      <div class="ds-empty" style="padding:40px 20px;">
        <div class="ds-empty-t">Geen klant-data</div>
        <div class="ds-empty-s">De dossier-fetch heeft geen klant-object opgeleverd.</div>
      </div>`;
    return;
  }
  rootEl.innerHTML = `
    <div class="kv-prof-grid">
      ${renderSidebarCards(customer)}
      ${renderMainCards(customer, dossier || { customer })}
    </div>`;
  wire(rootEl, customer, dossier);

  // Preview-cards async vullen (Abonnement + Onboarding). Fire-and-forget:
  // falen valt fail-soft terug op een lege staat, blokkeert de tab niet.
  fillAbonnementCard(rootEl, customer.id);
  fillOnboardingCard(rootEl, customer.id);
}
