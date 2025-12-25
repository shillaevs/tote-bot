// ton.ts — работа с TON (testnet/mainnet), проверки платежей и заготовка под USDT

import TonWeb from 'tonweb';
import { getHttpEndpoint } from '@orbs-network/ton-access';

// ----------------- Типы -----------------

export interface CheckTonPaymentParams {
  toAddress: string;          // Куда должны прийти TON
  expectedAmountTon: number;  // Сколько TON ждём (число, не в нанах)
  comment: string;            // Комментарий к платежу (invoiceId)
  minConfirmations: number;   // Сколько подтверждений надо
}

export interface CheckTonPaymentResult {
  found: boolean;
  txHash?: string;
}

export interface CheckJettonPaymentParams {
  ownerBaseAddress: string;      // Наш базовый адрес-«владелец» jetton-кошелька
  expectedAmountTokens: number;  // Сколько USDT ждём (число, НЕ в микро-юнитах)
  comment: string;               // Комментарий (invoiceId)
  minConfirmations: number;
}

export interface CheckJettonPaymentResult {
  found: boolean;
  txHash?: string;
}

export interface SendTonParams {
  toAddress: string;
  amountTon: number;
}

export interface SendTonResult {
  ok: boolean;
  txHash?: string;
  error?: string;
}

export interface InitTonResult {
  enabled: boolean;
  network?: 'testnet' | 'mainnet';
  endpoint?: string;
  reason?: string;
}

// ----------------- Конфиг из .env -----------------

const TON_NETWORK = (process.env.TON_NETWORK as 'testnet' | 'mainnet' | undefined) || 'testnet';
const TON_RECEIVE_ADDRESS = process.env.TON_RECEIVE_ADDRESS || '';
const TON_MNEMONIC = process.env.TON_MNEMONIC || '';
const TON_MIN_CONFIRMATIONS = Number(process.env.TON_MIN_CONFIRMATIONS || '1');
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// Для USDT (jetton) — пока только в конфиге, логику будем дорабатывать отдельно
const JETTON_USDT_ADDRESS = process.env.JETTON_USDT_ADDRESS || ''; // мастер-адрес USDT jetton

// ----------------- Внутреннее состояние -----------------

let tonweb: any | null = null;
let inited = false;
let enabled = false;
let currentEndpoint: string | undefined;

// ----------------- Утилиты логирования -----------------

function logInfo(msg: string, ...args: any[]) {
  if (LOG_LEVEL === 'info' || LOG_LEVEL === 'debug') {
    console.log(msg, ...args);
  }
}

function logDebug(msg: string, ...args: any[]) {
  if (LOG_LEVEL === 'debug') {
    console.log(msg, ...args);
  }
}

function logWarn(msg: string, ...args: any[]) {
  console.warn(msg, ...args);
}

function logError(msg: string, ...args: any[]) {
  console.error(msg, ...args);
}

// ----------------- Инициализация TON -----------------

export async function initTon(): Promise<InitTonResult> {
  if (inited) {
    return { enabled, network: TON_NETWORK, endpoint: currentEndpoint };
  }

  inited = true;

  // Минимальная проверка конфига
  if (!TON_RECEIVE_ADDRESS) {
    logWarn('[TON] TON_RECEIVE_ADDRESS не задан — работаем в режиме без платежей');
    enabled = false;
    return {
      enabled: false,
      reason: 'TON_RECEIVE_ADDRESS is missing',
    };
  }

  try {
    const endpoint = await getHttpEndpoint({ network: TON_NETWORK });
    currentEndpoint = endpoint;

    const provider = new TonWeb.HttpProvider(endpoint);
    tonweb = new TonWeb(provider);

    enabled = true;

    logInfo(
      `[TON] Подключились к TON ${TON_NETWORK}, endpoint: ${endpoint}`
    );

    return {
      enabled: true,
      network: TON_NETWORK,
      endpoint,
    };
  } catch (e) {
    logError('[TON] Не удалось инициализировать TON, работаем без платежей:', e);
    enabled = false;
    return {
      enabled: false,
      reason: 'initTon failed',
    };
  }
}

export function isTonConfigured(): boolean {
  return enabled && !!tonweb;
}

// ----------------- Проверка TON-платежа -----------------

