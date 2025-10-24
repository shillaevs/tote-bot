// bot.ts — тотализатор 15×3 без платёжки: билеты сохраняются в data/store.json
// Запуск: pm2 start "npx ts-node --compiler-options '{\"module\":\"commonjs\"}' bot.ts" --name tote-bot --cwd /tote-bot

import * as dotenv from 'dotenv';
dotenv.config();

import { Telegraf, Context, Markup } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/types';
// +++ PAYMENTS/TON +++
import { initTon, checkTonPayment, checkJettonPayment, sendJetton } from './ton.js';
import { calculatePayouts, type FormulaName } from './settlement.js';

import * as fs from 'fs/promises';
import * as path from 'path';

// --------------- .env ---------------
const BOT_TOKEN = process.env.BOT_TOKEN || '';
if (!BOT_TOKEN) {
  console.error('ERROR: BOT_TOKEN is empty. Put it into .env');
  process.exit(1);
}
const ADMIN_IDS: number[] = (process.env.ADMIN_IDS || '')
  .split(',')
  .map(s => Number(s.trim()))
  .filter(Boolean);

const EVENTS_COUNT = Number(process.env.EVENTS_COUNT || 15);
const PAGE_SIZE = 10;           // "Мои билеты": строки на страницу
const ADMIN_PAGE_SIZE = 15;     // "Админ: билеты": строки на страницу
const ADMIN_EDIT_PAGE_SIZE = 5; // 👈 событий на страницу в "Редакторе событий"

// Базовая ставка (руб) за «одиночный» билет (по одному исходу в каждом событии)
const STAKE_RUB = Number(process.env.STAKE_RUB || 100);

// === TON / PAYOUT ENV ===
const TON_NETWORK = (process.env.TON_NETWORK || 'testnet').toLowerCase();   // mainnet | testnet
const TON_RECEIVE_ADDRESS = process.env.TON_RECEIVE_ADDRESS || '';
const TON_MIN_CONFIRMATIONS = Number(process.env.TON_MIN_CONFIRMATIONS || 1);
const CURRENCY = (process.env.CURRENCY || 'TON').toUpperCase() as 'USDT_TON' | 'TON';
const STAKE_USDT = Number(process.env.STAKE_USDT || 0.1); // цена базового купона (TON при тестах)

const PAYOUT_FORMULA = (process.env.PAYOUT_FORMULA || 'MAX_HITS_EQUAL_SHARE') as FormulaName;
function __readJSONEnv(name: string, fallback: any) {
  try { return JSON.parse(process.env[name] || ''); } catch { return fallback; }
}
const PAYOUT_PARAMS_MAX_HITS_EQUAL_SHARE = __readJSONEnv('PAYOUT_PARAMS_MAX_HITS_EQUAL_SHARE', { prizePoolPct: 0.90, rolloverIfNoWinners: true });
const PAYOUT_PARAMS_TIERED_WEIGHTS       = __readJSONEnv('PAYOUT_PARAMS_TIERED_WEIGHTS',       { prizePoolPct: 0.90, weights: { "15": 70, "14": 20, "13": 10 }, minHits: 13, rolloverUnclaimed: true });
const PAYOUT_PARAMS_FIXED_TABLE          = __readJSONEnv('PAYOUT_PARAMS_FIXED_TABLE',          { fixed: { "15": 10000, "14": 1500, "13": 250 }, rolloverUnclaimed: true });

// --------------- Типы ---------------
type DrawStatus = 'setup' | 'open' | 'closed' | 'settled';

interface EventItem {
  idx: number;
  title: string;
  result: number | null; // 0,1,2 или null
  isVoid: boolean;
  sourceUrl?: string; // официальный источник результата
}

interface Settlement {
  settledAt: string;
  totalPlayed: number; // число не-void событий с результатом
  maxHits: number;     // максимум совпадений
  bankRUB: number;     // сумма всех ставок
  bankUSDT?: number;   // сумма банка в USDT/TON валюте выплат
  formulaName?: string;
  formulaParams?: any;
  formulaVersion?: string;
  winners: { ticketId: string; userId: number; username?: string; hits: number; prizeRUB: number; prizeUSDT?: number }[];
}

interface Draw {
  id: number;
  status: DrawStatus;
  createdAt: string;
  events: EventItem[];
  settlement?: Settlement;
}

const OUTCOMES = ['1', 'X', '2'];                  // компактно (для CSV/TXT)
const OUT_TEXT = ['Победа 1', 'Ничья', 'Победа 2']; // красиво (для UI)

interface Ticket {
  id: string;
  userId: number;
  username?: string;
  selections: number[][];
  createdAt: string;
}

interface UserData {
  hasTicketForCurrent: boolean;
  wallet?: string;
  username?: string;
}

interface Store {
  draw: Draw;
  tickets: Ticket[];
  nextTicketSeq: number;
  users: { [userId: string]: UserData };
  payments?: {
    [invoiceId: string]: {
      userId: number;
      currency: 'USDT_TON' | 'TON';
      amount: number;
      comment: string;
      paid: boolean;
      txHash?: string;
      createdAt: string;
    }
  };
}

interface Session {
  selections: number[][];
}

// --------------- FS ---------------
const DATA_DIR = path.join(process.cwd(), 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function loadStore(): Promise<Store> {
  await ensureDirs();
  try {
    const raw = await fs.readFile(STORE_FILE, 'utf8');
    const data = JSON.parse(raw);

    if (!Array.isArray(data.tickets)) data.tickets = [];
    if (!data.users || typeof data.users !== 'object' || Array.isArray(data.users)) {
      data.users = {};
    }
    if (!data.draw) {
      data.draw = {
        id: 1,
        status: 'setup',
        createdAt: new Date().toISOString(),
        events: [],
      };
    }
    if (typeof data.nextTicketSeq !== 'number') {
      data.nextTicketSeq = 1;
    }
    return data as Store;
  } catch {
    const initial: Store = {
      draw: { id: 1, status: 'setup', createdAt: new Date().toISOString(), events: [] },
      tickets: [],
      nextTicketSeq: 1,
      users: {},
    };
    await fs.writeFile(STORE_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
}

async function saveStore(data: Store) {
  if (!data.users || typeof data.users !== 'object' || Array.isArray(data.users)) {
    data.users = {};
  }
  await fs.writeFile(STORE_FILE, JSON.stringify(data, null, 2));
}

// --------------- Бот и состояние ---------------
const bot = new Telegraf(BOT_TOKEN);
let st: Store;

const sessions = new Map<number, Session>();

// --------------- Утилиты форматирования/подсчёта ---------------
function esc(s: string) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const fmtMoney = (n: number) => n.toLocaleString('ru-RU');

function playedEventsCount() {
  const evs = st?.draw?.events || [];
  return evs.filter(e => e && e.result !== null && !e.isVoid).length;
}

function computeHits(t: Ticket): number {
  if (!st?.draw?.events) return 0;
  let hits = 0;
  for (let i = 0; i < st.draw.events.length; i++) {
    const ev = st.draw.events[i];
    if (!ev || ev.result === null || ev.isVoid) continue;
    const sel = t.selections[i] || [];
    if (sel.includes(ev.result)) hits++;
  }
  return hits;
}

// === Комбинаторика для цены и генерация инвойса ===
function countCombinations(selections: number[][]): number {
  if (!selections || !selections.length) return 0;
  let prod = 1;
  for (const s of selections) {
    const len = (s && s.length) ? s.length : 0;
    if (len === 0) return 0;
    prod *= len;
  }
  return prod;
}

function genInvoice(userId: number, drawId: number) {
  const nonce = Math.random().toString(36).slice(2, 8).toUpperCase();
  const invoiceId = `INV-${drawId}-${userId}-${Date.now()}-${nonce}`;
  const comment = `TOTE-${drawId}-${userId}-${nonce}`;
  return { invoiceId, comment };
}

// === Формула стоимости Toto-15 ===

// --- Оплата и выпуск билета ---
bot.action('buy', async (ctx) => {
  st = st || await loadStore();
  const uid = ctx.from?.id!;
  if (st.draw.status !== 'open') { await ctx.answerCbQuery('Приём ставок закрыт'); return; }
  const sess = sessions.get(uid);
  if (!sess) { await ctx.answerCbQuery('Сначала выберите исходы билета'); return; }
  const combos = countCombinations(sess.selections);
  if (combos <= 0) { await ctx.answerCbQuery('Билет пуст — выберите исходы'); return; }

  const amount = (CURRENCY === 'USDT_TON') ? +(STAKE_USDT * combos).toFixed(6) : +(STAKE_USDT * combos).toFixed(6);

  const { invoiceId, comment } = genInvoice(uid, st.draw.id);
  st.payments = st.payments || {};
  st.payments[invoiceId] = { userId: uid, currency: CURRENCY, amount, comment, paid: false, createdAt: new Date().toISOString() };
  await saveStore(st);

  const text = [
    '<b>Оплата билета</b>',
    '',
    `Сумма: <b>${amount} ${CURRENCY === 'USDT_TON' ? 'USDT' : 'TON'}</b>`,
    `Адрес для перевода: <code>${TON_RECEIVE_ADDRESS}</code>`,
    `Комментарий к платежу: <code>${comment}</code>`,
    '',
    'Скопируйте комментарий без изменений. После перевода нажмите «Проверить оплату».',
  ].join('\n');

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [ [Markup.button.callback('🔄 Проверить оплату', `pay:check:${invoiceId}`)], [Markup.button.callback('🏠 На главную', 'home')] ] } });
});

