/* Local voice monitoring. No recording, uploading, or network audio. */
(function (root) {
    'use strict';
    class LocalAudioEngine {
        constructor({ onState = () => {}, onLevel = () => {} } = {}) {
            this.onState = onState; this.onLevel = onLevel;
            this.state = 'idle'; this.generation = 0; this.gain = 0.15;
            this.muted = true; this.effect = 'normal'; this.nodes = [];
        }
        report(state, message = '') {
            this.state = state; this.onState({ state, message, muted: this.muted });
        }
        async start() {
            if (this.state === 'requesting' || this.context) return;
            const generation = ++this.generation;
            if (!root.isSecureContext || !root.navigator.mediaDevices?.getUserMedia) {
                this.report('error', 'Abre FireVoice con HTTPS para usar el micrófono.'); return;
            }
            this.report('requesting', 'Autoriza el micrófono. La voz se procesa solo en este dispositivo.');
            let context, stream;
            try {
                const AudioContext = root.AudioContext || root.webkitAudioContext;
                if (!AudioContext) throw new Error('unsupported');
                // Resume during the gesture, before awaiting the permission prompt.
                context = new AudioContext({ latencyHint: 'interactive' });
                this.pendingContext = context;
                const resume = context.resume().then(() => null, error => error);
                stream = await root.navigator.mediaDevices.getUserMedia({ audio: {
                    channelCount: { ideal: 1 }, echoCancellation: { ideal: true },
                    noiseSuppression: { ideal: true }, autoGainControl: { ideal: false }
                } });
                const resumeError = await resume;
                if (resumeError) throw resumeError;
                if (generation !== this.generation) {
                    stream.getTracks().forEach(track => track.stop());
                    await context.close().catch(() => {}); return;
                }
                this.pendingContext = null; this.context = context; this.stream = stream;
                const source = context.createMediaStreamSource(stream);
                const filter = context.createBiquadFilter(); filter.type = 'highpass'; filter.frequency.value = 85;
                const analyser = context.createAnalyser(); analyser.fftSize = 1024;
                const dry = context.createGain(); dry.gain.value = 1;
                const delay = context.createDelay(0.5); delay.delayTime.value = 0.14;
                const wet = context.createGain(); wet.gain.value = this.effect === 'reverb' ? 0.15 : 0;
                const compressor = context.createDynamicsCompressor();
                compressor.threshold.value = -12; compressor.knee.value = 12;
                compressor.ratio.value = 12; compressor.attack.value = 0.003; compressor.release.value = 0.12;
                const output = context.createGain(); output.gain.value = 0;
                source.connect(filter); filter.connect(analyser);
                filter.connect(dry); dry.connect(compressor);
                filter.connect(delay); delay.connect(wet); wet.connect(compressor);
                compressor.connect(output); output.connect(context.destination);
                this.nodes = [source, filter, analyser, dry, delay, wet, compressor, output];
                this.output = output; this.wet = wet; this.muted = true;
                const samples = new Float32Array(analyser.fftSize);
                const meter = () => {
                    if (generation !== this.generation) return;
                    analyser.getFloatTimeDomainData(samples);
                    let energy = 0, peak = 0;
                    for (const value of samples) { energy += value * value; peak = Math.max(peak, Math.abs(value)); }
                    this.onLevel({ rms: Math.sqrt(energy / samples.length), peak });
                    this.frame = root.requestAnimationFrame(meter);
                };
                context.onstatechange = () => {
                    if (generation !== this.generation || context.state === 'closed') return;
                    if (context.state !== 'running') {
                        this.muted = true; output.gain.value = 0;
                        this.report('interrupted', 'Audio suspendido. Pulsa Habilitar salida para reanudar.');
                    }
                };
                stream.getTracks().forEach(track => { track.onended = () => {
                    if (generation === this.generation) {
                        void this.stop().then(() => this.report('error', 'El micrófono dejó de estar disponible. Vuelve a activarlo.'));
                    }
                }; });
                meter(); this.report('ready', 'Entrada preparada. La salida comienza silenciada.');
            } catch (error) {
                if (stream) stream.getTracks().forEach(track => track.stop());
                if (generation !== this.generation) return;
                await this.stop();
                const messages = {
                    NotAllowedError: 'Permiso denegado. Habilita el micrófono en los permisos del sitio y vuelve a intentar.',
                    NotFoundError: 'No se encontró un micrófono disponible.',
                    NotReadableError: 'El micrófono está ocupado o no puede abrirse. Cierra otras aplicaciones y reintenta.',
                    OverconstrainedError: 'Este dispositivo no admite la configuración de audio solicitada.'
                };
                this.report('error', messages[error.name] || 'No pudimos iniciar el audio. Prueba otro navegador o vuelve a activar el micrófono.');
            }
        }
        async setMuted(muted) {
            if (!this.context || !this.output) return;
            const context = this.context, output = this.output, generation = this.generation;
            // Silence synchronously, even if the AudioContext has been suspended.
            if (muted) {
                this.muted = true; output.gain.cancelScheduledValues(context.currentTime);
                output.gain.value = 0; this.report('muted', 'Salida silenciada. El medidor sigue mostrando la entrada.'); return;
            }
            try {
                await context.resume();
                if (generation !== this.generation || output !== this.output) return;
                if (context.state !== 'running') throw new Error('suspended');
                this.muted = false;
                output.gain.setTargetAtTime(this.gain, context.currentTime, 0.015);
                this.report('output', 'Salida habilitada. Confirma que escuchas tu voz.');
            } catch (_) {
                if (generation === this.generation) this.report('interrupted', 'No se pudo reanudar el audio. Vuelve a activarlo.');
            }
        }
        setGain(value) {
            this.gain = Math.max(0, Math.min(0.6, Number(value) || 0));
            if (this.output && !this.muted) this.output.gain.setTargetAtTime(this.gain, this.context.currentTime, 0.015);
        }
        setEffect(effect) {
            this.effect = effect === 'reverb' ? 'reverb' : 'normal';
            if (this.wet) this.wet.gain.setTargetAtTime(this.effect === 'reverb' ? 0.15 : 0, this.context.currentTime, 0.015);
        }
        async stop() {
            ++this.generation;
            root.cancelAnimationFrame(this.frame);
            const context = this.context || this.pendingContext;
            this.context = null; this.pendingContext = null; this.muted = true;
            if (this.stream) this.stream.getTracks().forEach(track => { track.onended = null; track.stop(); });
            this.stream = null;
            this.nodes.forEach(node => node.disconnect()); this.nodes = [];
            this.output = null; this.wet = null;
            if (context && context.state !== 'closed') { context.onstatechange = null; await context.close().catch(() => {}); }
            this.onLevel({ rms: 0, peak: 0 }); this.report('idle', 'Micrófono detenido.');
        }
    }
    root.LocalAudioEngine = LocalAudioEngine;
})(window);
