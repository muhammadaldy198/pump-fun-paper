// PaperSprint — a two-look age-judged pump.fun paper trader for the
// Pump.fun Paper Sprint (6h final window, 10 SOL paper, pumpfun-replay/v2).
//
// How it trades, in one paragraph: most pump.fun coins die within minutes,
// but the few that keep attracting real buyers sometimes run hard. This bot
// never chases a coin at birth. It watches every new bonding curve and
// judges it twice — once at `firstLook` slots old and once more at
// `secondLook` for slow starters — and only opens a small probe when the
// coin still looks alive at a check: real SOL reserves above a floor, enough
// distinct non-creator buyers, enough net buying over a recent window, and a
// price multiple inside a band above its creation price. A signal must hold
// for two consecutive batches before the bot acts on it (sequential
// confirmation), because a single-slot spike is noise. Winners are fed with
// small adds only on fresh highs while reserves keep growing, and every
// position is defended by staged profit banks, a hard stop, a trailing
// give-back exit, a reserve-collapse exit, and a staleness / maximum-hold
// clock.
//
// A second, scout tier buys breadth: the strict tier alone trades too few
// coins to clear the 20-coin guardrail in a slow 6-hour window, so coins
// that fail both main looks get a tiny probe at a loose bar, with fast
// exits and no adds. A scout costs little when it loses and counts toward
// the guardrail when it trades.
//
// A third layer — ownership gates — is what no other bot on the board has:
// the bot rebuilds each coin's holder table from the trade tape and refuses
// bundled or concentrated coins outright (see the veto checks in the
// judgement path). Undecided means skip: a coin whose tape is too thin to
// judge is never bought.
//
// Everything here is deterministic: no clock, no environment, no
// randomness. All money arithmetic is integer (bigint lamports) so the two
// grading runs agree exactly. Prices are virtual-quote-per-virtual-token,
// scaled by 1_000_000.
//
// The tunables live in DEFAULT_PARAMS below; createStrategy() takes
// overrides so offline sweeps can move them without touching the logic.

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
} from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;
const SCALE = 1_000_000n; // price scale: quote lamports per token, scaled

export interface BotParams {
  // Main tier: entry.
  probe: number; // first buy, SOL
  addSize: number; // each add on a fresh high, SOL
  maxPerCoin: number; // total per coin, SOL
  maxAddMult: number; // never add above this multiple of create price
  firstLook: number; // slots after creation: first judgement
  secondLook: number; // slots after creation: second judgement
  minRealSol: number; // real SOL reserves at a check
  minBuyers: number; // distinct non-creator buyers seen by a check
  minNetFlow: number; // net buys minus sells over the flow window, SOL
  flowSpan: number; // slots of history the flow window covers
  lowMult: number; // lowest entry multiple of create price
  highMult: number; // highest entry multiple of create price
  // Main tier: exits.
  bankAt1: number; // bank bankFrac1 of tokens at this value multiple
  bankFrac1: number; // percent of tokens banked at bankAt1
  bankAt2: number; // bank bankFrac2 of the rest at this value multiple
  bankFrac2: number; // percent of remaining tokens banked at bankAt2
  stopAt: number; // hard stop: value under this multiple of cost
  trailArm: number; // trailing arms once value reaches this multiple
  trailKeep: number; // exit once value falls to this share of its peak
  collapseAt: number; // exit if reserves fall under this share of peak
  staleAfter: number; // exit if no fresh high for this long (slots)
  holdMax: number; // exit no matter what after this long (slots)
  // Scout tier: cheap breadth insurance.
  scoutProbe: number; // 0.015 SOL: above the 0.01 SOL round-trip bar
  scoutRealSol: number;
  scoutBuyers: number;
  scoutFlow: number;
  scoutLowMult: number;
  scoutHighMult: number;
  scoutSecondLook: number; // slots: second scout look
  scoutStop: number;
  scoutTrailArm: number;
  scoutTrailKeep: number;
  scoutBankAt: number;
  scoutBankFrac: number;
  scoutStale: number;
  scoutHoldMax: number;
  scoutCollapse: number;
  // Ownership gates (0 = gate off, for ablation).
  vetoBundle: boolean; // refuse bundled launches
  vetoConcentration: boolean; // refuse concentrated holders
  vetoCreator: boolean; // refuse creator-sold / serial-launcher coins
  cohortExit: boolean; // exit when a cohort member fully exits
  // Order hygiene.
  buySlippageBps: number;
  sellSlippageBps: number;
  maxExposureSol: number; // cap on total lamports invested at once
}

