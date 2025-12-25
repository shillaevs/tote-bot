

// bot.ts — тотализатор 15×3 с Crypto Pay и TON: билеты сохраняются в data/store.json
// Запуск: pm2 start "npx ts-node bot.ts" --name tote-bot --cwd /tote-bot

import * as dotenv from 'dotenv';
dotenv.config();

import { Telegraf, Context, Markup } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/types';
import * as fs from 'fs/promises';
import * as path from 'path';
import fetch from 'node-fetch';
import {
  initTon,
  checkTonPayment,
  checkJettonPayment,
  sendTon,
  isTonConfigured,
} from './ton';


import { calculatePayouts, FormulaName, SettlementInput } from './settlement';
import { v4 as uuidv4 } from 'uuid';

// Глобальные обработчики ошибок
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// --------------- .env ---------------
const BOT_TOKEN = process.env.BOT_TOKEN || '';
if (!BOT_TOKEN) {
    console.error('ERROR: BOT_TOKEN is empty. Put it into .env');
    process.exit(1);
}

console.log('DEBUG BOT_TOKEN length =', BOT_TOKEN.length);

const ADMIN_IDS: number[] = (process.env.ADMIN_IDS || '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(Boolean);

const EVENTS_COUNT = Number(process.env.EVENTS_COUNT || 15);
const PAGE_SIZE = 10;           // "Мои билеты": строки на страницу
const ADMIN_PAGE_SIZE = 15;     // "Админ: билеты": строки на страницу
const ADMIN_EDIT_PAGE_SIZE = 5; // 👈 событий на страницу в "Редакторе событий"
const EVENTS_PER_PAGE = 5; // сколько событий показываем на одной странице при выборе исходов


const STAKE_RUB = Number(process.env.STAKE_RUB || 100);
const STAKE_TON = Number(process.env.STAKE_TON || 0.1);
const STAKE_USDT = Number(process.env.STAKE_USDT || 0.1);
const TON_NETWORK = (process.env.TON_NETWORK || 'testnet').toLowerCase();
const TON_RECEIVE_ADDRESS = process.env.TON_RECEIVE_ADDRESS || '';
const TON_MIN_CONFIRMATIONS = Number(process.env.TON_MIN_CONFIRMATIONS || 1);
const CURRENCY = (process.env.CURRENCY || 'TON').toUpperCase() as 'USDT_TON' | 'TON';


const PORT = Number(process.env.PORT || 8080);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:8080';
const WEBHOOK_SECRET = uuidv4();

const PAYOUT_FORMULA = (process.env.PAYOUT_FORMULA || 'MAX_HITS_EQUAL_SHARE') as FormulaName;
function __readJSONEnv(name: string, fallback: any) {
    try { return JSON.parse(process.env[name] || ''); } catch { return fallback; }
}
const PAYOUT_PARAMS_MAX_HITS_EQUAL_SHARE = __readJSONEnv('PAYOUT_PARAMS_MAX_HITS_EQUAL_SHARE', { prizePoolPct: 0.90, rolloverIfNoWinners: true });
const PAYOUT_PARAMS_TIERED_WEIGHTS = __readJSONEnv('PAYOUT_PARAMS_TIERED_WEIGHTS', { prizePoolPct: 0.90, weights: { "15": 70, "14": 20, "13": 10 }, minHits: 13, rolloverUnclaimed: true });
const PAYOUT_PARAMS_FIXED_TABLE = __readJSONEnv('PAYOUT_PARAMS_FIXED_TABLE', { fixed: { "15": 10000, "14": 1500, "13": 250 }, rolloverUnclaimed: true });

// === Комбинаторика и инвойсы ===
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

function calcStakeRUB(selections: number[][]): number {
    const combos = countCombinations(selections);
    return combos * STAKE_RUB;
}

function calcStakeCrypto(selections: number[][]): number {
    const combos = countCombinations(selections);
    return combos * (CURRENCY === 'USDT_TON' ? STAKE_USDT : STAKE_TON);
}

function genInvoice(userId: number, drawId: number, combos: number): string {
    const amount = combos * (CURRENCY === 'USDT_TON' ? STAKE_USDT : STAKE_TON);
    const comment = `tote_${drawId}_${userId}_${Date.now()}_${combos}`;
    return comment;
}

// --------------- Типы ---------------
type DrawStatus = 'setup' | 'open' | 'closed' | 'settled';

interface EventItem {
    idx: number;
    title: string;
    result: number | null;
    isVoid: boolean;
    sourceUrl?: string;
}

interface Settlement {
    settledAt: string;
    totalPlayed: number;
    maxHits: number;
    bankRUB: number;
    bankUSDT?: number;
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

const OUTCOMES = ['1', 'X', '2'];
const OUT_TEXT = ['Победа 1', 'Ничья', 'Победа 2'];

interface Ticket {
    id: string;
    userId: number;
    username?: string;
    selections: number[][];
    createdAt: string;
    paid: boolean;
    invoiceId?: string;
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
    payments: {
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

interface CustomContext extends Context {
    session?: {
        adminAction?: {
            type: 'set_title' | 'set_source' | 'set_wallet' | 'add_event';
            idx?: number;
        };
    };
}

// --------------- FS ---------------
const DATA_DIR = path.join(process.cwd(), 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

async function ensureDirs() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.mkdir(path.join(DATA_DIR, 'history'), { recursive: true });
}

async function loadStore(): Promise<Store> {
    await ensureDirs();
    try {
        const raw = await fs.readFile(STORE_FILE, 'utf8');
        const data = JSON.parse(raw);
        if (!Array.isArray(data.tickets)) data.tickets = [];
        if (!data.users || typeof data.users !== 'object') data.users = {};
        if (!data.payments || typeof data.payments !== 'object') data.payments = {};
        if (!data.draw) {
            data.draw = { id: 1, status: 'setup', createdAt: new Date().toISOString(), events: [] };
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
            payments: {}
        };
        await fs.writeFile(STORE_FILE, JSON.stringify(initial, null, 2));
        return initial;
    }
}

async function saveStore(data: Store) {
    if (!data.users || typeof data.users !== 'object') data.users = {};
    if (!data.payments || typeof data.payments !== 'object') data.payments = {};
    await fs.writeFile(STORE_FILE, JSON.stringify(data, null, 2));
}

// --------------- Бот и состояние ---------------
const bot = new Telegraf<CustomContext>(BOT_TOKEN);
let st: Store;
const sessions = new Map<number, Session>();

const paymentWatchers = new Map<string, NodeJS.Timeout>();


type AdminTextActionType = 'set_title' | 'set_source' | 'set_wallet' | 'add_event';

interface AdminTextAction {
    type: AdminTextActionType;
    idx?: number;
}

const adminTextActions = new Map<number, AdminTextAction>();


bot.catch((err: any, ctx) => {
  console.error('Unhandled error while processing', ctx.update);

  const desc =
    (typeof err === 'object' && (err.description || err.message)) ||
    String(err);

  if (desc.includes('message is not modified')) {
    console.warn('Ignored Telegram error: message is not modified');
    return;
  }

  console.error('Error details:', err);
});


// Логируем все входящие апдейты (сообщения и нажатия кнопок)
bot.use(async (ctx, next) => {
  try {
    const u = ctx.update as any;

    if (u.message && u.message.text) {
      console.log(
        '>>> MESSAGE',
        u.message.from?.id,
        u.message.from?.username,
        '-',
        u.message.text
      );
    } else if (u.callback_query) {
      console.log(
        '>>> CALLBACK',
        u.callback_query.from?.id,
        u.callback_query.from?.username,
        '-',
        u.callback_query.data
      );
    }
  } catch (e) {
    console.error('Log middleware error:', e);
  }

  return next();
});



// --------------- Утилиты ---------------
function esc(s: string) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const fmtMoney = (n: number) => n.toLocaleString('ru-RU');

function playedEventsCount() {
    const evs = st?.draw?.events || [];
    return evs.filter(e => e && e.result !== null && !e.isVoid).length;
}

function computeHits(store: Store, ticket: Ticket): number {
  if (!store?.draw?.events) return 0;
  let hits = 0;
  for (let i = 0; i < store.draw.events.length; i++) {
    const ev = store.draw.events[i];
    if (!ev || ev.result === null || ev.isVoid) continue;
    const sel = ticket.selections[i] || [];
    if (sel.includes(ev.result)) hits++;
  }
  return hits;
}

// Функция для безопасного редактирования сообщения
async function safeEditMessage(ctx: any, text: string, markup?: any) {
    try {
        await ctx.editMessageText(text, { 
            parse_mode: 'HTML', 
            reply_markup: markup 
        });
    } catch (error: any) {
        if (error.description && error.description.includes('message is not modified')) {
            // Игнорируем эту ошибку - сообщение уже в нужном состоянии
            console.log('Ignored "message not modified" error');
            return;
        }
        throw error; // Пробрасываем другие ошибки
    }
}

function isAdmin(ctx: Context): boolean {
    return ADMIN_IDS.includes(ctx.from?.id || 0);
}

function getAllTicketsSorted(): Ticket[] {
    return st.tickets.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function getAdminStatsSnapshot(st: Store) {
  const drawIdPrefix = `${st.draw.id}_`;
  const tickets = st.tickets.filter(t => t.id.startsWith(drawIdPrefix));

  const total = tickets.length;
  const paid = tickets.filter(t => t.paid).length;
  const unpaid = total - paid;

  const uniqueUsers = new Set(tickets.map(t => t.userId)).size;

  const bankCrypto = tickets
    .filter(t => t.paid)
    .reduce((sum, t) => sum + Number(calcStakeCrypto(t.selections)), 0);

  const bankRub = tickets
    .filter(t => t.paid)
    .reduce((sum, t) => sum + Number(calcStakeRUB(t.selections)), 0);

  return { total, paid, unpaid, uniqueUsers, bankCrypto, bankRub };
}

function adminDashboardText(st: Store): string {
  const s = getAdminStatsSnapshot(st);
  return (
`🔧 <b>Админ-панель</b>
🎯 Тираж #${st.draw.id} <b>${st.draw.status}</b>

🎫 Билеты: <b>${s.total}</b>
✅ Оплачено: <b>${s.paid}</b>   ⏳ Ожидают: <b>${s.unpaid}</b>
👥 Игроков: <b>${s.uniqueUsers}</b>

💰 <b>Банк (по оплаченным)</b>:
• ${s.bankRub.toFixed(0)} ₽
• ${s.bankCrypto.toFixed(4)} ${CURRENCY}

ℹ️ Банк считается по билетам со статусом <b>paid=true</b>.`
  );
}


// --------------- Клавиатуры ---------------
function mainKb(ctx: Context, draw: Draw): InlineKeyboardMarkup {
    const rows: any[] = [];
    if (draw.status === 'open') {
        rows.push([Markup.button.callback('🎯 Сыграть!', 'play')]);
    } else if (draw.status === 'settled') {
        rows.push([Markup.button.callback('🏆 Результаты', 'results')]);
    }
    rows.push([Markup.button.callback('📋 События', 'events')]);
    rows.push([Markup.button.callback('🎫 Мои билеты', 'my')]);
    if (isAdmin(ctx)) {
        rows.push([Markup.button.callback('🔧 Админ', 'admin')]);
    }
    rows.push([Markup.button.callback('❓ Правила', 'rules')]);
    return { inline_keyboard: rows };
}

function adminKb(draw: Draw): InlineKeyboardMarkup {
  const rows: any[] = [];

  // Действия по статусу тиража
  if (draw.status === 'setup') {
    rows.push([Markup.button.callback('🟢 Открыть тираж', 'as:start')]);
  } else if (draw.status === 'open') {
    rows.push([Markup.button.callback('🔒 Закрыть приём ставок', 'as:close')]);
  } else if (draw.status === 'closed') {
    rows.push([Markup.button.callback('✅ Рассчитать тираж', 'as:settle')]);
  } else if (draw.status === 'settled') {
    rows.push([Markup.button.callback('🆕 Новый тираж', 'as:newdraw')]);
  }

  // Инструменты админа — всегда доступны
  rows.push([Markup.button.callback('📊 Статистика', 'as:stats')]);

  // Отчёты/экспорт — тоже всегда (раз ты уже сделал handlers)
  rows.push([
    Markup.button.callback('📊 Статистика / отчёты', 'at:list'),
    Markup.button.callback('📤 Экспорт CSV', 'at:exp:csv'),
  ]);
  rows.push([Markup.button.callback('📤 Экспорт JSON', 'at:exp:json')]);

  // Редактор событий — всегда доступен
  rows.push([Markup.button.callback('📝 Редактор событий', 'ae:edit')]);

  // Назад — один раз
  rows.push([Markup.button.callback('⬅️ Назад', 'home')]);

  return { inline_keyboard: rows };
}



function adminEditKb(page: number, events: EventItem[]): InlineKeyboardMarkup {
    const totalPages = Math.ceil(events.length / ADMIN_EDIT_PAGE_SIZE);
    const rows: any[] = [];
    const start = (page - 1) * ADMIN_EDIT_PAGE_SIZE;
    const pageEvents = events.slice(start, start + ADMIN_EDIT_PAGE_SIZE);
    for (const ev of pageEvents) {
        rows.push([
            Markup.button.callback(`#${ev.idx + 1} ${esc(ev.title)}`, `ae:open:${ev.idx}`),
            Markup.button.callback('✏️', `ae:set_title:${ev.idx}`),
            Markup.button.callback('🗑️', `ae:delete:${ev.idx}`)
        ]);
    }
    const nav: any[] = [];
    if (page > 1) nav.push(Markup.button.callback('⬅️', `ae:page:${page - 1}`));
    if (page < totalPages) nav.push(Markup.button.callback('➡️', `ae:page:${page + 1}`));
    if (nav.length) rows.push(nav);
    rows.push([Markup.button.callback('➕ Добавить событие', 'ae:add')]);
    rows.push([Markup.button.callback('⬅️ Админ', 'admin')]);
    return { inline_keyboard: rows };
}

function getIntroHtml(hasTicket: boolean, drawId: string | number, drawStatus: 'open' | 'settled' | string): string {
    const statusText =
        drawStatus === 'open'
            ? '🟢 тираж открыт, ставки принимаются'
            : drawStatus === 'settled'
            ? '✅ тираж завершён, идут расчёты'
            : 'ℹ️ статус тиража уточняется';

    const ticketLine = hasTicket
        ? '🎟 <b>У вас уже есть билет</b> в текущем тираже — удача может быть совсем рядом!'
        : '👇 Нажмите «🎯 Сыграть!» и соберите свой билет — выберите исходы 15 матчей (1 / X / 2) и поборитесь за призы.';

    return (
        `🎉 <b>Добро пожаловать в тотализатор 15×3!</b>\n\n` +
        `📌 Формат игры: <b>15 событий</b>, на каждое вы выбираете исход — <b>1 / X / 2</b>.\n` +
        `Чем больше правильных исходов, тем крупнее потенциальный выигрыш.\n\n` +
        `🔄 <b>Текущий тираж #${drawId}</b>\n` +
        `${statusText}.\n\n` +
        `${ticketLine}\n\n` +
        `💡 В любой момент вы можете посмотреть:\n` +
        `• 📋 список событий — через кнопку «События»\n` +
        `• 🎫 ваши билеты — через «Мои билеты»\n` +
        `• 📜 правила — через «Правила»\n\n` +
        `Удачи и приятной игры! 🍀`
    );
}

function startAutoCheckTonPayment(params: {
  invoiceId: string;
  userId: number;
  chatId: number;
  expectedAmountTon: number;
}) {
  const { invoiceId, userId, chatId, expectedAmountTon } = params;

  // не запускаем два таймера на один invoice
  if (paymentWatchers.has(invoiceId)) return;

  let attempts = 0;
  const maxAttempts = 25;      // ~5 минут при интервале 12 сек
  const intervalMs = 12_000;

  const timer = setInterval(async () => {
    attempts++;

    try {
      st = st || await loadStore();

      const payment = st.payments[invoiceId];
      if (!payment) {
        stopWatcher(invoiceId);
        return;
      }

      // если уже отмечено как paid — просто останавливаем
      if (payment.paid) {
        stopWatcher(invoiceId);
        return;
      }

      // ИЩЕМ ТРАНЗАКЦИЮ В TON (testnet/mainnet зависит от ton.ts)
      const res = await checkTonPayment({
        toAddress: TON_RECEIVE_ADDRESS,
        expectedAmountTon: expectedAmountTon,
        comment: invoiceId,
        minConfirmations: TON_MIN_CONFIRMATIONS
      });

      if (res.found) {
        // отмечаем оплату
        payment.paid = true;
        payment.txHash = res.txHash || '';

        const ticket = st.tickets.find(t => t.invoiceId === invoiceId);
        if (ticket) ticket.paid = true;

        if (st.users[userId]) st.users[userId].hasTicketForCurrent = true;

        await saveStore(st);

        stopWatcher(invoiceId);

        // ВАЖНО: уведомляем отдельным сообщением (не edit), чтобы не ловить ошибки редактирования
        await bot.telegram.sendMessage(
  chatId,
  `✅ Оплата подтверждена! Билет активирован.\n\nИнвойс: ${invoiceId}\nTx: ${payment.txHash || '—'}`,
  { link_preview_options: { is_disabled: true } }
);

        return;
      }

      // таймаут
      if (attempts >= maxAttempts) {
        stopWatcher(invoiceId);
        await bot.telegram.sendMessage(
  chatId,
  `⏳ Не вижу оплату по инвойсу:\n${invoiceId}\n\nЕсли вы уже оплатили — нажмите «🔄 Проверить оплату» ещё раз.`,
  { link_preview_options: { is_disabled: true } }
);

      }
    } catch (e) {
      // ошибки сети/toncenter не валим бот — просто пишем в лог и продолжаем
      console.error('[AUTO_CHECK] error', e);
      if (attempts >= maxAttempts) stopWatcher(invoiceId);
    }
  }, intervalMs);

  paymentWatchers.set(invoiceId, timer);
}

function stopWatcher(invoiceId: string) {
  const t = paymentWatchers.get(invoiceId);
  if (t) clearInterval(t);
  paymentWatchers.delete(invoiceId);
}


// --------------- Обработчики команд ---------------
bot.start(async (ctx) => {
    st = st || await loadStore();
    const userId = ctx.from.id;
    const username = ctx.from.username || '';
    if (!st.users[userId]) {
        st.users[userId] = { hasTicketForCurrent: false, username };
        await saveStore(st);
    }

    const hasTicket = st.users[userId].hasTicketForCurrent;
    const text = getIntroHtml(hasTicket, st.draw.id, st.draw.status);

    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: mainKb(ctx, st.draw) });
});


bot.command('help', async (ctx) => {
    st = st || await loadStore();
    await ctx.reply('Помощь: используйте /start или кнопки меню.', {
        reply_markup: mainKb(ctx, st.draw),
    });
});

// ---------- Вспомогательные функции ----------

async function handleRules(ctx: CustomContext) {
    st = st || await loadStore();
    const text = `📜 Правила тотализатора 15×3\n\n1. Выберите 1-3 исхода (1/X/2) для каждого из 15 событий.\n2. Стоимость билета = ${fmtMoney(
        STAKE_RUB,
    )} ₽ × число комбинаций.\n3. После закрытия тиража результаты фиксируются.\n4. Призы распределяются по формуле: ${PAYOUT_FORMULA}.\n5. Максимум совпадений = выигрыш!`;
    await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[Markup.button.callback('🏠 Главная', 'home')]] },
    });
}

