// Group the same fixture across N bookmakers. Names differ by language and
// style (Tipsport "Arménsko - Cyprus", "Shelton B."; Bet365 "Armenien v Zypern",
// "B Shelton"), so matching uses kick-off time + fuzzy team-name tokens.
// A wrong group would show a fake surebet, so the rules are strict:
//   - same sport, kick-off within MAX_DT of the group
//   - BOTH teams similar (>= 0.5) to some member of the group
//   - same age/gender/reserve/doubles markers (U19, ženy, rez., "A/B")
//   - a group holds at most one event per bookmaker
// Manual fixes: data/aliases.json { "any book's name": "canonical name", ... }
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../../config');
const { preRaw, canon } = require('./names');

const MAX_DT = 20 * 60e3;
const STOP = new Set(['fc', 'sc', 'sk', 'sv', 'ac', 'fk', 'cf', 'cd', 'afc', 'bk', 'hc', 'hk', 'tsg', 'vfb', 'vfl', 'rb', 'as', 'us', 'ss', 'ud',
  'club', 'de', 'the', 'if', 'ik', 'nk', 'mfk', 'ofk', 'tj', 'ks', 'kv', 'jk', 'cs', 'ca', 'cr', 'se', 'ec', 'sd', 'fsv', 'spvgg', 'ssc', 'calcio', 'v', 'vs']);

function loadAliases() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'aliases.json'), 'utf8').replace(/^﻿/, '')); } catch { return {}; }
}

// Words shared by many unrelated teams: never evidence of a match on their own.
const GENERIC = new Set(['al', 'el', 'la', 'le', 'los', 'town', 'city', 'united', 'utd', 'county', 'rovers', 'athletic', 'atletico', 'sporting',
  'real', 'deportivo', 'inter', 'dynamo', 'dinamo', 'olympic', 'olympique', 'ol', 'st', 'saint', 'san', 'santa', 'sport', 'sports', 'fk', 'team',
  'esports', 'gaming', 'academy', 'junior', 'juniors',
  // club prefixes shared by many teams (Israel, Turkey, Brazil...)
  'hapoel', 'hap', 'maccabi', 'mac', 'beitar', 'bnei', 'ironi', 'sk', 'spor', 'clube', 'esporte', 'atletico', 'nacional', 'union', 'racing', 'gimnasia', 'independiente']);
// Age / gender / reserve markers: both sides must carry the same set.
const MARKERS = [
  [/\bu ?(1[5-9]|2[0-3])\b/, m => `u${m[1]}`],
  [/\b(women|zeny|ladies|w|z)\b/, () => 'w'],
  // (a bare "B" is not used: it clashes with initials like "Shelton B.")
  [/\b(ii|res|rez|reserves|rezervy|reserve)\b/, () => 'res'],
];
const MARKER_WORD = /^(u\d{2}|ii|res|rez|reserves|rezervy|reserve|women|zeny|ladies)$/;

function norm(name) {
  // Country names in Slovak/Czech/German, Niké age teams, women / reserve spellings -> one form (names.js).
  return canon(String(preRaw(name)).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ß/g, 'ss')
    .replace(/\((w|z|zeny|women)\)/g, ' w ').replace(/[^a-z0-9]+/g, ' ').trim());
}
function markers(name) {
  const n = ` ${norm(name)} `;
  const m = MARKERS.map(([re, f]) => { const x = n.match(re); return x ? f(x) : ''; }).filter(Boolean);
  if (String(name).includes('/')) m.push('doubles'); // tennis doubles "A/B"
  // Trailing bare "B" (no dot) = B team, e.g. "Komárno B". Initials always carry
  // a dot in these books' formats ("Shelton B.").
  if (/\S{3,}\s+B$/.test(String(name).trim()) && !m.includes('res')) m.push('res');
  return m.sort().join(',');
}
function tokens(name) {
  return norm(name).replace(/\bu (\d{2})\b/g, 'u$1').split(' ')
    .filter(t => t && !STOP.has(t) && !GENERIC.has(t) && !/^\d+$/.test(t) && !MARKER_WORD.test(t));
}

function tokEq(a, b) {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  return p >= 5;
}

// Share of the shorter name's meaningful tokens found in the other name.
// Single letters (initials) are ignored.
// At least one matched token must be 3+ letters (real evidence, not an initial).
// Different age/gender/reserve markers -> 0.
function sim(a, b) {
  if (markers(a) !== markers(b)) return 0;
  const la = tokens(a).filter(t => t.length > 1), lb = tokens(b).filter(t => t.length > 1);
  if (!la.length || !lb.length) return 0;
  const [s, l] = la.length <= lb.length ? [la, lb] : [lb, la];
  const hits = s.filter(t => l.some(u => tokEq(t, u)));
  if (!hits.some(t => t.length >= 3)) return 0;
  return hits.length / s.length;
}

// lists: array of event arrays (one per bookmaker or source).
// Returns groups seen at >= 2 bookmakers, as events with all their odds.
function mergeBooks(lists, log = () => { }) {
  const aliases = loadAliases();
  const al = n => aliases[n] || n;
  const groups = [];
  for (const list of lists) {
    for (const ev of list) {
      // A live event without a kick-off time (Bet365 In-Play) pairs with live groups by names only.
      const near = g => (g.start == null || ev.start == null ? g.live && ev.live : Math.abs(g.start - ev.start) <= MAX_DT);
      const win = groups.filter(g => g.sport === ev.sport && near(g) && !g.books.has(ev.book));
      let best = null, bestScore = 0;
      for (const g of win) {
        let sh = 0, sa = 0;
        for (const m of g.members) { sh = Math.max(sh, sim(al(ev.home), al(m.home))); sa = Math.max(sa, sim(al(ev.away), al(m.away))); }
        if (sh >= 0.5 && sa >= 0.5 && sh + sa > bestScore) { best = g; bestScore = sh + sa; }
      }
      if (best) {
        best.members.push(ev);
        best.books.add(ev.book);
        if (best.start == null && ev.start != null) best.start = ev.start;
      } else {
        groups.push({ sport: ev.sport, start: ev.start, live: !!ev.live, members: [ev], books: new Set([ev.book]) });
      }
    }
  }
  const out = groups.filter(g => g.books.size >= 2).map(g => {
    const a = g.members[0];
    return {
      id: `${a.sport}:${a.home}:${a.away}:${a.start}`,
      sport: a.sport, league: g.members.find(m => m.league)?.league || null,
      home: a.home, away: a.away, start: g.start,
      live: g.members.some(m => m.live),
      books: [...g.books],
      names: Object.fromEntries(g.members.map(m => [m.book, `${m.home} - ${m.away}${m.league ? ` (${m.league})` : ''}`])),
      odds: g.members.flatMap(m => m.odds),
    };
  });
  log(`groups: ${out.length} across >=2 books (of ${groups.length})`);
  return out;
}

module.exports = { mergeBooks, sim, tokens };
