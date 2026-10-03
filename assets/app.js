/*
 * app.js — the view layer.
 *
 * This is ExperienceView.swift's Song experience: the same beat orb, the same
 * level waveform, the same transport, the same notice when a device cannot
 * vibrate. It renders state the model owns and never decides anything about
 * playback or touch itself.
 *
 * Two panels are additions, because a browser is not always a phone: a motor
 * monitor that shows the vibration windows the addressable motor would receive,
 * and an optional low-frequency stand-in for devices without one.
 */
(function () {
    'use strict';

    const DATA = window.SONG_DATA;

    /* MARK: - Palette (Design/Theme.swift) */

    function hsvToBytes(hue, saturation, brightness) {
        const h = ((hue % 1) + 1) % 1 * 6;
        const i = Math.floor(h);
        const f = h - i;
        const p = brightness * (1 - saturation);
        const q = brightness * (1 - saturation * f);
        const t = brightness * (1 - saturation * (1 - f));
        const table = [[brightness, t, p], [q, brightness, p], [p, brightness, t],
            [p, q, brightness], [t, p, brightness], [brightness, p, q]];
        return table[i % 6].map((value) => Math.round(value * 255));
    }

    /** Theme.tint(forDegree:) — the shared cyan-to-violet ramp. */
    function rampTint(degree) {
        const t = Math.min(Math.max(degree / 6, 0), 1);
        return hsvToBytes(0.50 + 0.28 * t, 0.78, isDark() ? 0.95 : 0.46);
    }

    function isDark() {
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    function reducedMotion() {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    /** Theme.accent, read from the stylesheet so CSS stays the single source. */
    function accentTint() {
        const value = getComputedStyle(document.documentElement)
            .getPropertyValue('--accent').trim();
        const hex = /^#([0-9a-f]{6})$/i.exec(value);
        if (hex) {
            const number = parseInt(hex[1], 16);
            return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
        }
        const rgb = /rgba?\(([^)]+)\)/i.exec(value);
        if (rgb) {
            const parts = rgb[1].split(',').map((part) => parseFloat(part));
            return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
        }
        return [0, 122, 255];
    }

    function rgba(triple, alpha) {
        return `rgba(${triple[0]},${triple[1]},${triple[2]},${alpha})`;
    }

    function canvasGrid() {
        return isDark() ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.09)';
    }

    /* MARK: - DOM */

    const els = {
        audio: document.getElementById('audio'),
        stage: document.getElementById('stage'),
        orb: document.getElementById('orb'),
        orbFill: document.getElementById('orbFill'),
        orbValue: document.getElementById('orbValue'),
        waveform: document.getElementById('waveform'),
        motorCanvas: document.getElementById('motorCanvas'),
        motorValue: document.getElementById('motorValue'),
        motorFooter: document.getElementById('motorFooter'),
        hapticsNotice: document.getElementById('hapticsNotice'),
        contrastSlider: document.getElementById('contrastSlider'),
        contrastValue: document.getElementById('contrastValue'),
        toneToggle: document.getElementById('toneToggle'),
        progressSlider: document.getElementById('progressSlider'),
        timeCurrent: document.getElementById('timeCurrent'),
        timeDuration: document.getElementById('timeDuration'),
        restartButton: document.getElementById('restartButton'),
        playButton: document.getElementById('playButton'),
        startOverlay: document.getElementById('startOverlay'),
        startButton: document.getElementById('startButton'),
    };

    const ICONS = {
        play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.2l11 6.8-11 6.8z"></path></svg>',
        pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7.4" y="5.4" width="3.4" height="13.2" rx="1.2"></rect><rect x="13.2" y="5.4" width="3.4" height="13.2" rx="1.2"></rect></svg>',
    };

    /* MARK: - State */

    const haptics = window.hapticEngine;
    const tone = new window.TactileTone();

    let model = null;
    let lastOrbPercent = -1;
    let lastPlayGlyph = null;
    let noticeKey = null;
    let scrubbing = false;
    let audioFallbackTried = false;
    let waveformHeight = 0;
    let sliderPercent = -1;

    /* MARK: - Helpers */

    function clamp(value, low, high) {
        return Math.min(high, Math.max(low, value));
    }

    function timeLabel(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
        const total = Math.floor(seconds);
        return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    }

    /** The pitch tint the app uses for the waveform and scrubber. */
    function activeTint() {
        return model && model.activePitch
            ? rampTint(model.activePitch.degree)
            : accentTint();
    }

    function setSliderFill(input, fraction, tint) {
        const percent = clamp(fraction * 100, 0, 100).toFixed(2);
        input.style.setProperty('--track',
            `linear-gradient(to right, ${rgba(tint, 1)} 0 ${percent}%, ` +
            `var(--fill-strong) ${percent}% 100%)`);
    }

    function fitCanvas(canvas) {
        const ratio = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        const width = Math.max(1, Math.round(rect.width));
        const height = Math.max(1, Math.round(rect.height));
        if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
            canvas.width = Math.round(width * ratio);
            canvas.height = Math.round(height * ratio);
        }
        const context = canvas.getContext('2d');
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, width, height);
        return { context: context, width: width, height: height };
    }

    function roundRect(context, x, y, width, height, radius) {
        const r = Math.min(radius, width / 2, height / 2);
        context.beginPath();
        context.moveTo(x + r, y);
        context.arcTo(x + width, y, x + width, y + height, r);
        context.arcTo(x + width, y + height, x, y + height, r);
        context.arcTo(x, y + height, x, y, r);
        context.arcTo(x, y, x + width, y, r);
        context.closePath();
    }

    /* MARK: - Chrome */

    function updatePlayGlyph() {
        const glyph = model.isPlaying ? 'pause' : 'play';
        if (glyph === lastPlayGlyph) return;
        lastPlayGlyph = glyph;
        els.playButton.innerHTML = ICONS[glyph];
        els.playButton.setAttribute('aria-label', model.isPlaying ? '暂停' : '播放');
    }

    function updateTimes() {
        els.timeCurrent.textContent = timeLabel(model.currentTime);
        els.timeDuration.textContent = timeLabel(model.duration);
    }

    function updateNotice() {
        const unavailable = !haptics.hasMotor;
        const key = `${unavailable}|${haptics.apiPresent}|${model.errorMessage || ''}`;
        if (key === noticeKey) return;
        noticeKey = key;

        els.hapticsNotice.hidden = !unavailable && !model.errorMessage;
        if (model.errorMessage) {
            els.hapticsNotice.textContent = model.errorMessage;
        } else if (unavailable) {
            els.hapticsNotice.textContent = '此设备暂时无法提供震动，仍可播放音频和查看画面。';
        }

        els.motorFooter.textContent = haptics.hasMotor
            ? '每一柱是一个 100 毫秒窗口：通电越久，强度越大。'
            : '本机没有震动马达。每一柱是手机将会执行的 100 毫秒震动窗口。';
    }

    /* MARK: - Beat orb (BeatOrb) */

    function renderOrb() {
        const rect = els.stage.getBoundingClientRect();
        const size = Math.max(140, Math.round(Math.min(rect.width, rect.height) * 0.65));
        if (els.orb.dataset.size !== String(size)) {
            els.orb.dataset.size = String(size);
            els.orb.style.width = `${size}px`;
            els.orb.style.height = `${size}px`;
        }

        const level = clamp(model.hapticIntensity, 0, 1);
        els.orbFill.style.transform = reducedMotion() ? 'scale(1)' : `scale(${0.70 + level * 0.30})`;

        const percent = Math.round(level * 100);
        if (percent !== lastOrbPercent) {
            lastOrbPercent = percent;
            els.orbValue.textContent = `震动强度 ${percent}%`;
            els.orb.setAttribute('aria-label', `震动强度 ${percent}%`);
        }
    }

    /* MARK: - Level waveform (LevelWaveform) */

    function drawWaveform() {
        const canvas = els.waveform;
        const wanted = window.innerWidth > window.innerHeight ? 56 : 72;
        if (wanted !== waveformHeight) {
            waveformHeight = wanted;
            canvas.style.height = `${wanted}px`;
        }
        const { context, width, height } = fitCanvas(canvas);
        const levels = model.levels;
        if (!levels.length) return;

        const tint = activeTint();
        const step = width / levels.length;
        const middle = height / 2;

        for (let index = 0; index < levels.length; index += 1) {
            const barHeight = Math.max(2, levels[index] * height * 0.9);
            const x = index * step;
            const y = middle - barHeight / 2;
            const barWidth = Math.max(1, step - 1.5);
            const recency = index / levels.length;
            context.fillStyle = rgba(tint, 0.20 + recency * 0.7);
            roundRect(context, x, y, barWidth, barHeight, 1.5);
            context.fill();
        }
    }

    /* MARK: - Motor monitor (web-only readout of the haptic stream) */

    function drawMotor() {
        const { context, width, height } = fitCanvas(els.motorCanvas);
        const span = 3.2;
        const now = performance.now();
        const tint = accentTint();
        const windowMs = window.HapticEngine.windowMs;

        context.fillStyle = canvasGrid();
        context.fillRect(0, height - 1, width, 1);

        for (const command of haptics.history) {
            if (command.kind === 'stop') continue;
            const age = (now - command.at) / 1000;
            if (age < 0 || age > span) continue;

            const barWidth = Math.max(2, (windowMs / 1000 / span) * width - 2);
            const x = width - (age / span) * width - barWidth;
            const ratio = command.kind === 'pulse' ? 1 : clamp(command.onMs / windowMs, 0, 1);
            const barHeight = Math.max(2, (height - 4) * ratio);
            context.fillStyle = rgba(tint, command.kind === 'pulse'
                ? 0.9
                : 0.25 + 0.75 * clamp(command.intensity, 0, 1));
            roundRect(context, x, height - 2 - barHeight, barWidth, barHeight, 2);
            context.fill();
        }

        const last = haptics.lastCommand;
        const fresh = last && now - last.at < 260;
        let label = '待机';
        if (!haptics.hasMotor) {
            label = '本机无马达';
        } else if (fresh) {
            const percent = Math.round(clamp(last.intensity, 0, 1) * 100);
            label = last.kind === 'pulse'
                ? `脉冲 ${last.onMs}ms · 力度 ${percent}%`
                : `${last.onMs}ms / ${windowMs}ms · 强度 ${percent}%`;
        }
        if (els.motorValue.textContent !== label) els.motorValue.textContent = label;
    }

    /* MARK: - Frame loop */

    function frame() {
        if (model) {
            if (model.isPlaying) model.tick();

            renderOrb();
            drawWaveform();
            drawMotor();
            updatePlayGlyph();
            updateTimes();
            updateNotice();

            if (!scrubbing) {
                els.progressSlider.value = String(model.progress);
                const percent = Math.round(model.progress * 200) / 2;
                if (percent !== sliderPercent) {
                    sliderPercent = percent;
                    setSliderFill(els.progressSlider, percent / 100, activeTint());
                }
            }
            tone.setLevel(model.isPlaying ? model.hapticIntensity : 0);
        }
        window.requestAnimationFrame(frame);
    }

    /* MARK: - Actions */

    function startPlayback() {
        const started = model.play();
        if (started && typeof started.then === 'function') {
            started.then((ok) => {
                // Only a refused start needs the gate; a granted one is silent.
                els.startOverlay.hidden = ok !== false;
            });
        }
    }

    function togglePlayback() {
        if (!model) return;
        if (model.isPlaying) {
            model.pause();
        } else {
            startPlayback();
        }
    }

    function wireTransport() {
        els.playButton.addEventListener('click', togglePlayback);
        els.startButton.addEventListener('click', () => {
            els.startOverlay.hidden = true;
            startPlayback();
        });
        els.restartButton.addEventListener('click', () => {
            if (model) model.seek(0);
        });

        const beginScrub = () => { scrubbing = true; };
        const endScrub = () => { scrubbing = false; };
        els.progressSlider.addEventListener('pointerdown', beginScrub);
        els.progressSlider.addEventListener('pointerup', endScrub);
        els.progressSlider.addEventListener('pointercancel', endScrub);
        els.progressSlider.addEventListener('change', endScrub);
        els.progressSlider.addEventListener('input', (event) => {
            if (!model) return;
            const fraction = parseFloat(event.target.value);
            model.seek(fraction);
            setSliderFill(els.progressSlider, fraction, activeTint());
        });

        els.contrastSlider.addEventListener('input', (event) => {
            if (!model) return;
            const value = model.setContrast(parseFloat(event.target.value));
            els.contrastValue.textContent = `${value.toFixed(1)}×`;
            setSliderFill(els.contrastSlider,
                (value - window.ExperienceModel.contrastRange.min)
                / (window.ExperienceModel.contrastRange.max - window.ExperienceModel.contrastRange.min),
                accentTint());
        });

        els.toneToggle.addEventListener('change', (event) => {
            if (!tone.setEnabled(event.target.checked)) event.target.checked = false;
        });

        document.addEventListener('keydown', (event) => {
            if (!model || event.target instanceof HTMLInputElement) return;
            if (event.code === 'Space') {
                event.preventDefault();
                togglePlayback();
            } else if (event.code === 'ArrowLeft') {
                model.seek(clamp(model.progress - 0.02, 0, 1));
            } else if (event.code === 'ArrowRight') {
                model.seek(clamp(model.progress + 0.02, 0, 1));
            }
        });

        // scenePhase != .active pauses the experience in the app; a hidden tab
        // is the same situation.
        document.addEventListener('visibilitychange', () => {
            if (document.hidden && model && model.isPlaying) model.pause();
        });

        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            sliderPercent = -1;
        });
    }

    /* MARK: - Audio loading */

    function wireAudio() {
        els.audio.addEventListener('loadedmetadata', () => {
            if (model && Number.isFinite(els.audio.duration)) model.duration = els.audio.duration;
            updateTimes();
        });
        els.audio.addEventListener('ended', () => {
            if (model) model.stop();
        });
        // Some browsers refuse a relative media file on a file:// page. The same
        // recording is available base64-encoded; load it only if needed.
        els.audio.addEventListener('error', () => {
            if (audioFallbackTried) return;
            audioFallbackTried = true;
            const script = document.createElement('script');
            script.src = 'data/audio-data.js';
            script.onload = () => {
                if (!window.SONG_AUDIO_DATA_URI) return;
                const wasPlaying = model && model.isPlaying;
                els.audio.src = window.SONG_AUDIO_DATA_URI;
                els.audio.load();
                if (wasPlaying) els.audio.play();
                updateTimes();
            };
            document.head.appendChild(script);
        });
        els.audio.addEventListener('play', () => { if (model) model.isPlaying = true; });
        els.audio.addEventListener('pause', () => { if (model) model.isPlaying = false; });
    }

    /* MARK: - Boot */

    function boot() {
        if (!DATA) {
            document.body.textContent = '无法读取歌曲数据（data/song-data.js）。';
            return;
        }

        model = new window.ExperienceModel({ audio: els.audio, data: DATA, haptics: haptics });
        model.prepare();
        updateTimes();
        updateNotice();

        els.contrastSlider.value = String(model.hapticContrast);
        els.contrastValue.textContent = `${model.hapticContrast.toFixed(1)}×`;
        setSliderFill(els.contrastSlider,
            (model.hapticContrast - window.ExperienceModel.contrastRange.min)
            / (window.ExperienceModel.contrastRange.max - window.ExperienceModel.contrastRange.min),
            accentTint());

        wireTransport();
        wireAudio();
        window.requestAnimationFrame(frame);

        // A handle for the console and for the verification harness in scripts/.
        window.__experience = {
            get model() { return model; },
            haptics: haptics,
            tone: tone,
        };

        // Straight into the song. Browsers that refuse an automatic start fall
        // back to the gate, which also unlocks the motor on Android.
        startPlayback();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