async function handleEvents(ctx: CustomContext) {
    st = st || await loadStore();
    const evs = st.draw.events;
    if (!evs.length) {
        return ctx.reply('События не настроены. Обратитесь к админу.', {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[Markup.button.callback('🏠 Главная', 'home')]] },
        });
    }
    const lines = evs.map(
        (e, i) =>
            `${String(i + 1).padStart(2, '0')} ${esc(e.title)}${
                e.result !== null ? ` → ${OUT_TEXT[e.result]}` : ''
            }${e.isVoid ? ' (аннулировано)' : ''}${
                e.sourceUrl ? ` [📎](${e.sourceUrl})` : ''
            }`,
    );
    const text = `📋 События тиража #${st.draw.id}\n\n${lines.join('\n')}`;
    await ctx.reply(text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[Markup.button.callback('🏠 Главная', 'home')]] },
    });
}

async function handleMyTickets(ctx: CustomContext) {
    st = st || await loadStore();
    const userId = ctx.from!.id;
    const myTickets = st.tickets.filter(
        (t) => t.userId === userId && t.id.startsWith(`${st.draw.id}_`),
    );
    if (!myTickets.length) {
        return ctx.reply('У вас нет билетов в текущем тираже.', {
            reply_markup: { inline_keyboard: [[Markup.button.callback('🎯 Сыграть', 'play')]] },
        });
    }
    const page = 1;
    const text = myTicketsPageText(myTickets, page);
    const kb = myTicketsKb(myTickets, page);
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

async function handleAdminPanel(ctx: CustomContext) {
    if (!isAdmin(ctx)) {
        return ctx.reply('Доступ запрещён.');
    }
    st = st || await loadStore();
    const text = `🔧 Админ-панель: Тираж #${st.draw.id} (${st.draw.status})`;
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: adminKb(st.draw) });
}

