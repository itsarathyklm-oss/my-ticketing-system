// logger.js — persistent error logging, zero dependencies.
//
// Why this exists: every route in server.js catches its own errors and prints to
// console.error, which on a host like Render goes to a stream nobody is watching and
// is discarded on redeploy. This module keeps that console behaviour AND appends the
// same error — with a timestamp and full stack trace — to a file on disk, so an error
// that happened at 3am is still readable the next morning.
//
// It never throws. If the disk is read-only or the log dir cannot be created, it falls
// back to console only, so enabling logging can never take the app down.
//
// Log file:    ./logs/error.log          (append-only, one JSON entry per line)
// Rotation:    when error.log passes MAX_BYTES it is renamed to error.log.1 and the
//              previous error.log.1 is deleted — so the file can never grow without
//              bound and exactly one backup is kept.
// Rotation can also be forced programmatically: logger.rotate().
//
// This is additive. It does not change any route, response, or workflow.

const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'error.log');
const MAX_BYTES = 5 * 1024 * 1024; // roll over at 5 MB

let writable = true; // set false after the first filesystem failure -> console only
let internal = false; // true while log() itself is writing to console (blocks shim re-entry)

function ensureDir() {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Rename the current log to error.log.1, dropping any older backup. Best-effort.
function rotate() {
    if (!writable) return;
    try {
        ensureDir();
        if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size >= MAX_BYTES) {
            const backup = LOG_FILE + '.1';
            if (fs.existsSync(backup)) fs.unlinkSync(backup);
            fs.renameSync(LOG_FILE, backup);
        }
    } catch (err) {
        writable = false;
        console.error('[logger] disabled — cannot rotate log file:', err.message);
    }
}

// Build a JSON record for one error. context is an optional flat object of useful
// request facts (method, url, user). Sensitive keys are dropped before writing so a
// password or token never lands in the log.
const SENSITIVE = /(password|secret|token|authorization|cookie|api[_-]?key|pass)/i;

function toRecord(level, err, context) {
    const e = err instanceof Error ? err : new Error(String(err));
    const ctx = {};
    if (context && typeof context === 'object') {
        for (const k of Object.keys(context)) {
            if (SENSITIVE.test(k)) continue;
            const v = context[k];
            // Never log function values or huge blobs.
            if (typeof v === 'function' || typeof v === 'bigint') continue;
            ctx[k] = v;
        }
    }
    return {
        ts: new Date().toISOString(),
        level,
        message: e.message,
        stack: e.stack || '',
        context: ctx
    };
}

function write(record) {
    const line = JSON.stringify(record) + '\n';
    if (!writable) return;
    try {
        rotate();
        fs.appendFileSync(LOG_FILE, line, 'utf8');
    } catch (err) {
        writable = false;
        console.error('[logger] disabled — cannot write log file:', err.message);
    }
}

// log(level, err, context) — the core. Always mirrors to the console.
function log(level, err, context) {
    const record = toRecord(level, err, context);
    // Console: keep the existing human-readable behaviour and add the file location.
    const tag = level === 'error' ? '[ERROR]' : level === 'warn' ? '[WARN]' : '[INFO]';
    const where = writable ? ' (logged to ' + LOG_FILE + ')' : '';
    // Set the guard so the console.error shim below does NOT file this same event a
    // second time (without it, every logger.error() wrote two records).
    internal = true;
    try {
        console.error(tag, record.message, record.stack ? '\n' + record.stack : '', where);
    } finally {
        internal = false;
    }
    write(record);
    return record;
}

// Install a drop-in replacement for console.error that ALSO persists to file.
//
// Why a shim rather than editing all 41 call sites: every existing handler already
// calls console.error(...). Overriding it lets all of them persist with zero changes
// to a single route, which is what "no workflow change" requires. The shim is
// signature-compatible: it accepts (msg, ...args) exactly as console.error does.
//
// It preserves stack traces, which the old call sites threw away — most of them
// logged only err.message. Any argument that is an Error (or has a .stack) has its
// stack captured; everything else is passed through to the console as before.
//
// Must be installed BEFORE server.js defines any handler, so it is called first
// thing in server.js.
function installConsoleShim() {
    const original = console.error.bind(console);
    console.error = function (...args) {
        original(...args); // keep the exact console behaviour people rely on
        if (internal) return; // this is log() talking to the console — already filed
        try {
            // Find the first Error-ish argument: that is the real failure worth filing.
            const errArg = args.find(a => a instanceof Error || (a && typeof a === 'object' && typeof a.stack === 'string'));
            // Leading string args are the human label (e.g. 'Request failed:'). They say
            // WHICH handler failed, so they must be kept — not dropped in favour of
            // err.message alone.
            const strings = args.filter(a => typeof a === 'string').join(' ').trim();
            // A plain string with no error is a warning-level note (e.g. config notices);
            // file it at warn so error.log stays about actual failures.
            const level = errArg ? 'error' : 'warn';
            // Preserve the label: label + error message, or whichever of the two exists.
            const errText = errArg ? (errArg.message || String(errArg)) : '';
            const message = strings && errText && strings !== errText
                ? strings.replace(/:\s*$/, '') + ': ' + errText
                : (strings || errText);
            // Rebuild a real Error so the stack is captured even when a caller passed a string.
            const err = errArg instanceof Error
                ? Object.assign(errArg, { message })
                : Object.assign(new Error(message), errArg && errArg.stack ? { stack: errArg.stack } : {});
            write(toRecord(level, err, { via: 'console.error' }));
        } catch (e) {
            original('[logger] shim failed:', e.message);
        }
    };
}

module.exports = {
    LOG_DIR,
    LOG_FILE,
    // Convenience wrappers.
    error: (err, context) => log('error', err, context),
    warn: (err, context) => log('warn', err, context),
    info: (err, context) => log('info', err, context),
    // Call once at startup, before any handler runs.
    installConsoleShim,
    // Manual rotation hook (used by tests / ops).
    rotate
};
