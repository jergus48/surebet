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

1. Overview tab > **Otvoriť okno** next to the bookmaker (or run the shown command).
2. Log in by hand in that window. The login stays in `~/surebet-profiles/chrome-<book>`.
3. Calibrate selectors: copy `src/bettor/sites.js` field names into
   `data/sites.json`, e.g.

```json
{
  "tipsport": {
    "search": "https://www.tipsport.sk/...?q={q}",
    "selectors": {
      "loggedIn": "...", "oddsButton": "...", "stakeInput": "...",
      "slipOdds": "...", "placeButton": "...", "placedConfirm": "..."
    }
  }
}
```

Get each selector in the logged-in window: DevTools > right-click element > Copy > Copy selector.
Until `oddsButton`, `stakeInput` and `placeButton` are set, the book shows as
"nekalibrovaná" and the bot only opens the event and tells you the stake.

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
src/bettor/index.js   open/fill/place executor with limits
src/notify.js         Telegram
public/index.html     UI
data/                 settings.json, surebet.db (gitignored)
```
# surebet
