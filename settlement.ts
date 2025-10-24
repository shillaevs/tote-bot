// settlement.ts — стратегии распределения призов (USDT/TON-агностично)
export type FormulaName = 'MAX_HITS_EQUAL_SHARE' | 'TIERED_WEIGHTS' | 'FIXED_TABLE';

export interface SettlementInput {
  drawId: string;
  totalBank: number;         // общая сумма банка (в валюте выплат)
  maxHitsInDraw: number;     // максимальное число совпадений по итогам
  hitsByUser: Array<{ userId: number; wallet: string; hits: number }>;
}

export interface Payout {
  userId: number;
  wallet: string;
  amount: number;            // сколько выплатить
  hits: number;
}

export interface SettlementResult {
  formulaName: FormulaName;
  formulaVersion: string;
  formulaParams: any;
  prizePool: number;
  payouts: Payout[];
  leftover: number;          // перенос/резерв
}

const FORMULA_VERSION = '1.0.0';

function toMinor(x: number, decimals = 6): bigint {
  // 1.234567 USDT -> 1234567n
  return BigInt(Math.round(x * Math.pow(10, decimals)));
}
function fromMinor(x: bigint, decimals = 6): number {
  return Number(x) / Math.pow(10, decimals);
}

// 1) Равные доли среди победителей с максимальным числом совпадений
function maxHitsEqualShare(input: SettlementInput, params: any): SettlementResult {
  const prizePoolPct = params?.prizePoolPct ?? 0.90;
  const prizePoolMinor = toMinor(input.totalBank * prizePoolPct);
  const winners = input.hitsByUser.filter(h => h.hits === input.maxHitsInDraw);

  if (winners.length === 0) {
    return {
      formulaName: 'MAX_HITS_EQUAL_SHARE',
      formulaVersion: FORMULA_VERSION,
      formulaParams: params,
      prizePool: fromMinor(prizePoolMinor),
      payouts: [],
      leftover: fromMinor(prizePoolMinor)
    };
  }

  const shareMinor = prizePoolMinor / BigInt(winners.length);
  const payouts: Payout[] = winners.map(w => ({
    userId: w.userId,
    wallet: w.wallet,
    hits: w.hits,
    amount: fromMinor(shareMinor)
  }));

  const distributedMinor = shareMinor * BigInt(winners.length);
  const leftoverMinor = prizePoolMinor - distributedMinor;

  return {
    formulaName: 'MAX_HITS_EQUAL_SHARE',
    formulaVersion: FORMULA_VERSION,
    formulaParams: params,
    prizePool: fromMinor(prizePoolMinor),
    payouts,
    leftover: fromMinor(leftoverMinor)
  };
}

// 2) Многоуровневое распределение по весам (15/14/13...)
// часть банка делим на "уровни" по весам; в каждом уровне — поровну между победителями уровня
function tieredWeights(input: SettlementInput, params: any): SettlementResult {
  const prizePoolPct = params?.prizePoolPct ?? 0.90;
  const weights: Record<string, number> = params?.weights ?? {"15":70,"14":20,"13":10};
  const minHits = params?.minHits ?? Math.min(...Object.keys(weights).map(k => +k));
  const prizePoolMinor = toMinor(input.totalBank * prizePoolPct);

  const levels = Object.keys(weights).map(n => +n).filter(h => h <= input.maxHitsInDraw && h >= minHits);
  const totalWeight = levels.reduce((s,h)=> s + (weights[h]?.valueOf() ?? 0), 0);
  if (totalWeight <= 0) {
    return {
      formulaName: 'TIERED_WEIGHTS',
      formulaVersion: FORMULA_VERSION,
      formulaParams: params,
      prizePool: fromMinor(prizePoolMinor),
      payouts: [],
      leftover: fromMinor(prizePoolMinor)
    };
  }

  let leftoverMinor = prizePoolMinor;
  const payouts: Payout[] = [];

  for (const h of levels) {
    const group = input.hitsByUser.filter(x => x.hits === h);
    if (group.length === 0) continue;

    const poolForLevelMinor = (prizePoolMinor * BigInt(Math.round((weights[h] / totalWeight) * 1e6))) / BigInt(1e6);
    const shareMinor = poolForLevelMinor / BigInt(group.length);
    for (const g of group) {
      payouts.push({
        userId: g.userId, wallet: g.wallet, hits: g.hits,
        amount: fromMinor(shareMinor)
      });
    }
    leftoverMinor -= shareMinor * BigInt(group.length);
  }

  return {
    formulaName: 'TIERED_WEIGHTS',
    formulaVersion: FORMULA_VERSION,
    formulaParams: params,
    prizePool: fromMinor(prizePoolMinor),
    payouts,
    leftover: fromMinor(leftoverMinor < 0n ? 0n : leftoverMinor)
  };
}

// 3) Фиксированная таблица призов (например, гарантии спонсора)
function fixedTable(input: SettlementInput, params: any): SettlementResult {
  const fixed: Record<string, number> = params?.fixed ?? {"15":10000,"14":1500,"13":250};
  let leftoverMinor = 0n;
  const payouts: Payout[] = [];

  for (const [hitsStr, prize] of Object.entries(fixed)) {
    const h = +hitsStr;
    if (h > input.maxHitsInDraw) continue;
    const group = input.hitsByUser.filter(x => x.hits === h);
    if (group.length === 0) {
      leftoverMinor += toMinor(prize);
      continue;
    }
    const perHeadMinor = toMinor(prize) / BigInt(group.length);
    for (const g of group) {
      payouts.push({
        userId: g.userId, wallet: g.wallet, hits: g.hits,
        amount: fromMinor(perHeadMinor)
      });
    }
    const distributedMinor = perHeadMinor * BigInt(group.length);
    leftoverMinor += toMinor(prize) - distributedMinor;
  }

  return {
    formulaName: 'FIXED_TABLE',
    formulaVersion: FORMULA_VERSION,
    formulaParams: params,
    prizePool: input.totalBank,
    payouts,
    leftover: fromMinor(leftoverMinor < 0n ? 0n : leftoverMinor)
  };
}

export function calculatePayouts(
  name: FormulaName,
  input: SettlementInput,
  params: any
): SettlementResult {
  switch (name) {
    case 'MAX_HITS_EQUAL_SHARE': return maxHitsEqualShare(input, params);
    case 'TIERED_WEIGHTS':       return tieredWeights(input, params);
    case 'FIXED_TABLE':          return fixedTable(input, params);
    default: throw new Error(`Unknown formula: ${name}`);
  }
}
