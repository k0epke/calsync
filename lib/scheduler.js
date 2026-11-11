// node-cron scheduling per sync pair: per-pair interval (default 6h, min 15m),
// 0-5 minute jitter, catch-up on restart when overdue.
import { cron } from './deps.js';

const INTERVAL_CHOICES = [15, 30, 60, 120, 180, 240, 360, 480, 720, 1440];

// minutes -> cron expression. Sub-hourly intervals must divide 60 (15/20/30);
// other sub-hourly values normalize down to 15m. Hourly+ gets a fixed
// jitter minute in 0-5 as the cron minute field.
export function cronExprForInterval(minutes, jitterMinute) {
  let m = Math.max(15, Math.min(1440, Math.floor(Number(minutes) || 0)));
  if (m < 60) {
    if (![15, 20, 30].includes(m)) m = 15;
    return `*/${m} * * * *`;
  }
  const hours = Math.max(1, Math.min(24, Math.round(m / 60)));
  const j = Math.max(0, Math.min(5, Number.isFinite(jitterMinute) ? jitterMinute : 0));
  return `${j} */${hours} * * *`;
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
    const jitter = Math.floor(Math.random() * 6); // 0..5 minute jitter
    const expr = cronExprForInterval(pair.interval_minutes, jitter);
    const task = cron.schedule(expr, () => this.tick(pair.id), { timezone: this.config.timezone });
    try { task.start(); } catch { /* already started by schedule() in some versions */ }
    this._tasks.set(String(pair.id), { task, expr });
    this.logger.info(`Scheduled pair ${pair.id} "${pair.name}": "${expr}" (${pair.interval_minutes} min, jitter minute ${jitter})`);
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
