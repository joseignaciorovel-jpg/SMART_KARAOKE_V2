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

test('YouTube URL parsing handles mobile shares, parameter order and rejects lookalike hosts', async () => {
    const singer = await connect(); await join(singer);
    for (const url of ['https://m.youtube.com/watch?si=share&v=abcdefghijk', 'https://youtube.com/shorts/abcdefghijk', 'youtu.be/abcdefghijk?si=share']) {
        assert.equal((await ack(singer, 'add-song', { url })).ok, true);
    }
    for (const url of ['https://fake-youtube.com/watch?v=abcdefghijk', 'https://youtube.com/watch?v=bad', 'https://example.com/youtu.be/abcdefghijk']) {
        assert.equal((await ack(singer, 'add-song', { url })).ok, false);
    }
});

test('metadata outages do not prevent valid video links from entering the queue', async () => {
    const singer = await connect(); await join(singer);
    const previous = axios.get;
    try {
        axios.get = async () => { throw new Error('YouTube unavailable'); };
        const result = await ack(singer, 'add-song', { url: 'https://youtu.be/abcdefghijk' });
        assert.equal(result.ok, true);
        assert.match(result.message, /título provisional/);
        const snapshot = await state(singer);
        assert.ok([snapshot.currentSong, ...snapshot.queue].some(song => song.title === 'Video de YouTube (abcdefghijk)'));
    } finally { axios.get = previous; }
});

test('host controls Chacal modes; Fiesta never pauses and Competition emits a song-bound interruption', async () => {
    const host = await connect(), singer = await connect(); await join(singer);
    await ack(host, 'authenticate-host', {key: process.env.HOST_KEY});
    assert.equal((await ack(singer, 'set-chacal-options', {mode:'competencia', allowBoo:true})).ok, false);
    await ack(host, 'set-chacal-options', {mode:'fiesta', allowBoo:false});
    const pauses = []; host.on('chacal-overwhelming', data => pauses.push(data));
    const vote = socket => new Promise((resolve, reject) => socket.timeout(2000).emit('vote-chacal', (error, response) => error ? reject(error) : resolve(response)));
    const participants = (await state(host)).participantList;
    const voters = participants.map(person => clients.find(socket => socket.id === person.socketId));
    for (const voter of voters) await vote(voter);
    assert.equal(pauses.length, 0);
    const before = await state(host);
    await ack(host, 'set-chacal-options', {mode:'competencia', allowBoo:true});
    for (const voter of voters) await vote(voter);
    await state(host);
    assert.equal(pauses.length, 1);
    assert.equal(pauses[0].songId, before.currentSong.id);
    const config = await state(host); assert.equal(config.chacalMode, 'competencia'); assert.equal(config.allowBoo, true);
    await ack(host, 'set-chacal-options', {mode:'fiesta', allowBoo:false});
});

