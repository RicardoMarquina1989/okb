#!/usr/bin/env node
/**
 * Plain-language front end for kox.
 *
 * You describe what you want; Claude proposes one kox command at a time and
 * nothing runs until you confirm it. Claude never touches OKX directly — it can
 * only suggest argv for src/index.js, which this file validates against the
 * known command list and spawns without a shell.
 *
 * Commands that prompt (withdrawals, address book changes, auth setup) run
 * attached to your terminal, so codes and secrets you type go straight to kox
 * and are never sent to Claude. Read-only commands are captured and their
 * output is shared with Claude so it can explain the result.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline/promises';
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { colors as C } from './util/logger.js';

const CLI = path.join(config.root, 'src', 'index.js');
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.ANTHROPIC_EFFORT || 'medium';
const MAX_OUTPUT_TO_CLAUDE = 20_000;

/**
 * Every command Claude may propose. `terminal` commands run attached to the
 * user's terminal and their output is not shared with Claude — either because
 * they prompt for input or because they print secrets.
 */
const COMMANDS = {
  'deposit address': {},
  'deposit history': {},
  'withdraw send': { terminal: (args) => !args.includes('--dry-run'), movesFunds: (args) => !args.includes('--dry-run') },
  'withdraw status': {},
  'withdraw reconcile': {},
  'withdraw history': {},
  'withdraw cancel': { terminal: true },
  'address add': { terminal: true },
  'address list': {},
  'address check': {},
  'address remove': { terminal: true },
  transfer: { terminal: (args) => !args.includes('--yes') && !args.includes('--dry-run') },
  balance: {},
  currencies: {},
  doctor: {},
  'auth keygen': { terminal: true },
  'auth setup': { terminal: true },
  'auth status': {},
  'auth test': { terminal: true },
  'auth audit': {},
};

const flag = (v, args) => (typeof v === 'function' ? v(args) : Boolean(v));

/** Match argv against COMMANDS. Returns the spec or throws with a message for Claude. */
function resolveCommand(args) {
  if (!Array.isArray(args) || !args.length || !args.every((a) => typeof a === 'string')) {
    throw new Error('args must be a non-empty array of strings');
  }
  const rest = args[0] === '--simulated' ? args.slice(1) : args;
  if (rest.includes('--simulated')) throw new Error('--simulated is only accepted as the first argument');
  const key = COMMANDS[`${rest[0]} ${rest[1]}`] ? `${rest[0]} ${rest[1]}` : rest[0];
  const spec = COMMANDS[key];
  if (!spec) throw new Error(`"${rest.slice(0, 2).join(' ')}" is not a kox command. Allowed: ${Object.keys(COMMANDS).join(', ')}`);
  return {
    key,
    simulated: args[0] === '--simulated' || config.okx.simulated,
    terminal: flag(spec.terminal, args),
    movesFunds: flag(spec.movesFunds, args),
  };
}

const quote = (a) => (/^[\w.:@/=-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);

/* ------------------------------------------------------------- terminal */

let rl = null;
const openPrompt = () => (rl = readline.createInterface({ input: process.stdin, output: process.stdout }));
const closePrompt = () => {
  rl?.close();
  rl = null;
};

/** Run kox attached to the terminal so the user can answer its prompts directly. */
function runInTerminal(args) {
  closePrompt();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: config.root, stdio: 'inherit' });
    child.on('error', (err) => resolve({ code: 1, error: err.message }));
    child.on('close', (code) => resolve({ code }));
  }).finally(openPrompt);
}

/** Run a non-interactive kox command, echoing and capturing its output. */
function runCaptured(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: config.root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk) => {
      process.stdout.write(chunk);
      output += chunk.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => resolve({ code: 1, output: err.message }));
    child.on('close', (code) => resolve({ code, output }));
  });
}

const EXIT_MEANING = {
  0: 'success',
  1: 'error',
  77: 'approval failed or was declined',
  78: 'configuration problem',
  130: 'cancelled by the user',
};

/* ---------------------------------------------------------------- tools */