bot.action(/^pay:check:(.+)$/, async (ctx) => {
  st = st || await loadStore();
  const invoiceId = ctx.match[1];
  const rec = st.payments?.[invoiceId];
  if (!rec) { await ctx.answerCbQuery('Инвойс не найден'); return; }
  if (rec.paid) { await ctx.answerCbQuery('Уже оплачено'); return; }

  let found = false, txHash = '';
  if (rec.currency === 'USDT_TON') {
    const res = await checkJettonPayment({ ownerBaseAddress: TON_RECEIVE_ADDRESS, expectedAmountTokens: rec.amount, comment: rec.comment, minConfirmations: TON_MIN_CONFIRMATIONS });
    found = (res as any).found; txHash = (res as any).txHash || '';
  } else {
    const res = await checkTonPayment({ toAddress: TON_RECEIVE_ADDRESS, expectedAmountTon: rec.amount, comment: rec.comment, minConfirmations: TON_MIN_CONFIRMATIONS });
    found = (res as any).found; txHash = (res as any).txHash || '';
  }

  if (!found) { await ctx.answerCbQuery('Платёж пока не найден. Попробуйте позже.'); return; }

  rec.paid = true; rec.txHash = txHash;
  await saveStore(st);

  const uid = rec.userId;
  const sess = sessions.get(uid);
  if (!sess) { await ctx.reply('Оплата прошла, но нет данных билета. Оформите билет заново.'); return; }

  const tId = `T${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
  const ticket = { id: tId, userId: uid, username: ctx.from?.username, selections: sess.selections.map(a => a.slice()), createdAt: new Date().toISOString() };
  st.tickets.push(ticket);
  st.users[uid] = st.users[uid] || { hasTicketForCurrent: false };
  st.users[uid].hasTicketForCurrent = true;
  st.draw.settlement = st.draw.settlement || { settledAt: '', totalPlayed: 0, maxHits: 0, bankRUB: 0, winners: [] };
  st.draw.settlement.bankUSDT = +(st.draw.settlement.bankUSDT || 0) + rec.amount;

  await saveStore(st);
  await ctx.reply(`✅ Оплата найдена.\nБилет выпущен: ${tId}`, { reply_markup: homeKbInline() });
});
function calcStakeRUB(selections: number[][], base = STAKE_RUB): number {
  const mult = selections.reduce((acc, s) => acc * (s.length || 1), 1);
  return base * mult;
}
function stakeBreakdown(selections: number[][]) {
  let singles = 0, doubles = 0, triples = 0;
  for (const s of selections) {
    const n = s?.length || 0;
    if (n <= 1) singles++;
    else if (n === 2) doubles++;
    else triples++;
  }
  const mult = selections.reduce((acc, s) => acc * (s.length || 1), 1);
  return { singles, doubles, triples, mult };
}
function formatStakeLine(selections: number[][]) {
  const { singles, doubles, triples, mult } = stakeBreakdown(selections);
  const price = calcStakeRUB(selections);
  return `💰 <b>Текущая ставка: ${fmtMoney(price)} ₽</b>\n(множитель ×${mult} • 1×${singles}, 2×${doubles}, 3×${triples})`;
}

// === Settlement (один проход) ===
function isReadyForSettlement(draw: Draw): { ready: boolean; totalPlayed: number } {
  const evs = draw.events || [];
  if (!evs.length) return { ready: false, totalPlayed: 0 };
  let totalPlayed = 0;
  for (const e of evs) {
    if (e.isVoid) continue;
    if (e.result === null) return { ready: false, totalPlayed: 0 };
    totalPlayed++;
  }
  return { ready: totalPlayed > 0, totalPlayed };
}

function settleDraw(): Settlement {
  const { totalPlayed } = isReadyForSettlement(st.draw);
  const tickets = st.tickets.slice();

  const bank = tickets.reduce((sum, t) => sum + calcStakeRUB(t.selections), 0);

  let maxHits = 0;
  const scored = tickets.map(t => {
    const h = computeHits(t);
    if (h > maxHits) maxHits = h;
    return { t, hits: h };
  });

  const winnersRaw = scored.filter(x => x.hits === maxHits);
  const winnersCount = winnersRaw.length || 0;

  let prizePerWinner = 0;
  if (winnersCount > 0) {
    prizePerWinner = Math.floor(bank / winnersCount);
  }

  const winners = winnersRaw.map(x => ({
    ticketId: x.t.id,
    userId: x.t.userId,
    username: x.t.username,
    hits: x.hits,
    prizeRUB: prizePerWinner,
  }));

  const settlement: Settlement = {
    settledAt: new Date().toISOString(),
    totalPlayed,
    maxHits,
    bankRUB: bank,
    winners,
  };

  st.draw.settlement = settlement;
  st.draw.status = 'settled';
  return settlement;
}

function formatSettlementSummaryHTML(s: Settlement): string {
  const lines: string[] = [];
  lines.push(`🏁 <b>Итоги тиража</b>`);
  lines.push(`Сыгравших событий: <b>${s.totalPlayed}</b>`);
  lines.push(`Максимум совпадений: <b>${s.maxHits}</b>`);
  lines.push(`💰 Банк: <b>${fmtMoney(s.bankRUB)} ₽</b>`);
  lines.push(`Победителей: <b>${s.winners.length}</b>`);
  if (s.winners.length) {
    const sample = s.winners.slice(0, 10).map((w, i) => {
      const tag = w.username ? `@${esc(w.username)}` : `u:${w.userId}`;
      return `${i + 1}) ${tag} • #${esc(w.ticketId.slice(0, 8))}… • ${w.hits} совп. • приз ${fmtMoney(w.prizeRUB)} ₽`;
    });
    lines.push('');
    lines.push(sample.join('\n'));
    if (s.winners.length > 10) lines.push(`… и ещё ${s.winners.length - 10}`);
  }
  return lines.join('\n');
}

// Общий HTML-свод результатов (для превью/рассылки/кнопки игрока)
function getResultsSummaryHTML(): string {
  const d = st.draw;
  const lines: string[] = [];

  lines.push(`🏆 <b>Результаты тиража #${d.id}</b>`);
  lines.push('');

  (d.events || []).forEach((e, i) => {
    const n = String(i + 1).padStart(2, '0');
    const title = esc(e.title || `Событие ${i + 1}`);
    let res = '—';
    if (e.isVoid) res = 'АННУЛИРОВАНО';
    else if (e.result !== null) res = OUT_TEXT[e.result];

    let src = '';
    if (e.sourceUrl) {
      try {
        const u = new URL(e.sourceUrl);
        src = `\n   Источник: <a href="${esc(u.toString())}">${esc(u.hostname)}</a>`;
      } catch {
        src = `\n   Источник: <a href="${esc(e.sourceUrl)}">${esc(e.sourceUrl)}</a>`;
      }
    }
    lines.push(`${n}. ${title} — <b>${esc(res)}</b>${src}`);
  });

  const totalPlayed = playedEventsCount();
  const totalTickets = st.tickets.length;
  const uniqueUsers = new Set(st.tickets.map(t => t.userId)).size;
  const bank = st.tickets.reduce((sum, t) => sum + calcStakeRUB(t.selections), 0);

  lines.push('');
  lines.push(`Сыгравших событий: <b>${totalPlayed}/${st.draw.events.length}</b>`);
  lines.push(`👥 Билетов: <b>${totalTickets}</b> • 👤 Участников: <b>${uniqueUsers}</b> • 💰 Банк (сумма ставок): <b>${fmtMoney(bank)} ₽</b>`);

  if (d.settlement) {
    lines.push('');
    lines.push(formatSettlementSummaryHTML(d.settlement));
  }

  return lines.join('\n');
}

// Топ игроков по лучшему билету (черновой рейтинг, если нет settlement)
function getLeadersTable(limit = 10): { html: string; leaders: { userId: number; username?: string; hits: number }[] } {
  const bucket: Record<string, { userId: number; username?: string; hits: number }> = {};
  for (const t of st.tickets) {
    const key = String(t.userId);
    const h = computeHits(t);
    if (!bucket[key] || h > bucket[key].hits) {
      bucket[key] = { userId: t.userId, username: t.username, hits: h };
    }
  }
  const leaders = Object.values(bucket).sort((a, b) => b.hits - a.hits).slice(0, limit);

  const lines: string[] = [];
  if (!leaders.length) {
    lines.push('Пока нет билетов.');
  } else {
    lines.push('<b>Топ участников</b>');
    leaders.forEach((u, idx) => {
      const tag = u.username ? `@${esc(u.username)}` : `u:${u.userId}`;
      const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '🏅';
      lines.push(`${medal} ${tag} — <b>${u.hits}</b> совп.`);
    });
  }
  return { html: lines.join('\n'), leaders };
}

function getIntroHtml(): string {
  return [
    `👋 <b>Привет!</b> Ты в тотализаторе <b>15×3</b> — лёгкая игра на спортивные исходы.`,
    ``,
    `Как это работает:`,
    `• На каждый из <b>${EVENTS_COUNT}</b> матчей выбираешь исход: <b>1</b> (победа хозяев), <b>X</b> (ничья) или <b>2</b> (победа гостей).`,
    `• Можно отмечать сразу несколько исходов на матч — так шанс выше, но билет «шире».`,
    `• Когда готов — жми «<b>Сохранить</b>». Билет попадёт в базу текущего тиража.`,
    ``,
    `💡 Важно: <b>стоимость билета зависит от числа отмеченных исходов</b>.`,
    `Базовая ставка — <b>${STAKE_RUB} ₽</b>, итоговая цена = база × произведение выбранных вариантов (1/2/3) по всем событиям.`,
    ``,
    `Что здесь удобно:`,
    `• <b>🎲 Автовыбор</b> — бот сам раскидает случайные исходы по всем событиям.`,
    `• <b>🧹 Очистить выбор</b> — одним нажатием всё сбрасывается.`,
    `• <b>📋 Мои билеты</b> — аккуратный список с пагинацией, детальные карточки и экспорт в TXT/CSV.`,
    `• <b>🏆 Результаты</b> — официальный свод по тиражу с ссылками на источники.`,
    `• <b>🛠 Админ-меню</b> — для организаторов (редактор событий, результаты, отчёты).`,
    ``,
    `Удачи и азарта! 💙`,
  ].join('\n');
}

