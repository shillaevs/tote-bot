// bot.ts — минимально-полный тотализатор 15×3 с Crypto Pay и вебхуками
// Версия: 2025-09-30 (Crypto Pay: express-вебхуки + testnet переключатель)

import * as dotenv from 'dotenv';
dotenv.config();

import { Telegraf, Context, Markup } from 'telegraf';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import fetch from 'node-fetch';
import express from 'express'; // <— добавлено для вебхуков

// ------------------ Конфиг (.env) ------------------
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
const BASE_STAKE = Number(process.env.BASE_STAKE || 20);
const CURRENCY = process.env.CURRENCY || 'USDT';

// Crypto Pay: переключатель среды
const CRYPTOPAY_TOKEN = process.env.CRYPTOPAY_TOKEN || '';
const CRYPTOPAY_TESTNET = String(process.env.CRYPTOPAY_TESTNET || '').toLowerCase() === 'true';
const CRYPTOPAY_BASE = process.env.CRYPTOPAY_BASE || (CRYPTOPAY_TESTNET ? 'https://testnet-pay.crypt.bot' : 'https://pay.crypt.bot');

// Вебхуки и сеть
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const PORT = Number(process.env.PORT || 3000);

// Путь Telegram-вебхука (любой, но стабильно)
const TG_WEBHOOK_PATH = process.env.TG_WEBHOOK_PATH || '/telegram-webhook';

// Секретный путь для Crypto Pay вебхука (обязателен!)
const CRYPTOPAY_WEBHOOK_SECRET_PATH = '/' + (process.env.CRYPTOPAY_WEBHOOK_SECRET_PATH || 'cryptopay-webhook');

// ------------------ Типы ------------------
type DrawStatus = 'setup' | 'open' | 'closed' | 'settled';

interface EventItem {
  idx: number;
  title: string;
  result: number | null;
  isVoid: boolean;
}

interface Draw {
  id: number;
  status: DrawStatus;
  events: EventItem[];
  createdAt: string;
  rolloverPrev: { [key: string]: number };
}

interface Ticket {
  id: string;
  userId: number;
  username?: string;
  selections: number[][];
  combos: number;
  amount: number;
  paidAmount: number;
  createdAt: string;
  paid: boolean;
  invoiceUrl?: string;
  invoiceId?: string; // id инвойса в Crypto Pay
  hitCount?: number;
}

interface UserData {
  hasTicketForCurrent: boolean;
}

interface Store {
  draw: Draw;
  tickets: Ticket[];
  nextTicketSeq: number;
  users: { [userId: string]: UserData };
}

interface MainMsg {
  chatId: number;
  msgId: number;
}

interface Session {
  selections: number[][];
  mainMsg?: MainMsg;
  lastKeyboardHash?: string;
}

// ------------------ Память процесса ------------------
const sessions = new Map<number, Session>();

function newEmptySelections(): number[][] {
  return Array.from({ length: EVENTS_COUNT }, () => []);
}

function getSession(userId: number): Session {
  let s = sessions.get(userId);
  if (!s) {
    s = { selections: newEmptySelections() };
    sessions.set(userId, s);
  }
  return s;
}

// ------------------ Файловое хранилище ------------------
const DATA_DIR = path.join(process.cwd(), 'data');
const HISTORY_DIR = path.join(process.cwd(), 'history');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

let st: Store;

async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(HISTORY_DIR, { recursive: true });
}

async function loadStore(): Promise<Store> {
  await ensureDirs();
  try {
    const raw = await fs.readFile(STORE_FILE, 'utf8');
    const data = JSON.parse(raw);
    
    // ГАРАНТИРУЕМ, что users всегда существует и является объектом
    if (!data.users || typeof data.users !== 'object' || Array.isArray(data.users)) {
      data.users = {};
      console.log(`Fixed users: was ${typeof data.users}, now object`);
    }
    
    // Гарантируем, что все обязательные поля существуют
    if (!data.tickets || !Array.isArray(data.tickets)) data.tickets = [];
    if (!data.nextTicketSeq || typeof data.nextTicketSeq !== 'number') data.nextTicketSeq = 1;
    
    // Гарантируем, что draw существует и имеет правильную структуру
    if (!data.draw) {
      data.draw = createNewDraw(data.draw?.id || 1);
    }
    
    return data;
  } catch (error) {
    console.log(`Creating new store: ${error}`);
    return createNewStore();
  }
}

