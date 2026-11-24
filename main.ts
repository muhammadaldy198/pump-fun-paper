// pump-fun-paper: a judged-momentum paper-trading bot for the make.fun
// Pump.fun Paper Sprint (u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b).
// The grader runs `node /bot/main.ts`. The strategy lives in strategy.ts;
// the SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte
// at vendor/makefun-bot.ts.
//
// Protocol: the harness sends a hello line, then one batch per slot, and
// the bot answers each batch with exactly one reply carrying its orders.
// strategy.ts decides the orders; this file only wires it to the shim.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

// One strategy instance for the whole run: its per-coin books (holder
// tables, judgement state, positions) live across batches, so the bot
// must not be recreated between slots.
await runBot(createStrategy(DEFAULT_PARAMS));