export const DEFAULT_PARAMS: BotParams = {
  probe: 0.03,
  addSize: 0.12,
  maxPerCoin: 0.6,
  maxAddMult: 6,
  firstLook: 35,
  secondLook: 60,
  // EVIDENCE (judge-bar sweep, 27 combos, mean over 4 fail keys): rq >= 20
  // dominates rq 14 (mean +1.17 vs +0.23, worst +0.92 vs -0.08, wins in
  // BOTH halves, ex-best-2 still positive). The buyer bar is never binding
  // (coins passing rq >= 20 already have 20+ buyers) and flow 3 beats 2/5.
  minRealSol: 20,
  minBuyers: 14,
  minNetFlow: 3,
  flowSpan: 25,
  lowMult: 1.5,
  highMult: 9,
  // EVIDENCE (payoff sweep, 24 combos, mean over 4 fail keys): bankAt1 1.5
  // beats 1.8/2.0 (mean +1.24, worst +1.07, both halves positive); stopAt
  // 0.82 crushes 0.90 (+1.24 vs +0.28 — the tighter stop cuts runners);
  // maxPerCoin 0.6 crushes 0.3 (+1.24 vs +0.15 — the adds are the edge).
  bankAt1: 1.5,
  bankFrac1: 60,
  bankAt2: 3.5,
  bankFrac2: 50,
  stopAt: 0.82,
  // EVIDENCE (trail sweep, 27 combos): trailArm 1.5 beats 1.2/1.35 (mean
  // +1.41 vs +1.37 — arming later lets winners run longer); trailKeep 0.7
  // and 0.8 identical at arm 1.5, keep 0.8. bankAt2 is a no-op in practice
  // (no position reaches 2x after banking at 1.5x) — left at 3.5.
  trailArm: 1.5,
  trailKeep: 0.8,
  collapseAt: 0.45,
  staleAfter: 300,
  holdMax: 600,
  scoutProbe: 0.015,
  scoutRealSol: 6,
  scoutBuyers: 6,
  scoutFlow: 1,
  scoutLowMult: 1.1,
  scoutHighMult: 15,
  scoutSecondLook: 120,
  scoutStop: 0.9,
  scoutTrailArm: 1.25,
  scoutTrailKeep: 0.8,
  scoutBankAt: 1.5,
  scoutBankFrac: 50,
  scoutStale: 150,
  scoutHoldMax: 300,
  scoutCollapse: 0.5,
  vetoBundle: true,
  vetoConcentration: true,
  // EVIDENCE (ablation, dev window, single draw): the creator veto alone
  // turns +0.91 into -0.17 (it removes winners — creator selling early is
  // profit-taking, not a death signal at our entry horizon), and the cohort
  // exit alone turns +0.91 into -0.34 (early buyers selling into strength
  // is normal; exiting on it cuts runners short). Both default OFF.
  vetoCreator: false,
  cohortExit: false,
  buySlippageBps: 2000,
  sellSlippageBps: 10000,
  maxExposureSol: 3.0,
};

// ------------------------------------------------------------------ per-coin record

interface Watched {
  mint: string;
  born: number; // slot of its CreateEvent
  birthPrice: bigint; // scaled price at creation (0n when unknown)
  supply: bigint; // token_total_supply from CreateEvent
  creator: string;
  buyers: Set<string>; // distinct non-creator buyers (buy trades only)
  tape: { slot: number; buy: boolean; sol: bigint }[]; // recent trades, pruned to the flow window
  // Holder table, rebuilt from the tape: net token balance per wallet.
  holders: Map<string, bigint>;
  creatorSold: boolean;
  // Bundle evidence: buyers and token volume in the earliest slots.
  slot0Buyers: Set<string>;
  slot0Tokens: bigint; // tokens bought in the create slot
  earlyBuyers: Set<string>; // distinct buyers in the first 3 slots
  // Judgement state.
  look1: boolean;
  look2: boolean;
  done: boolean; // judged and rejected, or entered — never judge again
  confirmMain: number; // slot where the main bar first passed (-1 = none)
  confirmScout: number; // slot where the scout bar first passed (-1 = none)
  scoutLook1: boolean;
  scoutLook2: boolean;
  // Position state, live only while a position is held.
  peakPrice: bigint;
  peakRq: bigint;
  peakWorth: bigint;
  lastPeakSlot: number;
  openedAt: number;
  spent: bigint; // lamports spent on buys that filled
  fills: number;
  bank1: boolean;
  bank2: boolean;
  trailLive: boolean;
  isScout: boolean;
  cohort: Set<string>; // earliest buyers (first 3 slots) — their full exit is an alarm
  cohortDump: boolean; // a cohort member or the creator sold AFTER our entry
}

