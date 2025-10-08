// bot.ts — тотализатор 15×3, некастодиальные платежи TON/USDT (jetton на TON)
// Требует ton.ts (initTon/isTonConfigured/getReceiveAddress/getAssetKind/checkTonPayment/checkJettonPayment/sendTon/sendJetton)

import * as dotenv from 'dotenv';
dotenv.config();

import { Telegraf, Context, Markup } from 'telegraf';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';

import {
  initTon,
  isTonConfigured,
  getReceiveAddress,
  getAssetKind,
  checkTonPayment,
  checkJettonPayment,
  sendTon,
  sendJetton,
} from './ton';

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

// Валюта банка и ставок: 'TON' или 'USDT_TON'
const CURRENCY = (process.env.CURRENCY || 'TON').toUpperCase(); // 'TON' | 'USDT_TON'
const BASE_STAKE = Number(process.env.BASE_STAKE || 0.5); // ставка за одну комбинацию в валюте CURRENCY

// Настройки распределения призов
const PRIZE_POOL_PCT = Math.min(Math.max(Number(process.env.PRIZE_POOL_PCT || 0.9), 0), 1); // доля банка, идущая в призы (0..1)
const TIER1_HITS = Number(process.env.TIER1_HITS || 15);
const TIER2_HITS = Number(process.env.TIER2_HITS || 14);
const TIER3_HITS = Number(process.env.TIER3_HITS || 13);
const TIER1_SHARE = Math.min(Math.max(Number(process.env.TIER1_SHARE || 0.6), 0), 1);
const TIER2_SHARE = Math.min(Math.max(Number(process.env.TIER2_SHARE || 0.25), 0), 1);
const TIER3_SHARE = Math.min(Math.max(Number(process.env.TIER3_SHARE || 0.15), 0), 1);

// Проверка, что суммы долей адекватны
const sumShares = TIER1_SHARE + TIER2_SHARE + TIER3_SHARE;
if (sumShares > 1 + 1e-9) {
  console.warn('WARNING: TIER shares sum > 1. Extra will be ignored.');
}

// ------------------ Типы ------------------
type DrawStatus = 'setup' | 'open' | 'closed' | 'settled';

interface Draw {
  id: number;
  status: DrawStatus;
  createdAt: string;
  events: EventItem[];
}

const OUTCOMES = ['1', 'X', '2'];

interface EventItem {
  idx: number;
  title: string;
  result: number | null;
  isVoid: boolean;
}

interface Ticket {
  id: string;
  userId: number;
  username?: string;
  selections: number[][];
  combos: number;
  amount: number;         // сумма к оплате (в валюте CURRENCY)
  paidAmount: number;     // зарезервировано под будущее
  createdAt: string;
  paid: boolean;
  hitCount?: number;
  paymentComment?: string; // "TICKET:<id>" — для TON-комментария и для USDT forward-payload (если провайдер сохраняет)
}

interface UserData {
  hasTicketForCurrent: boolean;
  payoutAddress?: string; // TON адрес для выплат (и TON, и USDT-jetton)
}

interface Store {
  draw: Draw;
  tickets: Ticket[];
  nextTicketSeq: number;
  users: { [userId: string]: UserData };
}

interface Session {
  selections: number[][];
}

// ------------------ ФС ------------------
const DATA_DIR = path.join(process.cwd(), 'data');
const HISTORY_DIR = path.join(process.cwd(), 'history');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(HISTORY_DIR, { recursive: true });
}

async function loadStore(): Promise<Store> {
  await ensureDirs();
  try {
    const raw = await fs.readFile(STORE_FILE, 'utf8');
    const data = JSON.parse(raw);

    if (!Array.isArray(data.tickets)) data.tickets = [];
    for (const t of data.tickets) {
      // мягкая миграция: удаляем следы инвойсов (если остались)
      delete (t as any).invoiceUrl;
      delete (t as any).invoiceId;
      if (!('paymentComment' in t) && t.id) t.paymentComment = `TICKET:${t.id}`;
      if (!('paid' in t)) t.paid = false;
    }
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

async function saveHistorySnapshot(data: Store, extra?: any) {
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
      hitCount: t.hitCount ?? 0,
    })),
    extra,
  };
  const fname = `draw-${data.draw.id}-${Date.now()}.json`;
  await fs.writeFile(path.join(HISTORY_DIR, fname), JSON.stringify(snapshot, null, 2));
}

