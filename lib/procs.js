// Registry of child processes (claude / git / gh) spawned for reviews and
// calibration. On shutdown we kill these so a restart doesn't leave orphaned
// `claude` processes running in the background.
const children = new Set();

function track(child) {
  if (!child) return child;
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

function killAll(signal = "SIGTERM") {
  let n = 0;
  for (const child of children) {
    try {
      child.kill(signal);
      n += 1;
    } catch {
      // already gone
    }
  }
  return n;
}

module.exports = { track, killAll, children };
