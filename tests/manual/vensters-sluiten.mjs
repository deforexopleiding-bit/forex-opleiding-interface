/**
 * Vensters sluiten alleen op verzoek van de gebruiker — gedragstest.
 *
 * WAAROM DIT BESTAND BESTAAT
 * In "Event afronden" verdween het venster met alles erin terwijl er getypt
 * werd. De dader was niet te vinden door te lezen: een sleep-selectie in een
 * invoerveld die net buiten de kaart eindigt levert de klik af bij de donkere
 * achtergrond, en die sloot het venster. Dat is alleen aan te tonen door het
 * daadwerkelijk te doen — vandaar een echte browser en geen unit-test.
 *
 * WAT HET TEST
 * De harness laadt het échte modules/klanten-v2/views/_shared-v2.js met een
 * minimale DFO-stub eromheen, en bouwt een venster met exact de opmaak van
 * "Event afronden". Getest wordt: de achtergrond sluit niet meer (ook niet via
 * een sleep), het kruisje wel, Escape sluit alleen bij een leeg venster, en
 * cursor plus scrollpositie overleven een volledige render.
 *
 * DIT DRAAIT NIET MEE IN `npm test`.
 * Deze repo heeft geen Playwright en geen frontend-CI. Draaien doe je met een
 * omgeving die Playwright wél heeft:
 *
 *     node tests/manual/vensters-sluiten.mjs
 *     CHROME_PATH=/pad/naar/chrome node tests/manual/vensters-sluiten.mjs
 *
 * Exit-code 0 = alles groen. Verdwijnt dit gedrag ooit, dan wordt hij rood en
 * staat er meteen bij welke van de veertien gevallen het is.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
const b = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const p = await b.newPage({ viewport: { width: 1400, height: 800 } });
p.on("console", m => { if (m.type() === "error") console.log("  [console error]", m.text()); });
await p.goto(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "vensters-sluiten.harness.html")).href);

const open = () => p.evaluate(() => !!document.getElementById("card"));
const reset = async (which = "complete") => p.evaluate((w) => {
  window.__state = { open: w, notitie: "", status: "", renders: 0 };
  window.DFO.render();
}, which);
let fails = 0;
const check = (naam, ok) => { console.log((ok ? "  OK   " : "  FAIL ") + naam); if (!ok) fails++; };

// 1 — klik op de kale achtergrond sluit niet meer
await reset();
await p.mouse.click(40, 400);
check("klik op de donkere achtergrond sluit niet", await open());

// 2 — de sleep-selectie (de oorspronkelijke dader)
await reset();
await p.click("#note"); await p.type("#note", "belafspraak dinsdag");
const box = await p.locator("#note").boundingBox();
await p.mouse.move(box.x + box.width - 10, box.y + box.height / 2);
await p.mouse.down();
await p.mouse.move(box.x + 10, box.y + box.height / 2, { steps: 8 });
await p.mouse.move(60, box.y + box.height / 2, { steps: 10 });
await p.mouse.up();
check("sleep-selectie die buiten de kaart eindigt sluit niet", await open());
check("de getypte notitie staat er nog", (await p.evaluate(() => window.__state.notitie)) === "belafspraak dinsdag");

// 3 — het kruisje / Annuleren werkt nog wel
await reset();
await p.evaluate(() => window.__close());
check("sluiten via de knop werkt nog", !(await open()));

// 4 — Escape sluit zolang er niets is ingevuld
await reset();
let bereikt = await p.evaluate(async () => {
  let g = false; const h = e => { if (e.key === "Escape") g = true; };
  document.addEventListener("keydown", h);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  document.removeEventListener("keydown", h); return g;
});
check("Escape bereikt de app als er niets is ingevuld", bereikt === true);

// 5 — Escape doet niets zodra er getypt is
await reset();
await p.click("#note"); await p.type("#note", "iets");
bereikt = await p.evaluate(() => {
  let g = false; const h = e => { if (e.key === "Escape") g = true; };
  document.addEventListener("keydown", h);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  document.removeEventListener("keydown", h); return g;
});
check("Escape wordt geblokkeerd zodra er getypt is", bereikt === false);
check("venster staat na Escape nog open", await open());

// 6 — focus, cursor en scrollpositie overleven een render
await reset();
await p.click("#note"); await p.type("#note", "notitie met tekst");
await p.evaluate(() => { document.getElementById("note").setSelectionRange(7, 7); document.getElementById("card").scrollTop = 500; });
const scrollVoor = await p.evaluate(() => document.getElementById("card").scrollTop);
await p.evaluate(() => window.DFO.render());
const na = await p.evaluate(() => ({
  focus: document.activeElement && document.activeElement.id,
  caret: document.activeElement && document.activeElement.selectionStart,
  scroll: document.getElementById("card").scrollTop,
  waarde: document.getElementById("note").value,
}));
check("focus staat na de render weer in het notitieveld", na.focus === "note");
check("de cursor staat nog op dezelfde plek (7)", na.caret === 7);
check(`het venster is niet teruggesprongen (${scrollVoor} -> ${na.scroll})`, na.scroll === scrollVoor);
check("de tekst staat er nog", na.waarde === "notitie met tekst");

// 6b — een volgend venster begint weer schoon
await reset();
await p.click("#note"); await p.type("#note", "iets");
await p.evaluate(() => window.__close());        // sluiten via de knop
await reset();                                   // nieuw venster, niets ingevuld
bereikt = await p.evaluate(() => {
  let g = false; const h = e => { if (e.key === "Escape") g = true; };
  document.addEventListener("keydown", h);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  document.removeEventListener("keydown", h); return g;
});
check("Escape werkt weer in een volgend, leeg venster", bereikt === true);

// 7 — de abonnementen-wizard krijgt het gratis mee (klasse, geen inline stijl)
await reset("abo");
await p.mouse.click(40, 400);
check("abonnementen-wizard (.sw-modal-back) sluit niet meer op de achtergrond",
  await p.evaluate(() => !!document.getElementById("swback")));

// 8 — de navigatiesluier blijft gewoon werken
await p.evaluate(() => { window.__scrimGeklikt = false;
  const s = document.getElementById("scrim");
  s.style.cssText = "position:fixed;inset:0;z-index:44"; });
await p.evaluate(() => document.getElementById("scrim").click());
check("de navigatiesluier reageert nog wel op een klik", await p.evaluate(() => window.__scrimGeklikt === true));

console.log(fails === 0 ? "\nAlles groen." : `\n${fails} test(s) rood.`);
await b.close();
process.exit(fails ? 1 : 0);