// ------------------ Утилиты ------------------
function isAdmin(ctx: Context) {
  const uid = ctx.from?.id;
  return !!uid && ADMIN_IDS.includes(uid);
}

function combosCount(selections: number[][]) {
  return selections.reduce((acc, arr) => acc * Math.max(1, arr.length), 1);
}

function totalPrice(selections: number[][]) {
  return combosCount(selections) * BASE_STAKE;
}

function calcHash(str: string) {
  return createHash('sha256').update(str).digest('hex');
}

// ------------------ Бот и состояние ------------------
const bot = new Telegraf(BOT_TOKEN);
let st: Store;

// Сеансы (RAM)
const sessions = new Map<number, Session>();

function mainKb() {
  return {
    inline_keyboard: [
      [Markup.button.callback('🎫 Собрать билет', 'make')],
      [Markup.button.callback('📋 Мои билеты', 'my')],
    ],
  };
}

function eventRow(idx: number, sel: number[]) {
  return [
    Markup.button.callback(sel.includes(0) ? '✅ 1' : '1', `sel:${idx}:0`),
    Markup.button.callback(sel.includes(1) ? '✅ X' : 'X', `sel:${idx}:1`),
    Markup.button.callback(sel.includes(2) ? '✅ 2' : '2', `sel:${idx}:2`),
  ];
}

function makeTicketKb(s: Session) {
  const rows = [];
  for (let i = 0; i < EVENTS_COUNT; i++) {
    const sel = s.selections[i] || [];
    rows.push(eventRow(i, sel));
  }
  rows.push([Markup.button.callback('💾 Сохранить', 'save:ticket')]);
  return { inline_keyboard: rows };
}

// Заглушки событий
const placeholderEvents = Array.from({ length: EVENTS_COUNT }, (_, i) => ({
  idx: i,
  title: `Матч ${i + 1}: КомандаA — КомандаB`,
  result: null,
  isVoid: false,
}));

// ------------------ Команды ------------------
bot.start(async (ctx) => {
  st = st || await loadStore();
  await ctx.reply(
    `Добро пожаловать! Валюта: ${CURRENCY}. Соберите билет, оплатите и ждите результаты.`,
    { reply_markup: mainKb() }
  );
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    [
      'Команды:',
      '/help — помощь',
      '/wallet <TON-адрес> — указать адрес для выплат (TON/USDT на TON)',
      '/admin — админ-меню',
    ].join('\n')
  );
});

// /wallet — сохранить адрес для выплат
bot.command('wallet', async (ctx) => {
  const uid = ctx.from?.id;
  if (!uid) return;

  const text = (ctx.message as any)?.text || '';
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) {
    await ctx.reply('Формат:\n/wallet <TON-адрес>\n\nПример:\n/wallet EQC...');
    return;
  }
  const addr = parts[1];
  if (!/^E[QU][A-Za-z0-9_-]{46,}$/.test(addr)) {
    await ctx.reply('Похоже, это не TON-адрес. Проверь и пришли снова.');
    return;
  }

  st = st || await loadStore();
  const u = st.users[String(uid)] || { hasTicketForCurrent: false };
  u.payoutAddress = addr;
  st.users[String(uid)] = u;
  await saveStore(st);
  await ctx.reply('Адрес для выплат сохранён ✅');
});

// Админская одноразовая выплата: /payout <userId> <amount>
bot.command('payout', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const text = (ctx.message as any)?.text || '';
  const m = text.match(/\/payout\s+(\d+)\s+([0-9]+(?:\.[0-9]+)?)/);
  if (!m) {
    await ctx.reply('Формат: /payout <userId> <amount>\nНапример: /payout 123456789 12.5');
    return;
  }
  const userId = Number(m[1]);
  const amount = Number(m[2]);
  st = st || await loadStore();
  const addr = st.users?.[String(userId)]?.payoutAddress;
  if (!addr) {
    await ctx.reply('У пользователя не указан адрес /wallet');
    return;
  }
  try {
    if (CURRENCY === 'TON') {
      const res = await sendTon({ toAddress: addr, amountTon: amount, comment: `Prize draw #${st.draw.id}` });
      await ctx.reply(`Выплата TON отправлена. userId=${userId}, amount=${amount}\nTx: ${res.txHash || ''}`);
    } else {
      const res = await sendJetton({ toAddress: addr, amountTokens: amount, comment: `Prize draw #${st.draw.id}` });
      await ctx.reply(`Выплата USDT отправлена. userId=${userId}, amount=${amount}\nTx: ${res.txHash || ''}`);
    }
    try { await bot.telegram.sendMessage(userId, `Вам выплачено ${amount} ${CURRENCY} за тираж #${st.draw.id}.`); } catch {}
  } catch (e) {
    console.error('payout error', e);
    await ctx.reply('Ошибка выплаты');
  }
});

