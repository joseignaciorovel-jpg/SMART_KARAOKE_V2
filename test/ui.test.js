const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
function socketMock() {
    const handlers = new Map(), sent = [];
    return { connected: true, id: 'socket-1', sent,
        on(event, handler) { const listeners = handlers.get(event) || []; listeners.push(handler); handlers.set(event, listeners); },
        emit(event, payload, callback) { sent.push({ event, payload }); if (event === 'authenticate-host' && callback) callback(null, { ok: true }); },
        timeout() { return this; }, disconnect() { this.connected = false; this.fire('disconnect'); },
        connect() { this.connected = true; this.fire('connect'); },
        fire(event, data) { for (const handler of handlers.get(event) || []) handler(data); }
    };
}
function mobile() {
    const dom = new JSDOM(fs.readFileSync('public/join.html', 'utf8'), { url: 'https://firevoice.test/join.html', runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom, socket = socketMock();
    window.io = () => socket;
    window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    window.HTMLDialogElement.prototype.close = function () { this.open = false; };
    window.fetch = async () => ({ ok: true, json: async () => ({ data: [] }) });
    let engine;
    // Test DOM lifecycle against a deterministic engine, separately tested with WebAudio mocks.
    window.LocalAudioEngine = class {
        constructor(callbacks) { engine = this; this.callbacks = callbacks; this.muted = true; this.effect = 'normal'; this.state = 'idle'; this.stops = 0; }
        report(state) { this.state = state; this.callbacks.onState({ state, message: state, muted: this.muted }); }
        async start() { this.report('ready'); }
        async stop() { this.stops++; this.muted = true; this.report('idle'); }
        async setMuted(value) { this.muted = value; this.report(value ? 'muted' : 'output'); }
        setGain() {}
        setEffect(value) { this.effect = value; }
    };
    window.eval(fs.readFileSync('public/js/mobile.js', 'utf8'));
    return { dom, window, socket, engine, $: id => window.document.getElementById(id) };
}
test('mobile tabs, session, real-state labels, output confirmation, song change and disconnect cleanup', async () => {
    const h = mobile();
    try {
        h.socket.fire('connect');
        h.socket.fire('nickname-set', { nickname: 'Cony', team: 'red', participantId: 'participant-1', sessionToken: 'secret-session' });
        assert.equal(h.$('mainSection').hidden, false); assert.equal(h.$('loginSection').hidden, true);
        const state = { currentSong: { id: 'song-1', requesterId: 'participant-1', requester: 'Cony', title: 'Mi canción' }, queue: [], teamScores: { red: 5, blue: 2 }, coSingerIds: [], activeVoiceEffect: 'normal' };
        h.socket.fire('state-update', state);
        assert.equal(h.$('turnLabel').textContent, 'ES TU MOMENTO'); assert.equal(h.$('inviteBtn').hidden, false);
        h.window.document.querySelector('[data-tab=songs]').click();
        assert.equal(h.$('songs').hidden, false); assert.equal(h.$('sing').hidden, true);
        h.window.document.querySelector('[data-tab=sing]').click();
        h.$('micBtn').click(); assert.equal(h.$('audioControls').hidden, false);
        assert.equal(h.$('heardBtn').disabled, true);
        h.$('muteBtn').click(); await Promise.resolve();
        assert.equal(h.$('micStatus').textContent, 'Salida habilitada'); assert.equal(h.$('heardBtn').disabled, false);
        h.$('heardBtn').click(); assert.match(h.$('heardStatus').textContent, /confirmada por ti/);
        h.socket.fire('state-update', { ...state, currentSong: { ...state.currentSong, id: 'song-2', requesterId: 'other' } });
        assert.equal(h.engine.state, 'idle'); assert.equal(h.$('inviteBtn').hidden, true);
        h.socket.disconnect(); assert.equal(h.$('micBtn').disabled, true); assert.match(h.$('connectionStatus').textContent, /Sin conexión/);
        assert.ok(!h.socket.sent.some(item => item.event === 'mic-audio'));
    } finally { h.dom.window.close(); }
});
test('participant names are rendered as text in invitations and the song queue', () => {
    const h = mobile();
    try {
        h.socket.fire('participants-list', [{ id: 'socket-2', name: '<img src=x onerror=alert(1)>' }]);
        assert.equal(h.$('inviteList').querySelector('img'), null);
        h.socket.fire('state-update', { queue: [{ title: '<script>bad()</script>', requester: '<img src=x>' }] });
        assert.equal(h.$('songQueue').querySelector('script'), null); assert.equal(h.$('songQueue').querySelector('img'), null);
    } finally { h.dom.window.close(); }
});
test('screen host login enables labeled controls and hides queue actions again on disconnect', async () => {
    const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), { url: 'https://firevoice.test/', runScripts: 'outside-only' });
    const socket = socketMock(), window = dom.window;
    window.io = () => socket; window.confetti = () => {};
    window.fetch = async () => ({ ok: true, json: async () => ({ qrImage: 'data:image/png;base64,' }) });
    try {
        for (const [, body] of fs.readFileSync('public/index.html', 'utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
            if (body.trim()) window.eval(body);
        }
        window.eval(fs.readFileSync('public/js/show-party.js','utf8'));
        const $ = id => window.document.getElementById(id);
        assert.equal($('hostControls').hidden, true);
        $('hostKey').value = 'test'; $('hostForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
        assert.equal($('hostControls').hidden, false); assert.equal($('hostKey').value, '');
        assert.equal($('skipBtn').getAttribute('aria-label'), 'Siguiente canción');
        socket.disconnect(); assert.equal($('hostControls').hidden, true);
        await new Promise(resolve => setImmediate(resolve));
    } finally { dom.window.close(); }
});

test('song submission accepts shared links without scheme and always gives inline feedback', () => {
    const h = mobile();
    try {
        h.socket.fire('nickname-set', { nickname: 'Cony', team: 'red', participantId: 'p1', sessionToken: 'token' });
        h.$('youtubeUrlInput').value = 'youtu.be/abcdefghijk?si=shared';
        h.$('addSongBtn').click();
        assert.equal(h.$('addSongBtn').textContent, 'Añadiendo…');
        assert.equal(h.$('songFeedback').textContent, 'Enviando canción…');
        const sent = h.socket.sent.find(item => item.event === 'add-song');
        assert.equal(sent.payload.url, 'https://youtu.be/abcdefghijk?si=shared');
        assert.equal(h.$('songForm').noValidate, true);
    } finally { h.dom.window.close(); }
});
test('empty and non-YouTube song input display a message instead of silently blocking submission', () => {
    const h = mobile();
    try {
        h.socket.fire('nickname-set', { nickname: 'Cony', team: 'red', participantId: 'p1', sessionToken: 'token' });
        h.$('addSongBtn').click();
        assert.match(h.$('songFeedback').textContent, /Pega un enlace/);
        h.$('youtubeUrlInput').value = 'https://example.com/watch?v=abcdefghijk';
        h.$('addSongBtn').click();
        assert.match(h.$('songFeedback').textContent, /debe ser de YouTube/);
        assert.ok(!h.socket.sent.some(item => item.event === 'add-song'));
    } finally { h.dom.window.close(); }
});

test('mobile challenge form requires consent, renders invitations safely, and disables duplicate / self duel votes',()=>{
    const h=mobile();try{
        h.socket.fire('nickname-set',{nickname:'Ana',team:'red',participantId:'a',sessionToken:'private'});
        const duel={id:'d',names:['Bea','Leo'],singers:['b','c'],status:'voting',deadline:Date.now()+30000,eligible:['a'],voted:[],total:0};
        const state={currentSong:{id:'s',requesterId:'b',title:'Tema',requester:'Bea'},queue:[],participantList:[{id:'a',name:'Ana'},{id:'b',name:'Bea'}],support:{songId:'s',eligible:['a'],votes:[]},duels:[duel]};
        h.socket.fire('state-update',state);h.$('supportBtn').click();assert.equal(h.socket.sent.at(-1).event,'support-performance');
        h.socket.fire('state-update',{...state,support:{...state.support,votes:['a']}});assert.equal(h.$('supportBtn').disabled,true);
        h.$('challengeTarget').value='b';h.$('challengeUrls').value='youtu.be/abcdefghijk';h.$('sendChallengeBtn').click();assert.equal(h.socket.sent.at(-1).event,'create-challenge');
        h.socket.fire('challenge-invitation',{id:'invite',fromName:'<img src=x>',mode:'surprise',genre:'Pop',expiresAt:Date.now()+120000});assert.equal(h.$('challengeDialog').open,true);assert.equal(h.$('challengeInvitationText').querySelector('img'),null);h.$('acceptChallengeBtn').click();assert.equal(h.socket.sent.at(-1).payload.accept,true);
        h.$('duelVoteButtons').children[0].click();assert.equal(h.socket.sent.at(-1).event,'vote-duel');
        h.socket.fire('state-update',{...state,duels:[{...duel,voted:['a'],total:1}]});assert.equal(h.$('duelVoteButtons').children[0].disabled,true);
        h.socket.fire('state-update',{...state,duels:[{...duel,singers:['a','b'],eligible:[]}]});assert.equal(h.$('duelVoteButtons').children[0].disabled,true);
    }finally{h.dom.window.close();}
});