// --------------- Клавиатуры ---------------
function mainKb(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [Markup.button.callback('🎫 Собрать билет', 'make')],
      [Markup.button.callback('📋 Мои билеты', 'my')],
      [Markup.button.callback('🏆 Результаты', 'u:results')],
    ],
  };
}

function homeKbInline(): InlineKeyboardMarkup {
  return { inline_keyboard: [[Markup.button.callback('🏠 На главную', 'home')]] };
}

function confirmSaveKb(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        Markup.button.callback('✅ Подтвердить', 'save:ticket:confirm'),
        Markup.button.callback('❌ Отменить', 'save:ticket:cancel'),
      ],
      [Markup.button.callback('🏠 На главную', 'home')],
    ],
  };
}

function makeTicketKb(s: Session, events: EventItem[]): InlineKeyboardMarkup {
  const rows: any[] = [];

  for (let i = 0; i < EVENTS_COUNT; i++) {
    const sel = s.selections[i] || [];
    const title = events[i]?.title || `Событие ${i + 1}`;
    rows.push([
      Markup.button.callback(`${String(i + 1).padStart(2, '0')}. ${title}`.slice(0, 64), `noop:make:${i}`)
    ]);
    rows.push([
      Markup.button.callback(sel.includes(0) ? '✅ 1' : '1', `sel:${i}:0`),
      Markup.button.callback(sel.includes(1) ? '✅ X' : 'X', `sel:${i}:1`),
      Markup.button.callback(sel.includes(2) ? '✅ 2' : '2', `sel:${i}:2`)
    ]);
  }

  rows.push([
    Markup.button.callback('🎲 Автовыбор', 'auto:pick'),
    Markup.button.callback('🧹 Очистить выбор', 'clear:pick'),
    Markup.button.callback('💾 Сохранить', 'save:ticket'),
  ]);
  rows.push([Markup.button.callback('🏠 На главную', 'home')]);

  rows.push([Markup.button.callback('💳 Оплатить и выпустить билет', 'buy')]);
  return { inline_keyboard: rows };
}

// --------------- Пагинация редактора событий ---------------
function pageForEventIdx(idx: number) {
  return Math.floor(idx / ADMIN_EDIT_PAGE_SIZE) + 1;
}

// --------------- Заглушка событий для setup ---------------
const placeholderEvents = Array.from({ length: EVENTS_COUNT }, (_, i) => ({
  idx: i,
  title: `Матч ${i + 1}: КомандаA — КомандаB`,
  result: null,
  isVoid: false,
}));

// --------------- Команды /start /help /rules /events /my ---------------
bot.start(async (ctx) => {
  st = st || await loadStore();
  await ctx.reply(getIntroHtml(), { parse_mode: 'HTML', reply_markup: mainKb() });
});

// HELP без <hr>
bot.help(async (ctx) => {
  const helpText = `
<b>🎯 Добро пожаловать в тотализатор!</b>

Этот бот — простая игра на прогноз исходов матчей ⚽️🏒🏀  
Вы выбираете результаты — бот фиксирует ваш билет и ждёт окончания тиража.  
После завершения всех событий бот подведёт итоги и покажет победителей 💪

— — — — — — — — — —

<b>📘 Как играть:</b>

1️⃣ Нажмите <i>«Собрать билет»</i><br>
2️⃣ В каждом событии выберите исход:<br>
&nbsp;&nbsp;&nbsp;🅰 Победа первой команды<br>
&nbsp;&nbsp;&nbsp;🤝 Ничья<br>
&nbsp;&nbsp;&nbsp;🅱 Победа второй команды<br>
3️⃣ Не хотите вручную? Жмите 🎲 <i>«Автовыбор»</i> — бот расставит исходы сам.<br>
4️⃣ Можно стереть выбор кнопкой 🧹 <i>«Очистить выбор»</i>.<br>
5️⃣ Нажмите <i>«💾 Сохранить»</i> — появится подтверждение ставки и кнопка «Подтвердить».

— — — — — — — — — —

<b>💰 Ставка:</b><br>
• Базовая ставка — <b>${STAKE_RUB} ₽</b>.<br>
• Итоговая стоимость = база × произведение отмеченных исходов (1/2/3) по всем событиям.<br>
• Чем больше вариантов отмечаете, тем выше шансы — и тем дороже билет.

— — — — — — — — — —

<b>📋 Что ещё умеет бот:</b><br>
🎟 <i>«Мои билеты»</i> — список ваших билетов с навигацией и экспортом TXT/CSV.<br>
🏆 <i>«Результаты»</i> — официальный свод по тиражу с исходами и источниками.<br>

<b>🎉 Удачи и спортивного азарта!</b>
  `;
  await ctx.reply(helpText, { parse_mode: 'HTML', reply_markup: homeKbInline() });
});

// RULES
bot.command('rules', async (ctx) => {

// --- /wallet: сохранить адрес для выплат ---
bot.command('wallet', async (ctx) => {
  st = st || await loadStore();
  const uid = ctx.from?.id!;
  const parts = (ctx.message as any).text.split(/\s+/);
  if (parts.length < 2) {
    await ctx.reply('Пришлите адрес: /wallet EQC...ваш_адрес', { reply_markup: homeKbInline() });
    return;
  }
  const addr = parts[1].trim();
  st.users[uid] = st.users[uid] || { hasTicketForCurrent: false };
  st.users[uid].wallet = addr;
  st.users[uid].username = st.users[uid].username || ctx.from?.username || '';
  await saveStore(st);
  await ctx.reply(`Адрес сохранён: ${addr}`, { reply_markup: homeKbInline() });
});
  const text = `
<b>📜 Правила</b>

• Тираж состоит из ${EVENTS_COUNT} событий.<br>
• В каждом событии можно выбрать один или несколько исходов: <b>1</b> / <b>X</b> / <b>2</b>.<br>
• Итоговая ставка = <b>${STAKE_RUB} ₽ × произведение числа отмеченных исходов</b> по всем событиям.<br>
• Когда все события завершатся, бот подведёт итоги по совпадениям (void не учитываются).<br>
• Итоги подтверждаются ссылками на официальные источники (если указаны админом).
  `;
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: homeKbInline() });
});

// Список событий (публичный)
bot.command('events', async (ctx) => {
  st = st || await loadStore();

  if (!st.draw || !st.draw.events?.length) {
    await ctx.reply('Список событий пуст. Создайте события в /admin.', { reply_markup: homeKbInline() });
    return;
  }

  const lines = st.draw.events.map((e, i) => {
    const mark = e.isVoid ? '❌' : (e.result === null ? '⚪️' : '✅');
    const res = e.result === null ? '' : ` — результат: <b>${OUT_TEXT[e.result]}</b>`;
    let src = '';
    if (e.sourceUrl) {
      try {
        const u = new URL(e.sourceUrl);
        src = `\n   Источник: <a href="${esc(u.toString())}">${esc(u.hostname)}</a>`;
      } catch {
        src = `\n   Источник: <a href="${esc(e.sourceUrl)}">${esc(e.sourceUrl)}</a>`;
      }
    }
    return `${mark} ${String(i + 1).padStart(2, '0')}. ${esc(e.title)}${res}${src}`;
  });

  await ctx.reply(
    [
      `📋 <b>Список событий тиража #${st.draw.id}</b>`,
      `Статус: ${st.draw.status}`,
      '',
      lines.join('\n\n'),
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: homeKbInline() }
  );
});

// Мои билеты (команда и кнопка)
bot.command('my', async (ctx) => {
  await showMyTicketsPage(ctx, 1);
});
bot.action('my', async (ctx) => {
  await ctx.answerCbQuery('');
  await showMyTicketsPage(ctx, 1);
});

// Игрок: кнопка результатов
bot.action('u:results', async (ctx) => {
  st = st || await loadStore();
  const totalPlayed = playedEventsCount();
  if (totalPlayed === 0) {
    await ctx.answerCbQuery('');
    await ctx.reply('Итоги пока недоступны — ещё нет сыгравших событий.', { reply_markup: homeKbInline() });
    return;
  }
  const summary = getResultsSummaryHTML();
  await ctx.answerCbQuery('');
  await ctx.reply(summary, { parse_mode: 'HTML', reply_markup: homeKbInline() });
});

// Домой
async function goHome(ctx: Context) {
  const intro = getIntroHtml();
  try {
    // @ts-ignore
    if (ctx.callbackQuery) {
      await (ctx as any).editMessageText(intro, { parse_mode: 'HTML', reply_markup: mainKb() });
      return;
    }
  } catch {}
  await (ctx as any).reply(intro, { parse_mode: 'HTML', reply_markup: mainKb() });
}
bot.action('home', async (ctx) => {
  await ctx.answerCbQuery('');
  await goHome(ctx);
});

// --------------- Админка ---------------
function isAdmin(ctx: Context) {
  const uid = ctx.from?.id;
  return !!uid && ADMIN_IDS.includes(uid);
}

bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  adminState.set(ctx.from!.id, { mode: 'IDLE' });
  await ctx.reply(
    `Админ-меню. Тираж #${st.draw.id}, статус: ${st.draw.status}. Событий: ${st.draw.events.length}/${EVENTS_COUNT}`,
    { reply_markup: adminKb(st.draw) }
  );
});

type AdminMode = 'IDLE' | 'RENAME' | 'RENAME_ONE' | 'SET_SRC';
const adminState = new Map<number, { mode: AdminMode; evIdx?: number }>();

function adminKb(draw: Draw): InlineKeyboardMarkup {
  const rows = [
    [Markup.button.callback('🛠 Редактор событий', 'a:manage')],
    [Markup.button.callback('📋 События', 'a:events')],
    [
      Markup.button.callback('🟢 Открыть приём', 'a:open'),
      Markup.button.callback('🔴 Закрыть приём', 'a:close'),
    ],
    [Markup.button.callback('📊 Подвести итоги', 'a:settle')],
    [Markup.button.callback('📜 Показать список билетов', 'a:list')],
    [Markup.button.callback('🎟 Билеты (админ)', 'a:tickets')],
    [Markup.button.callback('👀 Превью итогов', 'a:preview')],
    [Markup.button.callback('📣 Разослать результаты', 'a:broadcast')],
    [Markup.button.callback('🏠 На главную', 'home')],
  ];
  return { inline_keyboard: rows };
}

