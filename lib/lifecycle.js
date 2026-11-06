'use strict';

// The server registry holds the plugin instance, not its configuration/status.
// Check at startup and on every dispatch boundary; never fall back to a stale root owner.
function isPluginOwner(handler, plugin, name = 'meshtask2') {
  return !!(plugin && handler && handler.plugins &&
    Object.prototype.hasOwnProperty.call(handler.plugins, name) && handler.plugins[name] === plugin);
}

class Lifecycle {
  constructor({ run, isOwner, onStop, onError = () => {}, intervalMs = 1000,
    setInterval: schedule = globalThis.setInterval, clearInterval: cancel = globalThis.clearInterval }) {
    for (const callback of [run, isOwner, onStop, onError, schedule, cancel]) {
      if (typeof callback !== 'function') throw new TypeError('Lifecycle callbacks must be functions.');
    }
    if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 2147483647) {
      throw new RangeError('Lifecycle intervalMs must be a positive timer-safe integer.');
    }
    this.run = run; this.isOwner = isOwner; this.onStop = onStop; this.onError = onError;
    this.intervalMs = intervalMs; this.schedule = schedule; this.cancel = cancel;
    this.started = false; this.stopped = false; this.timer = null;
    this.inFlight = null; this.stopPromise = null;
    this.active = this.active.bind(this);
  }

  report(error) {
    // Error reporting must not create unhandled rejections in upstream's unawaited hooks.
    try { Promise.resolve(this.onError(error)).catch(() => {}); } catch { /* best effort */ }
  }

  active() {
    if (!this.started || this.stopped) return false;
    try { if (this.isOwner() === true) return true; } catch (error) { this.report(error); }
    this.stop('ownership-lost');
    return false;
  }

  start() {
    if (this.started || this.stopped) return this;
    this.started = true;
    if (!this.active()) return this;
    try {
      // Keep checking ownership even when run is pending. A completion-only timeout
      // would leak its owner indefinitely if upstream disables during a stalled run.
      this.timer = this.schedule(() => {
        if (this.active() && !this.inFlight) this.tick();
      }, this.intervalMs);
      if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
    } catch (error) { this.stop('timer-error'); throw error; }
    return this;
  }

  tick() {
    if (!this.active()) return Promise.resolve(null);
    if (this.inFlight) return this.inFlight;
    // Install the flight before invoking user code, including synchronous callbacks.
    const flight = Promise.resolve().then(() => this.active() ? this.run(this.active) : null)
      .finally(() => { if (this.inFlight === flight) this.inFlight = null; });
    this.inFlight = flight;
    flight.catch((error) => this.report(error));
    return flight;
  }

  stop(reason = 'shutdown') {
    if (this.stopPromise) return this.stopPromise;
    // Synchronous barrier: the parent must recheck active() after each await and
    // immediately before claiming/sending. Already-started I/O cannot be revoked.
    this.stopped = true;
    if (this.timer !== null) { this.cancel(this.timer); this.timer = null; }
    const flight = this.inFlight;
    this.stopPromise = Promise.resolve().then(async () => {
      if (flight) { try { await flight; } catch { /* already reported by tick */ } }
      await this.onStop(reason);
    });
    this.stopPromise.catch((error) => this.report(error));
    return this.stopPromise;
  }
}

module.exports = { Lifecycle, isPluginOwner };