function newWatched(mint: string, slot: number, birthPrice: bigint, supply: bigint, creator: string): Watched {
  return {
    mint,
    born: slot,
    birthPrice,
    supply,
    creator,
    buyers: new Set(),
    tape: [],
    holders: new Map(),
    creatorSold: false,
    slot0Buyers: new Set(),
    slot0Tokens: 0n,
    earlyBuyers: new Set(),
    look1: false,
    look2: false,
    done: false,
    confirmMain: -1,
    confirmScout: -1,
    scoutLook1: false,
    scoutLook2: false,
    peakPrice: 0n,
    peakRq: 0n,
    peakWorth: 0n,
    lastPeakSlot: slot,
    openedAt: 0,
    spent: 0n,
    fills: 0,
    bank1: false,
    bank2: false,
    trailLive: false,
    isScout: false,
    cohort: new Set(),
    cohortDump: false,
  };
}

/** Scaled price of a curve: virtual quote reserves per virtual token. */
function scaledPrice(vQuote: bigint, vToken: bigint): bigint {
  if (vToken <= 0n) return 0n;
  return (vQuote * SCALE) / vToken;
}

/** Mark value in lamports of `tokens` at the curve's current reserves. */
function markValue(tokens: bigint, vQuote: bigint, vToken: bigint): bigint {
  if (vToken <= 0n) return 0n;
  return (tokens * vQuote) / vToken;
}

/** Tokens a buy of `spend` lamports (net of curve fees) receives at these reserves. */
function tokensForSpend(spend: bigint, vQuote: bigint, vToken: bigint): bigint {
  if (spend <= 1n || vToken <= 0n) return 0n;
  return ((spend - 1n) * vToken) / (vQuote + spend - 1n);
}

/** Quote lamports a sell of `tokens` returns at these reserves, before fees. */
function quoteForTokens(tokens: bigint, vQuote: bigint, vToken: bigint): bigint {
  if (tokens <= 0n || vToken <= 0n) return 0n;
  return (tokens * vQuote) / (vToken + tokens);
}

const toLamports = (sol: number): bigint => BigInt(Math.round(sol * 1_000_000_000));
const toX1000 = (x: number): bigint => BigInt(Math.round(x * 1000));

// ------------------------------------------------------------------ the bot