// ---------- Привязка и к командам, и к кнопкам ----------

// /rules и кнопка "rules"
bot.command('rules', async (ctx) => {
    await handleRules(ctx);
});
bot.action('rules', async (ctx) => {
    await ctx.answerCbQuery();
    await handleRules(ctx);
});

// /events и кнопка "events"
bot.command('events', async (ctx) => {
    await handleEvents(ctx);
});
bot.action('events', async (ctx) => {
    await ctx.answerCbQuery();
    await handleEvents(ctx);
});

// /my и кнопка "my"
bot.command('my', async (ctx) => {
    await handleMyTickets(ctx);
});
bot.action('my', async (ctx) => {
    await ctx.answerCbQuery();
    await handleMyTickets(ctx);
});

// /admin и кнопка "admin"
bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Доступ запрещён.');
  st = st || await loadStore();
  const text = adminDashboardText(st);
  await ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [Markup.button.callback('🔄 Обновить', 'admin:dash')],
        [Markup.button.callback('📝 Редактор событий', 'ae:edit')],
        [Markup.button.callback('⚙️ Действия тиража', 'admin')], // если у тебя adminKb на 'admin'
        [Markup.button.callback('🏠 Главная', 'home')],
      ]
    }
  });
});

bot.action('admin:dash', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Доступ запрещён.');
  st = st || await loadStore();
  const text = adminDashboardText(st);
  await ctx.answerCbQuery('');
  await safeEditMessage(ctx, text, {
    inline_keyboard: [
      [Markup.button.callback('🔄 Обновить', 'admin:dash')],
      [Markup.button.callback('📝 Редактор событий', 'ae:edit')],
      [Markup.button.callback('⚙️ Действия тиража', 'admin')],
      [Markup.button.callback('🏠 Главная', 'home')],
    ]
  });
});


bot.action('admin', async (ctx) => {
    await ctx.answerCbQuery();
    await handleAdminPanel(ctx);
});



// --------------- Действия: Игра ---------------

// Текст для одного исхода
function getOutcomeText(outcome: number | null): string {
  if (outcome === 0) return 'Победа 1';
  if (outcome === 1) return 'Ничья';
  if (outcome === 2) return 'Победа 2';
  return 'не выбран';
}

// Текст для всей сетки: список 01..15 + выбранные исходы
function buildPlayText(draw: Draw, selections: number[][]): string {
  const evs = draw.events;
  const totalEvents = Math.min(EVENTS_COUNT, evs.length);

  const header =
    `🎯 Выбор исходов для тиража #${draw.id}\n\n` +
    `Отметьте исходы (1 / X / 2) по каждому событию.\n` +
    `Можно выбирать один, два или три исхода на матч — как в классическом тотализаторе 15×3.\n\n`;

  const lines: string[] = [];
  for (let i = 0; i < totalEvents; i++) {
    const ev = evs[i];
    const title = esc(ev?.title || `Событие ${i + 1}`);

    const sel = selections[i] || [];
    let choice: string;
    if (!sel.length) {
      choice = 'не выбран';
    } else {
      const parts = sel.map(o => getOutcomeText(o));
      choice = parts.join(' + ');
    }

    lines.push(
      `${String(i + 1).padStart(2, '0')}. ${title}\n` +
      `   Ваш выбор: <b>${choice}</b>`
    );
  }

  return header + lines.join('\n\n');
}

// Клавиатура: для каждого события — строка названия + строка [1][X][2]
// Внизу — Автовыбор / Очистить / Сформировать / Главная
function buildPlayKb(s: Session, draw: Draw): InlineKeyboardMarkup {
  const evs = draw.events;
  const totalEvents = Math.min(EVENTS_COUNT, evs.length);
  const rows: any[] = [];

  for (let i = 0; i < totalEvents; i++) {
    const title = evs[i]?.title || `Событие ${i + 1}`;
    const sel = s.selections[i] || [];

    // Строка с названием события (кнопка-заглушка)
    rows.push([
      Markup.button.callback(
        `${String(i + 1).padStart(2, '0')}. ${title}`.slice(0, 64),
        `noop:event:${i}`
      ),
    ]);

    // Строка с исходами 1 / X / 2
    rows.push([
      Markup.button.callback(
        sel.includes(0) ? '✅ 1' : '1',
        `ps:toggle:${i}:0`
      ),
      Markup.button.callback(
        sel.includes(1) ? '✅ X' : 'X',
        `ps:toggle:${i}:1`
      ),
      Markup.button.callback(
        sel.includes(2) ? '✅ 2' : '2',
        `ps:toggle:${i}:2`
      ),
    ]);
  }

  // Общие действия
  rows.push([
    Markup.button.callback('🎲 Автовыбор', 'play:auto'),
    Markup.button.callback('🧹 Очистить выбор', 'play:clearAll'),
  ]);

  rows.push([
    Markup.button.callback('✅ Сформировать билет', 'confirm_ticket'),
  ]);

  rows.push([
    Markup.button.callback('🏠 Главная', 'home'),
  ]);

  return { inline_keyboard: rows };
}

