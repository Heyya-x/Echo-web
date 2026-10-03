/*
 * verify-model.js — runs the ported vibration pipeline head-less.
 *
 * The browser is not required to prove the touch channel works: AudioHapticSignal,
 * HapticEngine and ExperienceModel are the same files the page loads, so this
 * script loads them into a sandbox with a fake window, a fake audio element and
 * a fake motor clock, then plays the whole song frame by frame. It reports what
 * a phone would have felt and checks the properties the port must keep.
 *
 * Run: node scripts/verify-model.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.dirname(__dirname);
const FRAME_MS = 1000 / 60;

function createSandbox() {
    let now = 0;
    let nextTimerId = 1;
    const timers = new Map();
    const vibrations = [];

    const sandbox = {
        console: console,
        Math: Math,
        Number: Number,
        String: String,
        JSON: JSON,
        isFinite: isFinite,
        parseInt: parseInt,
        parseFloat: parseFloat,
        setTimeout: (fn, ms) => {
            const id = nextTimerId++;
            timers.set(id, { due: now + (ms || 0), fn: fn, repeat: null });
            return id;
        },
        setInterval: (fn, ms) => {
            const id = nextTimerId++;
            timers.set(id, { due: now + (ms || 0), fn: fn, repeat: ms || 16 });
            return id;
        },
        clearInterval: (id) => timers.delete(id),
        clearTimeout: (id) => timers.delete(id),
        devicePixelRatio: 2,
        matchMedia: () => ({ matches: false, addEventListener: () => {} }),
        localStorage: {
            store: {},
            getItem(key) {
                return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null;
            },
            setItem(key, value) { this.store[key] = String(value); },
        },
        location: { protocol: 'file:' },
        getComputedStyle: () => ({ getPropertyValue: () => '#007aff' }),
    };

    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.performance = { now: () => now };
    sandbox.navigator = {
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
        vibrate: (pattern) => {
            vibrations.push({ at: now, pattern: pattern });
            return true;
        },
    };

    /** Advance the sandbox clock, firing due interval callbacks. */
    sandbox.__advance = (ms) => {
        const target = now + ms;
        let guard = 0;
        for (;;) {
            let dueId = null;
            let dueAt = Infinity;
            for (const [id, timer] of timers) {
                if (timer.due <= target && timer.due < dueAt) {
                    dueAt = timer.due;
                    dueId = id;
                }
            }
            if (dueId === null) break;
            const timer = timers.get(dueId);
            now = timer.due;
            if (timer.repeat === null) timers.delete(dueId);
            else timer.due = now + timer.repeat;
            timer.fn();
            guard += 1;
            if (guard > 100000) throw new Error('timer runaway');
        }
        now = target;
    };

    for (const file of ['assets/audio-haptic-signal.js', 'assets/haptic-engine.js',
        'assets/experience-model.js']) {
        vm.runInNewContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
    }

    sandbox.__vibrations = vibrations;
    return sandbox;
}

function loadSongData(sandbox) {
    const source = fs.readFileSync(path.join(ROOT, 'data', 'song-data.js'), 'utf8');
    vm.runInNewContext(source, sandbox, { filename: 'song-data.js' });
    return sandbox.SONG_DATA;
}

function fakeAudio(data) {
    return {
        currentTime: 0,
        duration: data.duration,
        paused: true,
        ended: false,
        play() { this.paused = false; return Promise.resolve(true); },
        pause() { this.paused = true; },
    };
}

function percentile(sorted, fraction) {
    const index = Math.min(sorted.length - 1,
        Math.max(0, Math.round(fraction * (sorted.length - 1))));
    return sorted[index];
}

/** Frame-by-frame playback of the whole song. */
function playThrough(contrast) {
    const sandbox = createSandbox();
    const data = loadSongData(sandbox);
    const audio = fakeAudio(data);
    const model = new sandbox.ExperienceModel({ audio: audio, data: data, haptics: sandbox.hapticEngine });
    model.setContrast(contrast);
    model.prepare();
    model.play();
    audio.paused = false;

    const intensities = [];
    const duties = [];
    const frameCount = Math.ceil(data.duration * data.frameRate);

    for (let frame = 0; frame < frameCount; frame += 1) {
        audio.currentTime = frame / data.frameRate;
        sandbox.__advance(FRAME_MS);
        model.tick();
        intensities.push(model.hapticIntensity);
        const last = sandbox.hapticEngine.lastCommand;
        if (last && last.kind === 'continuous') duties.push(last.onMs);
    }

    const sorted = intensities.slice().sort((a, b) => a - b);
    const sortedDuties = duties.slice().sort((a, b) => a - b);
    const commands = sandbox.__vibrations.filter((entry) => entry.pattern !== 0);

    return {
        sandbox: sandbox,
        model: model,
        audio: audio,
        intensity: {
            min: sorted[0],
            p10: percentile(sorted, 0.1),
            median: percentile(sorted, 0.5),
            p90: percentile(sorted, 0.9),
            max: sorted[sorted.length - 1],
        },
        duty: {
            min: sortedDuties[0],
            median: percentile(sortedDuties, 0.5),
            max: sortedDuties[sortedDuties.length - 1],
        },
        motorCommands: commands.length,
        cancels: sandbox.__vibrations.filter((entry) => entry.pattern === 0).length,
        running: sandbox.hapticEngine.isRunning,
        notes: model.timeline.length,
    };
}

