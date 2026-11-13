// Name canonicalisation for pairing the same match across books, ported from the Python scanner's
// matcher (2026-11). Slovak/Czech books write countries in their language ("Moldavsko", "Arménsko"),
// Megawin and Bet365 in English or German; Niké writes age teams without the U ("Island 21"); women
// and reserves are spelled several ways. Everything is turned into one form before tokens are compared.
// Input and output are already folded: lower case, no accents, words separated by single spaces.

const PHRASES = {
  'faerske ostrovy': 'faroe islands', 'cerna hora': 'montenegro', 'cierna hora': 'montenegro',
  'severni irsko': 'northern ireland', 'severne irsko': 'northern ireland', 'sev irsko': 'northern ireland',
  'bosna a hercegovina': 'bosnia', 'bosnia and herzegovina': 'bosnia', 'bosnia herzegovina': 'bosnia',
  'severni makedonie': 'north macedonia', 'severne macedonsko': 'north macedonia', 'sev macedonsko': 'north macedonia',
  'san marino': 'sanmarino', 'novy zeland': 'new zealand', 'jizni korea': 'south korea', 'juzna korea': 'south korea',
  'korea republic': 'south korea', 'republic of korea': 'south korea', 'spojene arabske emiraty': 'uae',
  'united arab emirates': 'uae', 'saudska arabie': 'saudi arabia', 'saudska arabia': 'saudi arabia',
  'spojene staty': 'usa', 'united states': 'usa', 'jizni afrika': 'south africa', 'juzna afrika': 'south africa',
  'pobrezi slonoviny': 'ivory coast', 'pobrezie slonoviny': 'ivory coast', 'pobr slonoviny': 'ivory coast', 'cote d ivoire': 'ivory coast',
  'kapverdy': 'cape verde', 'cabo verde': 'cape verde', 'trinidad a tobago': 'trinidad and tobago',
  'dominikanska republika': 'domrep', 'dominikanska rep': 'domrep', 'dominican republic': 'domrep', 'dominican rep': 'domrep',
  'svata lucie': 'st lucia', 'svata lucia': 'st lucia', 'saint lucia': 'st lucia',
  'stredoafricka republika': 'central african republic', 'stredoafr rep': 'central african republic',
  'czech republic': 'czech',
};
const WORDS = {
  island: 'iceland', lotysko: 'latvia', lotyssko: 'latvia', rakusko: 'austria', rakousko: 'austria', svajciarsko: 'switzerland', svycarsko: 'switzerland',
  francuzsko: 'france', francie: 'france', taliansko: 'italy', italie: 'italy', anglicko: 'england', anglie: 'england',
  grecko: 'greece', recko: 'greece', bielorusko: 'belarus', belorusko: 'belarus', belgicko: 'belgium', belgie: 'belgium',
  brazilia: 'brazil', brazilie: 'brazil', australie: 'australia', gruzinsko: 'georgia', gruzie: 'georgia',
  armensko: 'armenia', armenie: 'armenia', albansko: 'albania', albanie: 'albania', luxembursko: 'luxembourg', lucembursko: 'luxembourg',
  makedonie: 'north macedonia', macedonsko: 'north macedonia', lichtenstejnsko: 'liechtenstein', lichtenstajnsko: 'liechtenstein',
  argentinie: 'argentina', bolivie: 'bolivia', kostarika: 'costa rica', jamajka: 'jamaica', salvador: 'el salvador',
  katar: 'qatar', irak: 'iraq', jordansko: 'jordan', libanon: 'lebanon', syrie: 'syria', kuvajt: 'kuwait',
  indie: 'india', indonesie: 'indonesia', indonezia: 'indonesia', thajsko: 'thailand', malajsie: 'malaysia', malajzia: 'malaysia',
  filipiny: 'philippines', zambie: 'zambia', keni: 'kenya', kena: 'kenya', jar: 'south africa',
  cesko: 'czech', czechia: 'czech', slovensko: 'slovakia', spanelsko: 'spain', litva: 'lithuania', svedsko: 'sweden',
  kanada: 'canada', nemecko: 'germany', skotsko: 'scotland', irsko: 'ireland', polsko: 'poland', madarsko: 'hungary',
  slovinsko: 'slovenia', chorvatsko: 'croatia', srbsko: 'serbia', rumunsko: 'romania', bulharsko: 'bulgaria',
  turecko: 'turkey', turkiye: 'turkey', ukrajina: 'ukraine', rusko: 'russia', estonsko: 'estonia', finsko: 'finland',
  norsko: 'norway', dansko: 'denmark', nizozemsko: 'netherlands', holandsko: 'netherlands', portugalsko: 'portugal',
  japonsko: 'japan', cina: 'china', kazachstan: 'kazakhstan', mexiko: 'mexico', izrael: 'israel', kypr: 'cyprus',
  moldavsko: 'moldova', azerbajdzan: 'azerbaijan', maroko: 'morocco', tunisko: 'tunisia', alzirsko: 'algeria',
  nigerie: 'nigeria', kamerun: 'cameroon', kolumbie: 'colombia', ekvador: 'ecuador',
  portoriko: 'puerto rico', dominika: 'dominica', bermudy: 'bermuda', komory: 'comoros', kongo: 'congo',
  // Bet365 (German site)
  armenien: 'armenia', zypern: 'cyprus', schottland: 'scotland', deutschland: 'germany', osterreich: 'austria', oesterreich: 'austria',
  schweiz: 'switzerland', frankreich: 'france', italien: 'italy', spanien: 'spain', niederlande: 'netherlands', belgien: 'belgium',
  tschechien: 'czech', slowakei: 'slovakia', polen: 'poland', ungarn: 'hungary', kroatien: 'croatia', serbien: 'serbia',
  rumanien: 'romania', bulgarien: 'bulgaria', griechenland: 'greece', turkei: 'turkey', russland: 'russia', schweden: 'sweden',
  norwegen: 'norway', danemark: 'denmark', finnland: 'finland', irland: 'ireland', nordirland: 'northern ireland',
  albanien: 'albania', georgien: 'georgia', moldawien: 'moldova', kasachstan: 'kazakhstan', litauen: 'lithuania', lettland: 'latvia',
  estland: 'estonia', slowenien: 'slovenia', luxemburg: 'luxembourg', weissrussland: 'belarus', aserbaidschan: 'azerbaijan',
  // cities
  munich: 'munchen', prague: 'praha', vienna: 'wien', cologne: 'koln', turin: 'torino', milan: 'milano', rome: 'roma',
  lisbon: 'lisboa', belgrade: 'beograd', warsaw: 'warszawa', bucharest: 'bucuresti', bukurest: 'bucuresti', bukarest: 'bucuresti',
};
const COUNTRY = new Set([...Object.values(WORDS), ...Object.values(PHRASES)]);
const PHRASE_RE = new RegExp(`\\b(${Object.keys(PHRASES).sort((a, b) => b.length - a.length).join('|')})\\b`, 'g');

// Raw name -> name with women / reserve / age markers written one way (before folding).
function preRaw(name) {
  return String(name)
    .replace(/\s+ž\.?$/i, ' women')                      // Niké "Everton ž."
    .replace(/\s+(?:rezervn[ýy] t[íi]m|rez\.?)$/i, ' reserves') // "Boca Juniors rezervný tím", "rez."
    .replace(/\s*\(\s*[A-Z]{3}\s*\)/g, '');               // club country code "(SLV)"
}

// Folded name -> canonical words.
function canon(folded) {
  let n = ` ${folded} `.replace(PHRASE_RE, m => PHRASES[m]);
  n = n.split(' ').map(w => WORDS[w] || w).join(' ').replace(/\s+/g, ' ').trim();
  // Niké age teams: "iceland 21" = "iceland u21" (only after a country: "hannover 96" stays)
  const m = /^(.+?) (1[7-9]|2[0-3])$/.exec(n);
  if (m && COUNTRY.has(m[1])) n = `${m[1]} u${m[2]}`;
  return n;
}

module.exports = { preRaw, canon, COUNTRY };
