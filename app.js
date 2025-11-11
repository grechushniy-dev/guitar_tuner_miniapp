// Load Pitchy library dynamically
let PitchDetector = null;

async function loadPitchy() {
    try {
        const pitchyModule = await import('https://cdn.jsdelivr.net/npm/pitchy@4/+esm');
        PitchDetector = pitchyModule.PitchDetector;
        window.PitchDetector = PitchDetector; // Also set on window for compatibility
        console.log('Pitchy loaded successfully via dynamic import');
        return true;
    } catch (error) {
        console.error('Error loading Pitchy:', error);
        return false;
    }
}

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
            { note: 'A', frequency: 110.00, stringNumber: 5, label: 'fifth' },  // 5th string
            { note: 'D', frequency: 146.83, stringNumber: 4, label: 'fourth' }, // 4th string
            { note: 'G', frequency: 196.00, stringNumber: 3, label: 'third' },  // 3rd string
            { note: 'B', frequency: 246.94, stringNumber: 2, label: 'second' }, // 2nd string
            { note: 'E', frequency: 329.63, stringNumber: 1, label: 'first' }   // 1st string (high E)
        ];

        // Tuning constants
        this.TUNING_TOLERANCE = 8; // ±8 cents tolerance
        this.MAX_OFFSET = 50; // Maximum offset in cents for visual display
        this.TUNED_CONFIRMATION_TIME = 800; // Time in ms to confirm tuning is stable
        this.UPDATE_INTERVAL = 100; // Update every 100ms
        this.CLARITY_THRESHOLD = 0.7; // Minimum clarity for valid pitch detection

        // State variables
        this.currentStringIndex = 0;
        this.audioContext = null;
        this.microphone = null;
        this.analyser = null;
        this.pitchDetector = null;
        this.updateIntervalId = null;
        this.isTuned = false;
        this.allStringsTuned = false;
        this.tuningTimeout = null;
        this.smoothedOffset = 0; // For smooth circle movement
        this.smoothingFactor = 0.15; // Smoothing factor (0-1), lower = smoother
        this.currentFrequency = null;
        this.currentNote = null;
        this.audioInput = null;
        this.PitchDetector = null; // Will be set after library loads

        // DOM elements
        this.elements = {
            permissionOverlay: document.getElementById('permissionOverlay'),
            instructionText: document.getElementById('instructionText'),
            tunedMessage: document.getElementById('tunedMessage'),
            tunedSubmessage: document.getElementById('tunedSubmessage'),
            orangeCircle: document.getElementById('orangeCircle'),
            noteText: document.getElementById('noteText')
        };

        // Musical note names
        this.NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        // Reference frequency (A4 = 440 Hz)
        this.A4_FREQUENCY = 440;
        this.A4_NOTE_INDEX = 9; // A is at index 9 in NOTE_NAMES
        this.A4_OCTAVE = 4;

        // Bind methods
        this.requestMicrophoneAccess = this.requestMicrophoneAccess.bind(this);
        this.init = this.init.bind(this);
        this.cleanup = this.cleanup.bind(this);
    }

    // Initialize app
    async init() {
        // Load Pitchy library first
        console.log('Loading Pitchy library...');
        const pitchyLoaded = await loadPitchy();
        
        if (!pitchyLoaded || !PitchDetector) {
            console.error('Failed to load Pitchy library');
            
            // Show user-friendly error message
            if (this.elements.permissionOverlay) {
                this.elements.permissionOverlay.innerHTML = `
                    <div class="permission-text" style="color: #ff0000; margin-bottom: 20px;">
                        Ошибка загрузки библиотеки анализа звука
                    </div>
                    <div class="permission-text" style="font-size: 14px; margin-bottom: 30px;">
                        Пожалуйста, обновите страницу или проверьте подключение к интернету
                    </div>
                    <button class="permission-btn" onclick="location.reload()">Обновить страницу</button>
                `;
            } else {
                alert('Ошибка загрузки библиотеки анализа звука (pitchy). Пожалуйста, обновите страницу.');
            }
            return;
        }

        // Store PitchDetector reference
        this.PitchDetector = PitchDetector;
        console.log('Pitchy PitchDetector loaded and ready');

        // Check if microphone access is already granted
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            await this.setupAudio(stream);
            if (this.elements.permissionOverlay) {
                this.elements.permissionOverlay.classList.add('hidden');
            }
        } catch (err) {
            console.log('Microphone access not granted:', err);
            // Show permission overlay - it's already visible
        }
    }

    // Request microphone access
    async requestMicrophoneAccess() {
        // Check if PitchDetector is available
        if (!PitchDetector && !this.PitchDetector) {
            console.error('PitchDetector is not available');
            // Try to load it again
            const loaded = await loadPitchy();
            if (!loaded) {
                alert('Библиотека анализа звука не загружена. Пожалуйста, обновите страницу.');
                return;
            }
            this.PitchDetector = PitchDetector;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            await this.setupAudio(stream);
            if (this.elements.permissionOverlay) {
                this.elements.permissionOverlay.classList.add('hidden');
            }
        } catch (err) {
            console.error('Error accessing microphone:', err);
            const errorMessage = err.name === 'NotAllowedError' 
                ? 'Доступ к микрофону запрещен. Пожалуйста, разрешите доступ в настройках браузера.'
                : err.name === 'NotFoundError'
                ? 'Микрофон не найден. Убедитесь, что микрофон подключен.'
                : 'Не удалось получить доступ к микрофону: ' + (err.message || err.name);
            alert(errorMessage);
        }
    }

    // Setup audio processing with pitchy
    async setupAudio(stream) {
        try {
            // Validate PitchDetector is available
            const PitchDetectorToUse = PitchDetector || this.PitchDetector || window.PitchDetector;
            
            if (!PitchDetectorToUse) {
                throw new Error('PitchDetector не загружен. Пожалуйста, обновите страницу.');
            }

            if (typeof PitchDetectorToUse.forFloat32Array !== 'function') {
                throw new Error('PitchDetector.forFloat32Array не доступен. Библиотека pitchy загружена неправильно.');
            }

            // Initialize audio context
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const sampleRate = this.audioContext.sampleRate;
            
            if (!sampleRate || isNaN(sampleRate)) {
                throw new Error('Не удалось получить sample rate из AudioContext');
            }
            
            console.log(`AudioContext sample rate: ${sampleRate} Hz`);

            // Create microphone source
            this.microphone = this.audioContext.createMediaStreamSource(stream);

            // Create analyser node
            this.analyser = this.audioContext.createAnalyser();
            if (!this.analyser) {
                throw new Error('Не удалось создать AnalyserNode');
            }

            // Set analyser properties
            this.analyser.fftSize = 8192; // Larger FFT for better frequency resolution
            this.analyser.smoothingTimeConstant = 0.3;
            this.microphone.connect(this.analyser);

            // Validate fftSize was set correctly
            if (!this.analyser.fftSize || this.analyser.fftSize === 0) {
                throw new Error('Не удалось установить fftSize для analyser');
            }

            // Initialize Pitchy detector
            console.log('Initializing Pitchy detector with sample rate:', sampleRate);
            
            try {
                this.pitchDetector = PitchDetectorToUse.forFloat32Array(sampleRate);
                
                if (!this.pitchDetector) {
                    throw new Error('PitchDetector.forFloat32Array вернул null или undefined');
                }

                if (!this.pitchDetector.inputLength || this.pitchDetector.inputLength === 0) {
                    throw new Error('pitchDetector.inputLength не определен');
                }

                this.audioInput = new Float32Array(this.pitchDetector.inputLength);
                console.log(`Pitchy detector initialized successfully. Input length: ${this.pitchDetector.inputLength}`);
            } catch (pitchError) {
                console.error('Error initializing Pitchy detector:', pitchError);
                throw new Error('Ошибка инициализации детектора высоты тона: ' + pitchError.message);
            }

            // Start tuning process
            this.startTuning();
        } catch (error) {
            console.error('Error setting up audio:', error);
            const errorMessage = error.message || 'Неизвестная ошибка инициализации анализа звука';
            
            // Show user-friendly error
            if (this.elements.permissionOverlay) {
                this.elements.permissionOverlay.innerHTML = `
                    <div class="permission-text" style="color: #ff0000; margin-bottom: 20px;">
                        Ошибка инициализации
                    </div>
                    <div class="permission-text" style="font-size: 14px; margin-bottom: 30px;">
                        ${errorMessage}
                    </div>
                    <button class="permission-btn" onclick="location.reload()">Обновить страницу</button>
                `;
                this.elements.permissionOverlay.classList.remove('hidden');
            } else {
                alert('Ошибка инициализации анализа звука: ' + errorMessage);
            }
        }
    }

    // Get pitch using Pitchy (called every 100ms)
    getPitch() {
        // Validate required components
        if (!this.analyser) {
            console.warn('Analyser not initialized');
            return;
        }

        if (!this.pitchDetector) {
            console.warn('PitchDetector not initialized');
            return;
        }

        if (!this.audioInput || !this.audioInput.length) {
            console.warn('AudioInput not initialized');
            return;
        }

        try {
            // Validate analyser.fftSize
            const fftSize = this.analyser.fftSize;
            if (!fftSize || fftSize === 0) {
                console.warn('Invalid fftSize:', fftSize);
                return;
            }

            // Get time domain data
            const buffer = new Float32Array(fftSize);
            this.analyser.getFloatTimeDomainData(buffer);

            // Copy required length to audioInput
            const length = Math.min(buffer.length, this.audioInput.length);
            if (length === 0) {
                console.warn('Buffer length is 0');
                return;
            }

            for (let i = 0; i < length; i++) {
                this.audioInput[i] = buffer[i];
            }

            // Detect pitch using Pitchy
            if (typeof this.pitchDetector.findPitch !== 'function') {
                console.error('pitchDetector.findPitch is not a function');
                return;
            }

            const [pitch, clarity] = this.pitchDetector.findPitch(this.audioInput);
            
            // Validate pitch and clarity values
            if (typeof pitch !== 'number' || typeof clarity !== 'number') {
                console.warn('Invalid pitch or clarity values:', pitch, clarity);
                this.currentFrequency = null;
                this.currentNote = null;
                return;
            }
            
            // Only use pitch if clarity is above threshold
            if (pitch > 0 && clarity > this.CLARITY_THRESHOLD && pitch >= 50 && pitch <= 400) {
                this.currentFrequency = pitch;
                this.currentNote = this.frequencyToNote(pitch);
                
                // Log to console as requested
                console.log(`Frequency: ${pitch.toFixed(2)} Hz, Note: ${this.currentNote ? this.currentNote.name : 'N/A'}, Clarity: ${(clarity * 100).toFixed(1)}%`);
            } else {
                this.currentFrequency = null;
                this.currentNote = null;
            }
        } catch (error) {
            console.error('Error getting pitch:', error);
            // Don't set to null immediately to avoid flickering, but log the error
            // this.currentFrequency = null;
            // this.currentNote = null;
        }
    }

    // Start tuning process
    startTuning() {
        this.updateUI();
        
        // Start pitch detection and UI update interval (every 100ms)
        this.updateIntervalId = setInterval(() => {
            // Get pitch from Pitchy
            this.getPitch();
            
            // Update UI with current frequency
            if (this.currentFrequency !== null) {
                this.updateTuning(this.currentFrequency);
            } else {
                this.updateTuning(null);
            }
        }, this.UPDATE_INTERVAL);
    }

    // Update tuning based on detected frequency
    updateTuning(frequency) {
        if (!frequency || frequency <= 0) {
            // No frequency detected
            this.smoothedOffset = this.smoothedOffset + (0 - this.smoothedOffset) * this.smoothingFactor;
            this.elements.orangeCircle.style.transition = 'none';
            this.elements.orangeCircle.style.transform = `translate(calc(-50% + ${this.smoothedOffset}px), -50%)`;
            this.updateNoteText(null);
            
            if (this.tuningTimeout) {
                clearTimeout(this.tuningTimeout);
                this.tuningTimeout = null;
            }
            this.isTuned = false;
            return;
        }

        const currentString = this.STRING_FREQUENCIES[this.currentStringIndex];
        const cents = this.frequencyToCents(frequency, currentString.frequency);
        
        // Update circle position
        this.updateCirclePosition(cents);
        
        // Update note text
        this.updateNoteText(frequency);
        
        // Check if tuned
        if (!this.isTuned && this.checkIfTuned(cents)) {
            this.isTuned = true;
            if (this.tuningTimeout) {
                clearTimeout(this.tuningTimeout);
            }
            this.tuningTimeout = setTimeout(() => {
                if (this.isTuned && !this.allStringsTuned) {
                    this.moveToNextString();
                }
                this.tuningTimeout = null;
            }, this.TUNED_CONFIRMATION_TIME);
        } else if (!this.checkIfTuned(cents)) {
            if (this.tuningTimeout) {
                clearTimeout(this.tuningTimeout);
                this.tuningTimeout = null;
            }
            this.isTuned = false;
        }
    }

    // Update UI for current string
    updateUI() {
        const currentString = this.STRING_FREQUENCIES[this.currentStringIndex];
        
        if (this.allStringsTuned) {
            this.elements.instructionText.classList.add('hidden');
            this.elements.tunedMessage.classList.remove('hidden');
            this.elements.tunedSubmessage.classList.remove('hidden');
            if (this.elements.noteText) {
                this.elements.noteText.textContent = '';
                this.elements.noteText.style.opacity = '0';
            }
            return;
        }

        this.elements.instructionText.textContent = `Pull ${currentString.label} string`;
        this.elements.instructionText.classList.remove('hidden');
        this.elements.tunedMessage.classList.add('hidden');
        this.elements.tunedSubmessage.classList.add('hidden');

        // Reset smoothed offset and hide note text when switching strings
        this.smoothedOffset = 0;
        if (this.elements.noteText) {
            this.elements.noteText.textContent = '';
            this.elements.noteText.style.opacity = '0';
        }

        // Update string indicators
        this.STRING_FREQUENCIES.forEach((str, index) => {
            const element = document.querySelector(`[data-string="${index}"]`);
            if (index < this.currentStringIndex) {
                // Already tuned strings - orange
                element.classList.remove('active');
                element.classList.add('highlighted');
            } else if (index === this.currentStringIndex) {
                // Current string being tuned - black
                element.classList.remove('highlighted');
                element.classList.add('active');
            } else {
                // Future strings - gray (default)
                element.classList.remove('highlighted', 'active');
            }
        });

        this.isTuned = false;
    }

    // Convert frequency to cents deviation from target
    frequencyToCents(detectedFreq, targetFreq) {
        if (!detectedFreq || detectedFreq <= 0) return 0;
        return 1200 * Math.log2(detectedFreq / targetFreq);
    }

    // Convert frequency to musical note
    frequencyToNote(frequency) {
        if (!frequency || frequency <= 0) return null;
        
        // Calculate semitones from A4 (440 Hz)
        const semitonesFromA4 = 12 * Math.log2(frequency / this.A4_FREQUENCY);
        
        // Round to nearest semitone
        const roundedSemitones = Math.round(semitonesFromA4);
        
        // Calculate which note this corresponds to
        const semitonesFromC0 = roundedSemitones + 57; // 57 = A4's position (9 + 4*12)
        
        // Calculate octave and note index
        const octave = Math.floor(semitonesFromC0 / 12);
        let noteIndex = semitonesFromC0 % 12;
        
        // Handle negative modulo
        if (noteIndex < 0) {
            noteIndex += 12;
        }
        
        return {
            name: this.NOTE_NAMES[noteIndex],
            octave: octave,
            frequency: frequency
        };
    }

    // Update note text in circle
    updateNoteText(frequency) {
        if (!this.elements.noteText) return;
        
        if (!frequency || frequency <= 0) {
            // Hide text when no frequency detected
            this.elements.noteText.textContent = '';
            this.elements.noteText.style.opacity = '0';
            return;
        }
        
        const note = this.frequencyToNote(frequency);
        if (note) {
            // Show note name without octave for cleaner display
            this.elements.noteText.textContent = note.name;
            this.elements.noteText.style.opacity = '1';
        } else {
            this.elements.noteText.textContent = '';
            this.elements.noteText.style.opacity = '0';
        }
    }

    // Update orange circle position based on tuning accuracy with smoothing
    updateCirclePosition(cents) {
        const maxOffset = 40; // Maximum pixel offset for visual feedback
        
        // Clamp cents to maximum offset for display
        const clampedCents = Math.max(-this.MAX_OFFSET, Math.min(this.MAX_OFFSET, cents));
        
        // Calculate target position: 
        // Positive cents (sharp/over-tuned) -> right (+)
        // Negative cents (flat/under-tuned) -> left (-)
        const targetOffset = (clampedCents / this.MAX_OFFSET) * maxOffset;
        
        // Apply exponential smoothing for smooth movement
        this.smoothedOffset = this.smoothedOffset + (targetOffset - this.smoothedOffset) * this.smoothingFactor;
        
        // Apply transform (no CSS transition, smoothing is handled by the smoothing algorithm)
        this.elements.orangeCircle.style.transition = 'none';
        this.elements.orangeCircle.style.transform = `translate(calc(-50% + ${this.smoothedOffset}px), -50%)`;
    }

    // Check if string is tuned
    checkIfTuned(cents) {
        return Math.abs(cents) <= this.TUNING_TOLERANCE;
    }

    // Move to next string
    moveToNextString() {
        // Clear any pending tuning timeout
        if (this.tuningTimeout) {
            clearTimeout(this.tuningTimeout);
            this.tuningTimeout = null;
        }
        
        if (this.currentStringIndex < this.STRING_FREQUENCIES.length - 1) {
            this.currentStringIndex++;
            this.updateUI();
            // Reset smoothed offset to center smoothly
            this.smoothedOffset = 0;
            this.elements.orangeCircle.style.transform = 'translate(-50%, -50%)';
            this.isTuned = false;
        } else {
            // All strings tuned
            this.allStringsTuned = true;
            this.updateUI();
            this.smoothedOffset = 0;
            this.elements.orangeCircle.style.transform = 'translate(-50%, -50%)';
            this.isTuned = false;
        }
    }

    // Cleanup resources
    cleanup() {
        if (this.tuningTimeout) {
            clearTimeout(this.tuningTimeout);
        }
        if (this.updateIntervalId) {
            clearInterval(this.updateIntervalId);
        }
        if (this.analyser) {
            this.analyser.disconnect();
        }
        if (this.microphone && this.microphone.mediaStream) {
            this.microphone.mediaStream.getTracks().forEach(track => track.stop());
        }
        if (this.audioContext) {
            this.audioContext.close();
        }
    }
}

// Initialize app when DOM is ready
let tuner;

window.addEventListener('load', () => {
    tuner = new GuitarTuner();
    tuner.init();

    // Make requestMicrophoneAccess available globally for button onclick
    window.requestMicrophoneAccess = tuner.requestMicrophoneAccess.bind(tuner);
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (tuner) {
        tuner.cleanup();
    }
});