export function createStrategy(overrides: Partial<BotParams> = {}) {
  const p: BotParams = { ...DEFAULT_PARAMS, ...overrides };

  const PROBE = toLamports(p.probe);
  const ADD = toLamports(p.addSize);
  const MAX_PER_COIN = toLamports(p.maxPerCoin);
  const MAX_ADD_MULT = toX1000(p.maxAddMult);
  const MIN_RQ = toLamports(p.minRealSol);
  const MIN_FLOW = toLamports(p.minNetFlow);
  const LOW_MULT = toX1000(p.lowMult);
  const HIGH_MULT = toX1000(p.highMult);
  const BANK1_AT = toX1000(p.bankAt1);
  const BANK1_FRAC = BigInt(p.bankFrac1);
  const BANK2_AT = toX1000(p.bankAt2);
  const BANK2_FRAC = BigInt(p.bankFrac2);
  const STOP = toX1000(p.stopAt);
  const TRAIL_ARM = toX1000(p.trailArm);
  const TRAIL_KEEP = toX1000(p.trailKeep);
  const COLLAPSE = BigInt(Math.round(p.collapseAt * 100));
  const SCOUT_PROBE = toLamports(p.scoutProbe);
  const SCOUT_RQ = toLamports(p.scoutRealSol);
  const SCOUT_FLOW = toLamports(p.scoutFlow);
  const SCOUT_LOW = toX1000(p.scoutLowMult);
  const SCOUT_HIGH = toX1000(p.scoutHighMult);
  const SCOUT_STOP = toX1000(p.scoutStop);
  const SCOUT_ARM = toX1000(p.scoutTrailArm);
  const SCOUT_KEEP = toX1000(p.scoutTrailKeep);
  const SCOUT_BANK_AT = toX1000(p.scoutBankAt);
  const SCOUT_BANK_FRAC = BigInt(p.scoutBankFrac);
  const SCOUT_COLLAPSE = BigInt(Math.round(p.scoutCollapse * 100));
  const MAX_EXPOSURE = toLamports(p.maxExposureSol);
  const MAX_TAPE = 400; // trades remembered per coin (flow window only)
  const MAX_BUYERS = 200; // distinct buyers remembered per coin

  const watched = new Map<string, Watched>();
  const undecided: Watched[] = []; // created, not yet decided
  // Coins that failed both judgements, kept (capped) as pace-probe
  // candidates for the guardrail. Their holder reconstruction is kept
  // so the gates still apply to probes.
  const rejected: Watched[] = [];
  const MAX_REJECTED = 100;
  // Guardrail pacing: the final window is 6 hours (~100,803 slots at the
  // dev window's rate). Target 25 coins by window end (margin above the
  // 20-coin guardrail). The pace probe only fires while behind pace.
  const WINDOW_SLOTS = 100803;
  const PACE_TARGET = 25;
  let windowStart = -1;
  let coinsTraded = 0; // distinct mints whose entry buy filled
  const creators = new Map<string, number>(); // creator -> coins launched in-window
  const buyIds = new Map<string, string>(); // client_id -> mint, for fills
  let idSeq = 1;
  let exposure = 0n; // lamports currently invested (buys filled minus sells)

  function nextId(): string {
    return `ps${idSeq++}`;
  }

  function forget(mint: string): void {
    watched.delete(mint);
    const i = undecided.findIndex((w) => w.mint === mint);
    if (i >= 0) undecided.splice(i, 1);
    const j = rejected.findIndex((w) => w.mint === mint);
    if (j >= 0) rejected.splice(j, 1);
  }

  /** Net SOL flow (buys minus sells) over the last p.flowSpan slots. */
  function netFlow(w: Watched, now: number): bigint {
    const from = now - p.flowSpan;
    let flow = 0n;
    for (let i = w.tape.length - 1; i >= 0; i--) {
      const t = w.tape[i];
      if (t.slot < from) break;
      flow += t.buy ? t.sol : -t.sol;
    }
    return flow;
  }

  // --- ownership gates -------------------------------------------------
  // All three vetoes read the holder table rebuilt from the tape. They run
  // at judgement time only, so a coin that passes the momentum bar still
  // has to prove it is not bundled, not concentrated, and not a serial
  // launcher's coin. Any doubt -> skip (fail-closed).

  /** Bundle veto: non-creator slot-0 buys >40% of supply, or >=12 distinct
   * non-creator buyers in the first 3 slots. Thresholds calibrated on the
   * dev window (diag-gates.mjs): slot-0 share median is ~30% and top-10
   * median ~70% at judgement time, so the literature values (20% / 35%)
   * veto nearly every active coin. These veto only the worst tail. */
  function isBundled(w: Watched): boolean {
    if (!p.vetoBundle) return false;
    if (w.supply > 0n && w.slot0Tokens * 5n > w.supply * 2n) return true; // >40%
    if (w.earlyBuyers.size >= 12) return true;
    return false;
  }

  /** Concentration veto: top-1 >35%, top-10 >85%, or Gini >0.85.
   * Calibrated on the dev window: top-10 median is 61-74% at judgement
   * time (early buyers structurally hold most of a newborn curve), so the
   * literature 35% vetoes 95-100% of candidates. 85% vetoes ~10-15%. */
  function isConcentrated(w: Watched): boolean {
    if (!p.vetoConcentration) return false;
    const balances: bigint[] = [];
    let total = 0n;
    for (const b of w.holders.values()) {
      if (b > 0n) {
        balances.push(b);
        total += b;
      }
    }
    // Fail-closed: too thin a tape to judge dispersion -> treat as concentrated.
    if (balances.length < 5 || total <= 0n) return true;
    balances.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const top1 = balances[balances.length - 1];
    if (top1 * 20n > total * 7n) return true; // top-1 >35%
    let top10 = 0n;
    for (let i = Math.max(0, balances.length - 10); i < balances.length; i++) top10 += balances[i];
    if (top10 * 20n > total * 17n) return true; // top-10 >85%
    // Gini, scaled x1000: G = (2*sum(i*x_i))/(n*sum) - (n+1)/n, i 1-based.
    let weighted = 0n;
    for (let i = 0; i < balances.length; i++) weighted += BigInt(i + 1) * balances[i];
    const n = BigInt(balances.length);
    const giniX1000 = (2000n * weighted) / (n * total) - ((n + 1n) * 1000n) / n;
    if (giniX1000 > 850n) return true;
    return false;
  }

  /** Creator veto: creator sold before entry, or launched another coin in-window. */
  function isBadCreator(w: Watched): boolean {
    if (!p.vetoCreator) return false;
    if (w.creatorSold) return true;
    if ((creators.get(w.creator) ?? 0) > 1) return true;
    return false;
  }

  function passesGates(w: Watched): boolean {
    return !isBundled(w) && !isConcentrated(w) && !isBadCreator(w);
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const now = state.slot;
    if (windowStart < 0) windowStart = now;
    const caps = state.hello.caps;
    const txFee = state.txFeeLamports();
    let free = state.freeCashLamports();
    let openSlots = caps.max_open_positions - state.committedPositionCount();

    // --- 1. Fold this batch's fills into the books. ---------------------
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      const mint = buyIds.get(f.client_id);
      if (mint === undefined) continue; // a sell, or a harness close
      buyIds.delete(f.client_id);
      if (f.side !== 'buy') continue;
      const w = watched.get(mint);
      if (w === undefined) continue;
      if (w.fills === 0) coinsTraded += 1; // first fill: a guardrail coin
      w.spent += BigInt(f.quote_lamports);
      w.fills += 1;
    }
    // Exposure: recompute from positions each batch (cheap, <=5).
    {
      let held = 0n;
      for (const pos of state.positions.values()) held += pos.cost_lamports;
      exposure = held;
    }

    // --- 2. Ingest this batch's events. ----------------------------------
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const birth = scaledPrice(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        const w = newWatched(e.mint, e.slot, birth, BigInt(e.token_total_supply), e.creator);
        watched.set(e.mint, w);
        undecided.push(w);
        creators.set(e.creator, (creators.get(e.creator) ?? 0) + 1);
      } else if (e.event === 'TradeEvent') {
        const w = watched.get(e.mint);
        if (w === undefined) continue;
        const user = e.user;
        const tokens = BigInt(e.token_amount);
        // Holder table: net token balance per wallet.
        const prev = w.holders.get(user) ?? 0n;
        w.holders.set(user, e.is_buy ? prev + tokens : prev - tokens);
        if (!e.is_buy && user === w.creator) w.creatorSold = true;
        // Cohort alarm: a sell AFTER our entry by the creator or by a member
        // of the earliest-buyer cohort. Pre-entry sells do not count — most
        // early flippers are already out by the time we enter at age 35+.
        if (!e.is_buy && w.done && e.slot > w.openedAt && (user === w.creator || w.cohort.has(user))) {
          w.cohortDump = true;
        }
        if (e.is_buy) {
          if (user !== w.creator && w.buyers.size < MAX_BUYERS) w.buyers.add(user);
          // Bundle evidence counts NON-creator wallets only: the creator's
          // own buy is skin-in-the-game (or a dev-buy signal), not a bundle.
          if (user !== w.creator) {
            if (e.slot === w.born) {
              w.slot0Buyers.add(user);
              w.slot0Tokens += tokens;
            }
            if (e.slot - w.born <= 2) w.earlyBuyers.add(user);
          }
        }
        // Cohort membership is fixed at entry time (see enter()), but the
        // early-buyer set is the raw material for it.
        if (!w.done) {
          w.tape.push({ slot: e.slot, buy: e.is_buy, sol: BigInt(e.sol_amount) });
          if (w.tape.length > MAX_TAPE) w.tape.splice(0, w.tape.length - MAX_TAPE);
        }
      } else if (e.event === 'CompleteEvent') {
        // The curve migrated: the harness closes any position itself.
        if (!state.positions.has(e.mint)) forget(e.mint);
      }
    }

    // --- 3. Manage open positions: exits first, then banks, then adds. ---
    // Orders already in flight still show in state.positions until their
    // fills land 2 slots later, so size new sells against the tokens that
    // are not already promised away, and count pending buys toward the
    // per-coin stake cap.
    const promisedSell = new Map<string, bigint>();
    const promisedBuy = new Map<string, bigint>();
    for (const pend of state.pending.values()) {
      if (pend.order.side === 'sell') {
        promisedSell.set(pend.order.mint, (promisedSell.get(pend.order.mint) ?? 0n) + BigInt(pend.order.token_amount));
      } else {
        promisedBuy.set(pend.order.mint, (promisedBuy.get(pend.order.mint) ?? 0n) + BigInt(pend.order.quote_lamports));
      }
    }

    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      const w = watched.get(mint);
      if (curve === undefined || w === undefined) continue;
      if (curve.complete) continue; // harness closes it

      const tokens = pos.token_amount;
      const unpromised = tokens - (promisedSell.get(mint) ?? 0n);
      const cost = pos.cost_lamports;
      if (tokens <= 0n || cost <= 0n) continue;
      const worth = markValue(tokens, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const mult = (worth * 1000n) / cost;
      const price = scaledPrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const rq = curve.real_quote_reserves;

      // A fresh high means the price beat every price seen since entry.
      // Capture it BEFORE folding this batch into the peaks.
      const freshHigh = price > w.peakPrice;
      if (freshHigh) {
        w.peakPrice = price;
        w.lastPeakSlot = now;
      }
      if (rq > w.peakRq) w.peakRq = rq;
      if (worth > w.peakWorth) w.peakWorth = worth;
      // Scouts run on tighter rails than main positions.
      const stopX = w.isScout ? SCOUT_STOP : STOP;
      const armX = w.isScout ? SCOUT_ARM : TRAIL_ARM;
      const keepX = w.isScout ? SCOUT_KEEP : TRAIL_KEEP;
      const collapseNum = w.isScout ? SCOUT_COLLAPSE : COLLAPSE;
      const stale = w.isScout ? p.scoutStale : p.staleAfter;
      const holdMax = w.isScout ? p.scoutHoldMax : p.holdMax;
      if (mult >= armX) w.trailLive = true;

      // Cohort alarm: the creator or a cohort member sold after our entry
      // (flagged during event ingestion, post-entry sells only).
      const cohortDump = p.cohortExit && w.cohortDump;

      // Full-exit checks, worst first.
      let exitAll = false;
      if (cohortDump) exitAll = true;
      else if (worth * 1000n < cost * stopX) exitAll = true; // hard stop
      else if (w.trailLive && worth * 1000n < w.peakWorth * keepX) exitAll = true;
      else if (w.peakRq > 0n && rq * 100n < w.peakRq * collapseNum) exitAll = true;
      else if (now - w.lastPeakSlot > stale) exitAll = true;
      else if (now - w.openedAt > holdMax) exitAll = true;

      if (exitAll) {
        // Quote gate on the exit: only sell when the proceeds cover the tx fee.
        if (unpromised > 0n) {
          const gross = quoteForTokens(unpromised, curve.virtual_quote_reserves, curve.virtual_token_reserves);
          const net = gross - (gross * 125n) / 10000n - txFee;
          if (net > 0n) {
            orders.push({ side: 'sell', mint, token_amount: unpromised, max_slippage_bps: p.sellSlippageBps });
          }
        }
        continue;
      }

      // Staged profit banks, one per batch at most. Scouts bank once, early.
      const bankAt = w.isScout ? SCOUT_BANK_AT : BANK1_AT;
      const bankFrac = w.isScout ? SCOUT_BANK_FRAC : BANK1_FRAC;
      if (!w.bank1 && mult >= bankAt) {
        const sell = (unpromised * bankFrac) / 100n;
        if (sell > 0n) {
          const gross = quoteForTokens(sell, curve.virtual_quote_reserves, curve.virtual_token_reserves);
          const net = gross - (gross * 125n) / 10000n - txFee;
          if (net > txFee) {
            orders.push({ side: 'sell', mint, token_amount: sell, max_slippage_bps: p.sellSlippageBps });
            w.bank1 = true;
            continue;
          }
        }
      }
      if (!w.isScout && w.bank1 && !w.bank2 && mult >= BANK2_AT) {
        const sell = (unpromised * BANK2_FRAC) / 100n;
        if (sell > 0n) {
          const gross = quoteForTokens(sell, curve.virtual_quote_reserves, curve.virtual_token_reserves);
          const net = gross - (gross * 125n) / 10000n - txFee;
          if (net > txFee) {
            orders.push({ side: 'sell', mint, token_amount: sell, max_slippage_bps: p.sellSlippageBps });
            w.bank2 = true;
            continue;
          }
        }
      }

      // Adds are main-tier only, on a fresh high while reserves grow.
      const spentNow = w.spent + (promisedBuy.get(mint) ?? 0n);
      if (
        !w.isScout &&
        w.fills > 0 &&
        freshHigh &&
        spentNow + ADD <= MAX_PER_COIN &&
        mult < MAX_ADD_MULT &&
        rq >= w.peakRq &&
        orders.length < caps.max_orders_per_batch &&
        exposure + ADD <= MAX_EXPOSURE
      ) {
        const cap = state.maxBuyLamports(mint);
        let amount = ADD;
        if (amount > cap) amount = cap;
        const room = MAX_PER_COIN - spentNow;
        if (amount > room) amount = room;
        if (amount >= PROBE && free >= amount + txFee) {
          // Quote gate on the add: the tokens must be worth the spend at a
          // conservative mark (effective price no more than 15% over mark).
          const expect = tokensForSpend((amount * 9875n) / 10000n, curve.virtual_quote_reserves, curve.virtual_token_reserves);
          const worthNow = markValue(expect, curve.virtual_quote_reserves, curve.virtual_token_reserves);
          if (worthNow * 100n >= amount * 85n) {
            const id = nextId();
            buyIds.set(id, mint);
            orders.push({ side: 'buy', client_id: id, mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
            free -= amount + txFee;
          }
        }
      }
    }

    // --- 4. Judge undecided coins, in stages. ----------------------------
    // Main looks at firstLook and secondLook on the strict bar; a signal
    // must hold for two consecutive batches before the bot acts (sequential
    // confirmation). A coin that fails both main looks then gets two scout
    // looks (secondLook and scoutSecondLook) on the loose bar, for a tiny
    // probe. Scouts only take a slot when at least two are free, so a main
    // entry is never crowded out.
    const enter = (w: Watched, price: bigint, reserves: bigint, scout: boolean): boolean => {
      const size = scout ? SCOUT_PROBE : PROBE;
      const needSlots = scout ? 2 : 1;
      if (openSlots < needSlots) return false;
      if (orders.length >= caps.max_orders_per_batch) return false;
      if (free < size + txFee) return false;
      if (exposure + size > MAX_EXPOSURE) return false;
      const cap = state.maxBuyLamports(w.mint);
      let amount = size;
      if (amount > cap) amount = cap;
      if (amount < size / 2n) return false;
      if (amount < 5_000_000n) return false; // dust guard: never below 0.005 SOL
      // Quote gate on entry: effective price no more than 15% over mark.
      const curve = state.curves.get(w.mint);
      if (curve !== undefined) {
        const expect = tokensForSpend((amount * 9875n) / 10000n, curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const worthNow = markValue(expect, curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (worthNow * 100n < amount * 85n) return false;
      }
      const id = nextId();
      buyIds.set(id, w.mint);
      orders.push({ side: 'buy', client_id: id, mint: w.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
      free -= amount + txFee;
      openSlots -= 1;
      w.done = true;
      w.isScout = scout;
      w.openedAt = now;
      w.peakPrice = price;
      w.peakRq = reserves;
      w.lastPeakSlot = now;
      w.cohort = new Set(w.earlyBuyers);
      return true;
    };

    for (let i = undecided.length - 1; i >= 0; i--) {
      const w = undecided[i];
      const age = now - w.born;
      const curve = state.curves.get(w.mint);
      if (curve === undefined || curve.complete) {
        undecided.splice(i, 1);
        continue;
      }
      if (age < p.firstLook) continue;

      const reserves = curve.real_quote_reserves;
      const price = scaledPrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const mult = w.birthPrice > 0n ? (price * 1000n) / w.birthPrice : 0n;
      const flow = netFlow(w, now);
      const mainBar =
        reserves >= MIN_RQ &&
        w.buyers.size >= p.minBuyers &&
        flow >= MIN_FLOW &&
        mult >= LOW_MULT &&
        mult <= HIGH_MULT;
      const scoutBar =
        reserves >= SCOUT_RQ &&
        w.buyers.size >= p.scoutBuyers &&
        flow >= SCOUT_FLOW &&
        mult >= SCOUT_LOW &&
        mult <= SCOUT_HIGH;

      // Sequential confirmation: a bar must pass on two consecutive batches
      // before the bot acts. A pass on a fresh slot after a pass on an
      // earlier slot confirms; a fail clears that bar's pending confirmation.
      // Main and scout confirmations are tracked separately so pursuing one
      // never resets the other.
      const confirm = (scout: boolean): boolean => {
        const slot = scout ? w.confirmScout : w.confirmMain;
        if (slot < 0) {
          if (scout) w.confirmScout = now;
          else w.confirmMain = now;
          return false;
        }
        if (slot === now) return false; // same batch, not a second look
        return true;
      };

      // Stage A — main look 1: ages [firstLook, secondLook). Main bar only:
      // the scout bar must NOT run here — a flickering main bar lets the
      // scout tier steal a coin that would have entered the main tier two
      // batches later (measured: early scout look turned +1.17 into -0.52
      // mean, and the 6h slice's +0.51 winner into a -0.003 scout probe).
      if (age >= p.firstLook && age < p.secondLook) {
        w.look1 = true;
        if (mainBar && passesGates(w)) {
          if (confirm(false) && enter(w, price, reserves, false)) {
            undecided.splice(i, 1);
            continue;
          }
        } else {
          w.confirmMain = -1;
        }
        continue;
      }
      // Stage B — main look 2 + scout look 1: ages [secondLook, scoutSecondLook).
      // Main has priority: only pursue the scout confirmation when the main
      // bar fails, so the two confirmations never fight over one batch.
      if (age >= p.secondLook && age < p.scoutSecondLook) {
        w.look2 = true;
        w.scoutLook1 = true;
        if (mainBar && passesGates(w)) {
          if (confirm(false) && enter(w, price, reserves, false)) {
            undecided.splice(i, 1);
            continue;
          }
        } else {
          w.confirmMain = -1;
          if (scoutBar && passesGates(w)) {
            if (confirm(true) && enter(w, price, reserves, true)) {
              undecided.splice(i, 1);
              continue;
            }
          } else {
            w.confirmScout = -1;
          }
        }
        continue;
      }
      // Stage C — scout look 2, for late survivors: ages >= scoutSecondLook.
      if (age >= p.scoutSecondLook) {
        w.scoutLook2 = true;
        if (scoutBar && passesGates(w)) {
          if (confirm(true) && enter(w, price, reserves, true)) {
            undecided.splice(i, 1);
            continue;
          }
        } else {
          w.confirmScout = -1;
        }
        // Grace window past the last look, then keep it as a pace-probe
        // candidate instead of forgetting it outright.
        if (age > p.scoutSecondLook + 30) {
          w.done = true;
          undecided.splice(i, 1);
          rejected.push(w);
          if (rejected.length > MAX_REJECTED) {
            const dropped = rejected.shift();
            if (dropped) forget(dropped.mint);
          }
        }
      }
    }

    // --- 4b. Guardrail pacing. -------------------------------------------
    // The 20-coin guardrail is a hard ranking cliff: miss it and the entry
    // ranks below every guardrail-passer regardless of PnL. If the entry
    // pace lags the 25-coin target, probe the best rejected coin (newest
    // first) with a scout probe at a minimal bar. This only fires while
    // behind pace, only touches coins that already failed both judgements
    // (so it can never steal a main-tier entry), and needs 2 free slots.
    {
      const elapsed = now - windowStart;
      const paceTarget = Math.min(PACE_TARGET, Math.floor((PACE_TARGET * elapsed) / WINDOW_SLOTS));
      if (coinsTraded < paceTarget && rejected.length > 0) {
        for (let i = rejected.length - 1; i >= 0; i--) {
          const w = rejected[i];
          const curve = state.curves.get(w.mint);
          if (curve === undefined || curve.complete) {
            rejected.splice(i, 1);
            continue;
          }
          const age = now - w.born;
          if (age > 600) {
            rejected.splice(i, 1); // too stale to bother probing
            continue;
          }
          const reserves = curve.real_quote_reserves;
          const price = scaledPrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
          const mult = w.birthPrice > 0n ? (price * 1000n) / w.birthPrice : 0n;
          const minimalBar = reserves >= 3_000_000_000n && w.buyers.size >= 3 && mult >= 1000n;
          if (!minimalBar || !passesGates(w)) continue;
          if (enter(w, price, reserves, true)) {
            rejected.splice(i, 1);
            break; // one pace probe per batch
          }
        }
      }
    }

    // --- 5. Housekeeping: forget old decided coins with no position. -----
    if (watched.size > 4000) {
      for (const [mint, w] of watched) {
        if (!state.positions.has(mint) && w.done && now - w.born > p.holdMax) {
          forget(mint);
        }
      }
    }

    return orders;
  }

  return { onBatch };
}
