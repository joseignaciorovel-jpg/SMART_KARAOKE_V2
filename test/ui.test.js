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
    window.eval(fs.readFileSync('public/js/wake-lock.js', 'utf8'));
    window.eval(fs.readFileSync('public/js/sound-library.js', 'utf8'));
    window.eval(fs.readFileSync('public/js/mobile.js', 'utf8'));
    return { dom, window, socket, engine, $: id => window.document.getElementById(id) };
}
test('mobile tabs, session, real-state labels, saved preferences and continuous local audio across songs and disconnects', async () => {
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
        h.$('micBtn').click(); assert.equal(h.$('micDialog').open, true);
        assert.equal(h.$('micMode').value,'0');
        h.$('micMode').value='1';h.$('micMode').dispatchEvent(new h.window.Event('input'));await Promise.resolve();
        assert.equal(h.$('micStatus').textContent,'Voz · salida activa');
        h.$('micMode').value='2';h.$('micMode').dispatchEvent(new h.window.Event('input'));await Promise.resolve();
        assert.equal(h.engine.effect,'reverb');assert.equal(h.$('micMode').getAttribute('aria-valuetext'),'Eco suave');
        h.$('gainControl').value=25;h.$('gainControl').dispatchEvent(new h.window.Event('input'));
        assert.equal(JSON.parse(h.window.localStorage.getItem('firevoice-mic-preferences')).gain,25);
        h.socket.fire('state-update', { ...state, currentSong: { ...state.currentSong, id: 'song-2', requesterId: 'other' } });
        assert.equal(h.engine.state,'output');assert.equal(h.engine.effect,'reverb');
        h.socket.disconnect();assert.equal(h.engine.stops,0);assert.match(h.$('connectionStatus').textContent,/Sin conexión/);
        h.window.document.dispatchEvent(new h.window.Event('visibilitychange'));assert.equal(h.engine.stops,0);
        h.$('closeMicBtn').click();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.engine.state,'idle');assert.equal(h.$('micDialog').open,false);
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
    window.eval(fs.readFileSync('public/js/sound-library.js','utf8'));
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

test('joining is free and optional teams appear only when the host enables them',()=>{
 const h=mobile();try{
 h.$('nicknameInput').value='Ana';h.$('joinForm').dispatchEvent(new h.window.Event('submit',{cancelable:true}));
 assert.equal(h.socket.sent.find(x=>x.event==='join-team').payload.team,null);
 h.socket.fire('nickname-set',{nickname:'Ana',team:null,participantId:'a',sessionToken:'private'});
 h.socket.fire('state-update',{gameMode:'arcade',queue:[]});assert.equal(h.$('teamChoice').hidden,true);
 h.socket.fire('state-update',{gameMode:'teams',queue:[]});assert.equal(h.$('teamChoice').hidden,false);
 h.window.document.querySelector('[data-team=red]').click();assert.deepEqual(JSON.parse(JSON.stringify(h.socket.sent.at(-1).payload)),{team:'red'});
 h.socket.fire('team-chosen',{team:'red'});assert.match(h.$('userTeamBadge').textContent,/Rojo/);
 h.socket.fire('team-chosen',{team:null});assert.match(h.$('userTeamBadge').textContent,/libre/);
 assert.equal(h.$('soundLibrary').children.length,6);
 }finally{h.dom.window.close();}
});

test('immersive microphone keeps invitations outside the singing view and Escape stops capture',async()=>{
 const h=mobile();try{
 h.socket.fire('nickname-set',{nickname:'Ana',team:null,participantId:'a',sessionToken:'private'});h.$('micBtn').click();
 h.$('micMode').value='1';h.$('micMode').dispatchEvent(new h.window.Event('input'));await Promise.resolve();
 h.socket.fire('receive-invitation',{fromName:'Bea',fromId:'b'});assert.equal(h.$('receiveDialog').open,false);assert.equal(h.$('micDialog').open,true);
 const cancel=new h.window.Event('cancel',{cancelable:true});h.$('micDialog').dispatchEvent(cancel);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(cancel.defaultPrevented,true);assert.equal(h.engine.muted,true);assert.equal(h.engine.stops,1);assert.equal(h.$('micDialog').open,false);assert.equal(h.$('receiveDialog').open,true);
 assert.equal(h.window.document.body.classList.contains('mic-open'),false);
 }finally{h.dom.window.close();}
});