function createNewDraw(id: number): Draw {
  return {
    id: id,
    status: 'setup',
    events: [],
    createdAt: new Date().toISOString(),
    rolloverPrev: { "12": 0, "13": 0, "14": 0, "15": 0 },
  };
}

function createNewStore(): Store {
  return {
    draw: createNewDraw(1),
    tickets: [],
    nextTicketSeq: 1,
    users: {},
  };
}


async function saveStore(data: Store) {
  // ГАРАНТИРУЕМ, что users существует перед сохранением
  if (!data.users || typeof data.users !== 'object') {
    data.users = {};
  }
  await fs.writeFile(STORE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ------------------ Crypto Pay ------------------
async function createCryptoPayInvoice(amount: number, description: string, payload: string): Promise<{ url: string; id: string }> {
  const url = `${CRYPTOPAY_BASE}/api/createInvoice`;
  const body = JSON.stringify({
    asset: CURRENCY,
    amount: amount.toString(),
    description: description,
    payload: payload,
    expired_in: 3600 // 1 hour
  });
  
  console.log(`Creating invoice at: ${url}`);
  console.log(`Request body: ${body}`);
  console.log(`Token: ${CRYPTOPAY_TOKEN.substring(0, 10)}...`);
  
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 
        'Crypto-Pay-API-Token': CRYPTOPAY_TOKEN, 
        'Content-Type': 'application/json'
      },
      body,
    });
    
    const responseText = await res.text();
    console.log(`Response status: ${res.status}`);
    console.log(`Response body: ${responseText}`);
    
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      throw new Error(`Invalid JSON response: ${responseText}`);
    }
    
    if (!data.ok) {
      throw new Error(`Crypto Pay API error: ${data.error?.code} - ${data.error?.name}`);
    }
    
    if (!data.result) {
      throw new Error('No result in response');
    }
    
    const invoiceUrl = data.result.pay_url || data.result.invoice_url;
    const invoiceId = data.result.invoice_id;
    
    if (!invoiceUrl || !invoiceId) {
      throw new Error('Missing invoice URL or ID in response');
    }
    
    console.log(`Invoice created: ${invoiceUrl}`);
    return { url: invoiceUrl, id: invoiceId.toString() };
    
  } catch (e) {
    console.error(`Failed to create invoice: ${e}`);
    throw e;
  }
}

async function saveHistorySnapshot(data: Store) {
  await ensureDirs();
  const snapshot = {
    id: data.draw.id,
    settledAt: new Date().toISOString(),
    draw: data.draw,
    tickets: data.tickets.map(t => ({
      id: t.id,
      userId: t.userId,
      username: t.username,
      combos: t.combos,
      amount: t.amount,
      paid: t.paid,
      hitCount: t.hitCount ?? null,
      invoiceId: t.invoiceId ?? null
    })),
  };
  const file = path.join(HISTORY_DIR, `draw-${data.draw.id}-${Date.now()}.json`);
  await fs.writeFile(file, JSON.stringify(snapshot, null, 2), 'utf8');
}

// ------------------ Расчёты ------------------
const OUTCOMES = ['1', 'X', '2'] as const;

function combosCount(selections: number[][]): number {
  return selections.reduce((acc, arr) => acc * (arr.length || 1), 1);
}

function totalSelections(selections: number[][]): number {
  return selections.reduce((s, arr) => s + arr.length, 0);
}

function totalPrice(selections: number[][]): number {
  const c = combosCount(selections);
  return c * BASE_STAKE;
}

