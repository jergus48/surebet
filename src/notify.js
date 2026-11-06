// Telegram alerts (Bot API sendMessage, HTML). Create a bot with @BotFather, send it
// any message (or add it as admin to your channel), then put its token in
// Settings and click "Find chat ID".
const { marketLabel } = require('./arb');

const BOOK_NAMES = {
  tipsport: 'Tipsport', bet365: 'Bet365', pinnacle: 'Pinnacle', fortuna: 'Fortuna', nike: 'Niké', doxxbet: 'DOXXbet',
  tipos: 'Tipos', synottip: 'Synottip', chance: 'Chance', stake: 'Stake', olybet: 'OlyBet', inbet: 'Inbet', maxbet: 'Maxbet MK', mozzart: 'Mozzart MK',
};
const bookName = k => BOOK_NAMES[k] || k;

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isUrl = u => /^https?:\/\//i.test(u || '');

// What a selection means, in words: "Sparta vyhrá", "Remíza", "Viac ako 2.5".
function selLabel(sb, leg) {
  const h = sb.home, a = sb.away;
  if (sb.market === 'totals') return leg.sel === 'O' ? `Over ${sb.point}` : `Under ${sb.point}`;
  if (sb.market === 'spreads') return leg.sel === 'H' ? `${h} ${sb.point > 0 ? '+' : ''}${sb.point}` : `${a} ${-sb.point > 0 ? '+' : ''}${-sb.point}`;
  switch (leg.sel) {
    case '1': return `${h} wins`;
    case '2': return `${a} wins`;
    case 'X': return 'Draw';
    case '1X': return `${h} wins or draw (1X)`;
    case 'X2': return `Draw or ${a} wins (X2)`;
    case '12': return 'Either team wins, no draw (12)';
    default: return leg.sel;
  }
}

const fmtMoney = n => Number(n).toFixed(2);
const fmtWhen = ms => new Date(ms).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

// opts.siblings: other surebets on the same match; opts.previous: earlier profit % (update message)
function format(sb, opts = {}) {
  const now = Date.now();
  const head = opts.test ? '🧪 <b>TEST: sample alert</b>'
    : opts.previous != null ? `🔄 <b>updated ${new Date(now).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</b> (was ${opts.previous}%)`
    : sb.live ? '🔴 <b>LIVE surebet</b>' : '💰 <b>New surebet!</b>';
  const lines = [head];
  if (sb.live && opts.previous == null && !opts.test) lines.push('<i>Live odds change fast, verify on the site.</i>');
  const odd = sb.legs.filter(l => l.outlier);
  if (odd.length && opts.previous == null) {
    lines.push(`⚡ <b>Fast-moving, check now:</b> ${odd.map(l => `${esc(bookName(l.book))} ${l.price} is well above the other books (~${l.ref}), likely a stale line that closes within minutes`).join('; ')}`);
  }
  lines.push(
    `Profit: <b>${sb.profitPct}%</b>`,
    `Sport: ${esc(sb.sportTitle)}`,
    `League: ${esc(sb.league || '–')}`,
    `Match: ${esc(sb.home)} - ${esc(sb.away)}`,
    `Starts: ${esc(sb.live ? 'in play' : fmtWhen(sb.start))}`,
    '',
  );
  for (const l of sb.legs) {
    const age = l.updated ? Math.max(0, Math.round((now - l.updated) / 60000)) : null;
    lines.push(`<b>${esc(bookName(l.book))}</b>:${age != null ? ` <i>(odds ${age} min old)</i>` : ''}`);
    lines.push(`  ${esc(selLabel(sb, l))} → <b>${l.price}</b>`);
    lines.push(`  Stake: ${fmtMoney(l.stake)} €${isUrl(l.link) ? ` <a href="${esc(l.link)}">${l.linkGeneric ? 'Site (find the match by name)' : 'Match'}</a>` : ''}`);
  }
  const payout = sb.staked + sb.worstProfit;
  lines.push('', `Total stake: ${fmtMoney(sb.staked)} € → min. payout ${fmtMoney(payout)} € (profit ${sb.worstProfit >= 0 ? '+' : ''}${fmtMoney(sb.worstProfit)} €)`);
  const sib = (opts.siblings || []).filter(x => x.key !== sb.key).slice(0, 4);
  if (sib.length) lines.push('', `➕ More on this match: ${sib.map(x => `${esc(marketLabel(x))} ${x.profitPct}%`).join(' · ')}`);
  return lines.join('\n');
}

// A realistic fake surebet for the "Test" button (links go to the real sites' homepages).
function sample() {
  const now = Date.now();
  return {
    key: 'test', eventId: 'test', sport: 'tennis', sportTitle: 'Tennis', league: 'ITF Heraklion (sample)', home: 'Player A', away: 'Player B',
    start: now + 3 * 3600e3, live: false, market: 'h2h', point: null, profitPct: 3.7, staked: 100, worstProfit: 3.7,
    legs: [
      { book: 'bet365', sel: '1', price: 4.0, stake: 25.93, updated: now - 2 * 60000, link: 'https://www.bet365.com/' },
      { book: 'tipsport', sel: '2', price: 1.4, stake: 74.07, updated: now - 60000, link: 'https://www.tipsport.sk/' },
    ],
  };
}

async function send(settings, text, opts = {}) {
  if (!settings.telegramBotToken || !settings.telegramChatId) return false;
  const body = { chat_id: settings.telegramChatId, text, disable_web_page_preview: true };
  if (opts.html) body.parse_mode = 'HTML';
  const r = await fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`telegram ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return true;
}

// Find the chat id of whoever last messaged the bot (Bot API getUpdates).
// You send your bot any message first (or add it to a channel as admin), then call this.
async function findChatId(settings) {
  if (!settings.telegramBotToken) throw new Error('Set the bot token first');
  const r = await fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/getUpdates`);
  const j = await r.json();
  if (!j.ok) throw new Error(`telegram: ${j.description || r.status}`);
  const msgs = (j.result || []).map(u => u.message || u.edited_message || u.channel_post || (u.my_chat_member && { chat: u.my_chat_member.chat })).filter(Boolean);
  const last = msgs[msgs.length - 1];
  if (!last) throw new Error('No messages yet: open your bot in Telegram, send it "hi", then try again');
  return { chatId: String(last.chat.id), name: last.chat.first_name || last.chat.title || last.chat.username || '' };
}

// Check the token itself (getMe): returns the bot's @username.
async function whoAmI(settings) {
  if (!settings.telegramBotToken) throw new Error('Set the bot token first');
  const r = await fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/getMe`);
  const j = await r.json();
  if (!j.ok) throw new Error(`telegram: ${j.description || r.status}`);
  return { username: j.result.username, name: j.result.first_name };
}

module.exports = { send, format, sample, bookName, findChatId, whoAmI, selLabel };
