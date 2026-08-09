// modules/klanten-v2/views/logboek-v2.js
//
// Fase F — Logboek (layout-only, voorbeeld-data). Compact — beide tabs
// zijn statische toolbar+tabel views.
// 1-op-1 uit prototype:
//   - VIEWS['logboek/Activiteit']    r4133-4155
//   - VIEWS['logboek/Per gebruiker'] r4119-4132
// Dormant — 'logboek' niet in V2_ACTIVE_ALLOWLIST. Preview ?v2preview=logboek.

(function () {
  if (!window.DFO) { console.error('[logboek-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[logboek-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, F } = window.DFO;
  const H = window.KV_V2.helpers;

  window.__logNotice = (l) => { console.info('[logboek-v2] ' + l); try { alert(l + ' — komt in de data-ronde.'); } catch (_) {} };

  const rollePill = (r) => H.pill(r === 'Super admin' ? 'violet' : r === 'Manager' ? 'accent' : r === 'Sales' ? 'emerald' : 'teal', r, 1);

  function perGebruikerView() {
    return `${H.voorbeeldBanner()}
    ${H.toolbar([H.search('Zoek gebruiker…')])}
    ${H.table(
      [{ l: 'Gebruiker' }, { l: 'Rol' }, { l: 'Laatst ingelogd', cls: 'optional' }, { l: 'Laatst actief' }, { l: 'IP', cls: 'optional' }, { l: 'Acties', cls: 'r' }],
      [
        ['Amigo Biemold',   'Super admin', 'Vandaag 08:12',  '2 min geleden',  '84.106.22.11',  412],
        ['Jeffrey Biemold', 'Manager',     'Vandaag 09:04',  '18 min geleden', '84.106.22.11',  287],
        ['Joost Berg',      'Sales',       'Vandaag 08:47',  '1 uur geleden',  '77.249.88.4',   134],
        ['Dave Klaassen',   'Mentor',      'Gisteren 19:22', '1 dag geleden',  '92.109.14.203',  56],
      ].map(([n, r, li, la, ip, a]) => [
        `<div class="row-avatar">${H.av(n, 28)}<span class="cell-main">${n}</span></div>`,
        rollePill(r),
        `<span class="mono" style="color:var(--text-3);font-size:12.5px">${li}</span>`,
        `<span style="font-size:12.5px">${la}</span>`,
        `<span class="mono" style="color:var(--text-3);font-size:12px">${ip}</span>`,
        `<span class="mono">${a}</span>`,
      ])
    )}`;
  }

  function activiteitView() {
    return `${H.voorbeeldBanner()}
    ${H.toolbar([
      H.chips('t', [{ l: 'Deze week', v: 'w' }, { l: 'Vandaag', v: 'd' }, { l: 'Deze maand', v: 'm' }, { l: 'Aangepast', v: 'c' }], F('t', 'w')),
      `<select class="filter-sel"><option>Alle gebruikers</option><option>Amigo Biemold</option><option>Jeffrey Biemold</option><option>Joost Berg</option><option>Dave Klaassen</option></select>`,
      `<select class="filter-sel"><option>Alle rollen</option><option>Super admin</option><option>Manager</option><option>Sales</option><option>Mentor</option></select>`,
      `<select class="filter-sel"><option>Alle modules</option><option>Finance</option><option>Wanbetalers</option><option>Sales</option><option>Klanten</option><option>E-mail</option><option>Admin</option></select>`,
      `<select class="filter-sel"><option>Alle resultaten</option><option>Gelukt</option><option>Geweigerd</option></select>`,
      H.search('Zoek op actie of e-mail…'),
      `<div class="tb-right"><button class="btn btn-ghost" onclick="__logNotice('Export')">${svg(I.down)}Export</button></div>`,
    ])}
    ${H.table(
      [{ l: 'Tijd' }, { l: 'Gebruiker' }, { l: 'Rol', cls: 'optional' }, { l: 'Module' }, { l: 'Actie' }, { l: 'Methode', cls: 'optional' }, { l: 'Resultaat' }, { l: 'IP', cls: 'optional' }],
      [
        ['13:26:04', 'Amigo Biemold',   'Super admin', 'Finance',     'finance.invoice.update',    'POST',  'ok 200',       '84.106.22.11'],
        ['13:24:51', 'Jeffrey Biemold', 'Manager',     'Wanbetalers', 'dunning.action.approve',    'POST',  'ok 200',       '84.106.22.11'],
        ['13:22:18', 'Joost Berg',      'Sales',       'Sales',       'sales.quotation.create',    'POST',  'ok 201',       '77.249.88.4'],
        ['13:19:02', 'Joost Berg',      'Sales',       'Finance',     'finance.invoice.credit',    'POST',  'geweigerd 403','77.249.88.4'],
        ['13:15:44', 'Dave Klaassen',   'Mentor',      'Klanten',     'customers.list',            'GET',   'ok 200',       '92.109.14.203'],
        ['13:12:09', 'Amigo Biemold',   'Super admin', 'Admin',       'admin.users.update',        'PATCH', 'ok 200',       '84.106.22.11'],
        ['13:04:31', 'Jeffrey Biemold', 'Manager',     'E-mail',      'email.reclassify.run',      'POST',  'ok 200',       '84.106.22.11'],
      ].map(([t, w, r, m, a, me, res, ip]) => [
        `<span class="mono" style="color:var(--text-3);font-size:12px">${t}</span>`,
        `<span class="cell-main">${w}</span>`,
        rollePill(r),
        `<span style="font-size:12.5px">${m}</span>`,
        `<span class="mono" style="font-size:12.5px">${a}</span>`,
        `<span class="mono" style="color:var(--text-3);font-size:12px">${me}</span>`,
        H.pill(res.startsWith('geweigerd') ? 'danger' : 'ok', res),
        `<span class="mono" style="color:var(--text-3);font-size:12px">${ip}</span>`,
      ])
    )}`;
  }

  window.DFO.VIEWS['logboek/Activiteit']    = activiteitView;
  window.DFO.VIEWS['logboek/Per gebruiker'] = perGebruikerView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('logboek');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('logboek');
  console.debug('[logboek-v2] registered 2 views (dormant)');
})();