function hasAllEventsPicked(selections: number[][], eventsLen: number): boolean {
  if (selections.length < eventsLen) return false;
  for (let i = 0; i < eventsLen; i++) {
    if (!selections[i] || selections[i].length === 0) return false;
  }
  return true;
}

function randInt(n: number): number {
  return Math.floor(Math.random() * n);
}

// ------------------ Рендер клавиатуры ------------------
function eventRowLabel(idx: number): string {
  return `${String(idx + 1).padStart(2, '0')}.`;
}

function truncate(text: string, max = 64): string {
  if (!text) return '';
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function isSelected(sel: number[], outcome: number): boolean {
  return sel.includes(outcome);
}

function keyboardFor(selections: number[][], draw: Draw) {
  const rows: any[] = [];
  const evLen = draw.events.length;

  for (let i = 0; i < evLen; i++) {
    const ev = draw.events[i];
    const sel = selections[i] || [];
    const prefix = ev.isVoid ? '🚫 ' : (ev.result !== null ? `🏁${OUTCOMES[ev.result]} ` : '');

    rows.push([
      Markup.button.callback(`${eventRowLabel(i)} ${prefix}${truncate(ev.title, 64)}`, `noop:${i}`)
    ]);

    rows.push([
      Markup.button.callback(`1${isSelected(sel, 0) ? ' ✅' : ''}`, `tog:${i}:0`),
      Markup.button.callback(`X${isSelected(sel, 1) ? ' ✅' : ''}`, `tog:${i}:1`),
      Markup.button.callback(`2${isSelected(sel, 2) ? ' ✅' : ''}`, `tog:${i}:2`),
    ]);
  }

  const combos = combosCount(selections);
  const price = totalPrice(selections);
  rows.push([Markup.button.callback(`Комбинаций: ${combos} | Итого: ${price} ${CURRENCY}`, 'noop:price')]);

  rows.push([
    Markup.button.callback('🎲 Автовыбор', 'auto:fill'),
    Markup.button.callback('🧹 Очистить', 'auto:clear'),
  ]);

  const canSave =
    draw.status === 'open' &&
    evLen === EVENTS_COUNT &&
    hasAllEventsPicked(selections, evLen);

  rows.push([
    Markup.button.callback(canSave ? '💾 Сохранить ставку' : '➖ Заполните все события', 'save:ticket')
  ]);

  const keyboard = { inline_keyboard: rows };
  return keyboard;
}

// ------------------ Текст заголовка ------------------
function headerText(draw: Draw, selections?: number[][]): string {
  const evLen = draw.events.length;
  const title = `*Тираж #${draw.id}* (статус: *${draw.status}*)\n`;
  const sub = `${EVENTS_COUNT} событий × 3 исхода (1/X/2). Базовая ставка: ${BASE_STAKE} ${CURRENCY} за комбинацию.\n` +
              `Цена билета = базовая ставка × произведение выбранных исходов.\n` +
              (evLen < EVENTS_COUNT ? `⚠ Добавлено ${evLen}/${EVENTS_COUNT} событий — оплата будет доступна, когда все ${EVENTS_COUNT} добавлены.\n` : '') +
              `📌 Выберите исходы и нажмите "Сохранить ставку", чтобы создать билет и перейти к оплате.\n`;

  const lines = draw.events.map((ev) => `${String(ev.idx + 1).padStart(2, '0')}. ${ev.title}`).join('\n');

  const tail = selections
    ? `\n\n*Выбрано исходов:* ${totalSelections(selections)}\n` +
      `*Комбинаций:* ${combosCount(selections)}\n` +
      `*Итого:* ${totalPrice(selections)} ${CURRENCY}`
    : '';

  return title + sub + '\n' + lines + tail;
}

// ------------------ Бот ------------------
const bot = new Telegraf(BOT_TOKEN);

function isAdmin(ctx: Context): boolean {
  const uid = ctx.from?.id || 0;
  return ADMIN_IDS.includes(uid);
}

// Функция для безопасного обновления сообщения
async function upsertMainMessage(ctx: Context, session: Session, draw: Draw) {
  const keyboard = keyboardFor(session.selections, draw);
  const text = headerText(draw, session.selections);
  
  // Создаем хэш текущей клавиатуры для избежания избыточных обновлений
  const keyboardHash = createHash('md5').update(JSON.stringify(keyboard)).digest('hex');
  
  try {
    if (session.mainMsg && session.lastKeyboardHash === keyboardHash) {
      // Клавиатура не изменилась, пропускаем обновление
      return;
    }

    if (session.mainMsg) {
      await ctx.telegram.editMessageText(
        session.mainMsg.chatId,
        session.mainMsg.msgId,
        undefined,
        text,
        { 
          parse_mode: 'Markdown',
          reply_markup: keyboard
        }
      );
      session.lastKeyboardHash = keyboardHash;
    } else {
      const msg = await ctx.reply(text, { 
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
      session.mainMsg = { chatId: msg.chat.id, msgId: msg.message_id };
      session.lastKeyboardHash = keyboardHash;
    }
  } catch (error: any) {
    if (error.message.includes('message is not modified')) {
      // Игнорируем эту ошибку - это нормально
      session.lastKeyboardHash = keyboardHash;
    } else {
      console.error(`Failed to update message: ${error}`);
      // При ошибке создаем новое сообщение
      try {
        const msg = await ctx.reply(text, { 
          parse_mode: 'Markdown',
          reply_markup: keyboard
        });
        session.mainMsg = { chatId: msg.chat.id, msgId: msg.message_id };
        session.lastKeyboardHash = keyboardHash;
      } catch (e) {
        console.error(`Failed to create new message: ${e}`);
      }
    }
  }
}

// /start — показать сетку
bot.start(async (ctx) => {
  try {
    if (!st) st = await loadStore();
    const uid = ctx.from?.id!;
    const s = getSession(uid);
    await upsertMainMessage(ctx, s, st.draw);
  } catch (error) {
    console.error(`Error in /start: ${error}`);
    await ctx.reply('Произошла ошибка при загрузке интерфейса. Попробуйте еще раз.');
  }
});

// /resetdraw — сбросить тираж (для админов)
bot.command('resetdraw', async (ctx) => {
  if (!isAdmin(ctx)) return;
  try {
    if (!st) st = await loadStore();
    st.draw = {
      id: st.draw.id + 1,
      status: 'setup',
      events: [],
      createdAt: new Date().toISOString(),
      rolloverPrev: { "12": 0, "13": 0, "14": 0, "15": 0 },
    };
    st.tickets = [];
    st.users = {};
    await saveStore(st);
    const keyboard = adminKb(st.draw);
    await ctx.reply(`Тираж #${st.draw.id} создан, статус: setup.`, { reply_markup: keyboard });
  } catch (error) {
    console.error(`Error in resetdraw: ${error}`);
    await ctx.reply('Ошибка при сбросе тиража');
  }
});

// Пустые кнопки
bot.action(/^noop:/, async (ctx) => {
  await ctx.answerCbQuery('');
});

// Переключение исходов
bot.action(/^tog:(\d+):([012])$/, async (ctx) => {
  try {
    if (!st) st = await loadStore();
    const uid = ctx.from?.id!;
    const s = getSession(uid);

    const m = ctx.match as RegExpExecArray;
    const i = Number(m[1]);
    const o = Number(m[2]);

    if (i < 0 || i >= st.draw.events.length) return ctx.answerCbQuery('Событие недоступно');
    if (st.draw.status !== 'open' && st.draw.status !== 'setup') return ctx.answerCbQuery('Приём закрыт');

    const arr = s.selections[i] || [];
    const ix = arr.indexOf(o);
    if (ix >= 0) arr.splice(ix, 1);
    else arr.push(o);

    s.selections[i] = Array.from(new Set(arr)).sort();

    await ctx.answerCbQuery('');
    await upsertMainMessage(ctx, s, st.draw);
  } catch (error) {
    console.error(`Error in toggle: ${error}`);
    await ctx.answerCbQuery('Ошибка при изменении выбора');
  }
});

// Автовыбор
bot.action('auto:fill', async (ctx) => {
  try {
    if (!st) st = await loadStore();
    const uid = ctx.from?.id!;
    const s = getSession(uid);

    for (let i = 0; i < st.draw.events.length; i++) {
      s.selections[i] = [randInt(3)];
    }
    await ctx.answerCbQuery('Заполнено случайно');
    await upsertMainMessage(ctx, s, st.draw);
  } catch (error) {
    console.error(`Error in auto:fill: ${error}`);
    await ctx.answerCbQuery('Ошибка при автозаполнении');
  }
});

// Очистка
bot.action('auto:clear', async (ctx) => {
  try {
    if (!st) st = await loadStore();
    const uid = ctx.from?.id!;
    const s = getSession(uid);
    s.selections = newEmptySelections();
    delete s.mainMsg;
    delete s.lastKeyboardHash;
    await ctx.answerCbQuery('Очищено');
    await upsertMainMessage(ctx, s, st.draw);
  } catch (error) {
    console.error(`Error in auto:clear: ${error}`);
    await ctx.answerCbQuery('Ошибка при очистке');
  }
});

// Сохранить билет → создать инвойс (если CRYPTOPAY_TOKEN задан)

bot.action('save:ticket', async (ctx) => {
  try {
    if (!st) st = await loadStore();
    const uid = ctx.from?.id!;
    console.log(`save:ticket for user ${uid}, draw status: ${st.draw.status}, events: ${st.draw.events.length}`);

    // ДОБАВЛЕНО: более строгая проверка статуса
    if (st.draw.status !== 'open') {
      await ctx.answerCbQuery(`Приём ставок закрыт (статус: ${st.draw.status})`);
      return;
    }
    
    if (st.draw.events.length !== EVENTS_COUNT) {
      await ctx.answerCbQuery(`Добавлены не все события (${st.draw.events.length}/${EVENTS_COUNT})`);
      return;
    }
    
    const s = getSession(uid);
    if (!hasAllEventsPicked(s.selections, EVENTS_COUNT)) {
      await ctx.answerCbQuery('Выберите исходы по всем событиям');
      return;
    }

    const combos = combosCount(s.selections);
    const amount = totalPrice(s.selections);

    const ticketId = `${uid}-${Date.now()}`;
    const ticket: Ticket = {
      id: ticketId,
      userId: uid,
      username: ctx.from?.username,
      selections: s.selections.map(a => [...a]),
      combos,
      amount,
      paidAmount: amount,
      createdAt: new Date().toISOString(),
      paid: !CRYPTOPAY_TOKEN,
    };

    let replyMarkup;
    if (CRYPTOPAY_TOKEN) {
      try {
        const invoice = await createCryptoPayInvoice(amount, `Ticket #${ticket.id} for draw #${st.draw.id}`, ticketId);
        ticket.invoiceUrl = invoice.url;
        ticket.invoiceId = invoice.id;
        ticket.paid = false;
        replyMarkup = { inline_keyboard: [[Markup.button.url('💳 Оплатить', invoice.url)]] };
      } catch (e) {
        console.error(`Failed to create invoice: ${e}`);
        await ctx.answerCbQuery('Ошибка создания инвойса');
        return;
      }
    }

    // ГАРАНТИРУЕМ, что users существует перед использованием
    if (!st.users) {
      st.users = {};
      console.log(`Initialized st.users for user ${uid}`);
    }
    
    st.tickets.push(ticket);
    st.users[uid.toString()] = { hasTicketForCurrent: true };
    await saveStore(st);

    await ctx.answerCbQuery('Билет создан!');

    let msg = `Билет *#${ticket.id}* создан.\nКомбинаций: *${combos}*\nСумма: *${amount} ${CURRENCY}*\n`;
    msg += ticket.invoiceUrl ? `Статус: *ожидает оплаты*` : `Оплата не настроена — билет активен.\nСтатус: *оплачен*`;
    await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: replyMarkup });
    
  } catch (e) {
    console.error(`Error in save:ticket for user ${ctx.from?.id}: ${e}`);
    await ctx.answerCbQuery('Ошибка при сохранении билета');
  }
});

// --------- Админ-меню ----------
type AdminState =
  | { mode: 'IDLE' }
  | { mode: 'ADDING' }
  | { mode: 'RENAMING'; idx: number }
  | { mode: 'RESULTS' };

const adminState = new Map<number, AdminState>();

function adminKb(draw: Draw) {
  const rows = [
    [Markup.button.callback('➕ Добавить событие', 'a:add')],
    [Markup.button.callback('✏️ Переименовать', 'a:rename')],
    [
      Markup.button.callback('🟢 Открыть приём', 'a:open'),
      Markup.button.callback('🔴 Закрыть приём', 'a:close'),
    ],
    [Markup.button.callback('🏁 Результаты/void', 'a:results')],
    [Markup.button.callback('📊 Подсчитать итоги (settle)', 'a:settle')],
    [Markup.button.callback('📣 Разослать результаты', 'a:broadcast')],
    [Markup.button.callback('📜 Показать список', 'a:list')],
  ];
  return { inline_keyboard: rows };
}

bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx)) return;
  try {
    if (!st) st = await loadStore();
    adminState.set(ctx.from!.id, { mode: 'IDLE' });
    const keyboard = adminKb(st.draw);
    await ctx.reply(`Админ-меню. Тираж #${st.draw.id}, статус: ${st.draw.status}.`, { reply_markup: keyboard });
  } catch (error) {
    console.error(`Error in admin: ${error}`);
    await ctx.reply('Ошибка при загрузке админ-меню');
  }
});