test('challenge consent, song-bound support, separate duet permissions and consecutive duel voting run on real sockets',async()=>{
    const host=await connect(),a=await connect(),b=await connect(),c=await connect();
    await ack(host,'authenticate-host',{key:process.env.HOST_KEY});
    const sa=await join(a,{nickname:'Ana'}),sb=await join(b,{nickname:'Bea'});await join(c,{nickname:'Público'});
    host.emit('clear-queue');await state(host);
    while((await state(host)).currentSong){host.emit('skip-song');await state(host);}
    const invitation=event(b,'challenge-invitation');
    assert.equal((await ack(a,'create-challenge',{targetId:sb.participantId,mode:'duel',genre:'Pop',urls:['youtu.be/abcdefghijk']})).ok,true);
    const invite=await invitation;assert.equal(invite.candidates,undefined);assert.equal((await state(host)).currentSong,null);
    assert.equal((await ack(c,'respond-challenge',{id:invite.id,accept:true})).ok,false);
    assert.equal((await ack(b,'respond-challenge',{id:invite.id,accept:true})).ok,true);
    let screen=await state(host);assert.equal(screen.currentSong.requesterId,sa.participantId);assert.equal(screen.queue[0].requesterId,sb.participantId);assert.equal(screen.queue[0].videoId,screen.currentSong.videoId);
    assert.equal((await ack(a,'support-performance',{songId:screen.currentSong.id})).ok,false);
    assert.equal((await ack(c,'support-performance',{songId:'old-song'})).ok,false);
    assert.equal((await ack(c,'support-performance',{songId:screen.currentSong.id})).ok,false);
    host.emit('finish-song',{songId:screen.currentSong.id});screen=await state(host);
    const leg2=screen.currentSong.id;host.emit('finish-song',{songId:invite.id});assert.equal((await state(host)).currentSong.id,leg2);
    host.emit('finish-song',{songId:leg2});screen=await state(host);const duel=screen.duels.at(-1);assert.equal(duel.status,'voting');assert.equal(duel.counts,null);
    assert.equal((await ack(a,'vote-duel',{duelId:duel.id,choice:sa.participantId})).ok,false);
    assert.equal((await ack(c,'vote-duel',{duelId:duel.id,choice:sa.participantId})).ok,true);
    assert.equal((await ack(c,'vote-duel',{duelId:duel.id,choice:sb.participantId})).ok,false);
    await ack(host,'close-duel-vote',{id:duel.id});assert.equal((await state(host)).duels.at(-1).total,1);
    const i2=event(b,'challenge-invitation');await ack(a,'create-challenge',{targetId:sb.participantId,mode:'duet',genre:'Pop',urls:['youtu.be/abcdefghijk']});const duetInvite=await i2;
    await ack(b,'respond-challenge',{id:duetInvite.id,accept:true});screen=await state(host);assert.deepEqual(screen.currentSong.singerIds,[sa.participantId,sb.participantId]);assert.ok(screen.coSingerIds.includes(sb.participantId));
    assert.equal((await ack(b,'support-performance',{songId:screen.currentSong.id})).ok,false);
    await ack(c,'support-performance',{songId:screen.currentSong.id});host.emit('finish-song',{songId:screen.currentSong.id});screen=await state(host);assert.equal(screen.duetRanking.length,1);assert.equal(screen.ranking.length,0);
    const i3=event(b,'challenge-invitation');await ack(a,'create-challenge',{targetId:sb.participantId,mode:'surprise',genre:'Rock',urls:['youtu.be/abcdefghijk','youtu.be/12345678901']});const surprise=await i3;assert.equal(surprise.candidates,undefined);
    await ack(b,'respond-challenge',{id:surprise.id,accept:false});assert.equal((await state(host)).currentSong,null);
    assert.equal((await ack(c,'set-lighting',{mode:'off',intensity:0})).ok,false);await ack(host,'set-lighting',{mode:'party',intensity:45});assert.equal((await state(host)).lighting.mode,'party');
    const exported=await new Promise((resolve,reject)=>host.timeout(2000).emit('export-session',(error,result)=>error?reject(error):resolve(result)));assert.equal(exported.ok,true);assert.ok(exported.data.sessions.some(s=>s.token===sa.sessionToken));
    assert.equal((await ack(c,'import-session',exported.data)).ok,false);assert.equal((await ack(host,'import-session',exported.data)).ok,false);
});

test('free participants can opt into teams without changing identity and receive sound feedback',async()=>{
 const host=await connect(),guest=await connect();await ack(host,'authenticate-host',{key:process.env.HOST_KEY});
 host.emit('set-mode',{mode:'arcade'});await state(host);
 const profile=await join(guest,{nickname:'Libre',team:null});assert.equal(profile.team,null);
 assert.equal((await ack(guest,'choose-team',{team:'red'})).ok,false);
 host.emit('set-mode',{mode:'teams'});await state(host);
 const changed=event(guest,'team-chosen');assert.equal((await ack(guest,'choose-team',{team:'red'})).ok,true);assert.equal((await changed).team,'red');
 assert.equal((await state(host)).participantList.find(p=>p.id===profile.participantId).team,'red');
 assert.equal((await ack(guest,'choose-team',{team:null})).ok,true);
 await ack(host,'set-chacal-options',{mode:'fiesta',allowBoo:false});assert.equal((await ack(guest,'trigger-effect','abucheo')).ok,false);
 assert.equal((await ack(guest,'trigger-effect','silbido')).ok,true);assert.equal((await ack(guest,'trigger-effect','animo')).ok,false);
});
