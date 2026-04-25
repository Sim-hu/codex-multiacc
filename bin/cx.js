#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.0";
const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RATE_LIMIT_RE = /(rate[-_ ]?limit|too many requests|quota exceeded|usage limit|\b429\b)/i;
class CliError extends Error {}

function homeDir() {
  return path.resolve(process.env.CODEX_ACCOUNTS_HOME || path.join(os.homedir(), ".codex-accounts"));
}

function nativeCodexHome() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function stripDashDash(args) {
  return args[0] === "--" ? args.slice(1) : args;
}

function splitCommandLine(line) {
  const args = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const char of line.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (current) args.push(current);
  return args;
}

function validateAccount(name) {
  if (!ACCOUNT_RE.test(name || "")) {
    throw new CliError("account name must start with a letter or number and contain only letters, numbers, dots, underscores, or hyphens");
  }
  return name;
}

class Store {
  constructor(root = homeDir()) {
    this.root = root;
    this.accountsDir = path.join(root, "accounts");
    this.statePath = path.join(root, "state.json");
  }

  ensure() {
    fs.mkdirSync(this.accountsDir, { recursive: true });
  }

  accountHome(name) {
    return path.join(this.accountsDir, validateAccount(name));
  }

  ensureAccount(name) {
    const accountHome = this.accountHome(name);
    fs.mkdirSync(accountHome, { recursive: true });
    return accountHome;
  }

  listAccounts() {
    if (!fs.existsSync(this.accountsDir)) return [];
    return fs.readdirSync(this.accountsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && ACCOUNT_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  }

  state() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  writeState(state) {
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  active() {
    const active = this.state().active;
    return this.listAccounts().includes(active) ? active : null;
  }

  setActive(name) {
    if (!this.listAccounts().includes(name)) throw new CliError(`unknown account: ${name}`);
    const state = this.state();
    state.active = name;
    this.writeState(state);
  }

  limitState(account) {
    const limits = this.state().limits || {};
    const entry = limits[account];
    return entry && typeof entry === "object" ? entry : null;
  }

  markLimited(account, limitedAt = Date.now()) {
    if (!this.listAccounts().includes(account)) throw new CliError(`unknown account: ${account}`);
    const state = this.state();
    state.limits = state.limits && typeof state.limits === "object" ? state.limits : {};
    state.limits[account] = {
      limitedAt,
      resetAt: limitedAt + (5 * 60 * 60 * 1000),
    };
    this.writeState(state);
  }

  clearLimit(account) {
    if (!this.listAccounts().includes(account)) throw new CliError(`unknown account: ${account}`);
    const state = this.state();
    if (state.limits && typeof state.limits === "object") {
      delete state.limits[account];
      this.writeState(state);
    }
  }

  rateLimitCache(maxAgeMs, now = Date.now()) {
    if (!maxAgeMs || maxAgeMs <= 0) return null;
    const cache = this.state().rateLimitCache;
    if (!cache || typeof cache !== "object" || !Array.isArray(cache.rows)) return null;
    if (!Number.isFinite(cache.fetchedAt) || now - cache.fetchedAt > maxAgeMs) return null;

    const accounts = this.listAccounts();
    const cachedAccounts = cache.rows.map((row) => row.account).sort((a, b) => a.localeCompare(b));
    if (accounts.length !== cachedAccounts.length || accounts.some((account, i) => account !== cachedAccounts[i])) return null;

    const active = this.active();
    return cache.rows.map((row) => ({
      ...row,
      active: row.account === active,
      auth: fs.existsSync(path.join(this.accountHome(row.account), "auth.json")),
    }));
  }

  writeRateLimitCache(rows, fetchedAt = Date.now()) {
    const state = this.state();
    state.rateLimitCache = {
      fetchedAt,
      rows: rows.map((row) => ({
        account: row.account,
        error: row.error || null,
        resetAt: row.resetAt ?? null,
        usedPercent: row.usedPercent ?? null,
        windowDurationMins: row.windowDurationMins ?? null,
        planType: row.planType ?? null,
        limitId: row.limitId ?? null,
        limitName: row.limitName ?? null,
        rateLimitReachedType: row.rateLimitReachedType ?? null,
      })),
    };
    this.writeState(state);
  }
}

function resolveCodexBin() {
  if (process.env.CODEX_ACCOUNTS_CODEX_BIN) return process.env.CODEX_ACCOUNTS_CODEX_BIN;

  const pathExt = process.platform === "win32"
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  const names = process.platform === "win32"
    ? pathExt.map((ext) => `codex${ext.toLowerCase()}`)
    : ["codex"];

  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new CliError("native codex CLI was not found on PATH");
}

function codexEnv(accountHome) {
  return { ...process.env, CODEX_HOME: accountHome };
}

function runNative(accountHome, codexArgs, { capture = false } = {}) {
  const bin = resolveCodexBin();
  const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
  const result = spawnSync(bin, codexArgs, {
    env: codexEnv(accountHome),
    stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    shell: useShell,
    maxBuffer: 1024 * 1024 * 64,
  });
  if (result.error) throw result.error;
  return result;
}

function spawnAppServer(accountHome) {
  const bin = resolveCodexBin();
  const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
  return spawn(bin, ["app-server", "--listen", "stdio://"], {
    env: codexEnv(accountHome),
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
    shell: useShell,
  });
}

function readJsonLines(stream, onObject) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const index = buffer.indexOf("\n");
      if (index === -1) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        onObject(JSON.parse(line));
      } catch {
        // Ignore non-JSON log noise from the app-server.
      }
    }
  });
}

