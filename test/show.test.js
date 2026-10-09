const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
function screen() {
    const dom = new JSDOM(fs.readFileSync('public/index.html','utf8'), {url:'https://firevoice.test/',runScripts:'outside-only'});
    const {window} = dom, handlers = new Map(), sent = [], timeouts = [];
    const socket = {on(name, fn){const list = handlers.get(name)||[];list.push(fn);handlers.set(name,list);}, emit(name,payload,ack){sent.push({name,payload});if(name==='authenticate-host'&&ack)ack(null,{ok:payload.key==='test-key'});}, timeout(){return this;}, fire(name,value){for(const fn of handlers.get(name)||[])fn(value);}};
    window.io = () => socket; window.confetti = () => {};
    window.fetch = async () => ({ok:true,json:async()=>({qrImage:'data:image/png;base64,AA=='})});
    window.Audio = class {play(){return Promise.resolve();} pause(){}};
    window.setTimeout = (fn, delay) => {const record={fn,delay,cancelled:false};timeouts.push(record);return record;};
    window.clearTimeout = record => {if(record)record.cancelled=true;};window.setInterval=()=>0;
    window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};window.HTMLDialogElement.prototype.close=function(){this.open=false;};
    for(const [,body] of fs.readFileSync('public/index.html','utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(body.trim())window.eval(body);
    const $ = id => window.document.getElementById(id);
    function host(){ $('hostKey').value='test-key'; $('hostForm').dispatchEvent(new window.Event('submit',{cancelable:true})); }
    return {dom,window,socket,timeouts,$,host};
}
test('welcome has QR, host entry and independent fullscreen / stage controls without moving the energy bar', async()=>{
    const h=screen();try{
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(h.$('welcomeQr').hidden,false);
        assert.equal(h.$('showMain').inert,undefined); // JSDOM does not implement the HTML inert property until assigned.
        h.$('welcomeHostBtn').click(); assert.equal(h.$('startOverlay').hidden,true);assert.equal(h.$('hostDialog').open,true);assert.equal(h.$('showMain').inert,false);
        h.host();assert.equal(h.$('hostSettings').hidden,false);
        const parent=h.$('slimMeter').parentNode;
        h.$('cinemaBtn').click();assert.equal(h.window.document.body.classList.contains('cinema-mode'),true);assert.equal(h.$('slimMeter').parentNode,parent);
        h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'Escape'}));assert.equal(h.window.document.body.classList.contains('cinema-mode'),false);
        h.$('lockHostBtn').click();assert.equal(h.$('hostControls').hidden,true);assert.equal(h.$('hostSettings').hidden,true);
    }finally{h.dom.window.close();}
});
test('Chacal pauses only in Competition and cancels resume when the song changes or host pauses',async()=>{
    const h=screen();try{
        let paused=0,played=0;
        h.window.fakePlayer={getPlayerState:()=>1,pauseVideo:()=>paused++,playVideo:()=>played++,loadVideoById(){},stopVideo(){}};
        h.window.YT = {Player: function () {return h.window.fakePlayer;}}; h.window.onYouTubeIframeAPIReady();
        await new Promise(resolve=>setImmediate(resolve));
        const song={id:'one',videoId:'abcdefghijk',title:'Tema',requester:'Cantante'};
        h.socket.fire('state-update',{currentSong:song,queue:[],chacalMode:'fiesta'});
        h.socket.fire('chacal-overwhelming',{songId:'one'});assert.equal(paused,0);
        h.socket.fire('state-update',{currentSong:song,queue:[],chacalMode:'competencia'});
        h.socket.fire('chacal-overwhelming',{songId:'one'});assert.equal(paused,1);
        const first=h.timeouts.find(item=>item.delay===5000);
        h.socket.fire('state-update',{currentSong:null,queue:[],chacalMode:'competencia'});assert.equal(first.cancelled,true);first.fn();assert.equal(played,0);
        h.socket.fire('state-update',{currentSong:song,queue:[],chacalMode:'competencia'});
        h.socket.fire('chacal-overwhelming',{songId:'one'});
        h.$('pauseBtn').click();h.timeouts.filter(item=>item.delay===5000).at(-1).fn();assert.equal(played,0);
        h.socket.fire('chacal-overwhelming',{songId:'one'});h.timeouts.filter(item=>item.delay===5000).at(-1).fn();assert.equal(played,1);
        await new Promise(resolve=>setImmediate(resolve));
    }finally{h.dom.window.close();}
});