// Пагинация редактора событий
function manageKb(draw: Draw, page = 1): InlineKeyboardMarkup {
  const rows: any[] = [];

  const total = draw.events.length;
  const pages = Math.max(1, Math.ceil(total / ADMIN_EDIT_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const start = (safePage - 1) * ADMIN_EDIT_PAGE_SIZE;
  const end = Math.min(start + ADMIN_EDIT_PAGE_SIZE, total);

  for (let i = start; i < end; i++) {
    const e = draw.events[i];
    const num = String(e.idx + 1).padStart(2, '0');
    const res = e.isVoid ? '❌' : (e.result === null ? '—' : OUT_TEXT[e.result]);
    rows.push([
      Markup.button.callback(`✏️ ${num}`, `ev:rn:${e.idx}`),
      Markup.button.callback(`🔗 ${num}`, `ev:src:${e.idx}`),
      Markup.button.callback(`🗑 ${num}`, `ev:del:${e.idx}`),
      Markup.button.callback(`${num} ${res}`.slice(0, 12), `noop:ev:${e.idx}`),
      Markup.button.callback(`${e.title.substring(0, 24)}`, `noop:ev:${e.idx}`),
    ]);
    rows.push([
      Markup.button.callback('1', `ev:set:${e.idx}:0`),
      Markup.button.callback('X', `ev:set:${e.idx}:1`),
      Markup.button.callback('2', `ev:set:${e.idx}:2`),
      Markup.button.callback('❌ Void', `ev:void:${e.idx}`),
      Markup.button.callback('♻️ Сброс', `ev:clear:${e.idx}`),
    ]);
  }

  rows.push([Markup.button.callback('➕ Добавить событие', 'a:add')]);

  // Навигация по страницам
  const pagesCount = Math.max(1, Math.ceil(total / ADMIN_EDIT_PAGE_SIZE));
  const nav: any[] = [];
  if (safePage > 1) nav.push(Markup.button.callback('⬅️ Пред.', `a:pg:${safePage - 1}`));
  if (safePage < pagesCount) nav.push(Markup.button.callback('➡️ След.', `a:pg:${safePage + 1}`));
  if (nav.length) rows.push(nav);

  rows.push([Markup.button.callback('🔒 Закрыть приём', 'admin:close'), Markup.button.callback('🧮 Рассчитать банк', 'admin:settle'), Markup.button.callback('💸 Выплатить призы', 'admin:pay')]);
  rows.push([Markup.button.callback('⬅️ Назад', 'a:back')]);
  rows.push([Markup.button.callback('🏠 На главную', 'home')]);

  return { inline_keyboard: rows };
}

bot.action('a:manage', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  await ctx.editMessageText(
    `Редактор событий. Сейчас: ${st.draw.events.length}/${EVENTS_COUNT}. Выберите строку или установите результаты:`,
    { reply_markup: manageKb(st.draw, 1) }
  );
});

// Переход страниц редактора
bot.action(/^a:pg:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const page = Number(ctx.match[1]);
  st = st || await loadStore();
  await ctx.answerCbQuery('');
  try {
    await ctx.editMessageReplyMarkup(manageKb(st.draw, page));
  } catch {
    await ctx.editMessageText(
      `Редактор событий. Сейчас: ${st.draw.events.length}/${EVENTS_COUNT}. Выберите строку или установите результаты:`,
      { reply_markup: manageKb(st.draw, page) }
    );
  }
});

// Просмотр событий (админ)

// --- Админ: закрыть приём ---
bot.action('admin:close', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  st.draw.status = 'closed';
  await saveStore(st);
  await ctx.answerCbQuery('Приём закрыт');
  await ctx.editMessageReplyMarkup({ inline_keyboard: manageKb(st.draw, 1).inline_keyboard });
});

// --- Админ: расчёт банка и призов ---
bot.action('admin:settle', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  const hitsByUser = st.tickets.map(t => ({ userId: t.userId, wallet: st.users[t.userId]?.wallet || '', hits: computeHits(t) }));
  const maxHits = hitsByUser.reduce((m, x) => Math.max(m, x.hits), 0);
  const totalBank = +(st.draw.settlement?.bankUSDT || 0);
  const name = (PAYOUT_FORMULA as FormulaName);
  const params = name === 'MAX_HITS_EQUAL_SHARE' ? PAYOUT_PARAMS_MAX_HITS_EQUAL_SHARE : name === 'TIERED_WEIGHTS' ? PAYOUT_PARAMS_TIERED_WEIGHTS : PAYOUT_PARAMS_FIXED_TABLE;
  const result = calculatePayouts(name, { drawId: String(st.draw.id), totalBank, maxHitsInDraw: maxHits, hitsByUser }, params);
  st.draw.settlement = st.draw.settlement || { settledAt: '', totalPlayed: 0, maxHits: 0, bankRUB: 0, winners: [] };
  st.draw.settlement.maxHits = maxHits;
  st.draw.settlement.formulaName = result.formulaName;
  st.draw.settlement.formulaParams = result.formulaParams;
  st.draw.settlement.formulaVersion = result.formulaVersion;
  st.draw.settlement.bankUSDT = totalBank;
  st.draw.settlement.winners = result.payouts.map(p => ({ ticketId: '—', userId: p.userId, username: st.users[p.userId]?.username, hits: p.hits, prizeUSDT: p.amount, prizeRUB: 0 }));
  await saveStore(st);
  await ctx.answerCbQuery('Банк рассчитан');
});

// --- Админ: массовые выплаты ---
bot.action('admin:pay', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  const s = st.draw.settlement;
  if (!s || !s.winners?.length) { await ctx.answerCbQuery('Нет списка победителей'); return; }
  let ok = 0, fail = 0;
  for (const w of s.winners) {
    const amount = +(w.prizeUSDT || 0);
    if (amount <= 0) continue;
    const wallet = st.users[w.userId]?.wallet;
    if (!wallet) { fail++; continue; }
    try {
      const res = await sendJetton({ toAddress: wallet, amountTokens: amount, comment: `Prize #${st.draw.id}`, forwardTon: 0.05 });
      if ((res as any).ok) ok++; else fail++;
    } catch { fail++; }
  }
  await ctx.answerCbQuery(`Выплаты завершены. Успехов: ${ok}, ошибок: ${fail}`);
});
bot.action('a:events', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();

  const lines = (st.draw.events || []).map((e, i) => {
    const num = String(i + 1).padStart(2, '0');
    const title = esc(e.title || `Событие ${i + 1}`);
    const res = e.isVoid ? '<i>АННУЛИРОВАНО</i>' : (e.result === null ? '—' : `<b>${OUT_TEXT[e.result]}</b>`);
    const src = e.sourceUrl
      ? (() => {
          try {
            const u = new URL(e.sourceUrl);
            return `\n   Источник: <a href="${esc(u.toString())}">${esc(u.hostname)}</a>`;
          } catch {
            return `\n   Источник: <a href="${esc(e.sourceUrl)}">${esc(e.sourceUrl)}</a>`;
          }
        })()
      : '';
    return `${num}. ${title} — ${res}${src}`;
  });

  const text = [
    `📋 <b>События тиража #${st.draw.id}</b>`,
    `Статус: <b>${st.draw.status}</b>`,
    '',
    lines.length ? lines.join('\n\n') : 'Пока пусто. Нажмите «➕ Добавить событие».',
  ].join('\n');

  await ctx.answerCbQuery('');
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: adminKb(st.draw) });
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: adminKb(st.draw) });
  }
});

// Возврат в админ-меню
bot.action('a:back', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  await ctx.answerCbQuery('');
  const text = `Админ-меню. Тираж #${st.draw.id}, статус: ${st.draw.status}. Событий: ${st.draw.events.length}/${EVENTS_COUNT}`;
  try {
    await ctx.editMessageText(text, { reply_markup: adminKb(st.draw) });
  } catch {
    await ctx.reply(text, { reply_markup: adminKb(st.draw) });
  }
});

bot.action(/^noop:(make|ev):\d+$/, async (ctx) => {
  await ctx.answerCbQuery('Выберите действие: 1/X/2, Void, ♻️ или ✏️/🔗/🗑');
});

// Добавить событие (перейти на страницу нового события)
bot.action('a:add', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  const newIdx = st.draw.events.length;
  if (newIdx >= EVENTS_COUNT) {
    await ctx.answerCbQuery('Достигнут лимит событий');
    return;
  }
  st.draw.events.push({ idx: newIdx, title: `Матч ${newIdx + 1}: КомандаA — КомандаB`, result: null, isVoid: false });
  await saveStore(st);
  await ctx.answerCbQuery('Событие добавлено');
  const page = pageForEventIdx(newIdx);
  try {
    await ctx.editMessageText(
      `Редактор событий. Сейчас: ${st.draw.events.length}/${EVENTS_COUNT}. Выберите строку или установите результаты:`,
      { reply_markup: manageKb(st.draw, page) }
    );
  } catch {
    await ctx.reply(`Добавлено событие #${newIdx + 1}.`, { reply_markup: manageKb(st.draw, page) });
  }
});

// Переименование — кнопка
bot.action(/^ev:rn:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const idx = Number(ctx.match[1]);
  st = st || await loadStore();
  if (!st.draw.events[idx]) {
    await ctx.answerCbQuery('Нет такого события');
    return;
  }
  adminState.set(ctx.from!.id, { mode: 'RENAME_ONE', evIdx: idx });
  await ctx.answerCbQuery('');
  await ctx.reply(`Введите новое имя для события #${idx + 1} (текущее: "${st.draw.events[idx].title}")`, { reply_markup: homeKbInline() });
});

