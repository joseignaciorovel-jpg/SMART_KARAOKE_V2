const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { fork } = require("node:child_process");
const { io } = require("socket.io-client");
const once = (socket, name) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout " + name)), 3000);
    socket.once(name, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
const ack = (socket, name, payload) =>
  new Promise((resolve, reject) =>
    socket
      .timeout(3000)
      .emit(name, payload, (error, value) =>
        error ? reject(error) : resolve(value),
      ),
  );
async function launch(directory) {
  const child = fork(path.join(__dirname, "fixtures/party-server.js"), {
    env: {
      ...process.env,
      SESSION_DATA_DIR: directory,
      HOST_KEY: "restart-test-host",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let errors = "";
  child.stderr.on("data", (chunk) => (errors += chunk));
  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Child startup timeout " + errors)),
      5000,
    );
    child.once("message", (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("Child exited " + code + " " + errors));
    });
  });
  const clients = [];
  return {
    async connect() {
      const socket = io(`http://127.0.0.1:${address.port}`, {
        autoConnect: false,
        reconnection: false,
      });
      clients.push(socket);
      const ready = once(socket, "connect");
      socket.connect();
      await ready;
      return socket;
    },
    async stop() {
      clients.forEach((s) => s.disconnect());
      const exit = new Promise((resolve) => child.once("exit", resolve));
      child.send("stop");
      await exit;
    },
    child,
  };
}
async function state(socket) {
  const pending = once(socket, "state-update");
  socket.emit("get-state");
  return pending;
}
async function join(socket, extra = {}) {
  const pending = once(socket, "nickname-set");
  socket.emit("join-team", { nickname: "Ana", team: "red", ...extra });
  return pending;
}
test("a real server restart restores queue, stable participant identity, support votes and lighting from private storage", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "firevoice-restart-"),
  );
  let runtime;
  try {
    runtime = await launch(directory);
    const host = await runtime.connect(),
      singer = await runtime.connect(),
      viewer = await runtime.connect();
    await ack(host, "authenticate-host", { key: "restart-test-host" });
    const s = await join(singer),
      v = await join(viewer, { nickname: "Público" });
    await ack(singer, "add-song", { url: "youtu.be/abcdefghijk" });
    await ack(singer, "add-song", { url: "youtu.be/12345678901" });
    const before = await state(host);
    await ack(viewer, "support-performance", { songId: before.currentSong.id });
    await ack(host, "set-lighting", { mode: "classic", intensity: 40 });
    await runtime.stop();
    runtime = await launch(directory);
    const screen = await runtime.connect(),
      returning = await runtime.connect(),
      returningViewer = await runtime.connect();
    const recovered = await join(returning, { sessionToken: s.sessionToken });
    await join(returningViewer, { sessionToken: v.sessionToken });
    const after = await state(screen);
    assert.equal(recovered.participantId, s.participantId);
    assert.equal(after.currentSong.id, before.currentSong.id);
    assert.equal(after.queue[0].id, before.queue[0].id);
    assert.deepEqual(after.lighting, { mode: "classic", intensity: 40 });
    assert.equal(after.persistence.configured, true);
    assert.equal(
      (
        await ack(returningViewer, "support-performance", {
          songId: after.currentSong.id,
        })
      ).ok,
      false,
    );
    assert.ok(!JSON.stringify(after).includes(s.sessionToken));
  } finally {
    if (runtime) await runtime.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