async function requestAppServer(accountHome, request) {
  const cp = spawnAppServer(accountHome);
  let settled = false;
  let rejectFn;
  const pending = new Map();
  const events = [];

  const finish = (value) => {
    if (settled) return;
    settled = true;
    try {
      cp.kill();
    } catch {
      // ignore
    }
    return value;
  };

  const waitFor = (id) => new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });

  const handle = (message) => {
    if (!message || typeof message !== "object") return;
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      const slot = pending.get(message.id);
      if (!slot) return;
      pending.delete(message.id);
      if (Object.prototype.hasOwnProperty.call(message, "error")) {
        slot.reject(new CliError(message.error?.message || "app-server request failed"));
      } else {
        slot.resolve(message.result);
      }
      return;
    }
    events.push(message);
  };

  const exited = new Promise((resolve, reject) => {
    rejectFn = reject;
    cp.on("error", reject);
    cp.on("exit", (code) => {
      if (!settled && pending.size > 0) {
        reject(new CliError(`app-server exited early with code ${code}`));
        return;
      }
      resolve(code);
    });
  });

  readJsonLines(cp.stdout, handle);
  readJsonLines(cp.stderr, () => {});

  cp.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "cx", version: VERSION } } }) + "\n");
  const init = await waitFor(1);
  if (!init || typeof init !== "object") throw new CliError("app-server initialize returned no data");

  cp.stdin.write(JSON.stringify(request) + "\n");
  const result = await waitFor(request.id);
  finish();
  await exited.catch(() => {});
  return { init, result, events };
}

function normalizeRateLimitSnapshot(payload) {
  const bucket = payload?.rateLimitsByLimitId?.codex || payload?.rateLimits || null;
  const primary = bucket?.primary || null;
  const secondary = bucket?.secondary || null;
  return {
    bucket,
    primary,
    secondary,
    resetAt: primary?.resetsAt ?? secondary?.resetsAt ?? null,
    usedPercent: primary?.usedPercent ?? secondary?.usedPercent ?? null,
    windowDurationMins: primary?.windowDurationMins ?? secondary?.windowDurationMins ?? null,
    planType: bucket?.planType ?? null,
    limitId: bucket?.limitId ?? null,
    limitName: bucket?.limitName ?? null,
    rateLimitReachedType: bucket?.rateLimitReachedType ?? null,
    credits: bucket?.credits ?? null,
  };
}

async function fetchAccountRateLimit(accountHome) {
  const { result } = await requestAppServer(accountHome, {
    id: 2,
    method: "account/rateLimits/read",
    params: null,
  });
  return normalizeRateLimitSnapshot(result);
}

function isRateLimited(stdout = "", stderr = "") {
  return RATE_LIMIT_RE.test(`${stdout}\n${stderr}`);
}