// ------------------ Админка ------------------
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
    [Markup.button.callback('💰 Распределить банк + выплатить', 'a:auto_payout')], // NEW
    [Markup.button.callback('📣 Разослать результаты', 'a:broadcast')],
    [Markup.button.callback('📜 Показать список', 'a:list')],
  ];
  return { inline_keyboard: rows };
}

bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  adminState.set(ctx.from!.id, { mode: 'IDLE' });
  await ctx.reply(
    `Админ-меню. Тираж #${st.draw.id}, статус: ${st.draw.status}.
Ставка: ${BASE_STAKE} ${CURRENCY}, событий: ${EVENTS_COUNT}`,
    { reply_markup: adminKb(st.draw) }
  );
});

const adminState = new Map<number, { mode: 'IDLE' | 'RENAME'; evIdx?: number }>();

bot.action('a:add', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  const evIdx = st.draw.events.length;
  if (evIdx >= EVENTS_COUNT) {
    await ctx.answerCbQuery('Уже достаточно событий');
    return;
  }
  st.draw.events.push({ idx: evIdx, title: `Матч ${evIdx + 1}: КомандаA — КомандаB`, result: null, isVoid: false });
  await saveStore(st);
  await ctx.answerCbQuery('Событие добавлено');
});

bot.action('a:rename', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  adminState.set(ctx.from!.id, { mode: 'RENAME', evIdx: 0 });
  await ctx.answerCbQuery('Пришлите: номер события и новое имя через точку.\nПример: 1. Реал — Барса');
});

bot.action('a:open', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  st.draw.status = 'open';
  if (st.draw.events.length === 0) {
    st.draw.events = placeholderEvents.map(e => ({ ...e }));
  }
  await saveStore(st);
  await ctx.answerCbQuery('Приём открыт');
});

bot.action('a:close', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  st.draw.status = 'closed';
  await saveStore(st);
  await ctx.answerCbQuery('Приём закрыт');
});

bot.action('a:results', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  const rows = st.draw.events.map((ev) => {
    const res = ev.isVoid ? 'void' : (ev.result !== null ? OUTCOMES[ev.result] : '?');
    return [Markup.button.callback(`${String(ev.idx + 1).padStart(2, '0')} ${res}`, `r:${ev.idx}`)];
  });
  rows.push([Markup.button.callback('⬅️ Назад', 'a:back')]);
  await ctx.editMessageText('Выставьте результаты (повторное нажатие — toggle void).', {
    reply_markup: { inline_keyboard: rows },
  });
});

bot.action(/^r:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  const ev = st.draw.events[Number(ctx.match[1])];
  if (!ev) {
    await ctx.answerCbQuery('Нет такого события');
    return;
  }
  if (ev.isVoid) {
    ev.isVoid = false;
    ev.result = (ev.result === null ? 0 : (ev.result + 1) % 3);
  } else {
    ev.result = (ev.result === null ? 0 : (ev.result + 1) % 3);
    if (ev.result === 0) ev.isVoid = true;
  }
  await saveStore(st);
  await ctx.answerCbQuery('OK');
});

bot.action('a:back', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  await ctx.editMessageText(
    `Админ-меню. Тираж #${st.draw.id}, статус: ${st.draw.status}.`,
    { reply_markup: adminKb(st.draw) }
  );
});

// ------------------ Пользовательские кнопки ------------------
bot.action('make', async (ctx) => {
  st = st || await loadStore();
  if (st.draw.status === 'setup') {
    st.draw.events = placeholderEvents.map(e => ({ ...e }));
    st.draw.status = 'open';
    await saveStore(st);
  }
  sessions.set(ctx.from!.id, { selections: Array.from({ length: EVENTS_COUNT }, () => []) });
  await ctx.editMessageText(
    'Отметьте исходы (1/X/2) по каждому событию, затем нажмите «Сохранить».',
    { reply_markup: makeTicketKb(sessions.get(ctx.from!.id)!) }
  );
});