// Источник — кнопка
bot.action(/^ev:src:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const idx = Number(ctx.match[1]);
  st = st || await loadStore();
  if (!st.draw.events[idx]) {
    await ctx.answerCbQuery('Нет такого события');
    return;
  }
  adminState.set(ctx.from!.id, { mode: 'SET_SRC', evIdx: idx });
  const cur = st.draw.events[idx].sourceUrl;
  await ctx.answerCbQuery('');
  await ctx.reply(
    [
      `Пришлите ссылку на официальный источник результата для события #${idx + 1}.`,
      cur ? `Текущее значение: ${cur}` : 'Сейчас не задано.',
      '',
      'Отправьте «-» чтобы очистить ссылку.'
    ].join('\n'),
    { reply_markup: homeKbInline() }
  );
});

// Удалить событие (вернуться на страницу, где оно было)
bot.action(/^ev:del:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const idx = Number(ctx.match[1]);
  st = st || await loadStore();
  if (!st.draw.events[idx]) {
    await ctx.answerCbQuery('Нет такого события');
    return;
  }
  const removed = st.draw.events.splice(idx, 1)[0];
  st.draw.events = st.draw.events.map((e, i) => ({ ...e, idx: i }));
  await saveStore(st);
  await ctx.answerCbQuery(`Удалено: ${removed.title}`);
  const page = pageForEventIdx(Math.max(0, Math.min(idx, st.draw.events.length - 1)));
  try {
    await ctx.editMessageText(
      `Редактор событий. Сейчас: ${st.draw.events.length}/${EVENTS_COUNT}. Выберите строку или установите результаты:`,
      { reply_markup: manageKb(st.draw, page) }
    );
  } catch {
    await ctx.reply(`Удалено событие #${idx + 1}. Сейчас: ${st.draw.events.length}/${EVENTS_COUNT}.`, { reply_markup: manageKb(st.draw, page) });
  }
});

// === Установка результатов (1/X/2), Void и Сброс — с возвратом на «ту» страницу ===
bot.action(/^ev:set:(\d+):(0|1|2)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const idx = Number(ctx.match[1]);
  const r = Number(ctx.match[2]) as 0|1|2;
  st = st || await loadStore();
  const ev = st.draw.events[idx];
  if (!ev) { await ctx.answerCbQuery('Нет такого события'); return; }
  ev.isVoid = false;
  ev.result = r;
  await saveStore(st);
  await ctx.answerCbQuery(`Результат #${idx + 1}: ${OUT_TEXT[r]}`);
  const page = pageForEventIdx(idx);
  try {
    await ctx.editMessageReplyMarkup(manageKb(st.draw, page));
  } catch {
    await ctx.reply('Обновлено', { reply_markup: manageKb(st.draw, page) });
  }
});

bot.action(/^ev:void:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const idx = Number(ctx.match[1]);
  st = st || await loadStore();
  const ev = st.draw.events[idx];
  if (!ev) { await ctx.answerCbQuery('Нет такого события'); return; }
  ev.isVoid = true;
  ev.result = null;
  await saveStore(st);
  await ctx.answerCbQuery(`Событие #${idx + 1} аннулировано`);
  const page = pageForEventIdx(idx);
  try {
    await ctx.editMessageReplyMarkup(manageKb(st.draw, page));
  } catch {
    await ctx.reply('Обновлено', { reply_markup: manageKb(st.draw, page) });
  }
});

bot.action(/^ev:clear:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const idx = Number(ctx.match[1]);
  st = st || await loadStore();
  const ev = st.draw.events[idx];
  if (!ev) { await ctx.answerCbQuery('Нет такого события'); return; }
  ev.isVoid = false;
  ev.result = null;
  await saveStore(st);
  await ctx.answerCbQuery(`Результат #${idx + 1} очищен`);
  const page = pageForEventIdx(idx);
  try {
    await ctx.editMessageReplyMarkup(manageKb(st.draw, page));
  } catch {
    await ctx.reply('Обновлено', { reply_markup: manageKb(st.draw, page) });
  }
});

// Открыть/закрыть приём
bot.action('a:open', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  st.draw.status = 'open';
  if (st.draw.events.length === 0) {
    st.draw.events = placeholderEvents.map(e => ({ ...e }));
  }
  await saveStore(st);
  await ctx.answerCbQuery('Приём открыт');
  await ctx.reply(`Приём открыт. Событий: ${st.draw.events.length}/${EVENTS_COUNT}.`, { reply_markup: homeKbInline() });
});

bot.action('a:close', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  st.draw.status = 'closed';
  await saveStore(st);
  await ctx.answerCbQuery('Приём закрыт');
  await ctx.reply('Приём закрыт.', { reply_markup: homeKbInline() });
});

// === Подвести итоги (один проход) ===
bot.action('a:settle', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();

  const { ready } = isReadyForSettlement(st.draw);
  if (!ready) {
    await ctx.answerCbQuery('Ещё не готовы все результаты (исключая void).');
    return;
  }
  const settlement = settleDraw();
  await saveStore(st);

  const text = [
    `✅ Тираж #${st.draw.id} подведён.`,
    '',
    formatSettlementSummaryHTML(settlement),
  ].join('\n');

  await ctx.answerCbQuery('Готово');
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: adminKb(st.draw) });
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: adminKb(st.draw) });
  }
});

// Список билетов (простой текст)
bot.action('a:list', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  const lines = st.tickets.map(t => {
    const selPretty = t.selections
      .map((arr, i) => {
        const human = arr.map(v => OUTCOMES[v]).join('/');
        return `${String(i + 1).padStart(2, '0')}:${human || '-'}`;
      })
      .join(' | ');
    const price = calcStakeRUB(t.selections);
    return `#${t.id} | u:${t.userId} | ${selPretty} | 💸 ${fmtMoney(price)} ₽`;
  });
  await ctx.answerCbQuery('');
  await ctx.reply(lines.slice(-50).join('\n') || 'Пусто', { reply_markup: homeKbInline() });
});

// Превью итогов
bot.action('a:preview', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();

  const summary = getResultsSummaryHTML();
  const add = !st.draw.settlement ? `\n\n<i>Совет:</i> проставьте все результаты (или Void) и нажмите «📊 Подвести итоги».` : '';
  const text = summary + add;

  await ctx.answerCbQuery('');
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: adminKb(st.draw) });
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: adminKb(st.draw) });
  }
});

// Рассылка итогов
bot.action('a:broadcast', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();

  const totalPlayed = playedEventsCount();
  if (totalPlayed === 0) {
    await ctx.answerCbQuery('Нет сыгравших событий — рассылать нечего');
    return;
  }

  const uniqUsers = Array.from(new Set(st.tickets.map(t => t.userId)));
  const summary = getResultsSummaryHTML();

  let ok = 0, fail = 0;

  if (st.draw.settlement) {
    const s = st.draw.settlement;
    const winnersByUser = new Map<number, { totalPrize: number; maxHits: number }>();
    for (const w of s.winners) {
      const prev = winnersByUser.get(w.userId) || { totalPrize: 0, maxHits: 0 };
      winnersByUser.set(w.userId, { totalPrize: prev.totalPrize + w.prizeRUB, maxHits: Math.max(prev.maxHits, w.hits) });
    }

    for (const uid of uniqUsers) {
      try {
        const rec = winnersByUser.get(uid);
        const hdr = rec
          ? `🎉 Вы в числе победителей тиража #${st.draw.id}! Совпадений: <b>${rec.maxHits}</b>. Ваш приз: <b>${fmtMoney(rec.totalPrize)} ₽</b>.`
          : `👋 Ваш результат по тиражу #${st.draw.id}.`;
        const text = [hdr, '', summary].join('\n');
        await ctx.telegram.sendMessage(uid, text, { parse_mode: 'HTML' });
        ok++;
      } catch {
        fail++;
      }
    }
  } else {
    // черновой вариант (без призов)
    for (const uid of uniqUsers) {
      try {
        const userTickets = st.tickets.filter(t => t.userId === uid);
        if (!userTickets.length) continue;

        const best = userTickets
          .map(t => ({ t, hits: computeHits(t) }))
          .sort((a, b) => b.hits - a.hits)[0];

        const userBlock = [
          `👋 Ваш результат по тиражу #${st.draw.id}`,
          `Совпадений: <b>${best.hits}</b> из <b>${totalPlayed}</b>`,
          ``,
          summary
        ].join('\n');

        await ctx.telegram.sendMessage(uid, userBlock, { parse_mode: 'HTML' });
        ok++;
      } catch {
        fail++;
      }
    }
  }

  const report = [
    `📣 Разослано итогов: <b>${ok}</b> пользователям`,
    fail ? `Не доставлено: ${fail}` : '',
  ].filter(Boolean).join('\n');

  await ctx.answerCbQuery('Готово');
  try {
    await ctx.editMessageText(report, { parse_mode: 'HTML', reply_markup: adminKb(st.draw) });
  } catch {
    await ctx.reply(report, { parse_mode: 'HTML', reply_markup: adminKb(st.draw) });
  }
});

