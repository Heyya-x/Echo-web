/*
 * HapticEngine — the browser counterpart of voice/Services/HapticEngine.swift
 *
 * The app talks to Core Haptics, which can hold one continuous player and
 * modulate its intensity every frame. The Web Vibration API cannot do that: it
 * only accepts a pattern of on/off milliseconds, with no amplitude parameter.
 * So each call in the Swift engine is translated like this:
 *
 *   updateAudio(intensity,sharpness)  Core Haptics: a looping continuous event
 *                                     whose intensity/sharpness are re-sent
 *                                     every frame.
 *                                     Web: one motor window per HAPTIC_WINDOW_MS.
 *                                     The window's duty cycle (how long the
 *                                     motor runs out of that window) carries the
 *                                     intensity, and the number of taps inside
 *                                     the window carries the sharpness.
 *   playPulse(intensity)              Core Haptics: a transient event.
 *                                     Web: one short vibrate() burst that takes
 *                                     the motor for its duration.
 *
 * Everything above that translation — the envelope, the contrast expansion, the
 * peak-to-sharpness mapping, the decision to stop on silence — is the same code
 * the app runs.
 */
(function (global) {
    'use strict';

    /** One motor window: how often the duty cycle is re-issued. */
    const HAPTIC_WINDOW_MS = 100;
    /**
     * Duty cycle for a given intensity. The Vibration API has no amplitude, so
     * strength has to be expressed as time-on. The exponent compensates for the
     * dynamic range the missing amplitude control would have provided, keeping
     * the *ordering* the app produces (soft passages stay soft) while remaining
     * perceptible on a real motor.
     */
    const DUTY_FLOOR = 0.12;
    const DUTY_RANGE = 0.88;
    const DUTY_GAMMA = 0.6;
    /** Above this sharpness a window is split into two crisp taps. */
    const CRISP_SHARPNESS = 0.55;
    /** How long a transient pulse owns the motor, on top of its own duration. */
    const PULSE_HANDOVER_MS = 24;

    function clamp(value, low, high) {
        return Math.min(high, Math.max(low, value));
    }

    function clamp01(value) {
        return Number.isFinite(value) ? clamp(value, 0, 1) : 0;
    }

    class HapticEngine {

        constructor() {
            this.apiPresent = typeof global.navigator !== 'undefined'
                && typeof global.navigator.vibrate === 'function';
            /*
             * navigator.vibrate exists on desktop Chrome too, where it is a
             * silent no-op, and iOS Safari exposes no Vibration API at all. A
             * motor is only worth promising where a page can really drive one:
             * this mirrors the app's `supportsHaptics`, which is false on the
             * Simulator for the same reason.
             */
            this.hasMotor = this.apiPresent
                && /Android/i.test(global.navigator.userAgent || '');
            this.isRunning = false;
            this.lastCommand = null;
            /** Newest-last command log, read by the on-screen motor monitor. */
            this.history = [];
            this.onCommand = null;

            this._intensity = 0;
            this._sharpness = 0;
            this._windowTimer = null;
            this._pulseUntil = 0;
        }

        /** True only when a command will actually reach a motor. */
        get supportsHaptics() {
            return this.apiPresent;
        }

        prepare() {
            if (!this.apiPresent) return;
            // Cancels anything stray and, on Android, registers the user
            // gesture that later vibrate() calls need.
            this._vibrate(0);
        }

        // MARK: - Audio-driven touch (Song experience)

        /**
         * Starts or re-tunes the continuous touch channel. Returns false when
         * the channel could not be opened, exactly like the Swift version.
         */
        updateAudio(intensity, sharpness) {
            if (!this.apiPresent) return false;
            if (!(intensity > 0)) {
                this.stopAudio();
                return true;
            }

            this._intensity = clamp01(intensity);
            this._sharpness = clamp01(sharpness);
            if (!this.isRunning) {
                this.isRunning = true;
                this._windowTimer = global.setInterval(
                    () => this._pumpWindow(), HAPTIC_WINDOW_MS
                );
                this._pumpWindow();
            }
            return true;
        }

        stopAudio() {
            if (!this.isRunning) return;
            this.isRunning = false;
            if (this._windowTimer !== null) {
                global.clearInterval(this._windowTimer);
                this._windowTimer = null;
            }
            this._emit('stop', 0, 0, 0);
            this._vibrate(0);
        }

        /** One motor window. Called on an interval while the song is playing. */
        _pumpWindow() {
            if (!this.isRunning) return;
            // A transient pulse owns the motor for its own duration.
            if (global.performance.now() < this._pulseUntil) return;

            const intensity = this._intensity;
            const sharpness = this._sharpness;
            const duty = DUTY_FLOOR + DUTY_RANGE * Math.pow(intensity, DUTY_GAMMA);
            const on = clamp(Math.round(HAPTIC_WINDOW_MS * duty), 6, HAPTIC_WINDOW_MS - 4);

            let pattern;
            if (sharpness > CRISP_SHARPNESS) {
                // Sharper passages read as two quick taps rather than one hum.
                const tap = Math.max(4, Math.round(on * 0.58));
                const rest = HAPTIC_WINDOW_MS - tap * 2 - 8;
                pattern = rest > 0 ? [tap, 8, tap, rest] : [on, HAPTIC_WINDOW_MS - on];
            } else {
                pattern = [on, HAPTIC_WINDOW_MS - on];
            }

            this._vibrate(pattern);
            this._emit('continuous', on, intensity, sharpness);
        }

        // MARK: - Transients

        /** A single steady pulse, used by Perform mode on every beat. */
        playPulse(intensity) {
            if (!this.apiPresent) return;
            const level = clamp01(intensity);
            const ms = Math.round(16 + 46 * level);
            this._pulseUntil = global.performance.now() + ms + PULSE_HANDOVER_MS;
            this._vibrate(ms);
            this._emit('pulse', ms, level, 0.5);
        }

        stop() {
            this.stopAudio();
            this._pulseUntil = 0;
            this._vibrate(0);
        }

        // MARK: - Plumbing

        _vibrate(pattern) {
            if (!this.apiPresent) return false;
            try {
                return global.navigator.vibrate(pattern) === true;
            } catch (error) {
                return false;
            }
        }

        _emit(kind, onMs, intensity, sharpness) {
            const command = {
                kind: kind,
                at: global.performance.now(),
                onMs: onMs,
                intensity: intensity,
                sharpness: sharpness,
            };
            this.lastCommand = command;
            this.history.push(command);
            if (this.history.length > 240) this.history.splice(0, this.history.length - 240);
            if (typeof this.onCommand === 'function') this.onCommand(command);
        }
    }

    HapticEngine.windowMs = HAPTIC_WINDOW_MS;

    global.HapticEngine = HapticEngine;
    global.hapticEngine = new HapticEngine();
})(window);
