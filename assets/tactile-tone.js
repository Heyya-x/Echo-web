/*
 * TactileTone — a web-only stand-in for the motor.
 *
 * Most desktop browsers and iOS Safari cannot vibrate a page at all. So that the
 * same haptic stream can still be *felt* on those devices, this renders it as a
 * low-frequency pulse under the music: the continuous channel becomes a rumble
 * whose gain follows the intensity the app would have sent to Core Haptics, and
 * every transient becomes a short thump. It is off by default and only ever
 * reads the values the haptic engine produced — it decides nothing itself.
 */
(function (global) {
    'use strict';

    const CARRIER_HZ = 58;
    const OVERTONE_HZ = 116;
    const MAX_GAIN = 0.22;
    const PULSE_GAIN = 0.3;

    class TactileTone {

        constructor() {
            this.enabled = false;
            this.context = null;
            this.gain = null;
            this.level = 0;
        }

        get available() {
            return typeof (global.AudioContext || global.webkitAudioContext) === 'function';
        }

        /** Must be called from a user gesture the first time. */
        setEnabled(enabled) {
            if (!this.available) {
                this.enabled = false;
                return false;
            }
            if (enabled) {
                this._open();
                this.enabled = true;
                if (this.context.state === 'suspended') this.context.resume();
            } else {
                this.enabled = false;
                this.setLevel(0);
                if (this.context && this.context.state === 'running') this.context.suspend();
            }
            return this.enabled;
        }

        _open() {
            if (this.context) return;
            const Ctor = global.AudioContext || global.webkitAudioContext;
            this.context = new Ctor();
            this.gain = this.context.createGain();
            this.gain.gain.value = 0;
            this.gain.connect(this.context.destination);

            for (const [frequency, weight] of [[CARRIER_HZ, 1], [OVERTONE_HZ, 0.34]]) {
                const oscillator = this.context.createOscillator();
                oscillator.type = 'sine';
                oscillator.frequency.value = frequency;
                const mix = this.context.createGain();
                mix.gain.value = weight;
                oscillator.connect(mix).connect(this.gain);
                oscillator.start();
            }
        }

        /** Continuous channel: one display frame of haptic intensity. */
        setLevel(intensity) {
            const level = Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 0;
            // One target per frame is wasteful; only follow real movement.
            if (Math.abs(level - this.level) < 0.01) return;
            this.level = level;
            if (!this.enabled || !this.context) return;
            const target = level <= 0 ? 0 : MAX_GAIN * Math.pow(level, 1.2);
            // Smoothed exactly like an audio parameter, never stepped.
            this.gain.gain.setTargetAtTime(target, this.context.currentTime, 0.02);
        }

        /** Transient channel: mirrors HapticEngine's command log. */
        command(command) {
            if (!this.enabled || !this.context || !command) return;
            if (command.kind === 'pulse') {
                const now = this.context.currentTime;
                const peak = PULSE_GAIN * Math.max(0.25, command.intensity);
                this.gain.gain.cancelScheduledValues(now);
                this.gain.gain.setValueAtTime(peak, now);
                this.gain.gain.setTargetAtTime(
                    this.level <= 0 ? 0 : MAX_GAIN * Math.pow(this.level, 1.2),
                    now + 0.05,
                    0.04
                );
            } else if (command.kind === 'stop') {
                this.gain.gain.setTargetAtTime(0, this.context.currentTime, 0.05);
            }
        }
    }

    global.TactileTone = TactileTone;
})(window);