// --------------- Обработка текстом (переименование / источник) ---------------
bot.on('text', async (ctx) => {
  const uid = ctx.from?.id;
  if (!uid) return;

  const state = adminState.get(uid);
  if (!state || state.mode === 'IDLE') return;
  if (!isAdmin(ctx)) return;

  const text = (ctx.message as any)?.text || '';

  if (state.mode === 'RENAME') {
    const m = text.match(/^\s*(\d+)\.\s*(.+?)\s*$/);
    if (!m) {
      await ctx.reply('Формат: номер. новое имя\nПример: 2. Милан — Интер', { reply_markup: homeKbInline() });
      return;
    }
    const idx = Number(m[1]) - 1;
    const name = m[2];
    st = st || await loadStore();
    const ev = st.draw.events[idx];
    if (!ev) {
      await ctx.reply('Нет такого события', { reply_markup: homeKbInline() });
      return;
    }
    ev.title = name;
    await saveStore(st);
    adminState.set(uid, { mode: 'IDLE' });
    await ctx.reply(`Ок. Событие #${idx + 1} переименовано в: ${name}`, { reply_markup: manageKb(st.draw, pageForEventIdx(idx)) });
  }

  if (state.mode === 'RENAME_ONE') {
    const idx = state.evIdx!;
    const name = text.trim();
    if (!name) {
      await ctx.reply('Название не может быть пустым. Введите снова.', { reply_markup: homeKbInline() });
      return;
    }
    st = st || await loadStore();
    const ev = st.draw.events[idx];
    if (!ev) {
      await ctx.reply('Нет такого события', { reply_markup: homeKbInline() });
      adminState.set(uid, { mode: 'IDLE' });
      return;
    }
    ev.title = name;
    await saveStore(st);
    adminState.set(uid, { mode: 'IDLE' });
    await ctx.reply(`Ок. Событие #${idx + 1} переименовано в: ${name}`, { reply_markup: manageKb(st.draw, pageForEventIdx(idx)) });
  }

  if (state.mode === 'SET_SRC') {
    const idx = state.evIdx!;
    let url = text.trim();

    st = st || await loadStore();
    const ev = st.draw.events[idx];
    if (!ev) {
      await ctx.reply('Нет такого события', { reply_markup: homeKbInline() });
      adminState.set(uid, { mode: 'IDLE' });
      return;
    }

    if (url === '-' || url === '—') {
      delete ev.sourceUrl;
      await saveStore(st);
      adminState.set(uid, { mode: 'IDLE' });
      await ctx.reply(`Источник для #${idx + 1} очищен.`, { reply_markup: manageKb(st.draw, pageForEventIdx(idx)) });
      return;
    }

    try {
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      const u = new URL(url);
      ev.sourceUrl = u.toString();
    } catch {
      await ctx.reply('Некорректная ссылка. Пришлите корректный URL (http/https) или «-» для очистки.', { reply_markup: homeKbInline() });
      return;
    }

    await saveStore(st);
    adminState.set(uid, { mode: 'IDLE' });
    await ctx.reply(`Источник для #${idx + 1} установлен: ${ev.sourceUrl}`, { reply_markup: manageKb(st.draw, pageForEventIdx(idx)) });
  }
});

// --------------- Пользовательские кнопки: сбор билета ---------------
bot.action('make', async (ctx) => {
  st = st || await loadStore();
  if (st.draw.status === 'setup') {
    st.draw.events = placeholderEvents.map(e => ({ ...e }));
    st.draw.status = 'open';
    await saveStore(st);
  }
  if (st.draw.status !== 'open') {
    await ctx.answerCbQuery('');
    await ctx.reply('Приём закрыт. Обратитесь позже.', { reply_markup: homeKbInline() });
    return;
  }
  const sess = { selections: Array.from({ length: EVENTS_COUNT }, () => []) };
  sessions.set(ctx.from!.id, sess);

  const text = [
    `Отметьте исходы (1/X/2) по каждому событию, затем нажмите «Сохранить».`,
    '',
    formatStakeLine(sess.selections),
  ].join('\n');

  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: makeTicketKb(sess, st.draw.events) });
});

// 🎲 Автовыбор
bot.action('auto:pick', async (ctx) => {
  st = st || await loadStore();
  if (st.draw.status !== 'open') {
    await ctx.answerCbQuery('Приём закрыт');
    return;
  }
  let sess = sessions.get(ctx.from!.id);
  if (!sess) {
    sess = { selections: Array.from({ length: EVENTS_COUNT }, () => []) };
    sessions.set(ctx.from!.id, sess);
  }
  for (let i = 0; i < EVENTS_COUNT; i++) {
    const r = Math.floor(Math.random() * 3); // 0,1,2
    sess.selections[i] = [r];
  }
  await ctx.answerCbQuery('Готово! Случайные исходы расставлены 👌');

  const text = [
    `Проверьте и при желании поправьте — затем нажмите «Сохранить».`,
    '',
    formatStakeLine(sess.selections),
  ].join('\n');

  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: makeTicketKb(sess, st.draw.events) });
});

// 🧹 Очистить выбор
bot.action('clear:pick', async (ctx) => {
  st = st || await loadStore();
  if (st.draw.status !== 'open') {
    await ctx.answerCbQuery('Приём закрыт');
    return;
  }
  let sess = sessions.get(ctx.from!.id);
  if (!sess) {
    sess = { selections: Array.from({ length: EVENTS_COUNT }, () => []) };
    sessions.set(ctx.from!.id, sess);
  } else {
    for (let i = 0; i < EVENTS_COUNT; i++) sess.selections[i] = [];
  }
  await ctx.answerCbQuery('Выбор очищен 🧼');

  const text = [
    `Отметьте исходы (1/X/2) по каждому событию, затем нажмите «Сохранить».`,
    '',
    formatStakeLine(sess.selections),
  ].join('\n');

  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: makeTicketKb(sess, st.draw.events) });
});

// === Переключение исходов с живым обновлением стоимости ===
bot.action(/^sel:(\d+):([012])$/, async (ctx) => {
  st = st || await loadStore();
  if (st.draw.status !== 'open') {
    await ctx.answerCbQuery('Приём закрыт');
    return;
  }
  const i = Number(ctx.match[1]);
  const v = Number(ctx.match[2]) as 0 | 1 | 2;

  let sess = sessions.get(ctx.from!.id);
  if (!sess) {
    sess = { selections: Array.from({ length: EVENTS_COUNT }, () => []) };
    sessions.set(ctx.from!.id, sess);
  }
  const arr = sess.selections[i] || [];

  const idx = arr.indexOf(v);
  if (idx >= 0) {
    // снять выбор
    arr.splice(idx, 1);
  } else {
    // добавить выбор
    if (arr.length < 3) arr.push(v);
  }
  // нормализация
  sess.selections[i] = Array.from(new Set(arr)).sort();

  await ctx.answerCbQuery('');

  const text = [
    `Отметьте исходы (1/X/2) по каждому событию, затем нажмите «Сохранить».`,
    '',
    formatStakeLine(sess.selections),
  ].join('\n');

  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: makeTicketKb(sess, st.draw.events) });
});

// --- Подтверждение цены перед сохранением ---
bot.action('save:ticket', async (ctx) => {
  st = st || await loadStore();
  if (st.draw.status !== 'open') {
    await ctx.answerCbQuery('Приём закрыт');
    return;
  }
  const sess = sessions.get(ctx.from!.id) || { selections: Array.from({ length: EVENTS_COUNT }, () => []) };

  const price = calcStakeRUB(sess.selections);
  const { singles, doubles, triples, mult } = stakeBreakdown(sess.selections);

  const text = [
    `Почти готово!`,
    ``,
    `💰 <b>Стоимость билета: ${fmtMoney(price)} ₽</b>`,
    `(база ${STAKE_RUB} ₽ × множитель ×${mult} • 1×${singles}, 2×${doubles}, 3×${triples})`,
    ``,
    `Нажмите «Подтвердить», чтобы зафиксировать билет.`,
  ].join('\n');

  await ctx.answerCbQuery('');
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: confirmSaveKb() });
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: confirmSaveKb() });
  }
});

bot.action('save:ticket:cancel', async (ctx) => {
  await ctx.answerCbQuery('Ок, можно скорректировать выбор.');
  const sess = sessions.get(ctx.from!.id) || { selections: Array.from({ length: EVENTS_COUNT }, () => []) };

  const text = [
    `Отметьте исходы (1/X/2) по каждому событию, затем нажмите «Сохранить».`,
    '',
    formatStakeLine(sess.selections),
  ].join('\n');

  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: makeTicketKb(sess, st.draw.events) });
});

// Фактическое сохранение билета после подтверждения
bot.action('save:ticket:confirm', async (ctx) => {
  try {
    if (!st) st = await loadStore();
    const uid = ctx.from?.id!;
    if (st.draw.status !== 'open') {
      await ctx.answerCbQuery(`Приём ставок закрыт (статус: ${st.draw.status})`);
      return;
    }
    if (st.draw.events.length !== EVENTS_COUNT) {
      await ctx.answerCbQuery(`Добавлены не все события (${st.draw.events.length}/${EVENTS_COUNT})`);
      return;
    }
    const s = sessions.get(uid);
    if (!s) {
      await ctx.answerCbQuery('Сначала отметьте исходы');
      return;
    }

    const ticketId = `${uid}-${Date.now()}`;
    const ticket: Ticket = {
      id: ticketId,
      userId: uid,
      username: ctx.from?.username,
      selections: s.selections.map(a => [...a]),
      createdAt: new Date().toISOString(),
    };

    if (!st.users) st.users = {};
    st.tickets.push(ticket);
    st.users[uid.toString()] = { hasTicketForCurrent: true };
    await saveStore(st);

    const human = ticket.selections
      .map((arr, i) => {
        const ev = st.draw?.events?.[i];
        const title = ev?.title ? ev.title : `Событие ${i + 1}`;
        const items = arr.length ? arr.map(v => OUT_TEXT[v]).join(' / ') : '—';
        return `${String(i + 1).padStart(2, '0')}  ${title}: ${items}`;
      })
      .join('\n');

    const price = calcStakeRUB(ticket.selections);
    const { singles, doubles, triples, mult } = stakeBreakdown(ticket.selections);

    await ctx.answerCbQuery('Билет сохранён!');
    await ctx.reply(
      [
        `<b>Билет #${esc(ticket.id)}</b>`,
        `Пользователь: @${esc(ticket.username || String(uid))}`,
        '',
        `<b>Выбранные исходы:</b>`,
        `<pre>№   Матч: Исход(ы)\n${esc(human)}</pre>`,
        '',
        `💸 <b>Стоимость билета: ${fmtMoney(price)} ₽</b>`,
        `(база ${STAKE_RUB} ₽ × множитель ×${mult} • 1×${singles}, 2×${doubles}, 3×${triples})`,
        `🎯 Участвует в тираже #${st.draw.id}`,
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: homeKbInline() }
    );
  } catch (e) {
    console.error(`Error in save:ticket:confirm for user ${ctx.from?.id}:`, e);
    await ctx.answerCbQuery('Ошибка при сохранении билета');
  }
});