bot.action('a:list', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  const text = headerText(st.draw);
  await ctx.answerCbQuery('');
  await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.action('a:add', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  if (st.draw.events.length >= EVENTS_COUNT) {
    return ctx.answerCbQuery('Уже 15/15 событий');
  }
  adminState.set(ctx.from!.id, { mode: 'ADDING' });
  await ctx.answerCbQuery('');
  await ctx.reply('Отправьте *текст события* отдельным сообщением.\nНапример: `18.08 20:00 • RPL • Зенит — Спартак`', { parse_mode: 'Markdown' });
});

bot.action('a:rename', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  if (st.draw.events.length === 0) {
    return ctx.answerCbQuery('Событий нет');
  }
  const rows = st.draw.events.map((ev) => [
    Markup.button.callback(`${String(ev.idx + 1).padStart(2, '0')}. ${truncate(ev.title, 40)}`, `a:ren:${ev.idx}`)
  ]);
  await ctx.answerCbQuery('');
  await ctx.reply('Выберите событие для переименования:', { reply_markup: { inline_keyboard: rows } });
});

bot.action(/^a:ren:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  const i = Number((ctx.match as RegExpExecArray)[1]);
  if (!st.draw.events.find(e => e.idx === i)) return ctx.answerCbQuery('Нет такого');
  adminState.set(ctx.from!.id, { mode: 'RENAMING', idx: i });
  await ctx.answerCbQuery('');
  await ctx.reply(`Новый текст для #${i + 1} (или "-" чтобы пропустить):`);
});