function formatDuration(ms) {
  if (ms <= 0) return "now";
  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${String(hours % 24).padStart(2, "0")}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function formatMinutesWindow(mins) {
  if (mins == null) return "-";
  if (mins % (24 * 60) === 0) return `${mins / (24 * 60)}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

function formatClock(ms) {
  return new Date(ms).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatShortClock(ms, now = Date.now()) {
  const date = new Date(ms);
  const ref = new Date(now);
  const sameDay = date.getFullYear() === ref.getFullYear()
    && date.getMonth() === ref.getMonth()
    && date.getDate() === ref.getDate();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${hh}:${mm}`;
}

function accountRows(store, now = Date.now()) {
  const active = store.active();
  return store.listAccounts().map((account) => {
    const accountHome = store.accountHome(account);
    const limit = store.limitState(account);
    const resetAt = Number(limit?.resetAt || 0);
    const limited = resetAt > now;
    return {
      account,
      active: account === active,
      auth: fs.existsSync(path.join(accountHome, "auth.json")),
      limited,
      resetAt,
      remaining: limited ? resetAt - now : 0,
    };
  });
}

async function accountLimitRows(store, { cacheMs = 0, now = Date.now() } = {}) {
  const cached = store.rateLimitCache(cacheMs, now);
  if (cached) return cached;

  const rows = await Promise.all(store.listAccounts().map(async (account) => {
    const accountHome = store.accountHome(account);
    try {
      const snapshot = await fetchAccountRateLimit(accountHome);
      return {
        account,
        active: account === store.active(),
        auth: fs.existsSync(path.join(accountHome, "auth.json")),
        ...snapshot,
      };
    } catch (error) {
      return {
        account,
        active: account === store.active(),
        auth: fs.existsSync(path.join(accountHome, "auth.json")),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
  if (cacheMs > 0) store.writeRateLimitCache(rows, now);
  return rows;
}

function printLimitTable(rows, now = Date.now()) {
  if (rows.length === 0) throw new CliError("no accounts registered");
  console.log("Account            Status       Used   Window   Reset                 Remaining");
  console.log("-----------------  -----------  -----  -------  --------------------  ---------");
  for (const row of rows) {
    const account = `${row.active ? "*" : " "} ${row.account}`.padEnd(17);
    const status = rowLimitStatus(row).padEnd(11);
    const used = row.usedPercent == null ? "-".padEnd(5) : `${String(row.usedPercent).padStart(3)}%`.padEnd(5);
    const window = formatMinutesWindow(row.windowDurationMins).padEnd(7);
    const reset = (row.resetAt ? formatClock(row.resetAt * 1000) : "-").padEnd(20);
    const remaining = row.resetAt ? formatDuration((row.resetAt * 1000) - now) : "-";
    console.log(`${account}  ${status}  ${used}  ${window}  ${reset}  ${remaining}`);
  }
}

function rowLimitStatus(row) {
  if (row.error) return "error";
  if (row.rateLimitReachedType) return row.rateLimitReachedType;
  if (row.usedPercent != null && row.usedPercent >= 100) return "limited";
  return "ready";
}

function formatStatusLine(rows, now = Date.now()) {
  if (rows.length === 0) return "cx:no-accounts";
  return rows.map((row) => {
    const prefix = row.active ? "*" : "";
    if (row.error) return `${prefix}${row.account}:error`;
    const status = rowLimitStatus(row);
    const used = row.usedPercent == null ? "?%" : `${Math.round(row.usedPercent)}%`;
    const window = formatMinutesWindow(row.windowDurationMins);
    const reset = row.resetAt ? formatShortClock(row.resetAt * 1000, now) : "-";
    const remaining = row.resetAt ? formatDuration((row.resetAt * 1000) - now).replace(/\s+/g, "") : "-";
    if (status !== "ready") return `${prefix}${row.account}:${used} ${status} reset ${reset}(${remaining})`;
    return `${prefix}${row.account}:${used}/${window} reset ${reset}`;
  }).join(" | ");
}

function parseStatuslineArgs(args) {
  const options = { activeOnly: false, cacheMs: 60_000 };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--active") {
      options.activeOnly = true;
    } else if (arg === "--fresh" || arg === "--no-cache") {
      options.cacheMs = 0;
    } else if (arg === "--cache-ms") {
      options.cacheMs = Number.parseInt(args[++i], 10);
      if (!Number.isFinite(options.cacheMs) || options.cacheMs < 0) throw new CliError("usage: cx statusline [--active] [--fresh] [--cache-ms <ms>]");
    } else {
      throw new CliError(`unknown statusline option: ${arg}`);
    }
  }
  return options;
}

function selectedAccount(store, explicit) {
  if (explicit) {
    if (!store.listAccounts().includes(explicit)) throw new CliError(`unknown account: ${explicit}`);
    return explicit;
  }
  const active = store.active();
  if (!active) throw new CliError("no active account; run `cx use <account>` or `cx pick` first");
  return active;
}

function nextAccountName(store, current = store.active()) {
  const accounts = store.listAccounts();
  if (accounts.length === 0) throw new CliError("no accounts registered");
  if (!accounts.includes(current)) return accounts[0];
  return accounts[(accounts.indexOf(current) + 1) % accounts.length];
}

function parseGlobal(argv) {
  const options = { account: null, autoNext: false, maxAttempts: null };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-a" || arg === "--account") {
      options.account = validateAccount(argv[++i]);
      continue;
    }
    if (arg === "--auto-next") {
      options.autoNext = true;
      continue;
    }
    if (arg === "--max-attempts") {
      options.maxAttempts = Number.parseInt(argv[++i], 10);
      continue;
    }
    rest.push(...argv.slice(i));
    break;
  }
  return { options, rest };
}

function copyIfExists(srcDir, destDir, file, overwrite) {
  const src = path.join(srcDir, file);
  const dest = path.join(destDir, file);
  if (!fs.existsSync(src)) return false;
  if (fs.existsSync(dest) && !overwrite) throw new CliError(`${dest} already exists; pass --overwrite to replace it`);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

function printHelp() {
  console.log(`cx ${VERSION}

Usage:
  cx                                        open the cx account shell
  cx shell                                  open the cx account shell
  cx tui                                    open native codex TUI with the active account
  cx [codex args...]                         run native codex with the active account
  cx -a <account> [codex args...]            run native codex with a specific account
  cx --auto-next exec "prompt"               retry next account when rate limit output is detected

Accounts:
  cx login <name> [-- <codex login args>]    login using isolated CODEX_HOME
  cx import <name> [--overwrite]             copy auth/config from $CODEX_HOME or ~/.codex
  cx list                                    list accounts
  cx limits                                  show usage reset windows for all accounts
  cx gui                                     live terminal dashboard for all accounts
  cx statusline                              print one-line usage status for prompts/status bars
  cx use <name>                              set active account
  cx current                                 print active account
  cx next                                    rotate active account
  cx pick                                    choose active account in a small terminal picker
  cx limit [name]                            mark an account as rate-limited for 5h
  cx unlimit [name]                          clear a rate-limit marker
  cx status [name]                           run 'codex login status'
  cx remove <name> --yes                     delete an account

Integration:
  cx hook powershell                         print a PowerShell function that maps 'codex' to 'cx'
  cx hook bash                               print a bash/zsh function that maps 'codex' to 'cx'
  cx where                                   show paths and native codex binary

Examples:
  cx login main
  cx login sub
  cx pick
  cx
  cx tui
  cx exec "review this repo"
  cx -a sub exec "continue the task"
`);
}

function printShellHelp() {
  console.log(`Slash commands:
  /account                  show active account
  /account <name>           switch active account
  /accounts                 list accounts
  /limits                   show usage reset windows
  /gui                      open live reset dashboard
  /statusline               print one-line usage status
  /next                     rotate active account
  /pick                     open account picker
  /limit [name]             mark account as rate-limited locally
  /unlimit [name]           clear rate-limit marker
  /login <name> [args...]   run codex login for an account
  /status [name]            run codex login status
  /codex [args...]          start native codex TUI/command with the active account
  /help                     show this help
  /exit                     quit

Plain text is sent as: codex exec <your text>`);
}

function commandLogin(store, args) {
  const account = args.shift();
  if (!account) throw new CliError("usage: cx login <account> [-- <codex login args>]");
  const accountHome = store.ensureAccount(account);
  const result = runNative(accountHome, ["login", ...stripDashDash(args)]);
  if (result.status === 0 && !store.active()) store.setActive(account);
  return result.status ?? 1;
}

function commandImport(store, args) {
  const account = args.shift();
  if (!account) throw new CliError("usage: cx import <account> [--source <dir>] [--overwrite]");
  let source = nativeCodexHome();
  let overwrite = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--overwrite") overwrite = true;
    else if (args[i] === "--source") source = path.resolve(args[++i]);
    else throw new CliError(`unknown import option: ${args[i]}`);
  }

  if (!fs.existsSync(source)) throw new CliError(`source CODEX_HOME does not exist: ${source}`);
  const accountHome = store.ensureAccount(account);
  const copied = ["auth.json", "config.toml", "AGENTS.md"].filter((file) => copyIfExists(source, accountHome, file, overwrite));
  if (copied.length === 0) throw new CliError(`no auth.json, config.toml, or AGENTS.md found in ${source}`);
  if (!store.active()) store.setActive(account);
  console.log(`Imported ${account}: ${copied.join(", ")}`);
  return 0;
}

function commandList(store) {
  const active = store.active();
  for (const account of store.listAccounts()) {
    const accountHome = store.accountHome(account);
    const auth = fs.existsSync(path.join(accountHome, "auth.json")) ? "auth" : "no-auth";
    console.log(`${account === active ? "*" : " "} ${account}\t${auth}\t${accountHome}`);
  }
  return 0;
}

async function commandLimits(store) {
  const rows = await accountLimitRows(store);
  printLimitTable(rows);
  return 0;
}

async function commandStatusline(store, args = []) {
  const options = parseStatuslineArgs(args);
  let rows = await accountLimitRows(store, { cacheMs: options.cacheMs });
  if (options.activeOnly) {
    const active = store.active();
    if (!active) throw new CliError("no active account");
    rows = rows.filter((row) => row.account === active);
  }
  console.log(formatStatusLine(rows));
  return 0;
}

async function commandGui(store) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const rows = await accountLimitRows(store);
    printLimitTable(rows);
    return 0;
  }

  const render = async () => {
    const rows = await accountLimitRows(store);
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write("Codex Accounts - usage reset dashboard\n\n");
    try {
      printLimitTable(rows);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`cx: ${message}\n`);
    }
    process.stdout.write("\nq: quit   r: refresh   cx gui refreshes from app-server\n");
  };

  return await new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    let timer = null;
    const cleanup = (code) => {
      if (timer) clearInterval(timer);
      process.stdin.off("data", onData);
      process.stdin.setRawMode(wasRaw);
      process.stdout.write("\n");
      resolve(code);
    };
    const onData = (chunk) => {
      const key = chunk.toString("utf8");
      if (key === "\u0003" || key === "q") return cleanup(0);
      if (key === "r") void render().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(`cx: ${message}\n`);
      });
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
    void render().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`cx: ${message}\n`);
    });
    timer = setInterval(() => {
      void render().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(`cx: ${message}\n`);
      });
    }, 30000);
  });
}