// --------------- Мои билеты: список/карточка/экспорт ---------------
function getUserTicketsSorted(uid: number): Ticket[] {
  const all = st.tickets.filter(t => t.userId === uid);
  return all.sort((a, b) => {
    const ta = a.createdAt || '';
    const tb = b.createdAt || '';
    if (ta === tb) return b.id.localeCompare(a.id);
    return tb.localeCompare(ta);
  });
}

function pageCount(total: number, size: number) {
  return Math.max(1, Math.ceil(total / size));
}

function formatTicketRowBrief(t: Ticket, indexInPage: number) {
  const filled = t.selections.reduce((acc, a) => acc + (a && a.length ? 1 : 0), 0);
  const dt = new Date(t.createdAt);
  const hh = String(dt.getHours()).padStart(2, '0');
  const mm = String(dt.getMinutes()).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  const mo = String(dt.getMonth() + 1).padStart(2, '0');
  const price = fmtMoney(calcStakeRUB(t.selections));
  return `${indexInPage}) #${t.id.slice(0, 8)}… • ${dd}.${mo} ${hh}:${mm} • заполнено ${filled}/${EVENTS_COUNT} • 💸 ${price} ₽`;
}

function formatMyListPageText(tickets: Ticket[], page: number) {
  const total = tickets.length;
  const totalPages = pageCount(total, PAGE_SIZE);
  const start = (page - 1) * PAGE_SIZE;
  const slice = tickets.slice(start, start + PAGE_SIZE);

  const lines = slice.map((t, i) => formatTicketRowBrief(t, i + 1));
  return [
    `📋 Мои билеты (стр. ${page}/${totalPages}, всего: ${total})`,
    '',
    lines.join('\n') || 'Пусто',
  ].join('\n');
}

async function showMyTicketsPage(ctx: Context, page: number) {
  st = st || await loadStore();
  const uid = ctx.from!.id;
  const tickets = getUserTicketsSorted(uid);
  const totalPages = pageCount(tickets.length, PAGE_SIZE);
  const safePage = Math.min(Math.max(1, page), totalPages);

  const text = formatMyListPageText(tickets, safePage);
  const kb = myListKeyboard(tickets, safePage, totalPages);

  try {
    // @ts-ignore
    if (ctx.callbackQuery) {
      await (ctx as any).editMessageText(text, { reply_markup: kb });
      return;
    }
  } catch {}
  await (ctx as any).reply(text, { reply_markup: kb });
}

function myListKeyboard(tickets: Ticket[], page: number, totalPages: number): InlineKeyboardMarkup {
  const rows: any[] = [];
  const start = (page - 1) * PAGE_SIZE;
  const slice = tickets.slice(start, start + PAGE_SIZE);

  slice.forEach((t) => {
    rows.push([Markup.button.callback(`🔍 Открыть`, `t:open:${t.id}:${page}`)]);
  });

  const navRow: any[] = [];
  if (page > 1) navRow.push(Markup.button.callback('⬅️ Пред.', `t:page:${page - 1}`));
  if (page < totalPages) navRow.push(Markup.button.callback('➡️ След.', `t:page:${page + 1}`));
  if (navRow.length) rows.push(navRow);

  rows.push([
    Markup.button.callback('⬇️ TXT', 't:exp:txt'),
    Markup.button.callback('⬇️ CSV', 't:exp:csv'),
  ]);

  rows.push([Markup.button.callback('🏠 На главную', 'home')]);

  return { inline_keyboard: rows };
}

function detailKb(tickets: Ticket[], currentId: string, pageFrom: number): InlineKeyboardMarkup {
  const rows: any[] = [];
  const idx = tickets.findIndex(x => x.id === currentId);
  const prev = idx > 0 ? tickets[idx - 1] : null;
  const next = idx >= 0 && idx < tickets.length - 1 ? tickets[idx + 1] : null;

  const navRow: any[] = [];
  if (prev) navRow.push(Markup.button.callback('⏮️ Пред. билет', `t:nav:prev:${currentId}:${pageFrom}`));
  if (next) navRow.push(Markup.button.callback('⏭️ След. билет', `t:nav:next:${currentId}:${pageFrom}`));
  if (navRow.length) rows.push(navRow);

  rows.push([Markup.button.callback('⬅️ Назад к списку', `t:back:${pageFrom}`)]);
  rows.push([Markup.button.callback('🏠 На главную', 'home')]);
  return { inline_keyboard: rows };
}

function formatTicketDetail(t: Ticket) {
  const dt = new Date(t.createdAt);
  const hh = String(dt.getHours()).padStart(2, '0');
  const mm = String(dt.getMinutes()).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  const mo = String(dt.getMonth() + 1).padStart(2, '0');

  const header = `🎫 Билет #${esc(t.id)} • @${esc(t.username || String(t.userId))} • ${dd}.${mo} ${hh}:${mm}`;
  const lines = t.selections.map((arr, i) => {
    const ev = st.draw?.events?.[i];
    const title = ev?.title ? ev.title : `Событие ${i + 1}`;
    const items = (arr && arr.length) ? arr.map(v => OUT_TEXT[v]).join(' / ') : '—';
    return `${String(i + 1).padStart(2, '0')}  ${esc(title)}: ${esc(items)}`;
  });

  const price = fmtMoney(calcStakeRUB(t.selections));

  return `${esc(header)}\n<pre>№   Матч: Исход(ы)\n${lines.join('\n')}</pre>\n💸 <b>Стоимость билета: ${price} ₽</b>\n🎯 Участвует в тираже #${st.draw.id}`;
}

bot.action(/^t:open:(.+?):(\d+)$/, async (ctx) => {
  st = st || await loadStore();
  const uid = ctx.from!.id;
  const ticketId = ctx.match[1];
  const page = Number(ctx.match[2]);

  const tickets = getUserTicketsSorted(uid);
  const ticket = tickets.find(t => t.id === ticketId);
  if (!ticket) {
    await ctx.answerCbQuery('Билет не найден');
    return;
  }

  const text = formatTicketDetail(ticket);
  const kb = detailKb(tickets, ticket.id, page);

  await ctx.editMessageText(text, { reply_markup: kb, parse_mode: 'HTML' });
});

bot.action(/^t:nav:(prev|next):(.+?):(\d+)$/, async (ctx) => {
  st = st || await loadStore();
  const uid = ctx.from!.id;
  const dir = ctx.match[1];
  const currentId = ctx.match[2];
  const page = Number(ctx.match[3]);

  const tickets = getUserTicketsSorted(uid);
  const idx = tickets.findIndex(t => t.id === currentId);
  if (idx < 0) {
    await ctx.answerCbQuery('Билет не найден');
    return;
  }
  const newIdx = dir === 'prev' ? Math.max(0, idx - 1) : Math.min(tickets.length - 1, idx + 1);
  const ticket = tickets[newIdx];

  const text = formatTicketDetail(ticket);
  const kb = detailKb(tickets, ticket.id, page);
  await ctx.editMessageText(text, { reply_markup: kb, parse_mode: 'HTML' });
});

bot.action(/^t:back:(\d+)$/, async (ctx) => {
  const page = Number(ctx.match[1]);
  await showMyTicketsPage(ctx, page);
});

// Экспорт TXT/CSV для пользователя
bot.action('t:exp:txt', async (ctx) => {
  st = st || await loadStore();
  const uid = ctx.from!.id;
  const tickets = getUserTicketsSorted(uid);

  if (!tickets.length) {
    await ctx.answerCbQuery('');
    await ctx.reply('У вас нет билетов для экспорта.', { reply_markup: homeKbInline() });
    return;
  }

  const blocks = tickets.map(t => {
    const head = `#${t.id} • @${t.username || t.userId} • ${new Date(t.createdAt).toISOString()}`;
    const body = t.selections
      .map((arr, i) => `${String(i + 1).padStart(2, '0')}  ${(arr && arr.length) ? arr.map(v => OUTCOMES[v]).join('/') : '-'}`)
      .join('\n');
    const price = fmtMoney(calcStakeRUB(t.selections));
    return `${head}\n${body}\n💸 ${price} ₽`;
  });

  const content = blocks.join('\n\n');
  const buf = Buffer.from(content, 'utf8');

  await ctx.answerCbQuery('');
  await (ctx as any).replyWithDocument({ source: buf, filename: `tickets_${uid}.txt` });
});

bot.action('t:exp:csv', async (ctx) => {
  st = st || await loadStore();
  const uid = ctx.from!.id;
  const tickets = getUserTicketsSorted(uid);

  if (!tickets.length) {
    await ctx.answerCbQuery('');
    await ctx.reply('У вас нет билетов для экспорта.', { reply_markup: homeKbInline() });
    return;
  }

  const header = ['ticket_id', 'user_id', 'created_at', ...Array.from({ length: EVENTS_COUNT }, (_, i) => `e${String(i + 1).padStart(2, '0')}`), 'stake_rub'];
  const rows = tickets.map(t => {
    const cols = Array.from({ length: EVENTS_COUNT }, (_, i) => {
      const arr = t.selections[i] || [];
      return arr.length ? arr.map(v => OUTCOMES[v]).join('/') : '-';
    });
    const price = String(calcStakeRUB(t.selections));
    return [t.id, String(t.userId), new Date(t.createdAt).toISOString(), ...cols, price];
  });

  const escapeCsv = (s: string) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const csv = [header.map(escapeCsv).join(','), ...rows.map(r => r.map(escapeCsv).join(','))].join('\n');
  const buf = Buffer.from(csv, 'utf8');

  await ctx.answerCbQuery('');
  await (ctx as any).replyWithDocument({ source: buf, filename: `tickets_${uid}.csv` });
});

// --------------- Админ: билеты (пагинация/просмотр/экспорт) ---------------
function getAllTicketsSorted(): Ticket[] {
  const all = st.tickets.slice();
  return all.sort((a, b) => {
    const ta = a.createdAt || '';
    const tb = b.createdAt || '';
    if (ta === tb) return b.id.localeCompare(a.id);
    return tb.localeCompare(ta);
  });
}

