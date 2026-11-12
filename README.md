# Surebet bot

Scans odds, finds surebets across bookmakers, shows them on a mobile-friendly
dashboard (Prehľad / Surebety / História / Log / Nastavenia), sends Telegram
alerts, and can open or place each leg in **that bookmaker's own debug Chrome
window** (genScript pattern: one `--remote-debugging-port` + one profile per book,
you log in by hand once, the bot never stores bookmaker passwords).

## Run

```
npm install
npm start            # http://localhost:8080
npm test             # arb math tests
```

## Live surebets

A separate loop (`liveSeconds`, default 15 s) reads only books with a fast live call:
Tipsport, Doxxbet, Tipos, Synottip (~1-2 s per poll, all read at the same moment).
Fortuna, Niké and Bet365 are not in the live loop (their live odds are slow or only
on a private websocket). A live surebet is reported only if:
every leg was read within `liveMaxAgeSec` (20 s), it survives `liveConfirmPolls` (2)
polls in a row, and its profit is within `liveMinProfitPct`..`liveMaxProfitPct` (1-10%).
Live bets have a bookmaker acceptance delay and odds move fast: treat live alerts as
"check now", and keep auto-betting prematch-only (`autoPrematchOnly`).
Every leg in the dashboard and in Telegram links to that match on that bookmaker's site
(Bet365 links to the page the match was read from).

## Run 24/7 on a Mac mini

1. Install Google Chrome and Node.js 22.13+ (`brew install node`, or the installer from nodejs.org).
2. `git clone https://github.com/jergus48/surebet.git && cd surebet`. Settings are not in git
   (`data/` is ignored): optionally copy `data/settings.json` from the old machine into `data/`.
   Update later with `bash scripts/mac/update.sh`.
3. In Terminal, inside the folder: `bash scripts/mac/install.sh`
   It installs dependencies, registers a LaunchAgent (starts at login, restarts on crash,
   keeps the Mac awake with `caffeinate`), and starts the bot.
4. Open http://localhost:8080 on the Mac, choose a password. From your phone on the same
   Wi-Fi use the address the installer prints.
5. For true 24/7: System Settings > Users & Groups > automatic login; Energy > start up
   after power failure, prevent automatic sleeping.
6. Telegram: Nastavenia > Telegram: paste the @BotFather token, Save, send your bot "hi",
   click "Zistiť chat ID", then "Test".

### Start betting on the Mac (after `bash scripts/mac/update.sh`)

All eight betting books ship calibrated (Tipsport, Chance, Niké, DOXXbet, Tipos, Synottip,
Megawin MK, Bet365), so there is no calibrating to do. Once:

1. Nastavenia > Bookmakers: tick the books you have accounts at, Save. Provider: `browser`.
2. Overview > **Open window (log in)** next to each book, log in by hand in that window, leave it
   open. Megawin: if it asks for the PIN (last four digits of the ЕМБГ), type it in that window.
