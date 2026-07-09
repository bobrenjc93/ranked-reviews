// A small async concurrency limiter (semaphore).
//
// Acquire a slot before doing work, release it when done. When all slots are
// taken, acquire() waits until another holder releases. This lets us process
// many PRs "progressively" without launching every `claude -p` review at once.
class Semaphore {
  constructor(max) {
    this.max = Math.max(1, max);
    this.count = 0;
    this.waiters = [];
  }

  async acquire() {
    if (this.count < this.max) {
      this.count += 1;
      return;
    }

    // No free slot: park here until a holder releases and hands us the slot.
    await new Promise((resolve) => this.waiters.push(resolve));
  }

  release() {
    const next = this.waiters.shift();
    if (next) {
      // Hand the slot directly to the next waiter; count stays the same.
      next();
    } else {
      this.count -= 1;
    }
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// A per-key mutex: serializes async work that shares the same key. We use it to
// keep concurrent git operations on the same repo clone from racing.
class KeyedMutex {
  constructor() {
    this.tails = new Map();
  }

  run(key, fn) {
    const prev = this.tails.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);

    // Keep the chain alive but don't let rejections leak as unhandled.
    this.tails.set(
      key,
      next.then(
        () => {},
        () => {}
      )
    );

    return next;
  }
}

module.exports = { Semaphore, KeyedMutex };
