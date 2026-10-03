/*
 * AudioHapticSignal — port of voice/Services/AudioHapticSignal.swift
 *
 * Converts playback meters into touch. No clock-based beats are invented when
 * the audio is silent; peak-to-average contrast controls the texture, while the
 * stored contrast strength decides how far soft and loud passages move apart.
 *
 * The maths is a line-for-line port, so a page and the app produce the same
 * intensity for the same meters.
 */
(function (global) {
    'use strict';

    function clamp(value, low, high) {
        return Math.min(high, Math.max(low, value));
    }

    /** Neutral strength: the metered dynamics are felt exactly as measured. */
    const ORIGINAL_CONTRAST = 1;
    /**
     * Level the expansion pivots on. Typical music sits near here, so raising
     * the strength moves quiet and loud passages apart instead of simply
     * turning everything up.
     */
    const CONTRAST_PIVOT = 0.5;
    /**
     * Quietest level an audible passage may reach. A dip in the music must not
     * stop the continuous player only for the next frame to start it again.
     */
    const MINIMUM_FELT_INTENSITY = 0.02;
    /** Widest expansion `applyContrast` honours, however the setting is stored. */
    const MAXIMUM_CONTRAST = 4;

    class AudioHapticSignal {

        constructor(contrast) {
            this.contrast = typeof contrast === 'number' ? contrast : ORIGINAL_CONTRAST;
            this.envelope = 0;
            this.previousTime = null;
        }

        /**
         * Expands the metered envelope around the pivot. A strength of 1 is the
         * identity, so a signal that was never configured feels what the audio
         * alone would have produced.
         */
        static applyContrast(envelope, strength) {
            const level = Number.isFinite(envelope) ? clamp(envelope, 0, 1) : 0;
            const gain = Number.isFinite(strength)
                ? clamp(strength, 0, MAXIMUM_CONTRAST)
                : ORIGINAL_CONTRAST;
            const expanded = CONTRAST_PIVOT + (level - CONTRAST_PIVOT) * gain;
            return clamp(expanded, MINIMUM_FELT_INTENSITY, 1);
        }

        /**
         * One display frame of meters. Returns the intensity and sharpness the
         * touch channel should carry right now; both are 0 while the audio is
         * silent, which is what stops the continuous player.
         */
        update(averageDB, peakDB, time) {
            if (!Number.isFinite(averageDB)
                || !Number.isFinite(peakDB)
                || !Number.isFinite(time)
                || !(averageDB > -48)) {
                this.reset();
                return { intensity: 0, sharpness: 0 };
            }

            const elapsed = this.previousTime === null ? 1 / 60 : time - this.previousTime;
            if (elapsed < 0 || elapsed > 0.25) this.envelope = 0;
            const delta = clamp(elapsed, 0, 0.1);
            this.previousTime = time;

            const target = Math.pow(clamp((averageDB + 48) / 48, 0, 1), 1.5);
            const response = target > this.envelope ? 0.025 : 0.075;
            this.envelope += (target - this.envelope) * (1 - Math.exp(-delta / response));

            const peakContrast = clamp((peakDB - averageDB) / 18, 0, 1);
            return {
                intensity: AudioHapticSignal.applyContrast(this.envelope, this.contrast),
                sharpness: 0.15 + peakContrast * 0.7,
            };
        }

        reset() {
            this.envelope = 0;
            this.previousTime = null;
        }
    }

    AudioHapticSignal.originalContrast = ORIGINAL_CONTRAST;
    AudioHapticSignal.contrastPivot = CONTRAST_PIVOT;
    AudioHapticSignal.minimumFeltIntensity = MINIMUM_FELT_INTENSITY;
    AudioHapticSignal.maximumContrast = MAXIMUM_CONTRAST;

    global.AudioHapticSignal = AudioHapticSignal;
})(window);