// Нажали "🎯 Сыграть!"
bot.action('play', async (ctx) => {
  st = st || await loadStore();
  if (st.draw.status !== 'open') {
    return ctx.answerCbQuery('Тираж закрыт для ставок.');
  }

  const userId = ctx.from!.id;
  if (st.users[userId]?.hasTicketForCurrent) {
    return ctx.answerCbQuery('У вас уже есть билет в текущем тираже!');
  }

  const evs = st.draw.events;
  if (!evs.length) {
    return ctx.answerCbQuery('События ещё не настроены.');
  }

  const totalEvents = Math.min(EVENTS_COUNT, evs.length);
  if (totalEvents === 0) {
    return ctx.answerCbQuery('События ещё не настроены.');
  }

  // Инициализируем пустые выборы: по матчу — массив исходов []
  const selections: number[][] = Array.from({ length: totalEvents }, () => []);
  const session: Session = { selections };
  sessions.set(userId, session);

  const text = buildPlayText(st.draw, selections);
  const kb = buildPlayKb(session, st.draw);

  await ctx.answerCbQuery();
  await safeEditMessage(ctx, text, kb);
});

// Тоггл 1 / X / 2 для конкретного события
// ps:toggle:<eventIdx>:<0|1|2>
bot.action(/^ps:toggle:(\d+):([012])$/, async (ctx) => {
  const eventIdx = Number(ctx.match[1]);
  const outcome = Number(ctx.match[2]); // 0,1,2

  const userId = ctx.from!.id;
  const session = sessions.get(userId);
  if (!session) {
    await ctx.answerCbQuery('Сессия истекла. Нажмите «Сыграть!» ещё раз.');
    return;
  }

  st = st || await loadStore();
  const evs = st.draw.events;
  const totalEvents = Math.min(EVENTS_COUNT, evs.length);

  if (eventIdx < 0 || eventIdx >= totalEvents) {
    await ctx.answerCbQuery();
    return;
  }

  const sel = session.selections[eventIdx] || [];
  const idx = sel.indexOf(outcome);
  if (idx >= 0) {
    // уже выбран — убираем
    sel.splice(idx, 1);
  } else {
    // не выбран — добавляем
    sel.push(outcome);
    sel.sort(); // чтобы порядок был 0,1,2
  }
  session.selections[eventIdx] = sel;

  const text = buildPlayText(st.draw, session.selections);
  const kb = buildPlayKb(session, st.draw);

  await ctx.answerCbQuery('Выбор обновлён ✅');
  await safeEditMessage(ctx, text, kb);
});

// Автовыбор — заполняет все пустые события случайным исходом 1/X/2
bot.action('play:auto', async (ctx) => {
  const userId = ctx.from!.id;
  const session = sessions.get(userId);

  if (!session) {
    await ctx.answerCbQuery('Сессия истекла. Нажмите «Сыграть!» ещё раз.');
    return;
  }

  st = st || await loadStore();
  const evs = st.draw.events;
  const totalEvents = Math.min(EVENTS_COUNT, evs.length);

  for (let i = 0; i < totalEvents; i++) {
    const sel = session.selections[i] || [];
    if (!sel.length) {
      session.selections[i] = [Math.floor(Math.random() * 3)];
    }
  }

  const text = buildPlayText(st.draw, session.selections);
  const kb = buildPlayKb(session, st.draw);

  await ctx.answerCbQuery('Пустые события заполнены случайным образом 🎲');
  await safeEditMessage(ctx, text, kb);
});

// Сбросить все выборы
bot.action('play:clearAll', async (ctx) => {
  const userId = ctx.from!.id;
  const session = sessions.get(userId);

  if (!session) {
    await ctx.answerCbQuery('Сессия уже очищена. Нажмите «Сыграть!» ещё раз.');
    return;
  }

  st = st || await loadStore();
  const evs = st.draw.events;
  const totalEvents = Math.min(EVENTS_COUNT, evs.length);

  for (let i = 0; i < totalEvents; i++) {
    session.selections[i] = [];
  }

  const text = buildPlayText(st.draw, session.selections);
  const kb = buildPlayKb(session, st.draw);

  await ctx.answerCbQuery('Все выборы очищены 🧹');
  await safeEditMessage(ctx, text, kb);
});


// --------------- Подтверждение билета ---------------
bot.action('confirm_ticket', async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session) return ctx.answerCbQuery('Сессия истекла.');

    const combos = countCombinations(session.selections);
    if (combos === 0) {
        return ctx.answerCbQuery('Выберите хотя бы один исход для каждого события!');
    }

    const priceRUB = calcStakeRUB(session.selections);
    const priceCrypto = calcStakeCrypto(session.selections);
    const invoice = genInvoice(userId, st.draw.id, combos);

    const text = `✅ Билет готов!\n\nКомбинаций: ${combos}\nСтоимость: ${fmtMoney(priceRUB)} ₽ (${priceCrypto} ${CURRENCY})\n\nОплатите через TON-кошелёк.`;
    const kb = {
        inline_keyboard: [
            [Markup.button.callback('💳 Оплатить', `pay:${invoice}`)],
            [Markup.button.callback('❌ Отмена', 'play')]
        ]
    };

    await ctx.answerCbQuery('');
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
});

// --------------- Оплата ---------------
bot.action(/^pay:(.+)$/, async (ctx) => {
    const invoiceId = ctx.match[1];
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session) return ctx.answerCbQuery('Сессия истекла.');

    st = st || await loadStore();
    const combos = countCombinations(session.selections);
    const amount = calcStakeCrypto(session.selections);
    const username = ctx.from.username || String(userId);

    let paymentUrl = '';

    if (CURRENCY === 'TON') {
    // amount = calcStakeCrypto(selections) → в нашем случае = STAKE_TON
    paymentUrl = `ton://transfer/${TON_RECEIVE_ADDRESS}?amount=${amount * 1e9}&text=${encodeURIComponent(invoiceId)}`;
}


    const ticket: Ticket = {
        id: `${st.draw.id}_${st.nextTicketSeq++}`,
        userId,
        username,
        selections: session.selections,
        createdAt: new Date().toISOString(),
        paid: false,
        invoiceId
    };

    st.tickets.push(ticket);
    st.payments[invoiceId] = {
        userId,
        currency: CURRENCY,
        amount,
        comment: invoiceId,
        paid: false,
        createdAt: new Date().toISOString()
    };
    await saveStore(st);

    sessions.delete(userId);

    const text = `💳 Оплатите билет #${ticket.id}\n\nСумма: ${amount} ${CURRENCY}\nКомментарий: ${invoiceId}\n\nИспользуйте ссылку:\n${paymentUrl}`;
    await ctx.answerCbQuery('');
    await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [Markup.button.url('💸 Оплатить', paymentUrl)],
                [Markup.button.callback('🔄 Проверить оплату', `check:${invoiceId}`)],
                [Markup.button.callback('🏠 Главная', 'home')]
            ]
        }
    });
	startAutoCheckTonPayment({
  invoiceId,
  userId,
  chatId: ctx.chat!.id,
  expectedAmountTon: amount, // amount должен быть в TON
});

// по желанию — отдельное сообщение игроку
await ctx.reply('⏳ Жду оплату… Проверяю автоматически (примерно 5 минут).');
});

// --------------- Проверка оплаты ---------------
bot.action(/^check:(.+)$/, async (ctx) => {
    const invoiceId = ctx.match[1];
    st = st || await loadStore();
    const payment = st.payments[invoiceId];
    if (!payment) return ctx.answerCbQuery('Инвойс не найден.');

    let paid = false;
    let txHash = '';

    if (CURRENCY === 'TON') {
        const result = await checkTonPayment({
            toAddress: TON_RECEIVE_ADDRESS,
            expectedAmountTon: payment.amount,
            comment: invoiceId,
            minConfirmations: TON_MIN_CONFIRMATIONS
        });
        paid = result.found;
        txHash = result.txHash || '';
    } else if (CURRENCY === 'USDT_TON') {
        const result = await checkJettonPayment({
            ownerBaseAddress: TON_RECEIVE_ADDRESS,
            expectedAmountTokens: payment.amount,
            comment: invoiceId,
            minConfirmations: TON_MIN_CONFIRMATIONS
        });
        paid = result.found;
        txHash = result.txHash || '';
    }

    if (paid && !payment.paid) {
        payment.paid = true;
        payment.txHash = txHash;
        const ticket = st.tickets.find(t => t.invoiceId === invoiceId);
        if (ticket) {
            ticket.paid = true;
            st.users[payment.userId].hasTicketForCurrent = true;
            await saveStore(st);
            await ctx.reply(`✅ Оплата подтверждена! Билет #${ticket.id} активирован.`, { parse_mode: 'HTML' });
        }
    } else if (paid) {
        await ctx.answerCbQuery('Оплата уже подтверждена.');
    } else {
        await ctx.answerCbQuery('Оплата ещё не получена. Попробуйте позже.');
    }
});