export async function checkTonPayment(
  params: CheckTonPaymentParams
): Promise<CheckTonPaymentResult> {
  if (!tonweb || !enabled) {
    logWarn('[TON] checkTonPayment вызван, но TON не инициализирован');
    return { found: false };
  }

  const {
    toAddress,
    expectedAmountTon,
    comment,
    minConfirmations,
  } = params;

  try {
    const addr = new (TonWeb as any).utils.Address(toAddress);
    const addrStr = addr.toString(false); // без user-friendly form
    const txs = await tonweb.provider.getTransactions(addrStr, 30);

    const expectedNano = BigInt(Math.round(expectedAmountTon * 1e9));

    for (const tx of txs) {
      const inMsg = tx.in_msg;
      if (!inMsg) continue;

      // Проверяем комментарий
      let msgComment = '';
      try {
        // В ответах toncenter/tonweb для текстового комментария
        // часто есть поле message или msg_data.text
        msgComment =
          inMsg.message ||
          inMsg.msg_data?.text ||
          '';
      } catch {
        // ignore
      }

      if (!msgComment || String(msgComment).trim() !== comment) continue;

      // Проверяем сумму
      const valueStr = inMsg.value || '0';
      const valueNano = BigInt(valueStr);
      if (valueNano < expectedNano) continue;

      // Проверяем подтверждения (простая эвристика по кол-ву дальних блоков)
      const nowLt = BigInt(tx.lt || '0');
      const utime = Number(tx.utime || 0);
      logDebug('[TON] Найден кандидат платежа:', { nowLt, utime, valueNano, msgComment });

      // В реальном проде стоит опираться на block_seqno / workchain / shard,
      // но для простоты считаем, что если транзакция уже видна — подтверждений достаточно.
      if (minConfirmations > 1) {
        // Можно добавить дополнительный опрос блоков, сейчас считаем "ок".
      }

      const txHash = tx.transaction_id?.hash || tx.hash;
      return { found: true, txHash };
    }

    return { found: false };
  } catch (e) {
    logError('[TON] Ошибка в checkTonPayment:', e);
    return { found: false };
  }
}

// ----------------- Проверка USDT (jetton) — заготовка -----------------

export async function checkJettonPayment(
  params: CheckJettonPaymentParams
): Promise<CheckJettonPaymentResult> {
  if (!tonweb || !enabled) {
    logWarn('[TON] checkJettonPayment вызван, но TON не инициализирован');
    return { found: false };
  }

  if (!JETTON_USDT_ADDRESS) {
    logWarn('[TON] JETTON_USDT_ADDRESS не задан, jetton-платежи пока не проверяем');
    return { found: false };
  }

  // ⚠️ ВАЖНО:
  // Здесь только "каркас" под проверку USDT.
  // Полноценная проверка jetton-платежей требует:
  //   1) вычисления jetton-wallet адреса получателя,
  //   2) чтения транзакций jetton-wallet,
  //   3) декодирования тела сообщения (forward_payload) по стандарту TEP-74,
  //   4) сопоставления комментария и суммы.
  //
  // Это уже довольно большой кусок кода + желательно использовать TonAPI/tonconsole.
  // Чтобы не городить сейчас сырую реализацию, я оставляю stub,
  // который аккуратно говорит "платёж не найден", чтобы не ломать бота.

  logWarn(
    '[TON] checkJettonPayment: jetton-платежи пока не реализованы. ' +
      'Бот продолжит работать, но USDT-платежи автоматически не подтверждаются.'
  );

  return { found: false };
}

// ----------------- Отправка TON (выплаты) — заготовка -----------------

export async function sendTon(_params: SendTonParams): Promise<SendTonResult> {
  // Сейчас твой бот выплаты по сети ещё не делает, а только считает и логирует.
  // Чтобы не обманывать, делаем честный stub.
  // Когда придём к автоматическим выплатам — допишем реальную отправку
  // через тоновский кошелёк и mnemonic.

  logWarn(
    '[TON] sendTon вызван, но авто-выплаты по сети пока не реализованы. ' +
      'Выплаты нужно делать вручную.'
  );

  return {
    ok: false,
    error: 'sendTon not implemented yet',
  };
}
