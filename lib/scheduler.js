// node-cron scheduling per sync pair: per-pair interval (default 6h, min 15m),
// deterministic per-pair minute offset, catch-up on restart when overdue.
import { cron } from './deps.js';

const INTERVAL_CHOICES = [15, 30, 60, 120, 180, 240, 360, 480, 720, 1440];

// minutes + pair id -> cron expression. Sub-hourly intervals must divide 60
// (15/20/30); other sub-hourly values normalize down to 15m; interval
// clamping (15..1440) and the existing hour-rounding behavior are unchanged.
// Each pair gets a deterministic minute offset — minute = (pairId * 7) %
// intervalMinutes — so same-interval pairs never fire on the same wall-clock
// minute (7 is invertible mod 15/20/30/60, so distinct pair ids stay distinct
// anchors). A pure "*/m" step cannot express a phase shift: sub-hourly pairs
// with a non-zero offset emit an explicit minute list (offset, offset+m, ...
// < 60); offset 0 keeps the plain step form. Hourly+ pins the minute field;
// cron minutes cap at 59, so the in-interval offset is taken mod 60.
// Seconds are 0 (5-field cron).
export function cronExprForInterval(minutes, pairId) {
  let m = Math.max(15, Math.min(1440, Math.floor(Number(minutes) || 0)));
  const pairNum = Math.max(0, Math.floor(Number(pairId) || 0));
  if (m < 60) {
    if (![15, 20, 30].includes(m)) m = 15;
    const offset = (pairNum * 7) % m;
    if (offset === 0) return `*/${m} * * * *`;
    const fireMinutes = [];
    for (let t = offset; t < 60; t += m) fireMinutes.push(t);
    return `${fireMinutes.join(',')} * * * *`;
  }
  const hours = Math.max(1, Math.min(24, Math.round(m / 60)));
  return `${(pairNum * 7) % 60} */${hours} * * *`;
}

export class Scheduler {
  constructor({ db, config, runPair, logger }) {
    this.db = db;
    this.config = config;
    this.runPair = runPair;
    this.logger = logger;
    this._tasks = new Map(); // pairId -> { task, expr, timer }
  }

  startAll() {
    for (const pair of this.db.listPairs()) {
      if (pair.enabled) this.addPair(pair);
      this.maybeCatchUp(pair);
    }
    this.logger.info(`Scheduler started: ${this._tasks.size} active schedule(s), timezone ${this.config.timezone}`);
  }

  addPair(pair) {
    this.removePair(pair.id);
    if (!pair.enabled) return null;
    // Deterministic minute anchor per pair — no random jitter: pairs sharing
    // an interval fire minutes apart instead of simultaneously (see
    // cronExprForInterval).
    const expr = cronExprForInterval(pair.interval_minutes, pair.id);
    const task = cron.schedule(expr, () => this.tick(pair.id), { timezone: this.config.timezone });
    try { task.start(); } catch { /* already started by schedule() in some versions */ }
    this._tasks.set(String(pair.id), { task, expr });
    this.logger.info(`Scheduled pair ${pair.id} "${pair.name}": "${expr}" (${pair.interval_minutes} min, deterministic anchor from pair id)`);
    return expr;
  }

  removePair(pairId) {
    const t = this._tasks.get(String(pairId));
    if (!t) return false;
    try { t.task.stop(); } catch { /* ignore */ }
    try { t.task.destroy?.(); } catch { /* ignore */ }
    if (t.timer) clearTimeout(t.timer);
    this._tasks.delete(String(pairId));
    return true;
  }

  tick(pairId) {
    Promise.resolve(this.runPair(pairId, { trigger: 'scheduled' }))
      .then((res) => {
        if (res?.status && res.status !== 'success') {
          this.logger.warn(`Scheduled sync for pair ${pairId}: ${res.status}${res.error ? ` — ${res.error}` : ''}`);
        }
      })
      .catch((err) => this.logger.error(`Scheduled sync for pair ${pairId} failed: ${err.message}`));
  }

  // Restart catch-up: if the pair never ran or last success is older than the
  // interval, run soon (staggered per pair to avoid a thundering herd).
  maybeCatchUp(pair) {
    if (!pair.enabled) return false;
    const status = this.db.getStatus(pair.id);
    const lastMs = Math.max(
      status?.last_success_at ? Date.parse(status.last_success_at) || 0 : 0,
      status?.last_run_at ? Date.parse(status.last_run_at) || 0 : 0,
    );
    const intervalMs = Math.max(15, Number(pair.interval_minutes) || 15) * 60_000;
    if (Date.now() - lastMs < intervalMs) return false;
    const delay = Math.min(20_000, 2_000 + ((Number(pair.id) % 10) * 1_500));
    const timer = setTimeout(() => this.tick(pair.id), delay);
    timer.unref?.();
    this._tasks.get(String(pair.id))?.timer ?? null;
    this.logger.info(`Pair ${pair.id} "${pair.name}" is overdue — catch-up run in ${Math.round(delay / 1000)}s`);
    return true;
  }

  stopAll() {
    for (const id of [...this._tasks.keys()]) this.removePair(id);
    this.logger.info('Scheduler stopped');
  }

  exprFor(pairId) { return this._tasks.get(String(pairId))?.expr ?? null; }
  size() { return this._tasks.size; }
}

export { INTERVAL_CHOICES as SYNC_INTERVAL_CHOICES };