bot.action(/^sel:(\d+):(\d+)$/, async (ctx) => {
  const idx = Number(ctx.match[1]);
  const out = Number(ctx.match[2]);
  const sess = sessions.get(ctx.from!.id);
  if (!sess) return;

  const a = new Set(sess.selections[idx] || []);
  if (a.has(out)) a.delete(out); else a.add(out);
  sess.selections[idx] = Array.from(a).sort();
  await ctx.editMessageReplyMarkup(makeTicketKb(sess));
});

// ------------------ Сохранение билета + оплата ------------------
bot.action('save:ticket', async (ctx) => {
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
      paid: false,
      paymentComment: `TICKET:${ticketId}`,
    };

    if (!isTonConfigured()) {
      await ctx.reply('Платёжная часть TON не настроена. Обратитесь к администратору.');
      return;
    }

    const receiveAddr = getReceiveAddress(); // для TON это адрес-кошелек, для USDT это base owner (выплата) — см. пояснение ниже
    const assetKind = getAssetKind(); // 'TON' | 'USDT_TON'

    const instructions = assetKind === 'TON'
      ? [
          'Оплатите билет некастодиально в *TON*:',
          '',
          `1) Откройте свой TON-кошелёк (Tonkeeper / MyTonWallet).`,
          `2) Отправьте *ровно* ${amount} TON на адрес:`,
          '`' + receiveAddr + '`',
          `3) В *комментарии* укажите: \`${ticket.paymentComment}\``,
          '',
          'После перевода нажмите кнопку ниже «Проверить платёж».',
        ]
      : [
          'Оплатите билет некастодиально в *USDT (jetton на TON)*:',
          '',
          `1) В кошельке (Tonkeeper/MyTonWallet) переведите *ровно* ${amount} USDT (TON) на *ваш* USDT-jetton wallet, принадлежащий адресу приёма.`,
          `   Адрес базового кошелька приёма:`,
          '`' + receiveAddr + '`',
          '   (кошелёк jetton будет вычислен автоматически; большинство кошельков подставляют его сами).',
          `2) В *комментарии/forward payload* укажите: \`${ticket.paymentComment}\`.`,
          '',
          'После перевода нажмите кнопку ниже «Проверить платёж».',
          '',
          '_Примечание: некоторые RPC провайдеры могут не передавать forward-payload. В таком случае мы учитываем только точное совпадение суммы._',
        ];

    await ctx.reply(instructions.join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[ Markup.button.callback('🔄 Проверить платёж', `pay:check:${ticket.id}`) ]] }
    });

    if (!st.users) st.users = {};
    st.tickets.push(ticket);
    st.users[uid.toString()] = { hasTicketForCurrent: true };
    await saveStore(st);

    await ctx.answerCbQuery('Билет создан!');
    await ctx.reply(
      `Билет *#${ticket.id}* создан.\nКомбинаций: *${combos}*\nСумма: *${amount} ${CURRENCY}*\nСтатус: *ожидает оплаты*`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error(`Error in save:ticket for user ${ctx.from?.id}:`, e);
    await ctx.answerCbQuery('Ошибка при сохранении билета');
  }
});

// Проверка платежа (TON или USDT_TON)
bot.action(/^pay:check:(.+)$/, async (ctx) => {
  try {
    const uid = ctx.from?.id;
    if (!uid) return;

    const ticketId = ctx.match[1];
    st = st || await loadStore();
    const t = st.tickets.find(x => x.id === ticketId && x.userId === uid);
    if (!t) {
      await ctx.answerCbQuery('Билет не найден');
      return;
    }
    if (t.paid) {
      await ctx.answerCbQuery('Уже оплачено ✅');
      return;
    }
    if (!isTonConfigured()) {
      await ctx.answerCbQuery('TON не настроен');
      return;
    }

    const assetKind = getAssetKind();
    let found = false;

    if (assetKind === 'TON') {
      const res = await checkTonPayment({
        toAddress: getReceiveAddress(),
        expectedAmountTon: t.amount,
        comment: t.paymentComment || `TICKET:${t.id}`,
      });
      found = res.found;
    } else {
      const res = await checkJettonPayment({
        ownerBaseAddress: getReceiveAddress(),
        expectedAmountTokens: t.amount,
        comment: t.paymentComment || `TICKET:${t.id}`,
      });
      found = res.found;
    }

    if (found) {
      t.paid = true;
      await saveStore(st);
      await ctx.answerCbQuery('Платёж найден ✅');
      await ctx.editMessageReplyMarkup(undefined);
      await ctx.reply(`Билет #${t.id} оплачен. Удачи!`);
    } else {
      await ctx.answerCbQuery('Платёж пока не найден. Повторите через минуту.');
    }
  } catch (e) {
    console.error('pay check error:', e);
    await ctx.answerCbQuery('Ошибка проверки');
  }
});

