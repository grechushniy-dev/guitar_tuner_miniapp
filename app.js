// Telegram Mini App initialization
class GuitarTuner {
    constructor() {
        // Initialize Telegram WebApp
        this.tg = window.Telegram?.WebApp;
        if (this.tg) {
            this.tg.ready();
            this.tg.expand();
        }

        // Guitar string frequencies (Hz) - standard tuning
        this.STRING_FREQUENCIES = [
            { note: 'E', frequency: 82.41, stringNumber: 6, label: 'sixth' },  // 6th string (low E)
            { note: 'A', frequency: 110.00, stringNumber: 5, label: 'fifth' }, // 5th string
            { note: 'D', frequency: 146.83, stringNumber: 4, label: 'fourth' },// 4th string
            { note: 'G', frequency: 196.00, stringNumber: 3, label: 'third' }, // 3rd string
            { note: 'B', frequency: 246.94, stringNumber: 2, label: 'second' },// 2nd string
            { note: 'E', frequency: 329.63, stringNumber: 1, label: 'first' }  // 1st string (high E)
        ];

        // Tuning constants
        this.TUNING_TOLERANCE = 15;          // ±15 cents считается «центр»
        this.MAX_OFFSET = 50;                // макс. отклонение по UI
        this.TUNED_CONFIRMATION_TIME = 1500; // 1.5 секунды в центре
        this.UPDATE_INTERVAL = 100;          // шаг обновления 100мс

        // Audio / detection
        this.audioContext = null;
        this.microphone = null;
        this.analyser = null;
        this.timeData = null;

        // State
        this.currentStringIndex = 0;
        this.isTuned = false;
        this.allStringsTuned = false;
        this.tuningTimeout = null;
        this.updateIntervalId = null;
        this.smoothedOffset = 0;
        this.smoothingFactor = 0.2;
        this.smoothedFrequency = null;
        this.frequencySmoothingFactor = 0.3;
        this.hasSound = false;

        // Note calculation
        this.NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        this.A4_FREQUENCY = 440;
        this.A4_NOTE_INDEX = 9; // A
        this.A4_OCTAVE = 4;

        // DOM elements
        this.elements = {
            permissionOverlay: document.getElementById('permissionOverlay'),
            instructionText: document.getElementById('instructionText'),
            tunedMessage: document.getElementById('tunedMessage'),
            tunedSubmessage: document.getElementById('tunedSubmessage'),
            orangeCircle: document.getElementById('orangeCircle'),
            noteText: document.getElementById('noteText'),
            resetButton: document.getElementById('resetButton')
        };

        // Bind methods
        this.requestMicrophoneAccess = this.requestMicrophoneAccess.bind(this);
        this.init = this.init.bind(this);
        this.resetTuning = this.resetTuning.bind(this);
        this.cleanup = this.cleanup.bind(this);
    }