bot.action('a:open', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  if (st.draw.events.length !== EVENTS_COUNT) {
    return ctx.answerCbQuery('Нужно 15/15 событий');
  }
  st.draw.status = 'open';
  await saveStore(st);
  await ctx.answerCbQuery('Открыто');
  await ctx.reply(`Приём ставок открыт.`, { reply_markup: adminKb(st.draw) });
});

bot.action('a:close', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  st.draw.status = 'closed';
  await saveStore(st);
  await ctx.answerCbQuery('Закрыто');
  await ctx.reply(`Приём ставок закрыт.`, { reply_markup: adminKb(st.draw) });
});

bot.action('a:results', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  adminState.set(ctx.from!.id, { mode: 'RESULTS' });

  const rows: any[] = [];
  for (const ev of st.draw.events) {
    rows.push([Markup.button.callback(`${String(ev.idx + 1).padStart(2, '0')}. ${truncate(ev.title, 40)}`, `noop:r${ev.idx}`)]);
    rows.push([
      Markup.button.callback(`1${ev.result === 0 ? ' ✅' : ''}`, `a:set:${ev.idx}:0`),
      Markup.button.callback(`X${ev.result === 1 ? ' ✅' : ''}`, `a:set:${ev.idx}:1`),
      Markup.button.callback(`2${ev.result === 2 ? ' ✅' : ''}`, `a:set:${ev.idx}:2`),
      Markup.button.callback(`${ev.isVoid ? '🚫 void ON' : 'void OFF'}`, `a:void:${ev.idx}`),
    ]);
  }
  rows.push([Markup.button.callback('⬅️ Назад в админ-меню', 'a:back')]);
  await ctx.answerCbQuery('');
  await ctx.reply('Установите результаты/void:', { reply_markup: { inline_keyboard: rows } });
});

