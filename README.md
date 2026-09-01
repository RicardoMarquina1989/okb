# kox-bot

A terminal bot for OKX funding operations: fetch deposit addresses, submit withdrawals behind a
multi-factor approval gate, and keep a local SQLite ledger of everything it does.

No UI, no server, no listening ports. Node.js + SQLite only.

---

## What the verification layer actually is

**OKX has no API for submitting email / SMS / Google Authenticator codes.** Their withdrawal
endpoint is authenticated by your API key, secret and passphrase, and is gated on OKX's side by:

- the API key's **IP allow-list** (mandatory for the withdraw permission), and
- your account's **withdrawal address whitelist**.

So the 2FA, email and phone verification in this project is a **local approval gate**: before the
bot calls OKX, it makes *you* prove it is you. That protects against someone who steals your `.env`
file or gets shell access to this machine — they hold the API keys but still cannot move funds
without your authenticator and mailbox/phone.

It is a second lock on your side of the door. It does not replace OKX's own controls, and it cannot
authorise anything OKX would otherwise refuse. Keep the IP allow-list and the exchange-side address
whitelist switched on.

---

## Setup

```bash
npm install
cp .env.example .env
```

**1. Create the OKX API key** (Profile → API → Create V5 API key)

- Permissions: **Read** + **Withdraw**. Leave Trade off — this bot never trades.
- Set the **IP allow-list** to this machine's public IP. Withdrawals fail with code `50110` without it.
- Whitelist your destination addresses in the OKX web UI. Withdrawals to an address that is not
  whitelisted fail with code `58207`.

Put the key, secret and API passphrase into `.env`.

**2. Generate the at-rest encryption key**

```bash
node src/index.js auth keygen     # paste the line into .env
```

**3. Enrol your authenticator**

```bash
node src/index.js auth setup      # scan the QR with any TOTP app
```

Store the manual-entry key offline. Losing it locks you out of withdrawals from this bot.

**4. Check everything**

```bash
node src/index.js doctor
```

Optionally `npm link` (or `npm i -g .`) to get a `kox` command instead of `node src/index.js`.

---

## Usage

### Deposits

```bash
kox deposit address USDT                        # every chain OKX offers
kox deposit address USDT --chain USDT-TRC20     # one chain
kox deposit address USDT --chain USDT-TRC20 --qr
kox deposit history --ccy USDT                  # sync from OKX into SQLite
kox deposit history --no-sync                   # local ledger only
```

### Withdrawals

Destinations must be saved first — this is the local allow-list, and adding to it is itself gated by
your factors:

```bash
kox address add --label cold --ccy USDT --chain USDT-TRC20 \
                --addr TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE
kox address list
```

Then:

```bash
kox withdraw send --label cold --amount 100 --dry-run   # validate, submit nothing
kox withdraw send --label cold --amount 100             # the real thing
kox withdraw send --label exch --amount 50 --dest internal
```

A real withdrawal walks through: summary → type the last 6 characters of the destination address →
every factor in `AUTH_FACTORS` → submit.

Afterwards:

```bash
kox withdraw status <clientId>    # refresh one
kox withdraw reconcile            # refresh all open ones
kox withdraw history --sync       # ledger, including withdrawals made elsewhere
kox withdraw cancel <clientId>
```

### Account and audit

```bash
kox balance --trading
kox currencies USDT               # chains, limits, fees
kox auth status                   # which factors are ready
kox auth test email               # prove delivery works before you need it
kox auth audit                    # recent security events
```

Add `--simulated` to any command to hit OKX demo trading.

---

## Turning on email / SMS codes

Set `AUTH_FACTORS=totp,email` (or `totp,email,sms`) and fill in the matching section of `.env`.
SMS needs the optional Twilio package:

```bash
npm install twilio
```

Verify delivery *before* you depend on it: `kox auth test email`.

---

## How the safety mechanisms work

**Codes are bound to the action.** Each approval hashes the exact intent — currency, chain, amount,
destination, fee — and the one-time codes are stored against that hash. A code issued for a 10 USDT
withdrawal cannot approve a 10,000 USDT one.

**TOTP codes are single-use.** A token is burned when used, so it cannot approve a second action
inside its 30-second window.

**The address tail is typed, not clicked.** Confirmation requires typing the last 6 characters of
the destination, which defeats clipboard-swapping malware.

**Withdrawals are never retried automatically.** GETs retry on rate limits; the withdrawal POST is
sent exactly once. If it errors, the bot queries OKX by `clientId` to find out whether it was
accepted anyway before recording anything — so a network blip cannot produce a double send or a
silently-lost withdrawal.

**Secrets are encrypted at rest.** The authenticator seed is stored AES-256-GCM encrypted under a
scrypt-derived key. Stored OTP hashes are peppered with the same key, so the database alone is not
enough. Audit-log details are redacted before they are written.

**Local ceilings.** `MAX_WITHDRAWAL_AMOUNT` caps a single transaction; `MAX_DAILY_WITHDRAWAL_AMOUNT`
caps a rolling 24 hours per currency. Amounts are also checked against OKX's own per-chain minimum,
maximum and decimal precision before anything is submitted.

---

## Data

Everything lives in `data/kox.db` (SQLite, WAL mode):

| table | contents |
| --- | --- |
| `withdrawals` | every withdrawal, with client id, OKX state, tx id and which factors approved it |
| `deposits` | synced deposit history |
| `deposit_addresses` | cached addresses per currency and chain |
| `address_book` | the local withdrawal allow-list |
| `auth_factors` | the encrypted authenticator seed |
| `otp_codes` | hashed one-time codes, bound to an intent |
| `approvals` | a record of each completed approval ceremony |
| `audit_log` | security-relevant events, redacted |

Inspect it with any SQLite client:

```bash
sqlite3 data/kox.db "SELECT requested_at, ccy, amount, status FROM withdrawals ORDER BY id DESC LIMIT 10;"
```

---

## Tests

```bash
npm test
```

38 tests run against a mock OKX server that validates request signatures exactly the way OKX does,
so a passing suite proves the signing, error mapping, validation rules, ledger and reconciliation
all behave. No credentials or network access needed.

---

## Operational notes

- `.env` and `data/` are gitignored. Keep them that way — `.env` is a withdrawal credential.
- The machine clock matters. TOTP tolerates ±30s; OKX rejects requests whose timestamp drifts more
  than 30 seconds (code `50113`).
- If OKX rejects with `58207`, the address is missing from the *exchange-side* whitelist. Adding it
  to the local address book is not the same thing.
- Back up the authenticator seed shown during `auth setup`, and `data/kox.db` if you care about the
  ledger history.
