const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: client } = require('socket.io-client');
const axios = require('axios');
// Only metadata is faked; Socket.IO/HTTP and authorization run against the real server.
axios.get = async () => ({ data: { title: 'Canción de prueba' } });
process.env.HOST_KEY = 'test-host-key-only';
const { server, io, stopTimers } = require('../server');
const clients = []; let url;
function event(socket, name) { return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, listener); reject(new Error(`Timeout: ${name}`)); }, 2000);
    const listener = data => { clearTimeout(timer); resolve(data); }; socket.once(name, listener);
}); }
function ack(socket, name, payload) { return new Promise((resolve, reject) => {
    socket.timeout(2000).emit(name, payload, (error, result) => error ? reject(error) : resolve(result));
}); }
async function connect() { const socket = client(url, { autoConnect: false, reconnection: false }); clients.push(socket);
    const connected = event(socket, 'connect'); socket.connect(); await connected; return socket; }
async function join(socket, extra = {}) { const joined = event(socket, 'nickname-set');
    socket.emit('join-team', { nickname: 'Mismo nombre', team: 'red', ...extra }); return joined; }
async function state(socket) { const received = event(socket, 'state-update'); socket.emit('get-state'); return received; }
before(async () => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); url = `http://127.0.0.1:${server.address().port}`; });
after(async () => { clients.forEach(socket => socket.disconnect()); stopTimers(); await new Promise(resolve => io.close(resolve)); });
test('identity, state recovery, host permissions, invitations and local-only audio', async () => {
    const host = await connect(), singer = await connect(), audience = await connect();
    const first = await join(singer), second = await join(audience);
    assert.notEqual(first.participantId, second.participantId);
    assert.notEqual(first.sessionToken, first.participantId);
    assert.equal((await ack(host, 'authenticate-host', { key: 'wrong' })).ok, false);
    assert.equal((await ack(host, 'authenticate-host', { key: process.env.HOST_KEY })).ok, true);
    const added = await ack(singer, 'add-song', { url: 'https://youtu.be/abcdefghijk', nickname: 'Spoofed' });
    assert.equal(added.ok, true);
    const initial = await state(host); assert.equal(initial.currentSong.requesterId, first.participantId);
    assert.equal(initial.currentSong.requester, 'Mismo nombre');
    assert.ok(!JSON.stringify(initial).includes(first.sessionToken));
    const rejected = event(audience, 'error-msg'); audience.emit('skip-song');
    assert.match(await rejected, /anfitrión/); assert.equal((await state(host)).currentSong.id, initial.currentSong.id);
    const invitation = event(audience, 'receive-invitation'); singer.emit('invite-participant', { targetSocketId: audience.id });
    assert.equal((await invitation).fromName, 'Mismo nombre');
    const accepted = event(audience, 'invitation-accepted'); audience.emit('accept-invitation', singer.id); await accepted;
    assert.ok((await state(host)).coSingerIds.includes(second.participantId));
    let forwarded = false; host.on('mic-audio', () => { forwarded = true; });
    singer.emit('mic-audio', Buffer.from('must not be forwarded'));
    // State request is ordered after mic-audio on the same socket.
    await state(singer); assert.equal(forwarded, false);
    singer.disconnect();
    const replacement = await connect(); const recovered = await join(replacement, { sessionToken: first.sessionToken });
    assert.equal(recovered.participantId, first.participantId);
    assert.equal((await state(replacement)).currentSong.requesterId, recovered.participantId);
    const modeChanged = event(host, 'game-mode-changed'); host.emit('set-mode', { mode: 'arcade' }); assert.equal(await modeChanged, 'arcade');
    const invalid = await ack(audience, 'add-song', { url: null }); assert.equal(invalid.ok, false);
    host.emit('skip-song'); assert.equal((await state(host)).currentSong, null);
    assert.deepEqual((await state(host)).coSingerIds, []);
});
test('anonymous clients cannot impersonate a singer when adding a song', async () => {
    const anonymous = await connect();
    const result = await ack(anonymous, 'add-song', { url: 'https://youtu.be/abcdefghijk', nickname: 'Inventado' });
    assert.equal(result.ok, false);
});