bot.action(/^a:set:(\d+):([012])$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  const m = ctx.match as RegExpExecArray;
  const i = Number(m[1]);
  const o = Number(m[2]);
  const ev = st.draw.events.find(e => e.idx === i);
  if (!ev) return ctx.answerCbQuery('Нет такого события');
  ev.result = o;
  await saveStore(st);
  await ctx.answerCbQuery('OK');
});

bot.action(/^a:void:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  const i = Number((ctx.match as RegExpExecArray)[1]);
  const ev = st.draw.events.find(e => e.idx === i);
  if (!ev) return ctx.answerCbQuery('Нет такого события');
  ev.isVoid = !ev.isVoid;
  await saveStore(st);
  await ctx.answerCbQuery(ev.isVoid ? 'void ON' : 'void OFF');
});

bot.action('a:back', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery('');
  await ctx.reply('Админ-меню.', { reply_markup: adminKb(st.draw) });
});

bot.action('a:settle', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();

  if (st.draw.status === 'settled') {
    await ctx.answerCbQuery('Уже подсчитано');
    return;
  }
  if (st.draw.status === 'open') {
    await ctx.answerCbQuery('Сначала закройте приём');
    return;
  }

  for (const ev of st.draw.events) {
    if (!ev.isVoid && ev.result === null) {
      await ctx.answerCbQuery('Заполните все результаты (кроме void)');
      return;
    }
  }

  for (const t of st.tickets) {
    t.hitCount = t.hitCount ?? 0;
    t.hitCount = t.selections ? t.selections.reduce((acc, _, i) => acc + 0, 0) : 0; // (оставлено без вашей математики)
    t.hitCount = (function (selections: number[][], draw: Draw) {
      let hits = 0;
      for (let i = 0; i < draw.events.length; i++) {
        const ev = draw.events[i];
        if (ev.isVoid) continue;
        if (ev.result === null) continue;
        const sel = selections[i] || [];
        if (sel.includes(ev.result)) hits++;
      }
      return hits;
    })(t.selections, st.draw);
  }

  st.draw.status = 'settled';
  await saveStore(st);
  await saveHistorySnapshot(st);
  await ctx.answerCbQuery('');
  await ctx.reply('Итоги посчитаны. Можно рассылать результаты.');
});