const TOOL = {
  name: 'run_kox',
  description:
    'Propose one kox command. The user sees the command and your explanation and must confirm before it runs. ' +
    'Read-only commands return their output to you. Commands that prompt for input (withdraw send without ' +
    '--dry-run, withdraw cancel, address add/remove, auth keygen/setup/test) run in the user\'s terminal and ' +
    'you only get the exit code. If the user declines, the result contains any feedback they typed.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['args', 'explanation'],
    properties: {
      args: {
        type: 'array',
        items: { type: 'string' },
        description:
          'argv after "kox", one token per element, e.g. ["withdraw","send","--label","cold","--amount","100","--dry-run"]. ' +
          'Put "--simulated" first to target OKX demo trading.',
      },
      explanation: {
        type: 'string',
        description: 'One or two plain sentences telling the user what this command does and whether it moves funds.',
      },
    },
  },
};

async function handleToolUse(block) {
  const result = (content, isError = false) => ({
    type: 'tool_result',
    tool_use_id: block.id,
    content,
    ...(isError ? { is_error: true } : {}),
  });

  const { args, explanation } = block.input ?? {};
  let cmd;
  try {
    cmd = resolveCommand(args);
  } catch (err) {
    return result(err.message, true);
  }

  const tags = [
    cmd.simulated ? `${C.cyan}SIMULATED${C.reset}` : `${C.bold}LIVE${C.reset}`,
    ...(cmd.movesFunds ? [`${C.red}${C.bold}MOVES FUNDS${C.reset}`] : []),
  ];
  console.log('');
  console.log(`${C.yellow}┌─ proposed step${C.reset}  ${tags.join('  ')}`);
  console.log(`${C.yellow}│${C.reset}  ${C.bold}kox ${args.map(quote).join(' ')}${C.reset}`);
  if (explanation) console.log(`${C.yellow}│${C.reset}  ${explanation}`);
  console.log(`${C.yellow}└─${C.reset}`);

  const answer = (await rl.question('Run it? [y/N, or type what to change] ')).trim();
  if (!/^y(es)?$/i.test(answer)) {
    return result(answer && !/^no?$/i.test(answer) ? `User declined. They said: ${answer}` : 'User declined to run this command.');
  }

  if (cmd.terminal) {
    const { code, error } = await runInTerminal(args);
    return result(
      `Exit code ${code} (${EXIT_MEANING[code] ?? 'error'}). ` +
        (error ? `Spawn error: ${error}. ` : '') +
        'The command ran in the user\'s terminal; its output was shown only to them.',
    );
  }

  console.log('');
  const { code, output } = await runCaptured(args);
  const clipped =
    output.length > MAX_OUTPUT_TO_CLAUDE ? `${output.slice(0, MAX_OUTPUT_TO_CLAUDE)}\n[output truncated]` : output;
  return result(`Exit code ${code} (${EXIT_MEANING[code] ?? 'error'}).\n${clipped || '(no output)'}`);
}

/* --------------------------------------------------------------- claude */

const SYSTEM = `You operate kox, a terminal bot for the user's OKX funding account, on their behalf. The user talks to you in plain language (often non-native English) and you turn each request into kox commands, proposed one at a time with the run_kox tool. They confirm every command before it runs, so propose the step and let them decide; do not ask "shall I?" in text first.

Commands (argv after "kox"):
- balance [--ccy C] [--trading] [--all] — OKX splits money between a funding account and a trading account; pass --trading to see both, since the total the user sees on OKX is their sum
- currencies [C] — chains, deposit/withdraw availability, min/max withdrawal, min fee, decimals
- deposit address <C> [--chain CHAIN] [--account 6|18] [--qr]
- deposit history [--ccy C] [--limit N] [--no-sync]
- address check <ADDR> [--ccy C] [--chain CHAIN] — is it in the local book, and has OKX paid out to it before (OKX's API cannot read its own whitelist, so this is the best available evidence)
- address list | address add --label L --ccy C --chain CHAIN --addr ADDR [--memo M] [--note N] | address remove <label>
- transfer --ccy C --amount A|max [--from trading|funding] [--to funding|trading] [--yes] [--dry-run] — moves money between the user's own two OKX accounts; nothing leaves OKX. Include --yes, since the user already confirms the step here.
- withdraw send --amount A|max (--label L | --to ADDR --ccy C) [--chain CHAIN] [--memo M] [--fee F] [--dest onchain|internal] [--no-top-up] [--dry-run]
  OKX pays withdrawals from the funding account only. By default withdraw send moves any shortfall from the trading account first (shown as "Top-up" in the dry run, approved together with the withdrawal), so the user does not need to transfer by hand. "--amount max" sends everything both accounts can release minus the network fee.
- withdraw status <clientId|wdId> | withdraw reconcile | withdraw history [--ccy C] [--status S] [--limit N] [--sync] | withdraw cancel <clientId|wdId>
- doctor — read-only health check of config, factors and API access
- auth status | auth audit [--limit N] | auth keygen | auth setup [--force] [--label L] | auth test <email|sms|console>
Put "--simulated" as the first argument to use OKX demo trading. Chains are named like "USDT-TRC20", "USDT-ERC20", "BTC-Bitcoin"; check with currencies when unsure.

How kox protects withdrawals: destinations must be saved in the local address book first (address add, which itself needs approval), and every withdrawal, address add and cancel asks the user to type the last 6 characters of the address and enter their authenticator code. Those prompts happen inside the command in the user's terminal. Never ask the user to tell you codes, API keys, secrets or passphrases, and never put them in arguments. The address must also be on the user's OKX withdrawal whitelist (error 58207 means it is not; that can only be fixed in OKX's own settings).

Working rules:
- Use only addresses, amounts and labels the user gave you or that came from command output. Never invent or "fix" an address.
- Before a real withdrawal, run the same command with --dry-run so the user sees amount, fee, network and destination, then propose the real one.
- If a request is ambiguous about currency, chain, amount or destination in a way that affects where money goes, ask instead of guessing.
- After a command runs, explain the result briefly in plain words. When the output was shown only to the user, ask them what happened if you need to know.
- Current mode: ${config.okx.simulated ? 'SIMULATED (demo trading) by default' : 'LIVE funds by default'}.
- Reply in the language the user writes in.`;