function commandLimit(store, args) {
  const account = args[0] || store.active();
  if (!account) throw new CliError("usage: cx limit [account]");
  store.markLimited(account);
  const resetAt = store.limitState(account)?.resetAt;
  console.log(`${account} limited until ${formatClock(resetAt)}`);
  return 0;
}

function commandUnlimit(store, args) {
  const account = args[0] || store.active();
  if (!account) throw new CliError("usage: cx unlimit [account]");
  store.clearLimit(account);
  console.log(`${account} cleared`);
  return 0;
}

function commandUse(store, args) {
  const account = args[0];
  if (!account) throw new CliError("usage: cx use <account>");
  store.setActive(account);
  console.log(account);
  return 0;
}

function commandCurrent(store) {
  const active = store.active();
  if (!active) throw new CliError("no active account");
  console.log(active);
  return 0;
}

function commandNext(store) {
  const account = nextAccountName(store);
  store.setActive(account);
  console.log(account);
  return 0;
}

async function commandPick(store) {
  const accounts = store.listAccounts();
  if (accounts.length === 0) throw new CliError("no accounts registered");
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return commandNext(store);
  }

  let index = Math.max(0, accounts.indexOf(store.active()));
  const render = () => {
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write("Codex account\n\n");
    accounts.forEach((account, i) => {
      const home = store.accountHome(account);
      const auth = fs.existsSync(path.join(home, "auth.json")) ? "" : "  no auth";
      process.stdout.write(`${i === index ? ">" : " "} ${account}${auth}\n`);
    });
    process.stdout.write("\nEnter: use   j/k or arrows: move   q: quit\n");
  };

  return await new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    render();
    const cleanup = (code) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(wasRaw);
      process.stdout.write("\n");
      resolve(code);
    };
    const onData = (chunk) => {
      const key = chunk.toString("utf8");
      if (key === "\u0003" || key === "q") return cleanup(130);
      if (key === "\r" || key === "\n") {
        store.setActive(accounts[index]);
        console.log(accounts[index]);
        return cleanup(0);
      }
      if (key === "\x1b[A" || key === "k") index = (index - 1 + accounts.length) % accounts.length;
      if (key === "\x1b[B" || key === "j") index = (index + 1) % accounts.length;
      render();
    };
    process.stdin.on("data", onData);
  });
}