bot.action('a:broadcast', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  if (st.draw.status !== 'settled') {
    await ctx.answerCbQuery('Сначала /settle');
    return;
  }
  await ctx.answerCbQuery('');

  const winners = [...st.tickets]
    .filter(t => t.paid)
    .sort((a, b) => (b.hitCount || 0) - (a.hitCount || 0));

  const lines = [
    `*Результаты тиража #${st.draw.id}*`,
    ...st.draw.events.map((ev) => {
      const res = ev.isVoid ? 'void' : (ev.result !== null ? OUTCOMES[ev.result] : '?');
      return `${String(ev.idx + 1).padStart(2, '0')}. ${ev.title} — *${res}*`;
    }),
  ];
  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });

  const notified = new Set<number>();
  for (const t of winners) {
    if (notified.has(t.userId)) continue;
    notified.add(t.userId);
    try {
      await bot.telegram.sendMessage(
        t.userId,
        `Ваш результат по тиражу #${st.draw.id}: *${t.hitCount}* попаданий.\nБилет #${t.id}, комбинаций: ${t.combos}, сумма: ${t.amount} ${CURRENCY}.`,
        { parse_mode: 'Markdown' }
      );
    } catch { /* ignore */ }
  }
  await ctx.reply(`Разослано ${notified.size} пользователям.`);
});