// --------------- Действия: Результаты и билеты ---------------
bot.action('results', async (ctx) => {
    st = st || await loadStore();
    if (!st.draw.settlement) {
        return ctx.answerCbQuery('Расчёт не завершён.');
    }
    const sett = st.draw.settlement;
    const text = `🏆 Результаты тиража #${st.draw.id}\n\nМакс. совпадений: ${sett.maxHits}/${sett.totalPlayed}\nБанк: ${fmtMoney(sett.bankRUB)} ₽ (${sett.bankUSDT} ${CURRENCY})\n\nПобедители:\n${sett.winners.map(w => `@${esc(w.username || String(w.userId))}: ${w.hits} совпадений, ${fmtMoney(w.prizeRUB)} ₽ (${w.prizeUSDT} ${CURRENCY})`).join('\n') || 'Нет победителей.'}`;
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[Markup.button.callback('🏠 Главная', 'home')]] } });
});

function myTicketsPageText(tickets: Ticket[], page: number): string {
    const start = (page - 1) * PAGE_SIZE;
    const pageTickets = tickets.slice(start, start + PAGE_SIZE);
    const lines = pageTickets.map(t => {
        const hits = st.draw.settlement ? computeHits(st, t) : '?';
        const status = t.paid ? '✅ Оплачен' : '⏳ Ожидает оплаты';
        return `🎫 #${esc(t.id)} • ${hits} совпадений • ${fmtMoney(calcStakeRUB(t.selections))} ₽ • ${status}`;
    });
    return `🎫 Ваши билеты (страница ${page}/${Math.ceil(tickets.length / PAGE_SIZE)}):\n\n${lines.join('\n') || 'Нет билетов.'}`;
}

function myTicketsKb(tickets: Ticket[], page: number): InlineKeyboardMarkup {
    const rows: any[] = [];
    const totalPages = Math.ceil(tickets.length / PAGE_SIZE);
    const start = (page - 1) * PAGE_SIZE;
    const pageTickets = tickets.slice(start, start + PAGE_SIZE);
    for (const t of pageTickets) {
        rows.push([Markup.button.callback(`#${t.id} (${t.paid ? 'Оплачен' : 'Ожидает'})`, `mt:open:${t.id}:${page}`)]);
    }
    if (totalPages > 1) {
        const nav = [];
        if (page > 1) nav.push(Markup.button.callback('⬅️', `mt:page:${page - 1}`));
        nav.push(Markup.button.callback(`${page}/${totalPages}`, `mt:page:${page}`));
        if (page < totalPages) nav.push(Markup.button.callback('➡️', `mt:page:${page + 1}`));
        rows.push(nav);
    }
    rows.push([Markup.button.callback('🏠 Главная', 'home')]);
    return { inline_keyboard: rows };
}

bot.action(/^mt:page:(\d+)$/, async (ctx) => {
    st = st || await loadStore();
    const page = Number(ctx.match[1]);
    const userId = ctx.from.id;
    const myTickets = st.tickets.filter(t => t.userId === userId && t.id.startsWith(`${st.draw.id}_`));
    const text = myTicketsPageText(myTickets, page);
    const kb = myTicketsKb(myTickets, page);
    await ctx.answerCbQuery('');
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
});

bot.action(/^mt:open:(.+?):(\d+)$/, async (ctx) => {
    const ticketId = ctx.match[1];
    const page = Number(ctx.match[2]);
    st = st || await loadStore();
    const t = st.tickets.find(x => x.id === ticketId);
    if (!t) return ctx.answerCbQuery('Билет не найден.');
    const text = formatTicketDetail(t);
    const kb = {
        inline_keyboard: [
            t.paid ? [] : [Markup.button.callback('🔄 Проверить оплату', `check:${t.invoiceId}`)],
            [Markup.button.callback('⬅️ Назад', `mt:page:${page}`)],
            [Markup.button.callback('🏠 Главная', 'home')]
        ].filter(r => r.length)
    };
    await ctx.answerCbQuery('');
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
});

function formatTicketDetail(t: Ticket): string {
    const dt = new Date(t.createdAt);
    const header = `🎫 Билет #${esc(t.id)} • ${dt.toLocaleString('ru-RU')} • ${t.paid ? '✅ Оплачен' : '⏳ Ожидает оплаты'}`;
    const lines = t.selections.map((arr, i) => {
        const items = arr.length ? arr.map(v => OUT_TEXT[v]).join(' / ') : '—';
        const ev = st.draw?.events?.[i];
        const title = ev?.title || `Событие ${i + 1}`;
        const result = ev?.result !== null ? ` → ${OUT_TEXT[ev.result]}${ev.isVoid ? ' (аннулировано)' : ''}` : '';
        return `${String(i + 1).padStart(2, '0')} ${esc(title)}: ${esc(items)}${result}`;
    });
    const price = fmtMoney(calcStakeRUB(t.selections));
    const priceCrypto = calcStakeCrypto(t.selections);
    const hits = computeHits(st, t);
    return `${header}\n<pre>№   Матч: Исход(ы)\n${lines.join('\n')}</pre>\n💸 ${price} ₽ (${priceCrypto} ${CURRENCY})\n🎯 ${hits} совпадений`;
}

// --------------- Админ: билеты ---------------
function adminTicketsPageText(tickets: Ticket[], page: number): string {
    const start = (page - 1) * ADMIN_PAGE_SIZE;
    const pageTickets = tickets.slice(start, start + ADMIN_PAGE_SIZE);
    const lines = pageTickets.map(t => `🎫 #${esc(t.id)} • @${esc(t.username || String(t.userId))} • ${fmtMoney(calcStakeRUB(t.selections))} ₽ • ${t.paid ? '✅ Оплачен' : '⏳ Ожидает'}`);
    const total = tickets.length;
    return `📊 Всего билетов: ${total}\nСтраница ${page}/${Math.ceil(total / ADMIN_PAGE_SIZE)}\n\n${lines.join('\n') || 'Нет билетов.'}`;
}

function adminTicketsKb(tickets: Ticket[], page: number): InlineKeyboardMarkup {
    const rows: any[] = [];
    const totalPages = Math.ceil(tickets.length / ADMIN_PAGE_SIZE);
    const start = (page - 1) * ADMIN_PAGE_SIZE;
    const pageTickets = tickets.slice(start, start + ADMIN_PAGE_SIZE);
    for (const t of pageTickets) {
        rows.push([Markup.button.callback(`#${t.id} (${t.paid ? 'Оплачен' : 'Ожидает'})`, `at:open:${t.id}:${page}`)]);
    }
    if (totalPages > 1) {
        const nav = [];
        if (page > 1) nav.push(Markup.button.callback('⬅️', `at:page:${page - 1}`));
        nav.push(Markup.button.callback(`${page}/${totalPages}`, `at:page:${page}`));
        if (page < totalPages) nav.push(Markup.button.callback('➡️', `at:page:${page + 1}`));
        rows.push(nav);
    }
    rows.push([
        Markup.button.callback('📤 Экспорт', 'at:exp'),
        Markup.button.callback('⬅️ Админ', 'admin')
    ]);
    return { inline_keyboard: rows };
}

bot.action('at:list', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Доступ запрещён.');
    st = st || await loadStore();
    const tickets = getAllTicketsSorted();
    const page = 1;
    const text = adminTicketsPageText(tickets, page);
    const kb = adminTicketsKb(tickets, page);
    await ctx.answerCbQuery('');
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
});

bot.action(/^at:page:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Доступ запрещён.');
    st = st || await loadStore();
    const page = Number(ctx.match[1]);
    const tickets = getAllTicketsSorted();
    const text = adminTicketsPageText(tickets, page);
    const kb = adminTicketsKb(tickets, page);
    await ctx.answerCbQuery('');
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
});

