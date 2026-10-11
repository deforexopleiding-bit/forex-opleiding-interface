// modules/klanten-v2/views/_mail-startlayouts.js
//
// Startlayouts voor de mailbouwer (2026-10-11): kant-en-klare sjablonen om vanuit
// te beginnen — welkomstmail, webinar-uitnodiging, aanbod, nieuwsbrief. In de
// huisstijl, volledig bewerkbaar (het zijn gewone blokken). De bouwer
// (views/_mail-bouwer.js) toont ze bij een nieuw sjabloon en via "Startlayout…".
// Afbeeldingen zijn het logo als plaatshouder — vervang ze door een eigen upload.
// Zet alleen window.MailStartlayouts.

(function () {
  'use strict';
  const LOGO = 'https://crm.deforexopleiding.nl/dfo-logo-email.png';
  const kop = (tekst, niveau = 'h2', uitlijning = 'left') => ({ soort: 'kop', tekst, niveau, uitlijning });
  const tekst = (html, uitlijning = 'left') => ({ soort: 'tekst', html, uitlijning });
  const knop = (t, url = '{{boekingslink}}', stijl = 'navy', uitlijning = 'center') => ({ soort: 'knop', tekst: t, url, stijl, uitlijning });
  const lijn = (kleur = 'grijs') => ({ soort: 'lijn', kleur });
  const ruimte = (hoogte = 16) => ({ soort: 'ruimte', hoogte });
  const afbeelding = (alt, breedte = 60) => ({ soort: 'afbeelding', url: LOGO, alt, breedte, link: '', uitlijning: 'center' });
  const kolommen = (links, rechts) => ({ soort: 'kolommen', links, rechts });

  window.MailStartlayouts = [
    {
      sleutel: 'welkom',
      naam: 'Welkomstmail',
      omschrijving: 'Hartelijk welkom, wat je kunt verwachten en een knop om een gesprek te plannen.',
      onderwerp: 'Welkom bij De Forex Opleiding, {{voornaam}}',
      blokken: () => [
        kop('Welkom, {{voornaam}}!'),
        tekst('<p>Fijn dat je er bent. Bij De Forex Opleiding leer je stap voor stap hoe je zelf de markt leest — met een vaste methode en begeleiding van ervaren traders.</p>'),
        tekst('<p><strong>Wat kun je verwachten?</strong></p><ul><li>Uitleg in je eigen tempo</li><li>Live sessies waarin we samen de markt bekijken</li><li>Een mentor die met je meekijkt</li></ul>'),
        knop('Plan een kennismakingsgesprek'),
        tekst('<p>Heb je vragen? Beantwoord gewoon deze mail, dan helpen we je verder.</p>'),
      ],
    },
    {
      sleutel: 'webinar',
      naam: 'Webinar-uitnodiging',
      omschrijving: 'Uitnodiging voor een gratis live webinar met wat je leert en een aanmeldknop.',
      onderwerp: '{{voornaam}}, je bent uitgenodigd voor ons gratis webinar',
      blokken: () => [
        kop('Gratis live webinar'),
        tekst('<p>Hoi {{voornaam}},</p><p>In dit webinar laten we live zien hoe wij de markt analyseren en welke stappen we nemen voordat we een trade plaatsen.</p>'),
        lijn('goud'),
        kolommen(
          { afbeelding: '', alt: '', html: '<p><strong>Wanneer</strong><br>Datum en tijd hier invullen</p>' },
          { afbeelding: '', alt: '', html: '<p><strong>Waar</strong><br>Online — je ontvangt de link na aanmelding</p>' },
        ),
        knop('Meld je gratis aan', 'https://www.deforexopleiding.nl', 'goud'),
        tekst('<p>Kun je er niet bij zijn? Meld je toch aan, dan sturen we je de opname.</p>'),
      ],
    },
    {
      sleutel: 'aanbod',
      naam: 'Aanbod',
      omschrijving: 'Een tijdelijk aanbod met de voordelen op een rij en een duidelijke knop.',
      onderwerp: 'Speciaal voor jou, {{voornaam}}',
      blokken: () => [
        kop('Een speciaal aanbod voor jou'),
        tekst('<p>Hoi {{voornaam}},</p><p>Omschrijf hier het aanbod: wat krijgt iemand, en tot wanneer geldt het?</p>'),
        tekst('<ul><li>Voordeel één</li><li>Voordeel twee</li><li>Voordeel drie</li></ul>'),
        knop('Bekijk het aanbod', '{{boekingslink}}', 'goud'),
        ruimte(8),
        tekst('<p><em>Dit aanbod is geldig tot [datum].</em></p>', 'center'),
      ],
    },
    {
      sleutel: 'nieuwsbrief',
      naam: 'Nieuwsbrief',
      omschrijving: 'Openingsbeeld, intro, twee onderwerpen naast elkaar en een afsluiter.',
      onderwerp: 'Nieuws van De Forex Opleiding',
      blokken: () => [
        afbeelding('De Forex Opleiding', 50),
        kop('Dit is er nieuw'),
        tekst('<p>Hoi {{voornaam}},</p><p>Een korte intro: wat staat er in deze nieuwsbrief?</p>'),
        lijn(),
        kolommen(
          { afbeelding: LOGO, alt: 'Onderwerp één', html: '<p><strong>Onderwerp één</strong><br>Een paar zinnen over het eerste onderwerp.</p>' },
          { afbeelding: LOGO, alt: 'Onderwerp twee', html: '<p><strong>Onderwerp twee</strong><br>Een paar zinnen over het tweede onderwerp.</p>' },
        ),
        lijn(),
        kop('Tip van de week', 'h3'),
        tekst('<p>Een praktische tip die lezers direct kunnen toepassen.</p>'),
        knop('Plan een gesprek'),
      ],
    },
  ];
})();