/** The duty cycle must rise with intensity; the motor has no other control. */
function dutyCurve() {
    const sandbox = createSandbox();
    const engine = sandbox.hapticEngine;
    engine.prepare();
    const curve = [];
    for (const intensity of [0.02, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 1]) {
        engine.updateAudio(intensity, 0.2);
        sandbox.__advance(100);
        curve.push({ intensity: intensity, onMs: engine.lastCommand.onMs });
    }
    engine.stopAudio();
    return curve;
}

function checks() {
    const results = [];
    const neutral = playThrough(1);
    const standard = playThrough(1.6);
    const strong = playThrough(2.5);

    results.push(['one motor window per ~100 ms', standard.motorCommands > 800,
        `${standard.motorCommands} commands for 94.7 s`]);
    results.push(['the motor is released when the song ends', standard.running === false,
        `isRunning=${standard.running}`]);
    results.push(['silence stops the channel instead of buzzing through it',
        standard.cancels > 0 && standard.cancels < 100, `${standard.cancels} cancels`]);
    results.push(['higher contrast pushes peaks up',
        strong.intensity.max > standard.intensity.max
        && standard.intensity.max > neutral.intensity.max,
        `${neutral.intensity.max.toFixed(3)} → ${standard.intensity.max.toFixed(3)} → ${strong.intensity.max.toFixed(3)}`]);
    results.push(['higher contrast pushes the quiet middle down',
        strong.intensity.median < standard.intensity.median,
        `${standard.intensity.median.toFixed(3)} → ${strong.intensity.median.toFixed(3)}`]);
    results.push(['the intensity floor keeps the channel alive', neutral.intensity.p10 >= 0.02,
        `p10=${neutral.intensity.p10.toFixed(3)}`]);
    results.push(['the analysed melody is loaded for the pitch tint',
        standard.notes === 267, `${standard.notes} notes`]);

    const curve = dutyCurve();
    let monotone = true;
    for (let index = 1; index < curve.length; index += 1) {
        if (curve[index].onMs < curve[index - 1].onMs) monotone = false;
    }
    results.push(['duty cycle rises with intensity', monotone,
        curve.map((point) => `${point.intensity}→${point.onMs}ms`).join(' ')]);

    return { results: results, neutral: neutral, standard: standard, strong: strong };
}

/** Pause must release the motor; resuming must re-arm it. */
function transportChecks() {
    const sandbox = createSandbox();
    const data = loadSongData(sandbox);
    const audio = fakeAudio(data);
    const model = new sandbox.ExperienceModel({ audio: audio, data: data, haptics: sandbox.hapticEngine });
    model.prepare();
    model.play();
    audio.paused = false;

    for (let frame = 0; frame < 600; frame += 1) {
        audio.currentTime = 5 + frame / data.frameRate;
        sandbox.__advance(FRAME_MS);
        model.tick();
    }
    const playing = sandbox.hapticEngine.isRunning;

    model.pause();
    const pausedIntensity = model.hapticIntensity;
    const paused = !sandbox.hapticEngine.isRunning && pausedIntensity === 0;
    const rewound = model.levels.every((level) => level === 0);

    model.seek(0.5);
    const seeked = Math.abs(audio.currentTime - data.duration * 0.5) < 0.01;
    const seekTarget = audio.currentTime;
    model.play();
    audio.paused = false;
    for (let frame = 0; frame < 60; frame += 1) {
        audio.currentTime = 47 + frame / data.frameRate;
        sandbox.__advance(FRAME_MS);
        model.tick();
    }
    const resumed = sandbox.hapticEngine.isRunning;

    return [
        ['the channel runs while the song plays', playing, `isRunning=${playing}`],
        ['pausing releases the motor and clears the signal', paused, `intensity=${pausedIntensity}`],
        ['pausing clears the waveform', rewound, 'all 84 buckets zero'],
        ['seeking lands on the requested fraction', seeked, `currentTime=${seekTarget.toFixed(2)}`],
        ['resuming re-arms the motor', resumed, `isRunning=${resumed}`],
    ];
}

function report(title, results) {
    console.log(`\n${title}`);
    let failed = 0;
    for (const [name, ok, detail] of results) {
        if (!ok) failed += 1;
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
    }
    return failed;
}

function main() {
    const { results, neutral, standard, strong } = checks();
    const format = (run) => ({
        contrast: run === neutral ? '1×' : run === standard ? '1.6×' : '2.5×',
        intensity: Object.fromEntries(Object.entries(run.intensity)
            .map(([key, value]) => [key, value.toFixed(3)])),
        dutyOnMs: run.duty,
        motorCommands: run.motorCommands,
        cancels: run.cancels,
    });
    console.log('Song experience, played through frame by frame:');
    console.log(JSON.stringify([format(neutral), format(standard), format(strong)], null, 2));

    let failed = report('Pipeline checks', results);
    failed += report('Transport checks', transportChecks());
    console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
    process.exitCode = failed === 0 ? 0 : 1;
}

main();
