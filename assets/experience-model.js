/*
 * ExperienceModel — port of voice/Music/ExperienceModel.swift, Song experience.
 *
 * Two signals run in parallel and never compete:
 *   · touch  — driven by the real audio energy, so haptics are always in sync
 *   · sight  — driven by the analysed melody, which tints the level waveform
 *              and the scrubber as the song moves from note to note
 *
 * The touch channel widens the gap between soft and loud passages by the
 * contrast strength chosen in Settings, exactly as the app does.
 *
 * The only substitution is the metering source: the app asks AVAudioPlayer for
 * a level once per display frame, and this page reads the same two numbers
 * (average dBFS and peak dBFS, loudest channel) from an envelope measured
 * offline from the very same recording, once per display frame. The tick loop,
 * the state machine and every derived value are the app's.
 *
 * The app's Perform mode is deliberately not part of this page, so the beat
 * pulses it uses and the note blocks it draws are not ported here.
 */
(function (global) {
    'use strict';

    /** Pitch.swift — the seven natural notes a learner can play. */
    const PITCH_ORDER = ['c', 'd', 'e', 'f', 'g', 'a', 'b'];
    const PITCH_SEMITONES = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
    const LESSON_OCTAVE = 4;

    /** HapticSettings */
    const CONTRAST_KEY = 'settings.hapticContrast';
    const DEFAULT_CONTRAST = 1.6;
    const CONTRAST_MIN = 1;
    const CONTRAST_MAX = 2.5;

    /** The rolling waveform holds this many frames. */
    const WAVEFORM_BUCKETS = 84;

    function clamp(value, low, high) {
        return Math.min(high, Math.max(low, value));
    }

    /**
     * Pitch.keyed(fromMidi:) — snaps an arbitrary MIDI note onto one of the
     * seven keys, folding the octave back so the visual ladder stays readable.
     */
    function keyedFromMidi(midi) {
        const pitchClass = ((midi % 12) + 12) % 12;
        let best = 'c';
        let bestDistance = Infinity;
        for (const candidate of PITCH_ORDER) {
            const raw = Math.abs(PITCH_SEMITONES[candidate] - pitchClass);
            const distance = Math.min(raw, 12 - raw);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = candidate;
            }
        }
        return { pitch: best, octave: LESSON_OCTAVE };
    }

    /**
     * Pitch.parse(token:) — reads the first letter and the digits. Accidentals
     * are out of scope for the MVP, exactly as in the app.
     */
    function parsePitch(raw) {
        const token = String(raw === undefined || raw === null ? '' : raw).trim();
        if (/^-?\d+$/.test(token)) return keyedFromMidi(parseInt(token, 10));

        const upper = token.toUpperCase();
        const letter = upper.slice(0, 1).toLowerCase();
        const pitch = PITCH_ORDER.indexOf(letter) >= 0 ? letter : 'c';
        const digits = upper.replace(/\D+/g, '');
        return { pitch: pitch, octave: digits ? parseInt(digits, 10) : LESSON_OCTAVE };
    }

    function degreeOf(pitch) {
        const degree = PITCH_ORDER.indexOf(pitch);
        return degree < 0 ? 0 : degree;
    }

    /** Array.indexOfLatestStart(at:) */
    function indexOfLatestStart(notes, time) {
        let result = null;
        for (let index = 0; index < notes.length; index += 1) {
            if (notes[index].startTime <= time) result = index;
            else break;
        }
        return result;
    }

    /** NoteEvent.occurs(at:) */
    function occurs(note, time) {
        return time >= note.startTime && time < note.startTime + note.duration;
    }

    class ExperienceModel {

        constructor(options) {
            const settings = options || {};
            this.audio = settings.audio;
            this.data = settings.data;
            this.haptics = settings.haptics || global.hapticEngine;

            this.isPlaying = false;
            this.isReady = false;
            this.errorMessage = null;
            this.hapticsAvailable = this.haptics ? this.haptics.hasMotor : false;

            this.hapticIntensity = 0;
            this.level = 0;
            this.levels = new Array(WAVEFORM_BUCKETS).fill(0);
            this.currentTime = 0;
            this.duration = this.data && this.data.duration ? this.data.duration : 0;

            /**
             * Note sounding right now, if any. It drives the pitch tint of the
             * waveform and the scrubber — the same use the app makes of it in
             * Song experience.
             */
            this.activePitch = null;

            this.hapticContrast = ExperienceModel.storedContrast();
            this.signal = new global.AudioHapticSignal(this.hapticContrast);

            this.timeline = (this.data && this.data.notes ? this.data.notes : []).map((note) => {
                const parsed = parsePitch(note.pitch);
                return {
                    letter: parsed.pitch.toUpperCase(),
                    degree: degreeOf(parsed.pitch),
                    startTime: note.startTime,
                    duration: note.duration,
                };
            }).sort((a, b) => a.startTime - b.startTime);

            this.frameRate = this.data && this.data.frameRate ? this.data.frameRate : 60;
            this.averageDB = this.data ? this.data.averageDB : [];
            this.peakDB = this.data ? this.data.peakDB : [];

            this.lastNoteIndex = -1;
        }

        // MARK: - Settings

        /** HapticSettings.storedContrast() */
        static storedContrast() {
            let stored = null;
            try {
                stored = global.localStorage.getItem(CONTRAST_KEY);
            } catch (error) {
                stored = null;
            }
            const value = stored === null ? NaN : Number.parseFloat(stored);
            if (!Number.isFinite(value)) return DEFAULT_CONTRAST;
            return clamp(value, CONTRAST_MIN, CONTRAST_MAX);
        }

        static storeContrast(value) {
            try {
                global.localStorage.setItem(CONTRAST_KEY, String(value));
            } catch (error) {
                /* A file:// page in a locked-down browser may refuse to store;
                   the in-memory value still applies for this session. */
            }
        }

        /** The contrast control stays inside the range the app supports. */
        setContrast(value) {
            const next = clamp(Number.isFinite(value) ? value : DEFAULT_CONTRAST,
                CONTRAST_MIN, CONTRAST_MAX);
            this.hapticContrast = next;
            this.signal.contrast = next;
            ExperienceModel.storeContrast(next);
            return next;
        }

        get progress() {
            return this.duration > 0 ? clamp(this.currentTime / this.duration, 0, 1) : 0;
        }

        // MARK: - Lifecycle

        prepare() {
            this.duration = Number.isFinite(this.audio.duration) && this.audio.duration > 0
                ? this.audio.duration
                : this.duration;
            this.isReady = true;
            this.lastNoteIndex = -1;
            this.activePitch = null;
        }

        teardown() {
            this.stop();
            this.isReady = false;
            if (this.haptics) this.haptics.stop();
        }

        // MARK: - Transport

        togglePlayback() {
            if (this.isPlaying) {
                this.pause();
            } else {
                this.play();
            }
        }

        play() {
            if (this.haptics) {
                this.haptics.stopAudio();
                this.haptics.prepare();
                this.hapticsAvailable = this.haptics.hasMotor;
            }
            this.errorMessage = null;
            const started = this.audio.play();
            this.isPlaying = true;
            this.currentTime = this.audio.currentTime || 0;
            this.updateNoteState(this.currentTime, true);
            if (started && typeof started.then === 'function') {
                return started.then(() => true, () => {
                    // Autoplay refused: the view shows an explicit start button.
                    this.isPlaying = false;
                    return false;
                });
            }
            return Promise.resolve(true);
        }

        pause() {
            this.audio.pause();
            this.currentTime = this.audio.currentTime || this.currentTime;
            this.isPlaying = false;
            this.resetLiveSignals();
        }

        stop() {
            this.audio.pause();
            try {
                this.audio.currentTime = 0;
            } catch (error) {
                /* Seeking before metadata is ready is harmless to ignore. */
            }
            this.isPlaying = false;
            this.currentTime = 0;
            this.resetLiveSignals();
        }

        seek(fraction) {
            if (!Number.isFinite(fraction) || !(this.duration > 0)) return;
            this.resetLiveSignals();
            const target = clamp(fraction * this.duration, 0, Math.max(0, this.duration - 0.05));
            try {
                this.audio.currentTime = target;
            } catch (error) {
                return;
            }
            this.currentTime = target;
            this.lastNoteIndex = -1;
            this.activePitch = null;
            if (this.isPlaying) this.updateNoteState(target, true);
        }

        // MARK: - Tick loop (one display frame)

        tick() {
            if (!this.isPlaying) return;
            this.currentTime = this.audio.currentTime || 0;

            // The app's tick treats "at or past the end" as finished and rewinds.
            if (this.audio.ended || this.currentTime >= this.duration - 0.1 && this.audio.paused) {
                this.stop();
                return;
            }

            const index = clamp(Math.round(this.currentTime * this.frameRate),
                0, Math.max(0, this.averageDB.length - 1));
            const db = this.averageDB.length ? this.averageDB[index] : -160;
            const peakDB = this.peakDB.length ? this.peakDB[index] : -160;
            const normalized = clamp((db + 48) / 48, 0, 1);
            this.level = normalized;

            this.levels.shift();
            this.levels.push(normalized);

            const frame = this.signal.update(db, peakDB, this.currentTime);
            this.hapticIntensity = frame.intensity;
            if (this.haptics && this.hapticsAvailable) {
                this.hapticsAvailable = this.haptics.updateAudio(frame.intensity, frame.sharpness);
            }

            this.updateNoteState(this.currentTime, false);
        }

        /** Sight follows the analysed melody. */
        updateNoteState(time, force) {
            if (!this.timeline.length) return;

            const index = indexOfLatestStart(this.timeline, time);
            if (index === null) {
                this.activePitch = null;
                this.lastNoteIndex = -1;
                return;
            }

            const note = this.timeline[index];
            if (!occurs(note, time)) {
                this.activePitch = null;
                return;
            }
            if (index === this.lastNoteIndex && !force) return;

            this.lastNoteIndex = index;
            this.activePitch = note;
        }

        resetLiveSignals() {
            if (this.haptics) this.haptics.stopAudio();
            this.signal.reset();
            this.hapticIntensity = 0;
            this.activePitch = null;
            this.lastNoteIndex = -1;
            this.level = 0;
            this.levels = new Array(WAVEFORM_BUCKETS).fill(0);
        }
    }

    ExperienceModel.contrastRange = { min: CONTRAST_MIN, max: CONTRAST_MAX, step: 0.1 };
    ExperienceModel.defaultContrast = DEFAULT_CONTRAST;

    global.ExperienceModel = ExperienceModel;
})(window);
