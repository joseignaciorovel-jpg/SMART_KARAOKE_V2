const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
function harness(request) {
  const window = {
    document: { hidden: false },
    navigator: { wakeLock: { request } },
  };
  vm.runInNewContext(fs.readFileSync("public/js/wake-lock.js", "utf8"), {
    window,
  });
  const messages = [];
  return {
    window,
    lock: new window.ScreenAwake((s) => messages.push(s)),
    messages,
  };
}
function sentinel() {
  return {
    released: false,
    async release() {
      this.released = true;
    },
    addEventListener() {},
  };
}
test("screen lock is released on hiding and explicitly requested again on return", async () => {
  const all = [];
  const h = harness(async () => {
    const s = sentinel();
    all.push(s);
    return s;
  });
  await h.lock.setEnabled(true);
  assert.equal(all.length, 1);
  h.window.document.hidden = true;
  await h.lock.visibilityChanged();
  assert.equal(all[0].released, true);
  h.window.document.hidden = false;
  await h.lock.visibilityChanged();
  assert.equal(all.length, 2);
  await h.lock.setEnabled(false);
  assert.equal(all[1].released, true);
});
test("late grants after stopping are released, with recovery if enabled again while pending", async () => {
  let grant;
  let requests = 0;
  const all = [];
  const h = harness(() => {
    requests++;
    if (requests === 1) return new Promise((r) => (grant = r));
    const s = sentinel();
    all.push(s);
    return Promise.resolve(s);
  });
  const pending = h.lock.setEnabled(true);
  await h.lock.setEnabled(false);
  void h.lock.setEnabled(true);
  const old = sentinel();
  grant(old);
  await pending;
  await Promise.resolve();
  assert.equal(old.released, true);
  assert.equal(requests, 2);
  assert.equal(h.lock.sentinel, all[0]);
  await h.lock.setEnabled(false);
});
test("a denied wake lock reports the limitation without retrying endlessly", async () => {
  let requests = 0;
  const h = harness(async () => {
    requests++;
    throw Error("denied");
  });
  await h.lock.setEnabled(true);
  assert.equal(requests, 1);
  assert.match(h.messages.at(-1), /no permitió/);
});