async function askLine(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

async function handleShellLine(store, line) {
  if (!line.startsWith("/")) {
    const account = selectedAccount(store, null);
    const result = runNative(store.accountHome(account), ["exec", line]);
    if ((result.status ?? 1) !== 0) process.exitCode = result.status ?? 1;
    return true;
  }

  const [slash, ...args] = splitCommandLine(line.slice(1));
  switch (slash) {
    case "q":
    case "quit":
    case "exit":
      return false;
    case "h":
    case "help":
      printShellHelp();
      return true;
    case "account":
    case "use":
      if (!args[0]) {
        console.log(store.active() || "no active account");
      } else {
        store.setActive(args[0]);
        console.log(args[0]);
      }
      return true;
    case "accounts":
    case "list":
    case "ls":
      commandList(store);
      return true;
    case "limits":
      await commandLimits(store);
      return true;
    case "gui":
    case "dashboard":
      await commandGui(store);
      return true;
    case "statusline":
      await commandStatusline(store, args);
      return true;
    case "next":
    case "switch":
      commandNext(store);
      return true;
    case "limit":
      commandLimit(store, args);
      return true;
    case "unlimit":
    case "clear-limit":
      commandUnlimit(store, args);
      return true;
    case "pick":
      await commandPick(store);
      return true;
    case "login":
      commandLogin(store, args);
      return true;
    case "status":
      commandStatus(store, args);
      return true;
    case "codex": {
      const account = selectedAccount(store, null);
      const result = runNative(store.accountHome(account), args);
      if ((result.status ?? 1) !== 0) process.exitCode = result.status ?? 1;
      return true;
    }
    default:
      console.log(`unknown slash command: /${slash}`);
      printShellHelp();
      return true;
  }
}

async function commandShell(store) {
  store.ensure();
  console.log("cx account shell. Type /help for commands.");

  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        if (!(await handleShellLine(store, line))) break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`cx: ${message}`);
      }
    }
    return process.exitCode || 0;
  }

  while (true) {
    const active = store.active();
    const prompt = active ? `cx:${active}> ` : "cx:no-account> ";
    const line = (await askLine(prompt)).trim();
    if (!line) continue;

    try {
      if (!(await handleShellLine(store, line))) return process.exitCode || 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`cx: ${message}`);
    }
  }
}