bot.action(/^at:open:(.+?):(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Доступ запрещён.');
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

function formatTicketDetailAdmin(t: Ticket) {
    const dt = new Date(t.createdAt);
    const hh = String(dt.getHours()).padStart(2, '0');
    const mm = String(dt.getMinutes()).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    const mo = String(dt.getMonth() + 1).padStart(2, '0');
    const header = `🎫 Билет #${esc(t.id)} • @${esc(t.username || String(t.userId))} • ${dd}.${mo} ${hh}:${mm} • ${t.paid ? '✅ Оплачен' : '⏳ Ожидает'}${t.invoiceId ? ` • Инвойс: ${t.invoiceId}` : ''}`;
    const lines = t.selections.map((arr, i) => {
        const items = arr.length ? arr.map(v => OUT_TEXT[v]).join(' / ') : '—';
        const ev = st.draw?.events?.[i];
        const title = ev?.title || `Событие ${i + 1}`;
        const result = ev?.result !== null ? ` → ${OUT_TEXT[ev.result]}${ev.isVoid ? ' (аннулировано)' : ''}` : '';
        return `${String(i + 1).padStart(2, '0')} ${esc(title)}: ${esc(items)}${result}`;
    });
    const price = fmtMoney(calcStakeRUB(t.selections));
    const priceCrypto = calcStakeCrypto(t.selections);
    const hits = computeHits(st, t);
    return `${header}\n<pre>№   Матч: Исход(ы)\n${lines.join('\n')}</pre>\n💸 ${price} ₽ (${priceCrypto} ${CURRENCY})\n🎯 ${hits} совпадений`;
}

// --------------- Админ: экспорт ---------------
bot.action('at:exp', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Доступ запрещён.');
    st = st || await loadStore();
    const kb = {
        inline_keyboard: [
            [Markup.button.callback('📄 TXT', 'at:exp:txt')],
            [Markup.button.callback('📊 CSV', 'at:exp:csv')],
            [Markup.button.callback('📋 JSON', 'at:exp:json')],
            [Markup.button.callback('⬅️ Админ', 'admin')]
        ]
    };
    await ctx.answerCbQuery('');
    await ctx.editMessageText('📤 Выберите формат экспорта:', { parse_mode: 'HTML', reply_markup: kb });
});

bot.action('at:exp:txt', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Доступ запрещён.');
    st = st || await loadStore();
    const tickets = getAllTicketsSorted();
    if (!tickets.length) {
        await ctx.answerCbQuery('');
        await ctx.reply('Нет билетов для экспорта.', { parse_mode: 'HTML', reply_markup: adminKb(st.draw) });
        return;
    }
    const blocks = tickets.map(t => {
        const head = `#${t.id} • u:${t.userId} • ${new Date(t.createdAt).toISOString()} • ${t.paid ? 'Оплачен' : 'Ожидает'}${t.invoiceId ? ` • ${t.invoiceId}` : ''}`;
        const body = t.selections.map((arr, i) => {
            const items = arr.length ? arr.map(v => OUTCOMES[v]).join('/') : '-';
            return `${String(i + 1).padStart(2, '0')} ${items}`;
        }).join('\n');
        const price = fmtMoney(calcStakeRUB(t.selections));
        const priceCrypto = calcStakeCrypto(t.selections);
        return `${head}\n${body}\n💸 ${price} ₽ (${priceCrypto} ${CURRENCY})`;
    });
    const content = blocks.join('\n\n');
    const buf = Buffer.from(content, 'utf8');
    await ctx.answerCbQuery('Экспорт TXT сформирован');
    await ctx.replyWithDocument({ source: buf, filename: `tickets_draw_${st.draw.id}.txt` });
});

bot.action('at:exp:csv', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Доступ запрещён.');
    st = st || await loadStore();
    const tickets = getAllTicketsSorted();
    if (!tickets.length) {
        await ctx.answerCbQuery('');
        await ctx.reply('Нет билетов для экспорта.', { parse_mode: 'HTML', reply_markup: adminKb(st.draw) });
        return;
    }
    const header = ['ticket_id', 'user_id', 'username', 'created_at', 'paid', 'invoice_id', ...Array.from({ length: EVENTS_COUNT }, (_, i) => `e${String(i + 1).padStart(2, '0')}`), 'stake_rub', `stake_${CURRENCY.toLowerCase()}`];
    const rows = tickets.map(t => {
        const cols = Array.from({ length: EVENTS_COUNT }, (_, i) => {
            const arr = t.selections[i] || [];
            return arr.length ? arr.map(v => OUTCOMES[v]).join('/') : '-';
        });
        return [t.id, String(t.userId), t.username || '', new Date(t.createdAt).toISOString(), String(t.paid), t.invoiceId || '', ...cols, String(calcStakeRUB(t.selections)), String(calcStakeCrypto(t.selections))];
    });
    const escCsv = (s: string) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    const csv = [header.map(escCsv).join(','), ...rows.map(r => r.map(escCsv).join(','))].join('\n');
    const buf = Buffer.from(csv, 'utf8');
    await ctx.answerCbQuery('Экспорт CSV сформирован');
    await ctx.replyWithDocument({ source: buf, filename: `tickets_draw_${st.draw.id}.csv` });
});

bot.action('at:exp:json', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Доступ запрещён.');
    st = st || await loadStore();
    const tickets = getAllTicketsSorted();
    if (!tickets.length) {
        await ctx.answerCbQuery('');
        await ctx.reply('Нет билетов для экспорта.', { parse_mode: 'HTML', reply_markup: adminKb(st.draw) });
        return;
    }
    const payload = JSON.stringify(tickets.map(t => ({
        id: t.id,
        userId: t.userId,
        username: t.username,
        createdAt: t.createdAt,
        paid: t.paid,
        invoiceId: t.invoiceId,
        selections: t.selections,
        stakeRUB: calcStakeRUB(t.selections),
        stakeCrypto: calcStakeCrypto(t.selections)
    })), null, 2);
    const buf = Buffer.from(payload, 'utf8');
    await ctx.answerCbQuery('Экспорт JSON сформирован');
    await ctx.replyWithDocument({ source: buf, filename: `tickets_draw_${st.draw.id}.json` });
});

// --------------- Админ: управление тиражом ---------------
bot.action('as:stats', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Доступ запрещён.');
    st = st || await loadStore();
    const tickets = st.tickets.filter(t => t.id.startsWith(`${st.draw.id}_`));
    const paidTickets = tickets.filter(t => t.paid);
    const totalStakesRUB = tickets.reduce((sum, t) => sum + calcStakeRUB(t.selections), 0);
    const totalStakesCrypto = tickets.reduce((sum, t) => sum + calcStakeCrypto(t.selections), 0);
    const paidStakesRUB = paidTickets.reduce((sum, t) => sum + calcStakeRUB(t.selections), 0);
    const paidStakesCrypto = paidTickets.reduce((sum, t) => sum + calcStakeCrypto(t.selections), 0);
    const text = `📊 Статистика тиража #${st.draw.id}\n\nСтатус: ${st.draw.status}\nСобытий: ${st.draw.events.length}\nБилетов: ${tickets.length} (оплачено: ${paidTickets.length})\nОбщий банк: ${fmtMoney(totalStakesRUB)} ₽ (${totalStakesCrypto} ${CURRENCY})\nОплаченный банк: ${fmtMoney(paidStakesRUB)} ₽ (${paidStakesCrypto} ${CURRENCY})`;
    await ctx.answerCbQuery('');
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: adminKb(st.draw) });
});



// --- Adapter: SettlementResult (из settlement.ts) -> Settlement (структура бота)
function mapSettlementResultToBotSettlement(
  st: Store,
  result: any, // SettlementResult
  currency: 'TON' | 'USDT_TON',
  bankRub: number
): Settlement {
  return {
    settledAt: new Date().toISOString(),
    totalPlayed: st.tickets.filter(t => t.id.startsWith(`${st.draw.id}_`)).length,
    maxHits: result.maxHitsInDraw,
    bankRUB: bankRub,
    bankUSDT: currency === 'USDT_TON' ? result.prizePool : undefined,
    formulaName: result.formulaName,
    formulaParams: result.formulaParams,
    formulaVersion: result.formulaVersion,
    winners: (result.payouts || []).map((p: any) => ({
      ticketId: '', // при желании можно найти конкретный билет по userId
      userId: p.userId,
      username: st.users[p.userId]?.username,
      hits: p.hits,
      prizeRUB: currency === 'TON' ? p.amount : 0,
      prizeUSDT: currency === 'USDT_TON' ? p.amount : undefined,
    })),
  };
}



// --------------- Админ: редактор событий ---------------
bot.action('ae:edit', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Доступ запрещён.');
    st = st || await loadStore();
    const page = 1;
    const text = `📝 Редактор событий (тираж #${st.draw.id})\n\n${st.draw.events.length} из ${EVENTS_COUNT} событий`;
    const kb = adminEditKb(page, st.draw.events);
    await ctx.answerCbQuery('');
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
});

bot.action(/^ae:page:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Доступ запрещён.');
    st = st || await loadStore();
    const page = Number(ctx.match[1]);
    const text = `📝 Редактор событий (тираж #${st.draw.id})\n\n${st.draw.events.length} из ${EVENTS_COUNT} событий`;
    const kb = adminEditKb(page, st.draw.events);
    await ctx.answerCbQuery('');
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
});

bot.action(/^ae:open:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Доступ запрещён.');
    st = st || await loadStore();
    const idx = Number(ctx.match[1]);
    const ev = st.draw.events.find(e => e.idx === idx);
    if (!ev) return ctx.answerCbQuery('Событие не найдено.');
    const resultText = ev.result !== null ? OUT_TEXT[ev.result] : 'Не установлено';
    const text = `📝 Событие #${idx + 1}\n\nНазвание: ${esc(ev.title)}\nРезультат: ${resultText}${ev.isVoid ? ' (аннулировано)' : ''}\nИсточник: ${ev.sourceUrl || 'Не указан'}`;
    const kb = {
        inline_keyboard: [
            [Markup.button.callback('✏️ Название', `ae:set_title:${idx}`)],
            [Markup.button.callback('📊 Установить результат', `ae:set_result:${idx}`)],
            [Markup.button.callback(ev.isVoid ? '✅ Восстановить' : '🗑️ Аннулировать', `ae:toggle_void:${idx}`)],
            [Markup.button.callback('🔗 Источник', `ae:set_source:${idx}`)],
            [Markup.button.callback('⬅️ Назад', `ae:edit`)]
        ]
    };
    await ctx.answerCbQuery('');
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
});

