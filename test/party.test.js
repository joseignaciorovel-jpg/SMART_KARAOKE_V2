const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { Party } = require("../lib/party");
const { SessionStore, validateSnapshot } = require("../lib/session-store");
function song(id, extra = {}) {
  return {
    id,
    requesterId: "a",
    requester: "Ana",
    videoId: "abcdefghijk",
    title: "Tema",
    ...extra,
  };
}
function snapshot(party, currentSong = null) {
  return {
    version: 1,
    savedAt: Date.now(),
    queue: [song("waiting")],
    history: [],
    currentSong,
    sessions: [
      { id: "a", token: "a".repeat(64), nickname: "Ana", team: "red" },
    ],
    party: party.snapshot(),
    teamScores: { red: 0, blue: 0 },
    gameMode: "teams",
    chacalMode: "fiesta",
    allowBoo: false,
  };
}
test("ranking normalizes unique audience support, excludes self-votes and skipped songs, and separates duet results", () => {
  const p = new Party();
  let s = song("one");
  p.start(s, ["a", "b", "c"]);
  assert.equal(p.support("a", "one").ok, false);
  assert.equal(p.support("b", "old").ok, false);
  assert.equal(p.support("b", "one").ok, true);
  assert.equal(p.support("b", "one").ok, false);
  p.finish(s, true, ["a", "b", "c"]);
  assert.deepEqual(
    p.ranking().map((r) => [r.score, r.provisional, r.performances]),
    [[50, true, 1]],
  );
  s = song("two");
  p.start(s, ["a", "b"]);
  p.support("b", "two");
  p.finish(s, true, ["a", "b"]);
  assert.equal(p.ranking()[0].score, 75);
  assert.equal(p.ranking()[0].provisional, false);
  s = song("skip");
  p.start(s, ["a", "b"]);
  p.finish(s, false, ["a", "b"]);
  assert.equal(p.ranking()[0].performances, 2);
  s = song("duet", {
    kind: "duet",
    singerIds: ["a", "b"],
    requester: "Ana + Bea",
  });
  p.start(s, ["a", "b", "c"]);
  assert.equal(p.support("b", "duet").ok, false);
  p.support("c", "duet");
  p.finish(s, true, ["a", "b", "c"]);
  assert.equal(p.ranking("duet")[0].score, 100);
  assert.equal(p.ranking()[0].performances, 2);
});
test("duel needs both completed legs, permits one audience vote, hides partial results, closes automatically and handles ties / no votes", () => {
  const p = new Party();
  p.duels.push({
    id: "d",
    singers: ["a", "b"],
    names: ["Ana", "Bea"],
    status: "queued",
    completed: [],
    eligible: [],
    votes: [],
  });
  const first = song("first", { duelId: "d" }),
    second = song("second", { requesterId: "b", duelId: "d" });
  p.start(first, ["a", "b", "c", "e"]);
  p.finish(first, true, ["a", "b", "c", "e"]);
  assert.equal(p.duels[0].status, "performing");
  p.start(second, ["a", "b", "c", "e"]);
  p.finish(second, true, ["a", "b", "c", "e"]);
  assert.equal(p.duels[0].status, "voting");
  assert.equal(p.voteDuel("a", "d", "a").ok, false);
  assert.equal(p.voteDuel("new", "d", "b").ok, false);
  assert.equal(p.voteDuel("c", "d", "a").ok, true);
  assert.equal(p.voteDuel("c", "d", "b").ok, false);
  p.voteDuel("e", "d", "b");
  assert.equal(p.publicDuels()[0].counts, null);
  p.closeDue(Date.now() + 31000);
  assert.deepEqual(p.publicDuels()[0].percentages, [50, 50]);
  assert.equal(p.voteDuel("e", "d", "b").ok, false);
  assert.equal(p.ranking().length, 0);
  const q = new Party({
    duels: [
      {
        id: "q",
        singers: ["a", "b"],
        names: ["Ana", "Bea"],
        status: "voting",
        deadline: Date.now() - 1,
        completed: ["one", "two"],
        eligible: ["c"],
        votes: [],
      },
    ],
  });
  q.closeDue();
  assert.equal(q.publicDuels()[0].total, 0);
  assert.deepEqual(q.publicDuels()[0].percentages, [0, 0]);
});
test("session file survives a fresh store and engine, keeps private identity and active votes, and rejects corrupt snapshots", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "firevoice-session-"),
  );
  try {
    const p = new Party(),
      current = song("active");
    p.start(current, ["a", "b"]);
    p.support("b", "active");
    const data = snapshot(p, current),
      writer = new SessionStore(directory);
    assert.equal(writer.write(data), true);
    const read = new SessionStore(directory).read(),
      restored = new Party(read.party);
    assert.equal(read.queue[0].id, "waiting");
    assert.equal(read.sessions[0].token, "a".repeat(64));
    assert.equal(restored.support("b", "active").ok, false);
    restored.finish(read.currentSong, true, ["a", "b"]);
    assert.equal(restored.ranking()[0].score, 100);
    assert.equal(
      fs.statSync(path.join(directory, "session.json")).mode & 0o777,
      0o600,
    );
    assert.throws(() =>
      validateSnapshot({
        ...data,
        party: { ...data.party, lighting: { mode: "bad", intensity: 1 } },
      }),
    );
    fs.writeFileSync(path.join(directory, "session.json"), "corrupt");
    assert.throws(() => new SessionStore(directory).read());
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