const client = new Anthropic();
const messages = [];

/** Run one user turn: call Claude, execute confirmed tool calls, repeat until it stops asking. */
async function agentTurn() {
  for (;;) {
    process.stdout.write(`${C.dim}…${C.reset}\r`);
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: EFFORT },
      cache_control: { type: 'ephemeral' },
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages,
    });

    if (response.stop_reason === 'max_tokens') {
      console.log(`${C.yellow}! response was cut off; try rephrasing more narrowly${C.reset}`);
      return;
    }

    messages.push({ role: 'assistant', content: response.content });

    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) console.log(`\n${C.green}kox›${C.reset} ${block.text.trim()}`);
    }

    if (response.stop_reason === 'refusal') {
      console.log(`${C.yellow}! Claude declined this request${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : ''}${C.reset}`);
      return;
    }
    if (response.stop_reason !== 'tool_use') return;

    const results = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') results.push(await handleToolUse(block));
    }
    messages.push({ role: 'user', content: results });
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(`${C.red}✗ ANTHROPIC_API_KEY is not set. Add it to .env.${C.reset}`);
    process.exitCode = 78;
    return;
  }

  console.log(`${C.bold}kox chat${C.reset} — tell me what you want to do. Every command needs your OK before it runs.`);
  console.log(`${C.dim}mode: ${config.okx.simulated ? 'SIMULATED' : 'LIVE'} · model: ${MODEL} · type "exit" to quit${C.reset}`);
  openPrompt();

  for (;;) {
    let line;
    try {
      line = (await rl.question(`\n${C.cyan}you›${C.reset} `)).trim();
    } catch {
      break; // stdin closed / Ctrl+C
    }
    if (!line) continue;
    if (/^(exit|quit|bye)$/i.test(line)) break;

    messages.push({ role: 'user', content: line });
    try {
      await agentTurn();
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        console.error(`${C.red}✗ Anthropic rejected the API key — check ANTHROPIC_API_KEY in .env${C.reset}`);
      } else if (err instanceof Anthropic.RateLimitError) {
        console.error(`${C.red}✗ rate limited by Anthropic — wait a moment and try again${C.reset}`);
      } else if (err instanceof Anthropic.APIError) {
        console.error(`${C.red}✗ Anthropic API error ${err.status ?? ''}: ${err.message}${C.reset}`);
      } else {
        console.error(`${C.red}✗ ${err?.message ?? err}${C.reset}`);
      }
      // A tool call left without a result would make every later request fail.
      const last = messages.at(-1);
      const pending = last?.role === 'assistant' ? last.content.filter((b) => b.type === 'tool_use') : [];
      if (pending.length) {
        messages.push({
          role: 'user',
          content: pending.map((b) => ({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: 'Interrupted before it ran.' })),
        });
      }
    }
  }
  closePrompt();
}

main();