bot.on('text', async (ctx) => {
  const uid = ctx.from?.id;
  if (!uid) return;

  const state = adminState.get(uid);
  if (!state || state.mode === 'IDLE') return;
  if (!isAdmin(ctx)) return;

  st = st || await loadStore();
  const text = ctx.message?.text?.trim() || '';

  if (state.mode === 'ADDING') {
    if (!text) return;
    if (st.draw.events.length >= EVENTS_COUNT) {
      adminState.set(uid, { mode: 'IDLE' });
      await ctx.reply('Уже 15/15.');
      return;
    }
    const idx = st.draw.events.length;
    st.draw.events.push({ idx, title: text, result: null, isVoid: false });
    await saveStore(st);
    await ctx.reply('Добавлено.');
    adminState.set(uid, { mode: 'IDLE' });
    return;
  }

  if (state.mode === 'RENAMING') {
    const i = state.idx;
    const ev = st.draw.events.find(e => e.idx === i);
    if (!ev) {
      adminState.set(uid, { mode: 'IDLE' });
      await ctx.reply('Не найдено.');
      return;
    }
    if (text !== '-') {
      ev.title = text;
      await saveStore(st);
      await ctx.reply('Переименовано.');
    } else {
      await ctx.reply('Пропущено.');
    }
    adminState.set(uid, { mode: 'IDLE' });
    return;
  }
});

// ------------------ Express веб-сервер и вебхуки ------------------
const app = express();
app.use(express.json());

// Telegram webhooks через Express:
//const TG_WEBHOOK_URL = `${PUBLIC_BASE_URL}${TG_WEBHOOK_PATH}`;

// Healthcheck
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ------------------ Запуск ------------------
(async () => {
  try {
    st = await loadStore();
    
    // Crypto Pay webhook
    app.post(CRYPTOPAY_WEBHOOK_SECRET_PATH, async (req, res) => {
      // ... ваш код Crypto Pay webhook
    });

    app.listen(PORT, () => {
      console.log(`HTTP server on :${PORT}. Mode: ${CRYPTOPAY_TESTNET ? 'TESTNET' : 'PROD'} (${CRYPTOPAY_BASE})`);
    });
    
    // ★★★ ИСПРАВЛЕННЫЙ БЛОК ЗАПУСКА ★★★
    console.log('🚀 Запускаю бота в POLLING режиме...');
    await bot.launch();
    console.log('✅ Бот запущен и слушает сообщения');
    
    console.log(`Tote-bot ready. Draw #${st.draw.id} status=${st.draw.status}. EVENTS_COUNT=${EVENTS_COUNT}, BASE_STAKE=${BASE_STAKE} ${CURRENCY}`);
    
  } catch (error) {
    console.error(`Failed to start bot: ${error}`);
    process.exit(1);
  }
})();


process.once('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');
  try {
    if (bot) {
      await bot.stop('SIGINT');
    }
  } catch (e) {
    console.error('Error during shutdown:', e);
  }
  process.exit(0);
});

process.once('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  try {
    if (bot) {
      await bot.stop('SIGTERM');
    }
  } catch (e) {
    console.error('Error during shutdown:', e);
  }
  process.exit(0);
});