3. Overview > **Read balances now**: every book should show its balance (Megawin in € and МКД).
4. Nastavenia > Automatické stávkovanie: mode **fill**, Save. Then Start. Each new surebet fills
   the slips in the windows; check each and click Place yourself. Switch to **auto** only after a
   few fill bets went through cleanly (and check each book's bet history after the first ones).

Log: `tail -f data/bot.log`. Restart: `launchctl kickstart -k gui/$(id -u)/com.surebet.bot`.
Remove: `bash scripts/mac/uninstall.sh`. The bookmaker Chrome windows open on the Mac's
screen (one per bookmaker); leave them open. Logins are only needed for placing bets.

First visit from the same machine asks you to pick a dashboard password. On a
server set it via env instead: `DASHBOARD_PASSWORD=... npm start`.
Other env overrides: `ODDS_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
`PORT`, `CHROME_PATH`, `SUREBET_PROFILE_ROOT`, `AUTOSTART=0`.

## Odds source

- `browser` (recommended, free): reads every enabled bookmaker from its own debug
  Chrome, calling the site's own offer API from inside its tab, then groups the
  same fixture across books (time + fuzzy names, strict on U19/rez./ženy/doubles).
  Each book in `bookmakers` has `source: "browser"` or `source: "api"` (Odds-API.io).

  | book | football | how | notes |
  |---|---|---|---|
  | tipsport | ~400 | `/rest/offer/v2/offer` | 1X2 + double chance, live |
  | fortuna | ~1200 | per tournament + odds batches | ~245 requests; re-read every 120 s |
  | nike | ~1200 | `nikeone/v1/boxes/search/portal` | Cloudflare on bursts; every 120 s; prematch |
  | doxxbet | ~900 | `/offer/GetOfferList` | one request per sport, live |
  | tipos | ~950 | `GetWebStandardEvents` (protobuf) | 1X2 only, live |
  | synottip | ~1600 | `GetWebStandardEvents` (protobuf) | 1X2 + DC + totals, prematch |
  | megawin | ~10 (+ tennis, basketball) | Sportinno `widgets/derby-events` | homepage featured matches only (the full offer needs the widget's login token); 1X2/winner + goal totals, prematch; every 60 s |
  | bet365 | few | page reading | Bet365 serves empty pages after automated reloads: use `source: "api"` |

  Wrong pairings: add `data/aliases.json` `{ "name at one book": "name at another" }`.
  `maxOddsAgeSec` drops prices older than that from surebets.
- `mock`: fake Tipsport/Bet365/Pinnacle odds, costs nothing. Use it to try the flow.
- `oddsapi`: the-odds-api.com v4. Cost per scan = markets x regions per sport.
  The Overview tab shows the estimated credits/hour; the scanner stops itself
  below `minCreditsLeft`.
  **Coverage gap:** this API does not carry Tipsport or Stake, and bet365 only as
  `bet365_au` (AFL/NRL). For Bet365 EU + Tipsport you need another feed. Add it as
  `src/providers/<name>.js` exporting `fetchEvents`, `listSports`,
  `estimateCreditsPerHour`, `getCredits` and register it in `src/providers/index.js`.

## Bet modes (Nastavenia > Automatické stávkovanie)

| mode | what happens on a new surebet |
|------|-------------------------------|
| off  | alert only |
| fill | each leg opens in its own bookmaker window in parallel; with calibrated selectors it also clicks the odds and types the stake. You click Place. |
| auto | like fill, then clicks Place on all legs at once, only within the limits (min profit %, max total stake, max bets/day, prematch only). If any leg is not ready, it falls back to fill. |

The Surebety tab has an **Otvoriť** button per row that runs `fill` for that surebet.

### One-time setup per bookmaker

1. Overview tab > **Open window (log in)** next to the bookmaker (or run the shown command).
2. Log in by hand in that window. The login stays in `~/surebet-profiles/chrome-<book>`.
3. Calibrate: Overview tab > **Calibrate** next to the bookmaker (the panel at the top
   walks you through it, with Keep / Click again / Skip per step), or in a terminal
   `node scripts/calibrate.js <book>` (e.g. `tipsport`). It opens a new tab in
   that book's window and asks you to click, one by one: your **balance**, any **odds**
   button (it goes onto the slip), the **stake box**, the **slip odds** and the **Place**
   button. The Place click is blocked, so calibrating never bets. It keeps only stable
   selectors (data attributes, readable classes; never hashed ones like `sc-b8dd6735-3`)
   and saves them to `data/sites.json`. Clear the bet slip by hand afterwards.
   - `--check` shows what the saved selectors find on the current page.
   - `--from tipsport` copies another book's selectors first (Chance runs on the same
     platform as Tipsport, Synottip on the same as Tipos), then checks them. In the
     dashboard panel this is "Copy and check".
   - Rerun it when a site changes its layout and a step stops working.

Until `oddsButton`, `stakeInput` and `placeButton` are set, the book shows as
"not calibrated" and the bot only opens the event and tells you the stake.

Tipsport, Chance, Tipos, Synottip, Niké and DOXXbet ship calibrated (tested 2026-11-10 by filling
real slips without placing). Before the bot touches a slip it checks: logged in, balance covers
the stake, slip empty, then after clicking: exactly one selection, the right match, price within
5 % of the scan, stake box shows exactly the stake, and the Place button is in €; stake and €
are checked again right before Place. Any miss stops that leg. Chance's slip has a € / G switch
(G = Goldeny bonus coins) that opens on G: the bot clicks € itself and refuses anything else.

**Megawin MK** (port 9332, filled a real slip 2026-11-10 without placing) is in denars: stakes are
planned in € and converted with `fx.MKD` (61.5, the peg) to whole denars, the balance is stored
in € (the dashboard also shows the МКД amount), and the Place button must read МКД. Its stake box
is an on-screen number pad, its slip collapses to a bar the bot expands, and it closes the cookie
notice with its X (never accepts) on every page. megawin.mk/sport redirects to the homepage from
outside North Macedonia, so only the homepage's featured matches can be bet from there, and those
(~30, read from Sportinno's public featured feed) are the matches its odds reader scans.

**Bet365** (port 9302, filled a real slip 2026-11-12 on a logged-in bet365.com account without
placing) uses only its readable bet-slip classes and the price attribute `data-content`; the rest
of its markup is scrambled per deploy. Sometimes a pick is answered with "Entschuldigung, es ist
ein Fehler aufgetreten" and an empty slip: the bot then hard-refreshes the page and clicks once
more, and stops the leg if it happens again. The slip check also accepts bet365's German team
names ("Slowakei v Färöer"), and when a price repeats on the page it clicks the one in the right
match. Its balance box is part of the slip, so a leg without a balance shown is stopped as logged
out. The account must be used from its own country (an Austrian account from Austria): from
elsewhere bet365 refuses picks with that same error. Leave the Jackpot 365 switch on the slip off.

### Balances, bet confirmation and money

- **Balances**: with the `balance` selector set, the bot reads each logged-in book's
  balance every `balanceEverySec` (300 s) and on "Read balances now". The Overview shows
  it, stake caps (`stakePercent`) use it instead of the typed bankroll, and Telegram warns
  once per 12 h when a book drops below `lowBalanceAlert` (15 €).
- **Confirmation**: after clicking Place the bot waits up to 20 s for the balance to fall
  by the stake (or for `placedConfirm` if you set one). A leg it cannot confirm is
  reported as `unconfirmed`: check that book's bet history by hand.
- **Money** (History tab): record every deposit and withdrawal with the person and book.
  Profit = balances now + withdrawn − deposited, split by each person's share of the
  deposits. Stakes on unsettled bets are not in any balance, so profit dips until they settle.
- **Test before real money**: with a book calibrated, use the **Open** button on the
  Surebets tab (mode `fill`): it puts the stake on every slip and stops before Place.

### Risks to know

- **Partial fills.** If one leg is placed and the other is rejected or the odds moved,
  you hold a normal bet, not an arb. The bot logs it as `partial` and sends a Telegram alert.
- **Account limits.** Bookmakers (bet365 especially) limit or close accounts that
  bet arbs or use automation. Automated betting breaks their terms.
- No CAPTCHA or bot-detection bypass is built in. If a site challenges, finish it by hand.

## Layout

```
src/server.js         dashboard + JSON API
src/scanner.js        poll loop
src/arb.js            surebet math (2-way, 3-way, totals, spreads) + stake split
src/providers/        mock, oddsapi
src/bettor/chrome.js  per-book debug Chrome (launch/connect over CDP)
src/bettor/sites.js   per-book URLs + selectors (override in data/sites.json)
src/bettor/balances.js  live balance per book, low-balance alerts
src/bettor/selectors.js stable-selector rules for calibration (picker.js runs in the page)
src/money.js          deposits/withdrawals -> profit per person
src/bettor/calibration.js  calibration steps + dashboard session
scripts/calibrate.js  the same calibration in a terminal
src/bettor/index.js   open/fill/place executor with limits
src/notify.js         Telegram
public/index.html     UI
data/                 settings.json, surebet.db (gitignored)
```
# surebet
