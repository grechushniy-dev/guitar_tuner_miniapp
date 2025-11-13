class GuitarTuner {
    constructor() {
        // Telegram WebApp
        this.tg = window.Telegram?.WebApp;
        if (this.tg) {
            this.tg.ready();
            this.tg.expand();
        }

        // Стандартный строй гитары
        this.STRING_FREQUENCIES = [
            { note: 'E', frequency: 82.41, label: 'sixth' },
            { note: 'A', frequency: 110.00, label: 'fifth' },
            { note: 'D', frequency: 146.83, label: 'fourth' },
            { note: 'G', frequency: 196.00, label: 'third' },
            { note: 'B', frequency: 246.94, label: 'second' },
            { note: 'E', frequency: 329.63, label: 'first' }
        ];

        // Настройки тюнера
        this.TUNING_TOLERANCE = 15;          // ±15 центов — считаем настроенной
        this.MAX_OFFSET = 50;                // макс. отклонение по UI в центах
        this.TUNED_CONFIRMATION_TIME = 1500; // 1.5 сек в центре
        this.UPDATE_INTERVAL = 80;           // шаг обновления (мс)

        // Аудио
        this.audioContext = null;
        this.microphone = null;
        this.analyser = null;
        this.timeData = null;

        // Состояние
        this.currentStringIndex = 0;
        this.isTuned = false;
        this.allStringsTuned = false;
        this.smoothedOffset = 0;
        this.smoothingFactor = 0.25;
        this.smoothedFrequency = null;
        this.frequencySmoothingFactor = 0.35;
        this.hasSound = false;
        this.tuningTimeout = null;
        this.updateIntervalId = null;

        // DOM
        this.elements = {
            permissionOverlay: document.getElementById('permissionOverlay'),
            instructionText: document.getElementById('instructionText'),
            tunedMessage: document.getElementById('tunedMessage'),
            tunedSubmessage: document.getElementById('tunedSubmessage'),
            orangeCircle: document.getElementById('orangeCircle'),
            noteText: document.getElementById('noteText'),
            resetButton: document.getElementById('resetButton')
        };

        // Ноты
        this.NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
        this.A4 = 440;

        // бинды
        this.requestMicrophoneAccess = this.requestMicrophoneAccess.bind(this);
        this.init = this.init.bind(this);
        this.resetTuning = this.resetTuning.bind(this);
    }

    async init() {
        if (this.elements.resetButton) {
            this.elements.resetButton.addEventListener('click', this.resetTuning);
        }
        // Ждём клик по кнопке доступа к микрофону
    }

    async requestMicrophoneAccess() {
        try {
            if (!this.audioContext) {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }

            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            await this.setupAudio(stream);

            if (this.elements.permissionOverlay) {
                this.elements.permissionOverlay.classList.add('hidden');
            }
        } catch (err) {
            console.error(err);
            alert('Ошибка доступа к микрофону: ' + (err.message || err.name));
        }
    }

    async setupAudio(stream) {
        this.microphone = this.audioContext.createMediaStreamSource(stream);
        this.analyser = this.audioContext.createAnalyser();

        this.analyser.fftSize = 2048;
        this.timeData = new Float32Array(this.analyser.fftSize);

        this.microphone.connect(this.analyser);

        this.startTuning();
    }

    // Автокорреляция: ищем период → частота
    detectPitch() {
        if (!this.analyser || !this.timeData) return null;

        this.analyser.getFloatTimeDomainData(this.timeData);

        // RMS — громкость сигнала
        let rms = 0;
        for (let i = 0; i < this.timeData.length; i++) {
            const v = this.timeData[i];
            rms += v * v;
        }
        rms = Math.sqrt(rms / this.timeData.length);

        // МАКСИМАЛЬНАЯ ЧУВСТВИТЕЛЬНОСТЬ
        // Очень низкий порог "тишины"
        if (rms < 0.0006) {   // было 0.0008 — сделали ещё более чувствительным
            return null;
        }

        const buf = this.timeData;
        const size = buf.length;
        const maxLag = size / 2;

        let bestLag = -1;
        let bestCorr = 0;

        // Нормализуем корреляцию, чтобы отсечь совсем шум
        for (let lag = 8; lag < maxLag; lag++) {
            let corr = 0;
            let normA = 0;
            let normB = 0;
            for (let i = 0; i < size - lag; i++) {
                const a = buf[i];
                const b = buf[i + lag];
                corr += a * b;
                normA += a * a;
                normB += b * b;
            }

            const denom = Math.sqrt(normA * normB) || 1e-9;
            const normalized = corr / denom;

            if (normalized > bestCorr) {
                bestCorr = normalized;
                bestLag = lag;
            }
        }

        // Порог корреляции тоже занижен (чувствительнее)
        if (bestLag === -1 || bestCorr < 0.35) {  // было 0.3
            return null;
        }

        const freq = this.audioContext.sampleRate / bestLag;
        if (freq < 50 || freq > 400) return null;

        return freq;
    }

    startTuning() {
        this.updateUI();

        this.updateIntervalId = setInterval(() => {
            const freq = this.detectPitch();

            if (freq) {
                this.hasSound = true;

                if (!this.smoothedFrequency) {
                    this.smoothedFrequency = freq;
                } else {
                    this.smoothedFrequency =
                        this.smoothedFrequency +
                        (freq - this.smoothedFrequency) * this.frequencySmoothingFactor;
                }

                this.updateTuning(this.smoothedFrequency);
            } else {
                this.hasSound = false;
                this.smoothedFrequency = null;
                this.updateTuning(null);
            }
        }, this.UPDATE_INTERVAL);
    }

    updateTuning(frequency) {
        const circle = this.elements.orangeCircle;
        if (!circle) return;

        if (!frequency) {
            // нет звука → круг бледный и возвращается в центр
            circle.style.opacity = '0.5';
            this.smoothedOffset += (0 - this.smoothedOffset) * this.smoothingFactor;
            circle.style.transform = `translate(calc(-50% + ${this.smoothedOffset}px), -50%)`;
            this.updateNoteText(null);

            this.isTuned = false;
            if (this.tuningTimeout) {
                clearTimeout(this.tuningTimeout);
                this.tuningTimeout = null;
            }
            return;
        }

        // есть звук → круг полностью видимый
        circle.style.opacity = '1';

        const current = this.STRING_FREQUENCIES[this.currentStringIndex];
        const cents = this.frequencyToCents(frequency, current.frequency);

        // определяем ноту
        const noteName = this.getNoteName(frequency);
        const isCorrectNote = (noteName === current.note);

        // ДВИЖЕНИЕ КРУГА:
        // freq < target (cents < 0) → НИЗИТ → нужно тянуть → круг вправо
        // freq > target (cents > 0) → ПЕРЕТЯНУТА → ослабить → круг влево
        this.updateCirclePosition(cents);
        this.updateNoteText(frequency);

        const centered = Math.abs(cents) <= this.TUNING_TOLERANCE;

        // НОВАЯ ЛОГИКА:
        // считаем струну настроенной ТОЛЬКО если:
        // 1) круг в центре
        // 2) есть звук
        // 3) отображается правильная нота для текущей струны
        const canConfirm = centered && this.hasSound && isCorrectNote;

        if (!this.isTuned && canConfirm) {
            this.isTuned = true;
            if (this.tuningTimeout) clearTimeout(this.tuningTimeout);

            this.tuningTimeout = setTimeout(() => {
                if (this.isTuned && this.hasSound) {
                    const finalFreq = this.smoothedFrequency || frequency;
                    const finalCents = this.frequencyToCents(finalFreq, current.frequency);
                    const finalNote = this.getNoteName(finalFreq);
                    const finalCorrectNote = (finalNote === current.note);

                    if (Math.abs(finalCents) <= this.TUNING_TOLERANCE && finalCorrectNote) {
                        this.moveToNextString();
                    } else {
                        this.isTuned = false;
                    }
                }
                this.tuningTimeout = null;
            }, this.TUNED_CONFIRMATION_TIME);
        }

        if (this.isTuned && !canConfirm) {
            this.isTuned = false;
            if (this.tuningTimeout) {
                clearTimeout(this.tuningTimeout);
                this.tuningTimeout = null;
            }
        }
    }

    updateUI() {
        const current = this.STRING_FREQUENCIES[this.currentStringIndex];

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
            if (this.elements.resetButton) {
                this.elements.resetButton.classList.remove('hidden');
            }
            return;
        }

        if (this.elements.instructionText) {
            this.elements.instructionText.textContent = `Pull ${current.label} string`;
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

        // индикаторы струн
        const letters = document.querySelectorAll('.string-letter');
        letters.forEach((el, i) => {
            el.classList.toggle('active', i === this.currentStringIndex);
            el.classList.toggle('highlighted', i < this.currentStringIndex);
        });
    }

    frequencyToCents(freq, target) {
        return 1200 * Math.log2(freq / target);
    }

    updateNoteText(freq) {
        const el = this.elements.noteText;
        if (!el) return;

        if (!freq) {
            el.style.opacity = 0;
            el.textContent = '';
            return;
        }

        const note = this.getNoteName(freq);
        el.textContent = note;
        el.style.opacity = 1;
    }

    getNoteName(freq) {
        const semitones = 12 * Math.log2(freq / this.A4);
        const rounded = Math.round(semitones);
        const index = (rounded + 9 + 12 * 4) % 12; // смещение от A4
        return this.NOTE_NAMES[index];
    }

    updateCirclePosition(cents) {
        const circle = this.elements.orangeCircle;
        if (!circle) return;

        const maxPx = 16;
        const clamped = Math.max(-this.MAX_OFFSET, Math.min(this.MAX_OFFSET, cents));

        // Знак инвертирован:
        // cents < 0 (низит) → offset > 0 → вправо
        // cents > 0 (перетянута) → offset < 0 → влево
        const targetOffset = (-clamped / this.MAX_OFFSET) * maxPx;

        this.smoothedOffset += (targetOffset - this.smoothedOffset) * this.smoothingFactor;

        circle.style.transform = `translate(calc(-50% + ${this.smoothedOffset}px), -50%)`;
    }

    moveToNextString() {
        this.isTuned = false;

        if (this.currentStringIndex < this.STRING_FREQUENCIES.length - 1) {
            this.currentStringIndex++;
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

        if (this.elements.orangeCircle) {
            this.elements.orangeCircle.style.opacity = '0.5';
            this.elements.orangeCircle.style.transform = 'translate(-50%, -50%)';
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
            this.elements.noteText.style.opacity = 0;
            this.elements.noteText.textContent = '';
        }

        this.updateUI();
    }
}

let tuner;

window.addEventListener('load', () => {
    tuner = new GuitarTuner();
    tuner.init();

    // Чтобы кнопка в HTML работала
    window.requestMicrophoneAccess = tuner.requestMicrophoneAccess.bind(tuner);
});