function commandStatus(store, args) {
  const accounts = args[0] ? [validateAccount(args[0])] : store.listAccounts();
  if (accounts.length === 0) throw new CliError("no accounts registered");
  let exitCode = 0;
  for (const account of accounts) {
    if (!store.listAccounts().includes(account)) throw new CliError(`unknown account: ${account}`);
    console.log(`== ${account} ==`);
    const result = runNative(store.accountHome(account), ["login", "status"]);
    exitCode ||= result.status ?? 1;
  }
  return exitCode;
}

function commandWhere(store) {
  console.log(`accounts_home=${store.root}`);
  console.log(`native_codex_home=${nativeCodexHome()}`);
  console.log(`native_codex_bin=${resolveCodexBin()}`);
  const active = store.active();
  if (active) {
    console.log(`active=${active}`);
    console.log(`active_codex_home=${store.accountHome(active)}`);
  }
  return 0;
}

function commandRemove(store, args) {
  const account = args.shift();
  if (!account) throw new CliError("usage: cx remove <account> --yes");
  if (!args.includes("--yes")) throw new CliError("removal requires --yes");
  const accountHome = store.accountHome(account);
  if (!fs.existsSync(accountHome)) throw new CliError(`unknown account: ${account}`);
  fs.rmSync(accountHome, { recursive: true, force: true });
  if (store.active() === account) {
    const state = store.state();
    delete state.active;
    store.writeState(state);
  }
  return 0;
}