bot.action(/^ae:set_title:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Доступ запрещён.');
    const idx = Number(ctx.match[1]);
    const userId = ctx.from?.id;
    if (!userId) return;

    adminTextActions.set(userId, { type: 'set_title', idx });

    await ctx.answerCbQuery('Введите название события:');
    await ctx.reply(`✏️ Введите новое название для события #${idx + 1}:`);
});


bot.action(/^ae:set_result:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Доступ запрещён.');
    const idx = Number(ctx.match[1]);
    const kb = {
        inline_keyboard: [
            [Markup.button.callback('1️⃣ Победа 1', `ae:result:${idx}:0`)],
            [Markup.button.callback('2️⃣ Ничья', `ae:result:${idx}:1`)],
            [Markup.button.callback('3️⃣ Победа 2', `ae:result:${idx}:2`)],
            [Markup.button.callback('🚫 Сбросить', `ae:result:${idx}:null`)],
            [Markup.button.callback('⬅️ Назад', `ae:open:${idx}`)]
        ]
    };
    await ctx.answerCbQuery('');
    await ctx.editMessageText(`📊 Установите результат для события #${idx + 1}`, { parse_mode: 'HTML', reply_markup: kb });
});

bot.action(/^ae:result:(\d+):(null|\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Доступ запрещён.');
    st = st || await loadStore();
    const idx = Number(ctx.match[1]);
    const result = ctx.match[2] === 'null' ? null : Number(ctx.match[2]);
    const ev = st.draw.events.find(e => e.idx === idx);
    if (!ev) return ctx.answerCbQuery('Событие не найдено.');
    ev.result = result;
    await saveStore(st);
    await ctx.answerCbQuery(`Результат ${result === null ? 'сброшен' : `установлен: ${OUT_TEXT[result]}`}`);
    await ctx.editMessageText(`📝 Событие #${idx + 1}\n\nНазвание: ${esc(ev.title)}\nРезультат: ${result === null ? 'Не установлено' : OUT_TEXT[result]}${ev.isVoid ? ' (аннулировано)' : ''}`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[Markup.button.callback('⬅️ Назад', `ae:open:${idx}`)]] } });
});

bot.action(/^ae:toggle_void:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Доступ запрещён.');
    st = st || await loadStore();
    const idx = Number(ctx.match[1]);
    const ev = st.draw.events.find(e => e.idx === idx);
    if (!ev) return ctx.answerCbQuery('Событие не найдено.');
    ev.isVoid = !ev.isVoid;
    if (ev.isVoid) ev.result = null;
    await saveStore(st);
    await ctx.answerCbQuery(ev.isVoid ? 'Событие аннулировано' : 'Событие восстановлено');
    await ctx.editMessageText(`📝 Событие #${idx + 1}\n\nНазвание: ${esc(ev.title)}\nРезультат: ${ev.result === null ? 'Не установлено' : OUT_TEXT[ev.result]}${ev.isVoid ? ' (аннулировано)' : ''}`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[Markup.button.callback('⬅️ Назад', `ae:open:${idx}`)]] } });
});

bot.action(/^ae:set_source:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Доступ запрещён.');
    const idx = Number(ctx.match[1]);
    const userId = ctx.from?.id;
    if (!userId) return;

    adminTextActions.set(userId, { type: 'set_source', idx });

    await ctx.answerCbQuery('Введите URL источника:');
    await ctx.reply(`🔗 Введите URL источника для события #${idx + 1}:`);
});


bot.action('ae:add', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Доступ запрещён.');
    st = st || await loadStore();

    if (st.draw.events.length >= EVENTS_COUNT) {
        return ctx.answerCbQuery(`Максимум ${EVENTS_COUNT} событий!`);
    }

    const userId = ctx.from?.id;
    if (!userId) return;

    adminTextActions.set(userId, { type: 'add_event' });

    await ctx.answerCbQuery('Введите название нового события:');
    await ctx.reply('➕ Введите название нового события:');
});


bot.on('text', async (ctx) => {
    if (!isAdmin(ctx)) return;

    const userId = ctx.from?.id;
    if (!userId) return;

    const action = adminTextActions.get(userId);
    if (!action) return; // это обычное сообщение, не в рамках админ-действия

    st = st || await loadStore();
    const text = ctx.message.text;

    if (action.type === 'set_title' && action.idx !== undefined) {
        const ev = st.draw.events.find(e => e.idx === action.idx);
        if (!ev) {
            await ctx.reply('Событие не найдено.');
        } else {
            ev.title = text;
            await saveStore(st);
            await ctx.reply(
                `✅ Название события #${action.idx + 1} обновлено: ${esc(ev.title)}`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[Markup.button.callback('⬅️ Редактор', 'ae:edit')]] }
                }
            );
        }
    } else if (action.type === 'set_source' && action.idx !== undefined) {
        const ev = st.draw.events.find(e => e.idx === action.idx);
        if (!ev) {
            await ctx.reply('Событие не найдено.');
        } else {
            ev.sourceUrl = text;
            await saveStore(st);
            await ctx.reply(
                `🔗 Источник для события #${action.idx + 1} обновлён.`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[Markup.button.callback('⬅️ Редактор', 'ae:edit')]] }
                }
            );
        }
    } else if (action.type === 'add_event') {
        const idx = st.draw.events.length;
        st.draw.events.push({
            idx,
            title: text,
            result: null,
            isVoid: false,
        });
        await saveStore(st);
        await ctx.reply(
            `➕ Событие #${idx + 1} добавлено: ${esc(text)}`,
            {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[Markup.button.callback('⬅️ Редактор', 'ae:edit')]] }
            }
        );
    }

    // Чистим состояние для этого админа
    adminTextActions.delete(userId);
});


// --------------- Главная ---------------
bot.action('home', async (ctx) => {
    st = st || await loadStore();
    const text = `🏠 Тотализатор 15×3 • Тираж #${st.draw.id} (${st.draw.status})`;
    await ctx.answerCbQuery('');
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: mainKb(ctx, st.draw) });
});

// 🚀 Старт тиража (из setup -> open)
bot.action('as:start', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Нет прав');
  st = st || await loadStore();

  if (st.draw.status !== 'setup') {
    await ctx.answerCbQuery('');
    await ctx.reply(`Нельзя запустить: текущий статус ${st.draw.status}.`);
    return;
  }
  // валидация: должны быть заведены события
  if (!st.draw.events || st.draw.events.length !== EVENTS_COUNT) {
    await ctx.answerCbQuery('');
    await ctx.reply(`Сначала настройте ${EVENTS_COUNT} событий в редакторе (ae:edit). Сейчас: ${st.draw.events?.length || 0}`);
    return;
  }

  st.draw.status = 'open';
  await saveStore(st);
  await ctx.answerCbQuery('Тираж открыт');
  await ctx.editMessageText(`🔧 Админ-панель: Тираж #${st.draw.id} (${st.draw.status})`, { reply_markup: adminKb(st.draw), parse_mode: 'HTML' });
});

// 🔒 Закрыть приём ставок (open -> closed)
bot.action('as:close', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Нет прав');
  st = st || await loadStore();

  if (st.draw.status !== 'open') {
    await ctx.answerCbQuery('');
    await ctx.reply(`Нельзя закрыть: текущий статус ${st.draw.status}.`);
    return;
  }
  st.draw.status = 'closed';
  await saveStore(st);
  await ctx.answerCbQuery('Приём ставок закрыт');
  await ctx.editMessageText(`🔧 Админ-панель: Тираж #${st.draw.id} (${st.draw.status})`, { reply_markup: adminKb(st.draw), parse_mode: 'HTML' });
});

