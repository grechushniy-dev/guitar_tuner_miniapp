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

        // State variables
        this.currentStringIndex = 0;
        this.audioContext = null;
        this.microphone = null;
        this.crepeModel = null;
        this.audioProcessor = null;
        this.updateIntervalId = null;
        this.isTuned = false;
        this.allStringsTuned = false;
        this.tuningTimeout = null;
        this.smoothedOffset = 0; // For smooth circle movement
        this.smoothingFactor = 0.15; // Smoothing factor (0-1), lower = smoother
        this.currentFrequency = null;
        this.currentNote = null;
        this.audioBuffer = [];
        this.bufferSize = 1024; // CREPE requires 1024 samples
        this.sampleRate = 16000; // CREPE uses 16kHz sample rate

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
        // Check if TensorFlow.js and Crepe are available
        if (typeof tf === 'undefined') {
            console.error('TensorFlow.js is not loaded. Please check CDN connection.');
            alert('Ошибка загрузки TensorFlow.js. Пожалуйста, обновите страницу.');
            return;
        }

        if (typeof Crepe === 'undefined') {
            console.error('Crepe.js is not loaded. Please check CDN connection.');
            alert('Ошибка загрузки Crepe.js. Пожалуйста, обновите страницу.');
            return;
        }

        // Check if microphone access is already granted
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            await this.setupAudio(stream);
            this.elements.permissionOverlay.classList.add('hidden');
        } catch (err) {
            console.log('Microphone access not granted:', err);
            // Show permission overlay
        }
    }

    // Request microphone access
    async requestMicrophoneAccess() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            await this.setupAudio(stream);
            this.elements.permissionOverlay.classList.add('hidden');
        } catch (err) {
            console.error('Error accessing microphone:', err);
            alert('Не удалось получить доступ к микрофону. Пожалуйста, разрешите доступ в настройках браузера.');
        }
    }

    // Setup audio processing with crepe.js
    async setupAudio(stream) {
        try {
            // Initialize audio context (sample rate will be handled by resampling)
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const actualSampleRate = this.audioContext.sampleRate;
            console.log(`AudioContext sample rate: ${actualSampleRate} Hz`);

            // Create microphone source
            this.microphone = this.audioContext.createMediaStreamSource(stream);

            // Initialize CREPE model
            console.log('Initializing CREPE model...');
            try {
                // Try to initialize CREPE model
                // The model URL might need to be adjusted based on actual crepe.js implementation
                this.crepeModel = new Crepe();
                await this.crepeModel.init();
                console.log('CREPE model initialized successfully');
            } catch (crepeError) {
                console.error('CREPE initialization error:', crepeError);
                // Try alternative initialization
                this.crepeModel = new Crepe('model/');
                await this.crepeModel.init();
                console.log('CREPE model initialized successfully (alternative path)');
            }

            // Store actual sample rate for resampling
            this.actualSampleRate = actualSampleRate;

            // Setup audio processing
            this.setupAudioProcessor();

            // Start tuning process
            this.startTuning();
        } catch (error) {
            console.error('Error setting up audio:', error);
            alert('Ошибка инициализации анализа звука: ' + error.message);
        }
    }

    // Setup audio processor for CREPE
    setupAudioProcessor() {
        // Create script processor to get audio samples
        // Using 4096 buffer size for better performance
        const processor = this.audioContext.createScriptProcessor(4096, 1, 1);
        
        // Buffer to accumulate samples for CREPE (needs 1024 samples at 16kHz)
        let sampleBuffer = [];
        const crepeSampleRate = 16000;
        const crepeBufferSize = 1024;
        
        processor.onaudioprocess = (event) => {
            const inputData = event.inputBuffer.getChannelData(0);
            const inputSampleRate = this.actualSampleRate;
            
            // Resample to 16kHz if needed
            const resampled = this.resampleAudio(inputData, inputSampleRate, crepeSampleRate);
            
            // Add to buffer
            for (let i = 0; i < resampled.length; i++) {
                sampleBuffer.push(resampled[i]);
            }
            
            // Process when we have enough samples (1024 at 16kHz)
            while (sampleBuffer.length >= crepeBufferSize) {
                const samples = sampleBuffer.slice(0, crepeBufferSize);
                sampleBuffer = sampleBuffer.slice(crepeBufferSize);
                
                // Process with CREPE (async, but we don't wait)
                this.processAudioWithCrepe(new Float32Array(samples));
            }
        };

        this.microphone.connect(processor);
        processor.connect(this.audioContext.destination);
        this.audioProcessor = processor;
    }

    // Resample audio to target sample rate
    resampleAudio(audioData, fromRate, toRate) {
        if (fromRate === toRate) {
            return audioData;
        }
        
        const ratio = toRate / fromRate;
        const outputLength = Math.round(audioData.length * ratio);
        const output = new Float32Array(outputLength);
        
        for (let i = 0; i < outputLength; i++) {
            const index = i / ratio;
            const indexFloor = Math.floor(index);
            const indexCeil = Math.min(indexFloor + 1, audioData.length - 1);
            const fraction = index - indexFloor;
            
            // Linear interpolation
            output[i] = audioData[indexFloor] * (1 - fraction) + audioData[indexCeil] * fraction;
        }
        
        return output;
    }

    // Process audio with crepe.js
    async processAudioWithCrepe(audioSamples) {
        try {
            if (!this.crepeModel || audioSamples.length !== 1024) return;

            // Get pitch prediction from CREPE
            // CREPE model.predict() returns frequency in Hz
            const frequency = await this.crepeModel.predict(audioSamples);
            
            // Handle different return formats (number or object with freq property)
            const freq = typeof frequency === 'object' && frequency.freq ? frequency.freq : frequency;
            
            if (freq && freq > 0 && freq >= 50 && freq <= 400) {
                this.currentFrequency = freq;
                this.currentNote = this.frequencyToNote(freq);
                
                // Log to console as requested
                console.log(`Frequency: ${freq.toFixed(2)} Hz, Note: ${this.currentNote ? this.currentNote.name : 'N/A'}`);
            } else if (freq === 0 || !freq) {
                // No pitch detected
                this.currentFrequency = null;
                this.currentNote = null;
            }
        } catch (error) {
            console.error('Error processing audio with crepe:', error);
            // Don't set to null on error to avoid flickering
        }
    }

    // Start tuning process
    startTuning() {
        this.updateUI();
        
        // Start update interval (every 100ms) to update UI with latest frequency
        this.updateIntervalId = setInterval(() => {
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
        if (this.audioProcessor) {
            this.audioProcessor.disconnect();
        }
        if (this.crepeModel) {
            // Cleanup CREPE model if needed
            this.crepeModel = null;
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
