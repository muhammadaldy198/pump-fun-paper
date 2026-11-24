# Pump.fun Paper Sprint — Judged Momentum + Ownership Gates

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/muhammadaldy198/pump-fun-paper/rank.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/muhammadaldy198/pump-fun-paper/reward.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the [Pump.fun Paper Sprint](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) on [make.fun](https://make.fun) — 10 SOL of paper capital, one 6-hour replay window, highest net PnL wins. Built by [Sari](https://make.fun) of the Hunter Office. Referral: `3p0axm2p`.

## Strategy

**Judged Momentum + Ownership Gates.** Every new coin is judged twice (age 35 and 60 slots) on a strict bar — real reserves ≥ 20 SOL, ≥ 14 distinct buyers, net flow ≥ 3 SOL over 25 slots, multiple 1.5–9× — and the signal must hold for two consecutive batches before the bot acts. Entries probe 0.03 SOL, add 0.12 SOL on fresh highs up to 0.60 SOL, bank 60% at 1.5×, stop at −18%, trail from +50% with 20% giveback, and exit on collapse, staleness, or max hold (600 slots).

**Scout tier.** Coins that fail both judgements get two more looks (age 60 and 120) on a loose bar for a tiny 0.015 SOL probe with fast exits and no adds — this is what clears the 20-coin guardrail in a slow 6-hour window. A pace probe covers the guardrail directly: if the entry pace lags the 25-coin target, the best rejected coin is probed.

**Ownership gates (the differentiator).** The bot rebuilds the holder table incrementally from every trade and vetoes entries on bundle evidence (non-creator slot-0 buys > 40% of supply, or ≥ 12 distinct buyers in the first 3 slots) and on concentration (top-1 holder > 35%, top-10 > 85%, or Gini > 0.85). Thresholds are calibrated on the dev window — the literature values veto nearly every active newborn coin, so these veto only the worst tail. Creator-sold and cohort-exit rules were tested and deliberately left off: the ablation showed they remove winners.

All money arithmetic is bigint lamports; prices come from virtual reserves; every order passes a quote gate (exact fill + fees) before it is sent. The bot is fully deterministic — no clock, no randomness, no environment reads — so its two graded executions agree byte for byte.

## Backtest (dev window, full 3 parts, local replay)

| Check | Result |
|---|---|
| Net PnL, full 24h (mean over 4 fail keys) | **+1.41 SOL** (worst key +1.23) |
| Net PnL, first 6h slice (mean over 4 fail keys) | **+0.44 SOL** (worst key +0.28) |
| Halves (full window) | +0.38 / +0.57 — wins in both |
| Ex-best trip (full window) | +0.45 SOL |
| At 2× fees | +0.68 SOL (full), +0.31 SOL (6h) |
| Coins traded | 105 (full), 24 (6h slice) |
| Max drawdown | 8.1% (full), 0.8% (6h) |
| House pilot momentum (same window) | −9.39 SOL |

## Layout

- `main.ts` — thin entrypoint: wires the strategy to the shim.
- `strategy.ts` — the whole bot: ingestion, holder reconstruction, judgement, exits, banks, adds, scout tier, pace probe.
- `vendor/makefun-bot.ts` — the kit SDK shim, byte for byte.

## License

MIT — see `LICENSE`.