// ✅ Завершить (closed -> settled) + расчёт выплат
bot.action('as:settle', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Нет прав');
  st = st || await loadStore();

  if (st.draw.status !== 'closed') {
    await ctx.answerCbQuery('');
    await ctx.reply(`Нельзя завершить: текущий статус ${st.draw.status}. Сначала закройте приём ставок (as:close).`);
    return;
  }

  // 1) Сколько событий реально сыграло (есть result и не void)
  const resolvedEvents = (st.draw.events || []).filter(ev => ev && ev.result !== null && !ev.isVoid);
  const maxPossibleHits = resolvedEvents.length;

  // 2) Оплаченные билеты текущего тиража
  const tickets = st.tickets.filter(t => t.id.startsWith(`${st.draw.id}_`) && t.paid);

  // 3) Лучший результат (максимум совпадений) по пользователю
  const hitsByUserMap = new Map<number, { userId: number; wallet: string; hits: number }>();
  for (const t of tickets) {
    const hits = computeHits(st, t);
    const prev = hitsByUserMap.get(t.userId);
    const best = prev ? Math.max(prev.hits, hits) : hits; // берём максимум
    hitsByUserMap.set(t.userId, {
      userId: t.userId,
      wallet: st.users[t.userId]?.wallet || '',
      hits: best
    });
  }
  const hitsByUser = Array.from(hitsByUserMap.values());

  // 4) Банк из реально оплаченных платежей
  let totalBank = 0;
  for (const t of tickets) {
    const inv = t.invoiceId ? st.payments[t.invoiceId] : undefined;
    if (inv && inv.paid && inv.currency === CURRENCY) {
      totalBank += inv.amount; // TON или USDT_TON (в зависимости от CURRENCY)
    }
  }

  // 5) Подготовка входа в формулу
  const input = {
    drawId: String(st.draw.id),
    totalBank,
    maxHitsInDraw: maxPossibleHits,
    hitsByUser
  };

  // 6) Вызов формулы (по умолчанию TIERED_WEIGHTS)
  const params =
    PAYOUT_FORMULA === 'MAX_HITS_EQUAL_SHARE' ? PAYOUT_PARAMS_MAX_HITS_EQUAL_SHARE :
    PAYOUT_FORMULA === 'TIERED_WEIGHTS'      ? PAYOUT_PARAMS_TIERED_WEIGHTS :
    PAYOUT_FORMULA === 'FIXED_TABLE'         ? PAYOUT_PARAMS_FIXED_TABLE :
                                                PAYOUT_PARAMS_MAX_HITS_EQUAL_SHARE;

  const result = calculatePayouts(PAYOUT_FORMULA as FormulaName, input as any, params as any);

  // 7) Сохранение итогов
  st.draw.status = 'settled';
  st.draw.settlement = mapSettlementResultToBotSettlement(
    st,
    result as any,
    CURRENCY,
    /* bankRub */ 0 // если нужен ещё рублевый банк — подставь сюда
  );
  await saveStore(st);

  // 8) Сообщение админу
  const winnersText = (st.draw.settlement.winners || [])
    .map(w => `@${w.username || w.userId}: ${w.hits} совп., ${CURRENCY === 'TON' ? `${w.prizeRUB} TON` : `${w.prizeUSDT} USDT`}`)
    .join('\n') || 'Нет победителей.';
  await ctx.answerCbQuery('');
  await ctx.editMessageText(
    `🔧 Админ-панель: Тираж #${st.draw.id} (${st.draw.status})`,
    { reply_markup: adminKb(st.draw), parse_mode: 'HTML' }
  );
  await ctx.reply(
    `✅ Тираж #${st.draw.id} рассчитан\n` +
    `Макс. попаданий: ${st.draw.settlement.maxHits}/${maxPossibleHits}\n` +
    `Формула: ${st.draw.settlement.formulaName}\n` +
    `Банк: ${result.prizePool} ${CURRENCY === 'TON' ? 'TON' : 'USDT'}\n\n` +
    `Победители:\n${winnersText}`
  );

  // 9) ДМ победителям
  for (const w of st.draw.settlement.winners || []) {
    try {
      const prizeStr = CURRENCY === 'TON' ? `${w.prizeRUB} TON` : `${w.prizeUSDT} USDT`;
      await ctx.telegram.sendMessage(
        w.userId,
        `🏆 Поздравляем! Ваш результат: ${w.hits} совпаданий.\n` +
        `Приз: ${prizeStr}\n\n` +
        `Спасибо за участие в тираже #${st.draw.id}!`
      );
    } catch {}
  }
});

// 🆕 Новый тираж (доступно только из settled)
bot.action('as:newdraw', async (ctx) => {
    if (!isAdmin(ctx)) {
        return ctx.answerCbQuery('Нет прав');
    }

    st = st || await loadStore();

    if (st.draw.status !== 'settled') {
        await ctx.answerCbQuery('');
        await ctx.reply(`Новый тираж можно создать только из статуса "settled". Сейчас: ${st.draw.status}.`);
        return;
    }

    const oldDrawId = st.draw.id;

    // 1. Архивируем старый тираж
    try {
        const historyDir = path.join(DATA_DIR, 'history');
        await fs.mkdir(historyDir, { recursive: true });

        const historyPath = path.join(historyDir, `draw_${oldDrawId}.json`);
        const snapshot = {
            exportedAt: new Date().toISOString(),
            draw: st.draw,
            tickets: st.tickets,
            payments: st.payments,
        };

        await fs.writeFile(historyPath, JSON.stringify(snapshot, null, 2), 'utf-8');
        console.log(`🗂 Архивирован тираж #${oldDrawId} -> ${historyPath}`);
    } catch (e) {
        console.error('Ошибка архивации тиража перед созданием нового:', e);
        // не выкидываем ошибку наружу, просто логируем
    }

    // 2. Готовим новый пустой тираж
    const newDrawId = oldDrawId + 1;

    st.draw = {
        id: newDrawId,
        status: 'setup',
        createdAt: new Date().toISOString(),
        events: [],
        settlement: undefined,
    } as any; // если TS ругнётся на тип, это можно потом подправить

    // 3. Очищаем билеты, платежи и счётчик
    st.tickets = [];
    st.payments = {};
    st.nextTicketSeq = 1;

    // 4. Сбрасываем флаг "у меня есть билет" у всех пользователей
    if (st.users && typeof st.users === 'object') {
        for (const key in st.users) {
            if (Object.prototype.hasOwnProperty.call(st.users, key)) {
                const u = st.users[Number(key)];
                if (u) {
                    u.hasTicketForCurrent = false;
                }
            }
        }
    }

    await saveStore(st);

    const text =
        `✅ Создан новый тираж #${st.draw.id}\n` +
        `Статус: ${st.draw.status}\n\n` +
        `Сейчас:\n` +
        `• Событий: 0 из ${EVENTS_COUNT}\n` +
        `• Билетов: 0\n\n` +
        `Перейдите в "📝 Редактор событий", заведите ${EVENTS_COUNT} матчей,\n` +
        `а затем нажмите "🟢 Открыть тираж".`;

    await ctx.answerCbQuery('Новый тираж создан');
    await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: adminKb(st.draw),
    });
});

bot.action('as:stats', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Доступ запрещён.');
  st = st || await loadStore();

  const drawIdPrefix = `${st.draw.id}_`;
  const tickets = st.tickets.filter(t => t.id.startsWith(drawIdPrefix));

  const total = tickets.length;
  const paid = tickets.filter(t => t.paid).length;
  const unpaid = total - paid;

  const uniqueUsers = new Set(tickets.map(t => t.userId)).size;

  // банк по факту (только оплаченные)
  const bankCrypto = tickets
    .filter(t => t.paid)
    .reduce((sum, t) => sum + Number(calcStakeCrypto(t.selections)), 0);

  const bankRub = tickets
    .filter(t => t.paid)
    .reduce((sum, t) => sum + Number(calcStakeRUB(t.selections)), 0);

  const text =
`📊 <b>Статистика тиража #${st.draw.id}</b> (${st.draw.status})

🎫 Билеты: <b>${total}</b>
✅ Оплачено: <b>${paid}</b>
⏳ Не оплачено: <b>${unpaid}</b>
👥 Уникальных игроков: <b>${uniqueUsers}</b>

💰 Банк (оплачено):
• ~ <b>${bankRub.toFixed(0)}</b> ₽
• ~ <b>${bankCrypto.toFixed(4)}</b> ${CURRENCY}

ℹ️ Примечание: банк считается по <b>оплаченным</b> билетам.
`;

  await ctx.answerCbQuery('');
  await safeEditMessage(ctx, text, {
    inline_keyboard: [
      [Markup.button.callback('🔄 Обновить', 'as:stats')],
      [Markup.button.callback('⬅️ Админка', 'admin')],
    ]
  });
});


// --------------- Запуск ---------------
(async () => {
  try {
    st = await loadStore();
    console.log('🚀 Запускаю бота...');

    await initTon();

    // setMyCommands — НЕ критично. Если Telegram/сеть моргнула, бот всё равно должен жить.
    try {
      await bot.telegram.setMyCommands([
        { command: 'start', description: 'Запустить бота' },
        { command: 'help', description: 'Помощь' },
        { command: 'rules', description: 'Правила' },
        { command: 'events', description: 'Список событий' },
        { command: 'my', description: 'Мои билеты' }
      ]);
      console.log('✅ setMyCommands OK');
    } catch (e) {
      console.warn('⚠️ setMyCommands failed (не критично):', e);
    }

    await bot.launch({ dropPendingUpdates: true });

    console.log(`✅ Бот запущен. Draw #${st.draw.id} status=${st.draw.status}`);
  } catch (error) {
    console.error('Failed to start bot:', error);
    // Не выходим из процесса
  }
})();


// Аккуратное завершение
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
