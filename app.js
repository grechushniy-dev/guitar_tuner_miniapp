class GuitarTuner {
    constructor() {
        this.tg = window.Telegram?.WebApp;
        if (this.tg) {
            this.tg.ready();
            this.tg.expand();
        }

        this.STRING_FREQUENCIES = [
            { note: 'E', frequency: 82.41, label: 'sixth' },
            { note: 'A', frequency: 110.00, label: 'fifth' },
            { note: 'D', frequency: 146.83, label: 'fourth' },
            { note: 'G', frequency: 196.00, label: 'third' },
            { note: 'B', frequency: 246.94, label: 'second' },
            { note: 'E', frequency: 329.63, label: 'first' }
        ];

        this.TUNING_TOLERANCE = 15;
        this.MAX_OFFSET = 50;
        this.TUNED_CONFIRMATION_TIME = 1500;
        this.UPDATE_INTERVAL = 100;

        this.audioContext = null;
        this.microphone = null;
        this.analyser = null;
        this.timeData = null;

        this.currentStringIndex = 0;
        this.isTuned = false;
        this.allStringsTuned = false;
        this.smoothedOffset = 0;
        this.smoothingFactor = 0.2;
        this.smoothedFrequency = null;
        this.frequencySmoothingFactor = 0.3;
        this.hasSound = false;

        this.elements = {
            permissionOverlay: document.getElementById('permissionOverlay'),
            instructionText: document.getElementById('instructionText'),
            tunedMessage: document.getElementById('tunedMessage'),
            tunedSubmessage: document.getElementById('tunedSubmessage'),
            orangeCircle: document.getElementById('orangeCircle'),
            noteText: document.getElementById('noteText'),
            resetButton: document.getElementById('resetButton')
        };

        this.NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
        this.A4 = 440;

        this.requestMicrophoneAccess = this.requestMicrophoneAccess.bind(this);
        this.init = this.init.bind(this);
        this.resetTuning = this.resetTuning.bind(this);
    }

    async init() {
        if (this.elements.resetButton) {
            this.elements.resetButton.addEventListener("click", this.resetTuning);
        }
    }

    async requestMicrophoneAccess() {
        try {
            if (!this.audioContext)
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

            if (this.audioContext.state === "suspended")
                await this.audioContext.resume();

            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            await this.setupAudio(stream);

            this.elements.permissionOverlay.classList.add("hidden");

        } catch (err) {
            alert("Ошибка доступа: " + err.message);
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

    detectPitch() {
        this.analyser.getFloatTimeDomainData(this.timeData);

        let rms = 0;
        for (let i = 0; i < this.timeData.length; i++)
            rms += this.timeData[i] * this.timeData[i];

        rms = Math.sqrt(rms / this.timeData.length);
        if (rms < 0.01) return null;

        let bestLag = -1;
        let bestCorr = 0;
        let buf = this.timeData;
        let size = buf.length;
        let maxLag = size / 2;

        for (let lag = 8; lag < maxLag; lag++) {
            let corr = 0;
            for (let i = 0; i < size - lag; i++)
                corr += buf[i] * buf[i + lag];

            if (corr > bestCorr) {
                bestCorr = corr;
                bestLag = lag;
            }
        }

        if (bestLag === -1) return null;

        const freq = this.audioContext.sampleRate / bestLag;
        return (freq < 50 || freq > 400) ? null : freq;
    }

    startTuning() {
        this.updateUI();

        this.updateIntervalId = setInterval(() => {
            const freq = this.detectPitch();

            if (freq) {
                this.hasSound = true;

                if (!this.smoothedFrequency)
                    this.smoothedFrequency = freq;
                else
                    this.smoothedFrequency = this.smoothedFrequency + (freq - this.smoothedFrequency) * 0.3;

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

        if (!frequency) {
            circle.style.opacity = "0.5";
            this.smoothedOffset += (0 - this.smoothedOffset) * this.smoothingFactor;
            circle.style.transform = `translate(calc(-50% + ${this.smoothedOffset}px), -50%)`;
            this.updateNoteText(null);
            this.isTuned = false;
            return;
        }

        circle.style.opacity = "1";
        const current = this.STRING_FREQUENCIES[this.currentStringIndex];
        const cents = this.frequencyToCents(frequency, current.frequency);

        this.updateCirclePosition(cents);
        this.updateNoteText(frequency);

        const centered = Math.abs(cents) < this.TUNING_TOLERANCE;

        if (centered && this.hasSound && !this.isTuned) {
            this.isTuned = true;
            this.tuningTimeout = setTimeout(() => {
                if (this.isTuned && this.hasSound)
                    this.moveToNextString();
            }, this.TUNED_CONFIRMATION_TIME);
        }

        if (!centered) {
            this.isTuned = false;
            clearTimeout(this.tuningTimeout);
        }
    }

    updateUI() {
        const current = this.STRING_FREQUENCIES[this.currentStringIndex];

        if (this.allStringsTuned) {
            this.elements.instructionText.classList.add("hidden");

            this.elements.tunedMessage.textContent = "Let's Play";
            this.elements.tunedMessage.classList.remove("hidden");

            this.elements.tunedSubmessage.textContent = "All strings are tuned.";
            this.elements.tunedSubmessage.classList.remove("hidden");

            this.elements.resetButton.classList.remove("hidden");
            return;
        }

        this.elements.instructionText.textContent = `Pull ${current.label} string`;

        [...document.querySelectorAll(".string-letter")].forEach((el, i) => {
            el.classList.toggle("active", i === this.currentStringIndex);
            el.classList.toggle("highlighted", i < this.currentStringIndex);
        });
    }

    frequencyToCents(freq, target) {
        return 1200 * Math.log2(freq / target);
    }

    updateNoteText(freq) {
        if (!freq) {
            this.elements.noteText.style.opacity = 0;
            return;
        }

        const note = this.getNoteName(freq);

        this.elements.noteText.textContent = note;
        this.elements.noteText.style.opacity = 1;
    }

    getNoteName(freq) {
        const semitones = 12 * Math.log2(freq / this.A4);
        const noteIndex = (Math.round(semitones) + 9 + 12 * 4) % 12;
        return this.NOTE_NAMES[noteIndex];
    }

    updateCirclePosition(cents) {
        const maxPx = 16;
        let target = (Math.max(-this.MAX_OFFSET, Math.min(this.MAX_OFFSET, cents)) / this.MAX_OFFSET) * maxPx;
        this.smoothedOffset += (target - this.smoothedOffset) * this.smoothingFactor;

        this.elements.orangeCircle.style.transform =
            `translate(calc(-50% + ${this.smoothedOffset}px), -50%)`;
    }

    moveToNextString() {
        if (this.currentStringIndex < this.STRING_FREQUENCIES.length - 1) {
            this.currentStringIndex++;
            this.isTuned = false;
            this.updateUI();
        } else {
            this.allStringsTuned = true;
            this.updateUI();
        }
    }

    resetTuning() {
        this.currentStringIndex = 0;
        this.allStringsTuned = false;
        this.isTuned = false;

        this.smoothedOffset = 0;
        this.smoothedFrequency = null;
        this.hasSound = false;

        this.elements.orangeCircle.style.opacity = "0.5";
        this.elements.noteText.style.opacity = 0;

        this.elements.tunedMessage.classList.add("hidden");
        this.elements.tunedSubmessage.classList.add("hidden");
        this.elements.resetButton.classList.add("hidden");

        this.updateUI();
    }
}

let tuner;

window.addEventListener('load', () => {
    tuner = new GuitarTuner();
    tuner.init();
    window.requestMicrophoneAccess = tuner.requestMicrophoneAccess;
});
