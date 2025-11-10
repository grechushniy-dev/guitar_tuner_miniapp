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

        // Use larger FFT size for better frequency resolution (16384 is well supported)
        this.analyser.fftSize = 16384;
        this.analyser.smoothingTimeConstant = 0.1; // Very low smoothing for responsive detection
        this.analyser.minDecibels = -90;
        this.analyser.maxDecibels = -10;
        
        const bufferLength = this.analyser.frequencyBinCount;
        this.dataArray = new Float32Array(this.analyser.fftSize); // Time domain data (fftSize samples)
        this.frequencyData = new Uint8Array(bufferLength); // Frequency domain data (frequencyBinCount bins)

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
        // Tuned strings = orange (highlighted), current string = black (active), future strings = gray (default)
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

    // Detect pitch using hybrid approach: FFT for initial detection + autocorrelation for accuracy
    detectPitch() {
        if (!this.analyser || !this.frequencyData || !this.dataArray) return null;

        const sampleRate = this.audioContext.sampleRate;
        const fftSize = this.analyser.fftSize;
        
        // Method 1: Use FFT for quick frequency estimation
        this.analyser.getByteFrequencyData(this.frequencyData);
        
        const bufferLength = this.frequencyData.length;
        const freqResolution = sampleRate / fftSize;
        
        // Check signal strength in frequency domain
        let totalEnergy = 0;
        for (let i = 0; i < bufferLength; i++) {
            totalEnergy += this.frequencyData[i];
        }
        const averageEnergy = totalEnergy / bufferLength;
        
        // Ignore very weak signals
        if (averageEnergy < 3) {
            return null;
        }
        
        // Focus on guitar frequency range: 50-400 Hz
        const minBin = Math.max(1, Math.floor(50 / freqResolution));
        const maxBin = Math.min(Math.floor(400 / freqResolution), bufferLength - 2);
        
        // Find peaks in the frequency spectrum
        let peaks = [];
        for (let i = minBin; i <= maxBin; i++) {
            const magnitude = this.frequencyData[i];
            // Check if this is a local maximum
            if (magnitude > this.frequencyData[i - 1] && 
                magnitude > this.frequencyData[i + 1] && 
                magnitude > 15) { // Minimum magnitude threshold
                peaks.push({ bin: i, magnitude: magnitude });
            }
        }
        
        // Sort peaks by magnitude
        peaks.sort((a, b) => b.magnitude - a.magnitude);
        
        if (peaks.length === 0) {
            return null;
        }
        
        // Use the strongest peak as candidate
        const candidatePeak = peaks[0];
        
        // Parabolic interpolation for sub-bin accuracy
        const bin = candidatePeak.bin;
        const y1 = this.frequencyData[bin - 1];
        const y2 = this.frequencyData[bin];
        const y3 = this.frequencyData[bin + 1];
        
        let frequency = bin * freqResolution;
        const denom = y1 - 2 * y2 + y3;
        if (Math.abs(denom) > 0.001) {
            const offset = (y1 - y3) / (2 * denom);
            frequency = (bin + offset) * freqResolution;
        }
        
        // Method 2: Use autocorrelation on time domain data for verification
        // This helps filter out harmonics and gives more accurate fundamental frequency
        this.analyser.getFloatTimeDomainData(this.dataArray);
        const timeDataLength = this.dataArray.length;
        
        // Check signal strength in time domain
        let signalStrength = 0;
        for (let i = 0; i < timeDataLength; i++) {
            signalStrength += Math.abs(this.dataArray[i]);
        }
        signalStrength /= timeDataLength;
        
        if (signalStrength < 0.005) {
            return null;
        }
        
        // Apply Hanning window
        const windowed = new Float32Array(timeDataLength);
        for (let i = 0; i < timeDataLength; i++) {
            windowed[i] = this.dataArray[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (timeDataLength - 1)));
        }
        
        // Autocorrelation around the FFT-detected frequency
        const expectedPeriod = sampleRate / frequency;
        const searchRange = Math.floor(expectedPeriod * 0.3); // Search ±30% around expected period
        const minPeriod = Math.max(1, Math.floor(expectedPeriod - searchRange));
        const maxPeriod = Math.min(Math.floor(expectedPeriod + searchRange), Math.floor(timeDataLength / 2));
        
        let bestOffset = -1;
        let bestCorrelation = -1;
        
        for (let offset = minPeriod; offset <= maxPeriod; offset++) {
            let correlation = 0;
            let normalization = 0;
            
            for (let i = 0; i < timeDataLength - offset; i++) {
                correlation += windowed[i] * windowed[i + offset];
                normalization += windowed[i] * windowed[i];
            }
            
            if (normalization > 0) {
                correlation = correlation / Math.sqrt(normalization);
                if (correlation > bestCorrelation) {
                    bestCorrelation = correlation;
                    bestOffset = offset;
                }
            }
        }
        
        // Use autocorrelation result if it's reliable
        if (bestCorrelation > 0.2 && bestOffset > 0) {
            const autocorrFreq = sampleRate / bestOffset;
            // Validate and use autocorrelation frequency if it's close to FFT estimate
            if (autocorrFreq >= 50 && autocorrFreq <= 400) {
                // Weighted average: favor autocorrelation but consider FFT
                const weight = bestCorrelation;
                frequency = weight * autocorrFreq + (1 - weight) * frequency;
            }
        }
        
        // Final validation
        if (frequency >= 50 && frequency <= 400) {
            return frequency;
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
        if (!this.analyser || !this.frequencyData || this.allStringsTuned) {
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