function formatAdminRow(t: Ticket, n: number) {
  const dt = new Date(t.createdAt);
  const hh = String(dt.getHours()).padStart(2, '0');
  const mm = String(dt.getMinutes()).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  const mo = String(dt.getMonth() + 1).padStart(2, '0');
  const filled = t.selections.reduce((acc, a) => acc + (a && a.length ? 1 : 0), 0);
  const price = fmtMoney(calcStakeRUB(t.selections));
  return `${n}) #${t.id.slice(0,8)}… • u:${t.userId} • ${dd}.${mo} ${hh}:${mm} • заполнено ${filled}/${EVENTS_COUNT} • 💸 ${price} ₽`;
}

function adminTicketsPageText(tickets: Ticket[], page: number) {
  const total = tickets.length;
  const totalPages = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  const start = (page - 1) * ADMIN_PAGE_SIZE;
  const slice = tickets.slice(start, start + ADMIN_PAGE_SIZE);
  const lines = slice.map((t, i) => formatAdminRow(t, i + 1));

  const uniqueUsers = new Set(tickets.map(t => t.userId)).size;
  const bank = tickets.reduce((sum, t) => sum + calcStakeRUB(t.selections), 0);

  return [
    `🎟 Билеты (админ) — стр. ${page}/${totalPages}, всего: ${total}`,
    `👥 Билетов: ${total} • 👤 Участников: ${uniqueUsers} • 💰 Банк: ${fmtMoney(bank)} ₽`,
    '',
    lines.join('\n') || 'Пусто',
  ].join('\n');
}

function adminTicketsKb(tickets: Ticket[], page: number): InlineKeyboardMarkup {
  const rows: any[] = [];
  const total = tickets.length;
  const totalPages = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  const start = (page - 1) * ADMIN_PAGE_SIZE;
  const slice = tickets.slice(start, start + ADMIN_PAGE_SIZE);

  slice.forEach((t) => {
    rows.push([Markup.button.callback('🔍 Открыть', `at:open:${t.id}:${page}`)]);
  });

  const nav: any[] = [];
  if (page > 1) nav.push(Markup.button.callback('⬅️ Пред.', `at:page:${page - 1}`));
  if (page < totalPages) nav.push(Markup.button.callback('➡️ След.', `at:page:${page + 1}`));
  if (nav.length) rows.push(nav);

  rows.push([
    Markup.button.callback('⬇️ TXT', 'at:exp:txt'),
    Markup.button.callback('⬇️ CSV', 'at:exp:csv'),
    Markup.button.callback('⬇️ JSON', 'at:exp:json'),
  ]);

  rows.push([Markup.button.callback('⬅️ Назад', 'a:back')]);
  rows.push([Markup.button.callback('🏠 На главную', 'home')]);
  return { inline_keyboard: rows };
}

bot.action('a:tickets', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  const tickets = getAllTicketsSorted();
  const page = 1;
  const text = adminTicketsPageText(tickets, page);
  const kb = adminTicketsKb(tickets, page);
  await ctx.answerCbQuery('');
  await ctx.editMessageText(text, { reply_markup: kb });
});

bot.action(/^at:page:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  const page = Number(ctx.match[1]);
  const tickets = getAllTicketsSorted();
  const text = adminTicketsPageText(tickets, page);
  const kb = adminTicketsKb(tickets, page);
  await ctx.answerCbQuery('');
  await ctx.editMessageText(text, { reply_markup: kb });
});

function formatTicketDetailAdmin(t: Ticket) {
  const dt = new Date(t.createdAt);
  const hh = String(dt.getHours()).padStart(2, '0');
  const mm = String(dt.getMinutes()).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  const mo = String(dt.getMonth() + 1).padStart(2, '0');

  const header = `🎫 Билет #${esc(t.id)} • @${esc(t.username || String(t.userId))} • ${dd}.${mo} ${hh}:${mm}`;
  const lines = t.selections.map((arr, i) => {
    const OUT = OUT_TEXT;
    const items = (arr && arr.length) ? arr.map(v => OUT[v]).join(' / ') : '—';
    const ev = st.draw?.events?.[i];
    const title = ev?.title || `Событие ${i + 1}`;
    return `${String(i + 1).padStart(2, '0')}  ${esc(title)}: ${esc(items)}`;
  });

  const price = fmtMoney(calcStakeRUB(t.selections));

  return `${esc(header)}\n<pre>№   Матч: Исход(ы)\n${lines.join('\n')}</pre>\n💸 <b>Стоимость билета: ${price} ₽</b>\n🎯 Участвует в тираже #${st.draw.id}`;
}

bot.action(/^at:open:(.+?):(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  const ticketId = ctx.match[1];
  const page = Number(ctx.match[2]);
  const tickets = getAllTicketsSorted();
  const t = tickets.find(x => x.id === ticketId);
  if (!t) {
    await ctx.answerCbQuery('Билет не найден');
    return;
  }
  const text = formatTicketDetailAdmin(t);

  const rows: any[] = [];
  const idx = tickets.findIndex(x => x.id === ticketId);
  const prev = idx > 0 ? tickets[idx - 1] : null;
  const next = idx >= 0 && idx < tickets.length - 1 ? tickets[idx + 1] : null;
  const nav: any[] = [];
  if (prev) nav.push(Markup.button.callback('⏮️ Пред. билет', `at:open:${prev.id}:${page}`));
  if (next) nav.push(Markup.button.callback('⏭️ След. билет', `at:open:${next.id}:${page}`));
  if (nav.length) rows.push(nav);
  rows.push([Markup.button.callback('⬅️ Назад', `at:page:${page}`)]);
  rows.push([Markup.button.callback('🏠 На главную', 'home')]);
  const kb: InlineKeyboardMarkup = { inline_keyboard: rows };

  await ctx.answerCbQuery('');
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
});

// Экспорты всех билетов для админа
bot.action('at:exp:txt', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  const tickets = getAllTicketsSorted();

  if (!tickets.length) {
    await ctx.answerCbQuery('');
    await ctx.reply('Нет билетов для экспорта.', { reply_markup: adminKb(st.draw) });
    return;
  }

  const blocks = tickets.map(t => {
    const head = `#${t.id} • u:${t.userId} • ${new Date(t.createdAt).toISOString()}`;
    const body = t.selections.map((arr, i) => {
      const OUT = OUTCOMES;
      const items = (arr && arr.length) ? arr.map(v => OUT[v]).join('/') : '-';
      return `${String(i + 1).padStart(2, '0')}  ${items}`;
    }).join('\n');
    const price = fmtMoney(calcStakeRUB(t.selections));
    return `${head}\n${body}\n💸 ${price} ₽`;
  });
  const content = blocks.join('\n\n');
  const buf = Buffer.from(content, 'utf8');

  await ctx.answerCbQuery('Экспорт TXT сформирован');
  await (ctx as any).replyWithDocument({ source: buf, filename: `tickets_all.txt` });
});

bot.action('at:exp:csv', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  const tickets = getAllTicketsSorted();

  if (!tickets.length) {
    await ctx.answerCbQuery('');
    await ctx.reply('Нет билетов для экспорта.', { reply_markup: adminKb(st.draw) });
    return;
  }

  const header = ['ticket_id', 'user_id', 'created_at', ...Array.from({ length: EVENTS_COUNT }, (_, i) => `e${String(i + 1).padStart(2, '0')}`), 'stake_rub'];
  const rows = tickets.map(t => {
    const cols = Array.from({ length: EVENTS_COUNT }, (_, i) => {
      const arr = t.selections[i] || [];
      const OUT = OUTCOMES;
      return arr.length ? arr.map(v => OUT[v]).join('/') : '-';
    });
    const price = String(calcStakeRUB(t.selections));
    return [t.id, String(t.userId), new Date(t.createdAt).toISOString(), ...cols, price];
  });

  const escCsv = (s: string) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const csv = [header.map(escCsv).join(','), ...rows.map(r => r.map(escCsv).join(','))].join('\n');
  const buf = Buffer.from(csv, 'utf8');

  await ctx.answerCbQuery('Экспорт CSV сформирован');
  await (ctx as any).replyWithDocument({ source: buf, filename: `tickets_all.csv` });
});

bot.action('at:exp:json', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  const tickets = getAllTicketsSorted();

  if (!tickets.length) {
    await ctx.answerCbQuery('');
    await ctx.reply('Нет билетов для экспорта.', { reply_markup: adminKb(st.draw) });
    return;
  }

  const payload = JSON.stringify(tickets, null, 2);
  const buf = Buffer.from(payload, 'utf8');

  await ctx.answerCbQuery('Экспорт JSON сформирован');
  await (ctx as any).replyWithDocument({ source: buf, filename: `tickets_all.json` });
});

// --------------- Запуск ---------------
(async () => {
  try {
    st = await loadStore();

    console.log('🚀 Запускаю бота в POLLING режиме (NO PAYMENTS)...');

        // Init TON provider for non-custodial payments
    await initTon();

await bot.telegram.setMyCommands([
      { command: 'help',   description: 'Помощь' },
      { command: 'rules',  description: 'Правила' },
      { command: 'events', description: 'Список событий' },
      { command: 'my',     description: 'Мои билеты' },
      // /admin намеренно не публикуем для всех; админы знают команду
    ]);

    await bot.launch();
    console.log(
      `✅ Бот запущен. Draw #${st.draw.id} status=${st.draw.status}, EVENTS_COUNT=${EVENTS_COUNT}, STAKE_RUB(base)=${STAKE_RUB}`
    );
  } catch (error) {
    console.error(`Failed to start bot: ${error}`);
    process.exit(1);
  }
})();

process.once('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');
  try { await bot.stop('SIGINT'); } catch {}
  process.exit(0);
});

process.once('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  try { await bot.stop('SIGTERM'); } catch {}
  process.exit(0);
});