    async init() {
        // Кнопка "Tune again"
        if (this.elements.resetButton) {
            this.elements.resetButton.addEventListener('click', this.resetTuning);
        }

        // Пытаемся сразу получить доступ, если пользователь уже давал разрешение
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            await this.setupAudio(stream);
            if (this.elements.permissionOverlay) {
                this.elements.permissionOverlay.classList.add('hidden');
            }
        } catch (err) {
            console.log('Microphone access not yet granted:', err);
            // просто показываем оверлей, кнопка вызовет requestMicrophoneAccess
        }
    }

    async requestMicrophoneAccess() {
        try:
            if (this.audioContext && this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }

            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            await this.setupAudio(stream);
            if (this.elements.permissionOverlay) {
                this.elements.permissionOverlay.classList.add('hidden');
            }
        } catch (err) {
            console.error('Error accessing microphone:', err);
            const errorMessage = err.name === 'NotAllowedError' 
                ? 'Доступ к микрофону запрещен. Разрешите доступ в настройках браузера или Telegram.'
                : err.name === 'NotFoundError'
                ? 'Микрофон не найден. Убедитесь, что он подключён.'
                : 'Не удалось получить доступ к микрофону: ' + (err.message || err.name);
            alert(errorMessage);
        }
    }

    async setupAudio(stream) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }

        this.microphone = this.audioContext.createMediaStreamSource(stream);

        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0.8;

        this.timeData = new Float32Array(this.analyser.fftSize);

        this.microphone.connect(this.analyser);

        this.startTuning();
    }

    // Автокорреляция по тайм-домену
    detectPitch() {
        if (!this.analyser || !this.timeData) return null;

        const bufferSize = this.timeData.length;
        this.analyser.getFloatTimeDomainData(this.timeData);

        // RMS — есть ли вообще звук
        let rms = 0;
        for (let i = 0; i < bufferSize; i++) {
            const v = this.timeData[i];
            rms += v * v;
        }
        rms = Math.sqrt(rms / bufferSize);

        if (rms < 0.01) {
            return null; // слишком тихо
        }

        // Убираем DC-смещение
        let mean = 0;
        for (let i = 0; i < bufferSize; i++) {
            mean += this.timeData[i];
        }
        mean /= bufferSize;

        const samples = new Float32Array(bufferSize);
        for (let i = 0; i < bufferSize; i++) {
            samples[i] = this.timeData[i] - mean;
        }

        let bestLag = -1;
        let bestCorr = 0;
        const maxLag = Math.floor(bufferSize / 2);

        for (let lag = 20; lag < maxLag; lag++) {
            let corr = 0;
            for (let i = 0; i < bufferSize - lag; i++) {
                corr += samples[i] * samples[i + lag];
            }

            if (corr > bestCorr) {
                bestCorr = corr;
                bestLag = lag;
            }
        }

        if (bestLag === -1 || bestCorr <= 0) {
            return null;
        }

        const frequency = this.audioContext.sampleRate / bestLag;

        if (frequency < 50 || frequency > 400) {
            return null;
        }

        return frequency;
    }

    startTuning() {
        this.updateUI();

        this.updateIntervalId = setInterval(() => {
            const frequency = this.detectPitch();

            if (frequency && frequency > 0) {
                this.hasSound = true;

                // сглаживаем частоту
                if (this.smoothedFrequency === null) {
                    this.smoothedFrequency = frequency;
                } else {
                    const diff = Math.abs(frequency - this.smoothedFrequency);
                    const maxDiff = this.smoothedFrequency * 0.1;

                    if (diff < maxDiff) {
                        this.smoothedFrequency = this.smoothedFrequency + (frequency - this.smoothedFrequency) * this.frequencySmoothingFactor;
                    } else {
                        this.smoothedFrequency = this.smoothedFrequency + (frequency - this.smoothedFrequency) * 0.5;
                    }
                }

                const usedFrequency = this.smoothedFrequency || frequency;
                this.updateTuning(usedFrequency);
            } else {
                this.hasSound = false;
                this.smoothedFrequency = null;
                this.updateTuning(null);
            }
        }, this.UPDATE_INTERVAL);
    }

    updateTuning(frequency) {
        const circle = this.elements.orangeCircle;

        if (!frequency || frequency <= 0) {
            // нет звука
            if (circle) {
                circle.style.opacity = '0.5';
            }

            // плавно уводим в центр
            this.smoothedOffset = this.smoothedOffset + (0 - this.smoothedOffset) * this.smoothingFactor;
            if (circle) {
                circle.style.transition = 'none';
                circle.style.transform = `translate(calc(-50% + ${this.smoothedOffset}px), -50%)`;
            }

            this.updateNoteText(null);

            if (this.tuningTimeout) {
                clearTimeout(this.tuningTimeout);
                this.tuningTimeout = null;
            }
            this.isTuned = false;
            return;
        }

        // есть звук
        if (circle) {
            circle.style.opacity = '1';
        }

        const currentString = this.STRING_FREQUENCIES[this.currentStringIndex];
        const cents = this.frequencyToCents(frequency, currentString.frequency);

        this.updateCirclePosition(cents);
        this.updateNoteText(frequency);

        const inCenter = Math.abs(cents) <= this.TUNING_TOLERANCE;
        const canBeTuned = inCenter && this.hasSound;

        if (!this.isTuned && canBeTuned) {
            this.isTuned = true;

            if (this.tuningTimeout) {
                clearTimeout(this.tuningTimeout);
            }

            this.tuningTimeout = setTimeout(() => {
                if (!this.isTuned || !this.hasSound) return;

                const finalCents = this.frequencyToCents(this.smoothedFrequency || frequency, currentString.frequency);
                if (Math.abs(finalCents) <= this.TUNING_TOLERANCE) {
                    this.moveToNextString();
                } else {
                    this.isTuned = false;
                }
                this.tuningTimeout = null;
            }, this.TUNED_CONFIRMATION_TIME);
        } else if (this.isTuned && !canBeTuned) {
            // вышли из «центра»
            this.isTuned = false;
            if (this.tuningTimeout) {
                clearTimeout(this.tuningTimeout);
                this.tuningTimeout = null;
            }
        }
    }

    updateUI() {
        const currentString = this.STRING_FREQUENCIES[this.currentStringIndex];

        if (this.allStringsTuned) {
            if (this.elements.instructionText) {
                this.elements.instructionText.classList.add('hidden');
            }
            if (this.elements.tunedMessage) {
                this.elements.tunedMessage.textContent = "Let's Play";
                this.elements.tunedMessage.classList.remove('hidden');
            }
            if (this.elements.tunedSubmessage) {
                this.elements.tunedSubmessage.textContent = "All strings are tuned.";
                this.elements.tunedSubmessage.classList.remove('hidden');
            }
            if (this.elements.noteText) {
                this.elements.noteText.textContent = '';
                this.elements.noteText.style.opacity = '0';
            }
            if (this.elements.resetButton) {
                this.elements.resetButton.classList.remove('hidden');
            }
            if (this.elements.orangeCircle) {
                this.smoothedOffset = 0;
                this.elements.orangeCircle.style.transform = 'translate(-50%, -50%)';
                this.elements.orangeCircle.style.opacity = '0.5';
            }
            return;
        }

        // обычный режим
        if (this.elements.instructionText) {
            this.elements.instructionText.textContent = `Pull ${currentString.label} string`;
            this.elements.instructionText.classList.remove('hidden');
        }
        if (this.elements.tunedMessage) {
            this.elements.tunedMessage.classList.add('hidden');
        }
        if (this.elements.tunedSubmessage) {
            this.elements.tunedSubmessage.classList.add('hidden');
        }
        if (this.elements.resetButton) {
            this.elements.resetButton.classList.add('hidden');
        }

        this.smoothedOffset = 0;
        this.smoothedFrequency = null;
        this.isTuned = false;

        if (this.elements.orangeCircle) {
            this.elements.orangeCircle.style.transform = 'translate(-50%, -50%)';
            this.elements.orangeCircle.style.opacity = '0.5';
        }

        if (this.elements.noteText) {
            this.elements.noteText.textContent = '';
            this.elements.noteText.style.opacity = '0';
        }

        // обновляем индикаторы струн
        this.STRING_FREQUENCIES.forEach((str, index) => {
            const el = document.querySelector(`[data-string="${index}"]`);
            if (!el) return;

            if (index < this.currentStringIndex) {
                el.classList.remove('active');
                el.classList.add('highlighted');
            } else if (index === this.currentStringIndex) {
                el.classList.remove('highlighted');
                el.classList.add('active');
            } else {
                el.classList.remove('highlighted', 'active');
            }
        });
    }

    frequencyToCents(detectedFreq, targetFreq) {
        if (!detectedFreq || detectedFreq <= 0 || !targetFreq || targetFreq <= 0) return 0;
        return 1200 * Math.log2(detectedFreq / targetFreq);
    }

    frequencyToNote(frequency) {
        if (!frequency || frequency <= 0) return null;

        const semitonesFromA4 = 12 * Math.log2(frequency / this.A4_FREQUENCY);
        const rounded = Math.round(semitonesFromA4);

        const semitonesFromC0 = rounded + (this.A4_OCTAVE * 12 + this.A4_NOTE_INDEX);
        const octave = Math.floor(semitonesFromC0 / 12);
        let noteIndex = semitonesFromC0 % 12;
        if (noteIndex < 0) noteIndex += 12;

        return {
            name: this.NOTE_NAMES[noteIndex],
            octave,
            frequency
        };
    }

    updateNoteText(frequency) {
        if (!this.elements.noteText) return;

        if (!frequency || frequency <= 0) {
            this.elements.noteText.textContent = '';
            this.elements.noteText.style.opacity = '0';
            return;
        }

        const note = this.frequencyToNote(frequency);
        if (!note) {
            this.elements.noteText.textContent = '';
            this.elements.noteText.style.opacity = '0';
            return;
        }

        this.elements.noteText.textContent = note.name;
        this.elements.noteText.style.opacity = '1';
    }

    updateCirclePosition(cents) {
        const circle = this.elements.orangeCircle;
        if (!circle) return;

        const maxOffsetPx = 16; // пикселей влево/вправо
        const clampedCents = Math.max(-this.MAX_OFFSET, Math.min(this.MAX_OFFSET, cents));
        let targetOffset = 0;

        if (Math.abs(cents) <= this.TUNING_TOLERANCE) {
            targetOffset = 0;
            const centerSmooth = 0.4;
            this.smoothedOffset = this.smoothedOffset + (targetOffset - this.smoothedOffset) * centerSmooth;
            if (Math.abs(this.smoothedOffset) < 0.5) {
                this.smoothedOffset = 0;
            }
        } else {
            targetOffset = (clampedCents / this.MAX_OFFSET) * maxOffsetPx;
            this.smoothedOffset = this.smoothedOffset + (targetOffset - this.smoothedOffset) * this.smoothingFactor;
        }

        circle.style.transition = 'none';
        circle.style.transform = `translate(calc(-50% + ${this.smoothedOffset}px), -50%)`;
    }

    moveToNextString() {
        if (this.tuningTimeout) {
            clearTimeout(this.tuningTimeout);
            this.tuningTimeout = null;
        }
        this.isTuned = false;

        if (this.currentStringIndex < this.STRING_FREQUENCIES.length - 1) {
            this.currentStringIndex += 1;
        } else {
            this.allStringsTuned = true;
        }

        this.updateUI();
    }

    resetTuning() {
        this.currentStringIndex = 0;
        this.allStringsTuned = false;
        this.isTuned = false;
        this.smoothedOffset = 0;
        this.smoothedFrequency = null;
        this.hasSound = false;

        if (this.tuningTimeout) {
            clearTimeout(this.tuningTimeout);
            this.tuningTimeout = null;
        }

        // сбрасываем индикаторы
        this.STRING_FREQUENCIES.forEach((str, index) => {
            const el = document.querySelector(`[data-string="${index}"]`);
            if (el) {
                el.classList.remove('highlighted', 'active');
            }
        });

        if (this.elements.orangeCircle) {
            this.elements.orangeCircle.style.transform = 'translate(-50%, -50%)';
            this.elements.orangeCircle.style.opacity = '0.5';
        }
        if (this.elements.tunedMessage) {
            this.elements.tunedMessage.classList.add('hidden');
        }
        if (this.elements.tunedSubmessage) {
            this.elements.tunedSubmessage.classList.add('hidden');
        }
        if (this.elements.resetButton) {
            this.elements.resetButton.classList.add('hidden');
        }
        if (this.elements.noteText) {
            this.elements.noteText.textContent = '';
            this.elements.noteText.style.opacity = '0';
        }

        this.updateUI();
    }

    cleanup() {
        if (this.tuningTimeout) {
            clearTimeout(this.tuningTimeout);
        }
        if (this.updateIntervalId) {
            clearInterval(this.updateIntervalId);
        }
        if (this.microphone && this.microphone.mediaStream) {
            this.microphone.mediaStream.getTracks().forEach(t => t.stop());
        }
        if (this.audioContext) {
            this.audioContext.close();
        }
    }
}

let tuner = null;

window.addEventListener('load', () => {
    tuner = new GuitarTuner();
    tuner.init();

    // чтобы кнопка в HTML могла дернуть этот метод
    window.requestMicrophoneAccess = tuner.requestMicrophoneAccess.bind(tuner);
});

window.addEventListener('beforeunload', () => {
    if (tuner) {
        tuner.cleanup();
    }
});