// ------------------ Списки, settle, рассылка ------------------
bot.action('my', async (ctx) => {
  st = st || await loadStore();
  const uid = ctx.from!.id;
  const mine = st.tickets.filter(t => t.userId === uid).slice(-10);
  if (!mine.length) {
    await ctx.answerCbQuery('');
    await ctx.reply('У вас нет билетов.');
    return;
  }
  await ctx.answerCbQuery('');
  const lines = mine.map(t => {
    const paid = t.paid ? '✅' : '⌛';
    return `#${t.id} — ${t.combos} комб., ${t.amount} ${CURRENCY}, оплачено: ${paid}`;
  });
  await ctx.reply(lines.join('\n'));
});

bot.action('a:list', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  const lines = st.tickets.map(t => {
    const paid = t.paid ? '✅' : '⌛';
    return `#${t.id} | u:${t.userId} | ${t.combos} | ${t.amount} ${CURRENCY} | ${paid}`;
  });
  await ctx.answerCbQuery('');
  await ctx.reply(lines.slice(-50).join('\n') || 'Пусто');
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

  // Подсчёт попаданий
  for (const t of st.tickets) {
    t.hitCount = (function calcHits(selections: number[][], draw: Draw) {
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
  await ctx.reply('Итоги посчитаны. Теперь можно «Распределить банк + выплатить».');
});

// ---------- АВТО-РАСПРЕДЕЛЕНИЕ БАНКА + МАССОВЫЕ ВЫПЛАТЫ ----------
bot.action('a:auto_payout', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();

  if (st.draw.status !== 'settled') {
    await ctx.answerCbQuery('Сначала подсчитайте итоги (settle)');
    return;
  }

  // Банк = сумма оплаченных билетов
  const paidTickets = st.tickets.filter(t => t.paid);
  const totalBank = paidTickets.reduce((s, t) => s + t.amount, 0);
  const prizePool = totalBank * PRIZE_POOL_PCT;
  const house = totalBank - prizePool;

  // Собираем победителей по тиру
  const tiers = [
    { hits: TIER1_HITS, share: TIER1_SHARE, winners: [] as Ticket[] },
    { hits: TIER2_HITS, share: TIER2_SHARE, winners: [] as Ticket[] },
    { hits: TIER3_HITS, share: TIER3_SHARE, winners: [] as Ticket[] },
  ];

  for (const t of paidTickets) {
    for (const tr of tiers) {
      if ((t.hitCount || 0) === tr.hits) tr.winners.push(t);
    }
  }

  // Перераспределение: если в тиру нет победителей — share уходит ниже, к первому тиру, где есть победители
  let remaining = prizePool;
  const tierPools: number[] = [0, 0, 0];

  // 1) предварительно назначим по долям
  const pre = tiers.map(tr => tr.share * prizePool);
  // 2) если в тиру нет победителей — копим нераспределённый остаток
  let carry = 0;
  for (let i = 0; i < tiers.length; i++) {
    if (tiers[i].winners.length > 0) {
      tierPools[i] = pre[i];
    } else {
      carry += pre[i];
    }
  }
  // 3) раздать carry в порядке приоритета первым тирами, где есть победители
  if (carry > 0) {
    for (let i = 0; i < tiers.length; i++) {
      if (tiers[i].winners.length > 0) {
        tierPools[i] += carry;
        carry = 0;
        break;
      }
    }
  }
  remaining = tierPools.reduce((s, x) => s + x, 0);

  // Выплаты: равными долями в рамках тира
  const assetKind = getAssetKind();
  const results: string[] = [];
  for (let i = 0; i < tiers.length; i++) {
    const tr = tiers[i];
    const pool = tierPools[i];
    if (pool <= 0 || tr.winners.length === 0) {
      results.push(`Тир ${tr.hits}: победителей нет (пул 0).`);
      continue;
    }
    const perWinner = pool / tr.winners.length;

    results.push(`Тир ${tr.hits}: ${tr.winners.length} победителей, пул ${pool.toFixed(6)} ${CURRENCY}, по ${perWinner.toFixed(6)}.`);

    // Массовая отправка
    for (const t of tr.winners) {
      const userId = t.userId;
      const addr = st.users?.[String(userId)]?.payoutAddress;
      if (!addr) {
        try { await bot.telegram.sendMessage(userId, `Вы выиграли ${perWinner.toFixed(6)} ${CURRENCY}, но не указан адрес /wallet.`); } catch {}
        results.push(` - user ${userId}: нет /wallet`);
        continue;
      }
      try {
        if (assetKind === 'TON') {
          const res = await sendTon({ toAddress: addr, amountTon: perWinner, comment: `Prize draw #${st.draw.id} (${tr.hits} hits)` });
          results.push(` - user ${userId}: выплатил TON ${perWinner.toFixed(6)} (tx ${res.txHash || ''})`);
        } else {
          const res = await sendJetton({ toAddress: addr, amountTokens: perWinner, comment: `Prize draw #${st.draw.id} (${tr.hits} hits)` });
          results.push(` - user ${userId}: выплатил USDT ${perWinner.toFixed(6)} (tx ${res.txHash || ''})`);
        }
        try { await bot.telegram.sendMessage(userId, `Поздравляем! Выплата ${perWinner.toFixed(6)} ${CURRENCY} за тираж #${st.draw.id}.`); } catch {}
      } catch (e) {
        console.error('mass payout error', e);
        results.push(` - user ${userId}: ERROR отправки`);
      }
    }
  }

  await saveHistorySnapshot(st, {
    prizePool,
    house,
    tierPools,
    totals: { totalBank, prizePool, house, currency: CURRENCY }
  });

  await ctx.answerCbQuery('Готово');
  await ctx.reply(
    [
      `*Авто-распределение и выплаты по тиражу #${st.draw.id}*`,
      `Банк (оплаченные билеты): ${totalBank.toFixed(6)} ${CURRENCY}`,
      `Фонд призов (${(PRIZE_POOL_PCT * 100).toFixed(1)}%): ${prizePool.toFixed(6)} ${CURRENCY}`,
      `Орг. часть: ${house.toFixed(6)} ${CURRENCY}`,
      '',
      ...results,
    ].join('\n'),
    { parse_mode: 'Markdown' }
  );
});

// Рассылка результатов (инфо)
bot.action('a:broadcast', async (ctx) => {
  if (!isAdmin(ctx)) return;
  st = st || await loadStore();
  if (st.draw.status !== 'settled') {
    await ctx.answerCbQuery('Сначала подсчитайте /settle');
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
        `Ваш результат по тиражу #${st.draw.id}: *${t.hitCount}*.\nБилет #${t.id}, комбинаций: ${t.combos}, сумма: ${t.amount} ${CURRENCY}.`,
        { parse_mode: 'Markdown' }
      );
    } catch { /* ignore */ }
  }
  await ctx.reply(`Разослано ${notified.size} пользователям.`);
});

// Переименование события (админ, текстом)
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
      await ctx.reply('Формат: номер. новое имя\nПример: 2. Милан — Интер');
      return;
    }
    const idx = Number(m[1]) - 1;
    const name = m[2];
    st = st || await loadStore();
    const ev = st.draw.events[idx];
    if (!ev) {
      await ctx.reply('Нет такого события');
      return;
    }
    ev.title = name;
    await saveStore(st);
    adminState.set(uid, { mode: 'IDLE' });
    await ctx.reply('Ок', { reply_markup: adminKb(st.draw) });
  }
});

// ------------------ Запуск ------------------
(async () => {
  try {
    st = await loadStore();

    // Инициализация TON (если настроен)
    try {
      if (isTonConfigured()) {
        await initTon();
        console.log('TON initialized');
      } else {
        console.log('TON not configured');
      }
    } catch (e) {
      console.error('TON init error', e);
    }

    console.log('🚀 Запускаю бота в POLLING режиме...');
    await bot.launch();
    console.log(
      `✅ Бот запущен. Draw #${st.draw.id} status=${st.draw.status}, EVENTS_COUNT=${EVENTS_COUNT}, BASE_STAKE=${BASE_STAKE} ${CURRENCY}`
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
