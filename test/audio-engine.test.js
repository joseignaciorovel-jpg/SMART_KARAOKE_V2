const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function harness(getUserMedia) {
    const contexts = [], tracks = [], states = [], frames = new Map();
    let frameId = 0;
    class Param {
        constructor() { this.value = 0; }
        setTargetAtTime(v) { this.value = v; }
        cancelScheduledValues() {}
    }
    class Node {
        constructor(kind) { this.kind = kind; this.connections = []; this.disconnected = false;
            for (const property of ['gain','frequency','delayTime','threshold','knee','ratio','attack','release']) this[property] = new Param(); }
        connect(node) { this.connections.push(node); }
        disconnect() { this.disconnected = true; }
        getFloatTimeDomainData(samples) { samples.fill(0.1); }
    }
    class Context {
        constructor(options) { this.options = options; this.state = 'suspended'; this.currentTime = 0; this.nodes = []; this.destination = new Node('destination'); contexts.push(this); }
        node(kind) { const node = new Node(kind); this.nodes.push(node); return node; }
        createMediaStreamSource() { return this.node('source'); }
        createBiquadFilter() { return this.node('filter'); }
        createAnalyser() { return this.node('analyser'); }
        createGain() { return this.node('gain'); }
        createDelay() { return this.node('delay'); }
        createDynamicsCompressor() { return this.node('compressor'); }
        async resume() { this.state = 'running'; }
        async close() { this.state = 'closed'; }
    }
    const makeStream = () => {
        const track = { stopped: false, stop() { this.stopped = true; } }; tracks.push(track);
        return { getTracks: () => [track] };
    };
    const window = { isSecureContext: true, AudioContext: Context,
        navigator: { mediaDevices: { getUserMedia: getUserMedia || (async () => makeStream()) } },
        requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
        cancelAnimationFrame: id => frames.delete(id) };
    vm.runInNewContext(fs.readFileSync('public/js/audio-engine.js', 'utf8'), { window });
    const engine = new window.LocalAudioEngine({ onState: state => states.push(state) });
    return { engine, window, contexts, tracks, states, makeStream };
}
test('local graph starts muted, normal is dry, echo toggles its wet path, silence and stop release resources', async () => {
    const { engine, contexts, tracks } = harness();
    await engine.start();
    assert.equal(contexts.length, 1); assert.equal(contexts[0].options.latencyHint, 'interactive');
    assert.equal(engine.state, 'ready'); assert.equal(engine.output.gain.value, 0);
    assert.equal(engine.wet.gain.value, 0);
    assert.ok(engine.output.connections.includes(contexts[0].destination));
    const nodes = [...engine.nodes];
    engine.setEffect('reverb'); assert.equal(engine.wet.gain.value, 0.15);
    engine.setEffect('normal'); assert.equal(engine.wet.gain.value, 0);
    await engine.setMuted(false); assert.equal(engine.output.gain.value, 0.15);
    engine.setGain(100); assert.equal(engine.output.gain.value, 0.6);
    await engine.setMuted(true); assert.equal(engine.output.gain.value, 0);
    await engine.stop(); assert.equal(tracks[0].stopped, true); assert.equal(contexts[0].state, 'closed');
    assert.ok(nodes.every(node => node.disconnected)); assert.equal(engine.context, null);
});
test('cancel while permission is pending stops late stream without reopening output', async () => {
    let resolvePermission;
    const h = harness(() => new Promise(resolve => { resolvePermission = resolve; }));
    const started = h.engine.start();
    await h.engine.start(); assert.equal(h.contexts.length, 1);
    await h.engine.stop(); resolvePermission(h.makeStream()); await started;
    assert.equal(h.tracks[0].stopped, true); assert.equal(h.engine.state, 'idle'); assert.equal(h.engine.context, null);
});
test('permission denial closes the pending context and returns a recoverable message', async () => {
    const h = harness(async () => { throw Object.assign(new Error(), { name: 'NotAllowedError' }); });
    await h.engine.start(); assert.equal(h.engine.state, 'error');
    assert.match(h.states.at(-1).message, /Permiso denegado/); assert.equal(h.contexts[0].state, 'closed');
});
test('stopping during resume cannot enable a discarded output', async () => {
    const h = harness(); await h.engine.start(); const output = h.engine.output;
    let resume;
    h.engine.context.resume = () => new Promise(resolve => { resume = resolve; });
    const enabling = h.engine.setMuted(false); await h.engine.stop(); resume(); await enabling;
    assert.equal(output.gain.value, 0); assert.equal(h.engine.context, null);
});
test('loss of audio context mutes output and never restores it silently', async () => {
    const h = harness(); await h.engine.start(); await h.engine.setMuted(false);
    h.engine.context.state = 'suspended'; h.engine.context.onstatechange();
    assert.equal(h.engine.muted, true); assert.equal(h.engine.output.gain.value, 0); assert.equal(h.engine.state, 'interrupted');
    await h.engine.stop();
});
test('explicit resume keeps level, echo and chosen output after an OS interruption',async()=>{
 const h=harness();await h.engine.start();h.engine.setGain(.25);h.engine.setEffect('reverb');await h.engine.setMuted(false);
 h.engine.context.state='suspended';h.engine.context.onstatechange();
 assert.equal(h.engine.output.gain.value,0);assert.equal(h.engine.desiredMuted,false);
 await h.engine.resume();assert.equal(h.engine.state,'output');assert.equal(h.engine.gain,.25);assert.equal(h.engine.effect,'reverb');assert.equal(h.engine.output.gain.value,.25);
 await h.engine.stop();
});

test('resuming a muted microphone restarts input while keeping output silent',async()=>{
 const h=harness();await h.engine.start();h.engine.context.state='suspended';h.engine.context.onstatechange();await h.engine.resume();
 assert.equal(h.engine.context.state,'running');assert.equal(h.engine.muted,true);assert.equal(h.engine.output.gain.value,0);await h.engine.stop();
});
