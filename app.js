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

        // State variables
        this.currentStringIndex = 0;
        this.audioContext = null;
        this.analyser = null;
        this.microphone = null;
        this.dataArray = null;
        this.frequencyData = null;
        this.animationFrameId = null;
        this.isTuned = false;
        this.allStringsTuned = false;
        this.tuningTimeout = null;

        // DOM elements
        this.elements = {
            permissionOverlay: document.getElementById('permissionOverlay'),
            instructionText: document.getElementById('instructionText'),
            tunedMessage: document.getElementById('tunedMessage'),
            tunedSubmessage: document.getElementById('tunedSubmessage'),
            orangeCircle: document.getElementById('orangeCircle')
        };

        // Bind methods
        this.requestMicrophoneAccess = this.requestMicrophoneAccess.bind(this);
        this.init = this.init.bind(this);
        this.cleanup = this.cleanup.bind(this);
    }

    // Initialize app
    init() {
        // Check if microphone access is already granted
        navigator.mediaDevices.getUserMedia({ audio: true })
            .then(stream => {
                this.setupAudio(stream);
                this.elements.permissionOverlay.classList.add('hidden');
            })
            .catch(err => {
                console.log('Microphone access not granted:', err);
                // Show permission overlay
            });
    }

    // Request microphone access
    async requestMicrophoneAccess() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.setupAudio(stream);
            this.elements.permissionOverlay.classList.add('hidden');
        } catch (err) {
            console.error('Error accessing microphone:', err);
            alert('Не удалось получить доступ к микрофону. Пожалуйста, разрешите доступ в настройках браузера.');
        }
    }

    // Setup audio processing
    setupAudio(stream) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        this.analyser = this.audioContext.createAnalyser();
        this.microphone = this.audioContext.createMediaStreamSource(stream);
        this.microphone.connect(this.analyser);

        this.analyser.fftSize = 16384; // Higher FFT size for better frequency resolution
        this.analyser.smoothingTimeConstant = 0.3; // Lower smoothing for more responsive detection
        const bufferLength = this.analyser.frequencyBinCount;
        this.dataArray = new Float32Array(bufferLength);
        this.frequencyData = new Float32Array(bufferLength);

        this.startTuning();
    }

    // Start tuning process
    startTuning() {
        this.updateUI();
        this.animate();
    }

    // Update UI for current string
    updateUI() {
        const currentString = this.STRING_FREQUENCIES[this.currentStringIndex];
        
        if (this.allStringsTuned) {
            this.elements.instructionText.classList.add('hidden');
            this.elements.tunedMessage.classList.remove('hidden');
            this.elements.tunedSubmessage.classList.remove('hidden');
            return;
        }

        this.elements.instructionText.textContent = `Pull ${currentString.label} string`;
        this.elements.instructionText.classList.remove('hidden');
        this.elements.tunedMessage.classList.add('hidden');
        this.elements.tunedSubmessage.classList.add('hidden');

        // Update string indicators
        this.STRING_FREQUENCIES.forEach((str, index) => {
            const element = document.querySelector(`[data-string="${index}"]`);
            if (index < this.currentStringIndex) {
                // Already tuned strings
                element.classList.remove('highlighted', 'active');
                element.classList.add('active');
            } else if (index === this.currentStringIndex) {
                // Current string
                element.classList.remove('active');
                element.classList.add('highlighted');
            } else {
                // Future strings
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

    // Detect pitch using autocorrelation with improved algorithm
    detectPitch() {
        if (!this.analyser || !this.dataArray) return null;

        this.analyser.getFloatTimeDomainData(this.dataArray);
        
        const sampleRate = this.audioContext.sampleRate;
        const buffer = this.dataArray;
        const bufferLength = buffer.length;
        
        // Check signal strength
        let signalStrength = 0;
        for (let i = 0; i < bufferLength; i++) {
            signalStrength += Math.abs(buffer[i]);
        }
        signalStrength /= bufferLength;
        
        // Ignore very weak signals
        if (signalStrength < 0.01) {
            return null;
        }
        
        // Apply Hanning window
        const windowed = new Float32Array(bufferLength);
        for (let i = 0; i < bufferLength; i++) {
            windowed[i] = buffer[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (bufferLength - 1)));
        }
        
        // Autocorrelation
        let bestOffset = -1;
        let bestCorrelation = -1;
        const correlationThreshold = 0.3;
        
        // Search in frequency range 50-400 Hz for guitar
        const minPeriod = Math.floor(sampleRate / 400);
        const maxPeriod = Math.floor(sampleRate / 50);
        
        // Autocorrelation function
        for (let offset = minPeriod; offset < maxPeriod && offset < bufferLength / 2; offset++) {
            let correlation = 0;
            let normalization = 0;
            
            for (let i = 0; i < bufferLength - offset; i++) {
                correlation += windowed[i] * windowed[i + offset];
                normalization += windowed[i] * windowed[i];
            }
            
            if (normalization > 0) {
                correlation = correlation / Math.sqrt(normalization);
                
                // Prefer correlations that are local maxima
                if (correlation > bestCorrelation) {
                    bestCorrelation = correlation;
                    bestOffset = offset;
                }
            }
        }
        
        // Check if we found a valid pitch
        if (bestCorrelation > correlationThreshold && bestOffset > 0) {
            const frequency = sampleRate / bestOffset;
            // Validate frequency is in reasonable range
            if (frequency >= 50 && frequency <= 400) {
                return frequency;
            }
        }
        
        return null;
    }

    // Update orange circle position based on tuning accuracy
    updateCirclePosition(cents) {
        const maxOffset = 40; // Maximum pixel offset for visual feedback
        
        // Clamp cents to maximum offset for display
        const clampedCents = Math.max(-this.MAX_OFFSET, Math.min(this.MAX_OFFSET, cents));
        
        // Calculate position: -maxOffset (left/flat) to +maxOffset (right/sharp)
        const offset = (clampedCents / this.MAX_OFFSET) * maxOffset;
        
        // Apply transform with smooth transition
        this.elements.orangeCircle.style.transition = 'transform 0.05s ease-out';
        this.elements.orangeCircle.style.transform = `translate(calc(-50% + ${offset}px), -50%)`;
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
            // Reset circle to center
            this.elements.orangeCircle.style.transform = 'translate(-50%, -50%)';
            this.isTuned = false;
        } else {
            // All strings tuned
            this.allStringsTuned = true;
            this.updateUI();
            this.elements.orangeCircle.style.transform = 'translate(-50%, -50%)';
            this.isTuned = false;
        }
    }

    // Animation loop
    animate() {
        if (!this.analyser || !this.dataArray || this.allStringsTuned) {
            this.animationFrameId = requestAnimationFrame(() => this.animate());
            return;
        }

        const detectedFrequency = this.detectPitch();
        const currentString = this.STRING_FREQUENCIES[this.currentStringIndex];
        
        if (detectedFrequency && detectedFrequency > 0) {
            const cents = this.frequencyToCents(detectedFrequency, currentString.frequency);
            this.updateCirclePosition(cents);
            
            // Check if tuned
            if (!this.isTuned && this.checkIfTuned(cents)) {
                this.isTuned = true;
                // Clear any existing timeout
                if (this.tuningTimeout) {
                    clearTimeout(this.tuningTimeout);
                }
                // Wait to confirm tuning is stable before moving to next string
                this.tuningTimeout = setTimeout(() => {
                    if (this.isTuned && !this.allStringsTuned) {
                        this.moveToNextString();
                    }
                    this.tuningTimeout = null;
                }, this.TUNED_CONFIRMATION_TIME);
            } else if (!this.checkIfTuned(cents)) {
                // String is out of tune, cancel timeout and reset flag
                if (this.tuningTimeout) {
                    clearTimeout(this.tuningTimeout);
                    this.tuningTimeout = null;
                }
                this.isTuned = false;
            }
        } else {
            // No frequency detected, smoothly return circle to center
            const currentTransform = this.elements.orangeCircle.style.transform;
            if (currentTransform && currentTransform !== 'translate(-50%, -50%)') {
                // Gradually return to center
                this.elements.orangeCircle.style.transition = 'transform 0.3s ease-out';
                this.elements.orangeCircle.style.transform = 'translate(-50%, -50%)';
            }
            // Cancel tuning timeout if no sound
            if (this.tuningTimeout) {
                clearTimeout(this.tuningTimeout);
                this.tuningTimeout = null;
            }
            this.isTuned = false;
        }

        this.animationFrameId = requestAnimationFrame(() => this.animate());
    }

    // Cleanup resources
    cleanup() {
        if (this.tuningTimeout) {
            clearTimeout(this.tuningTimeout);
        }
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
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