function commandHook(args) {
  const shell = args[0] || "";
  if (shell === "powershell" || shell === "pwsh") {
    console.log("function codex { cx @args }");
    console.log("function cxa { cx pick }");
    console.log("function cxs { cx statusline @args }");
    return 0;
  }
  if (shell === "bash" || shell === "zsh" || shell === "sh") {
    console.log("codex() { cx \"$@\"; }");
    console.log("cxa() { cx pick; }");
    console.log("cxs() { cx statusline \"$@\"; }");
    return 0;
  }
  throw new CliError("usage: cx hook powershell|bash");
}

function runWithAccount(store, options, codexArgs) {
  const start = selectedAccount(store, options.account);
  if (!options.autoNext) {
    return runNative(store.accountHome(start), codexArgs).status ?? 1;
  }

  const accounts = store.listAccounts();
  const startIndex = accounts.indexOf(start);
  const order = accounts.slice(startIndex).concat(accounts.slice(0, startIndex));
  const attempts = Math.min(options.maxAttempts || order.length, order.length);

  for (let i = 0; i < attempts; i += 1) {
    const account = order[i];
    process.stderr.write(`[cx] ${account} (${i + 1}/${attempts})\n`);
    const result = runNative(store.accountHome(account), codexArgs, { capture: true });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if ((result.status ?? 1) === 0) {
      store.setActive(account);
      store.clearLimit(account);
      return 0;
    }
    if (!isRateLimited(result.stdout, result.stderr)) return result.status ?? 1;
    store.markLimited(account);
    if (i + 1 < attempts) process.stderr.write("[cx] rate limit detected; switching account\n");
  }
  return 1;
}

async function dispatch(argv, store = new Store()) {
  const { options, rest } = parseGlobal(argv);
  const command = rest[0];
  const args = rest.slice(1);

  if (!command) {
    if (process.stdin.isTTY && process.stdout.isTTY) return await commandShell(store);
    return runWithAccount(store, options, []);
  }
  if (command === "help" || command === "-h" || command === "--help") {
    printHelp();
    return 0;
  }
  if (command === "version" || command === "--version") {
    console.log(`cx ${VERSION}`);
    return 0;
  }
  switch (command) {
    case "shell": return await commandShell(store);
    case "tui": return runWithAccount(store, options, args);
    case "login": return commandLogin(store, args);
    case "import": return commandImport(store, args);
    case "list":
    case "ls": return commandList(store);
    case "limits": return await commandLimits(store);
    case "statusline": return await commandStatusline(store, args);
    case "gui":
    case "dashboard": return await commandGui(store);
    case "use": return commandUse(store, args);
    case "current": return commandCurrent(store);
    case "next":
    case "switch": return commandNext(store);
    case "limit": return commandLimit(store, args);
    case "unlimit":
    case "clear-limit": return commandUnlimit(store, args);
    case "pick": return await commandPick(store);
    case "status": return commandStatus(store, args);
    case "where": return commandWhere(store);
    case "remove":
    case "rm": return commandRemove(store, args);
    case "hook": return commandHook(args);
    default:
      return runWithAccount(store, options, rest);
  }
}

async function main(argv = process.argv.slice(2)) {
  try {
    const code = await dispatch(argv);
    process.exitCode = code;
    return code;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`cx: ${message}`);
    process.exitCode = 2;
    return 2;
  }
}

const modulePath = fs.realpathSync(fileURLToPath(import.meta.url));
const invokedPath = process.argv[1] ? fs.realpathSync(path.resolve(process.argv[1])) : "";
if (modulePath === invokedPath) {
  await main();
}

export {
  Store,
  dispatch,
  accountRows,
  formatStatusLine,
  formatDuration,
  isRateLimited,
  nextAccountName,
  parseGlobal,
  normalizeRateLimitSnapshot,
  splitCommandLine,
  validateAccount,
};
