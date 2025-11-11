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
        this.TUNING_TOLERANCE = 20; // ±20 cents tolerance (more lenient for real-world tuning)
        this.MAX_OFFSET = 50; // Maximum offset in cents for visual display
        this.TUNED_CONFIRMATION_TIME = 1500; // Time in ms to confirm tuning is stable (increased for reliability)
        this.UPDATE_INTERVAL = 100; // Update every 100ms
        
        // Frequency smoothing for stable detection
        this.smoothedFrequency = null;
        this.frequencySmoothingFactor = 0.3; // How much to trust new frequency readings
        
        // Tuning state tracking
        this.tuningStableCount = 0; // Count consecutive tuned readings
        this.tuningStableThreshold = 8; // Need 8 consecutive tuned readings (0.8 seconds at 100ms interval)

        // State variables
        this.currentStringIndex = 0;
        this.audioContext = null;
        this.microphone = null;
        this.analyser = null;
        this.updateIntervalId = null;
        this.isTuned = false;
        this.allStringsTuned = false;
        this.tuningTimeout = null;
        this.smoothedOffset = 0; // For smooth circle movement
        this.smoothingFactor = 0.2; // Smoothing factor (0-1), lower = smoother
        this.currentFrequency = null;
        this.currentNote = null;

        // Audio processing buffers
        this.timeData = null;
        this.frequencyData = null;

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
        try {
            // Resume audio context if it exists and is suspended
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
                ? 'Доступ к микрофону запрещен. Пожалуйста, разрешите доступ в настройках браузера.'
                : err.name === 'NotFoundError'
                ? 'Микрофон не найден. Убедитесь, что микрофон подключен.'
                : 'Не удалось получить доступ к микрофону: ' + (err.message || err.name);
            alert(errorMessage);
        }
    }

    // Setup audio processing
    async setupAudio(stream) {
        try {
            // Initialize audio context
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            
            // Resume audio context if suspended (required in some browsers)
            if (this.audioContext.state === 'suspended') {
                console.log('AudioContext is suspended, attempting to resume...');
                await this.audioContext.resume();
            }
            
            const sampleRate = this.audioContext.sampleRate;
            
            if (!sampleRate || isNaN(sampleRate)) {
                throw new Error('Не удалось получить sample rate из AudioContext');
            }
            
            console.log(`AudioContext initialized. State: ${this.audioContext.state}, Sample rate: ${sampleRate} Hz`);

            // Check stream is active
            const audioTracks = stream.getAudioTracks();
            console.log('Audio tracks:', audioTracks.length);
            if (audioTracks.length > 0) {
                console.log('Audio track settings:', audioTracks[0].getSettings());
                console.log('Audio track enabled:', audioTracks[0].enabled);
                console.log('Audio track readyState:', audioTracks[0].readyState);
            }

            // Create microphone source
            this.microphone = this.audioContext.createMediaStreamSource(stream);

            // Create analyser node with optimal settings
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 8192; // Good balance between resolution and performance
            this.analyser.smoothingTimeConstant = 0.05; // Very low smoothing for maximum responsiveness
            this.analyser.minDecibels = -100; // Lower for better sensitivity
            this.analyser.maxDecibels = 0; // Higher for better sensitivity
            
            this.microphone.connect(this.analyser);

            // Initialize buffers
            const bufferLength = this.analyser.frequencyBinCount;
            this.timeData = new Float32Array(this.analyser.fftSize);
            this.frequencyData = new Uint8Array(bufferLength);

            console.log(`Analyser initialized. FFT size: ${this.analyser.fftSize}, Buffer length: ${bufferLength}, Sample rate: ${sampleRate} Hz`);
            
            // Handle audio context state changes
            this.audioContext.addEventListener('statechange', () => {
                console.log('AudioContext state changed to:', this.audioContext.state);
                if (this.audioContext.state === 'suspended') {
                    console.warn('AudioContext was suspended - user interaction may be required');
                    // Try to resume automatically
                    this.audioContext.resume().then(() => {
                        console.log('AudioContext resumed successfully');
                    }).catch(err => {
                        console.error('Failed to resume AudioContext:', err);
                    });
                }
            });

            // Test audio input multiple times to verify it's working
            setTimeout(() => {
                this.testAudioInput();
            }, 300);
            
            setTimeout(() => {
                this.testAudioInput();
            }, 1000);
            
            setTimeout(() => {
                this.testAudioInput();
            }, 2000);

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

    // Test audio input to verify microphone is working
    testAudioInput() {
        if (!this.analyser || !this.timeData) {
            console.warn('Cannot test audio input - analyser not ready');
            return;
        }

        this.analyser.getFloatTimeDomainData(this.timeData);
        
        let signalStrength = 0;
        let maxAmplitude = 0;
        let minAmplitude = Infinity;
        for (let i = 0; i < this.timeData.length; i++) {
            const abs = Math.abs(this.timeData[i]);
            signalStrength += abs;
            if (abs > maxAmplitude) {
                maxAmplitude = abs;
            }
            if (abs < minAmplitude) {
                minAmplitude = abs;
            }
        }
        signalStrength /= this.timeData.length;
        
        // Also check frequency data
        if (this.frequencyData) {
            this.analyser.getByteFrequencyData(this.frequencyData);
            let freqEnergy = 0;
            for (let i = 0; i < this.frequencyData.length; i++) {
                freqEnergy += this.frequencyData[i];
            }
            freqEnergy /= this.frequencyData.length;
            console.log(`Audio test - Time domain: strength=${signalStrength.toFixed(6)}, max=${maxAmplitude.toFixed(6)}, min=${minAmplitude.toFixed(6)} | Frequency domain: avg energy=${freqEnergy.toFixed(2)}`);
        } else {
            console.log(`Audio test - Signal strength: ${signalStrength.toFixed(6)}, Max amplitude: ${maxAmplitude.toFixed(6)}, Min amplitude: ${minAmplitude.toFixed(6)}`);
        }
        
        if (signalStrength < 0.00001 && maxAmplitude < 0.001) {
            console.warn('⚠️ WARNING: Very weak or no audio signal detected. Microphone may not be receiving sound.');
        } else if (signalStrength > 0.0001 || maxAmplitude > 0.01) {
            console.log('✅ Audio input is working - signal detected');
        } else {
            console.log('ℹ️ Audio input detected but signal is weak');
        }
    }

    // Detect pitch using FFT-based peak detection (fast and reliable for musical tones)
    detectPitch() {
        if (!this.analyser || !this.frequencyData) {
            return null;
        }

        try {
            const sampleRate = this.audioContext.sampleRate;
            const fftSize = this.analyser.fftSize;
            const bufferLength = this.frequencyData.length;
            const freqResolution = sampleRate / fftSize;

            // Get frequency domain data
            this.analyser.getByteFrequencyData(this.frequencyData);

            // Check overall signal energy
            let totalEnergy = 0;
            for (let i = 0; i < bufferLength; i++) {
                totalEnergy += this.frequencyData[i];
            }
            const averageEnergy = totalEnergy / bufferLength;

            // Very low threshold for maximum sensitivity
            if (averageEnergy < 0.5) {
                return null;
            }

            // Focus on guitar frequency range: 50-400 Hz
            const minBin = Math.max(1, Math.floor(50 / freqResolution));
            const maxBin = Math.min(Math.floor(400 / freqResolution), bufferLength - 2);

            // Find all local maxima (peaks) in the frequency spectrum
            const peaks = [];
            for (let i = minBin; i <= maxBin; i++) {
                const magnitude = this.frequencyData[i];
                // Check if this is a local maximum
                if (magnitude > this.frequencyData[i - 1] && 
                    magnitude > this.frequencyData[i + 1] && 
                    magnitude > 3) { // Very low threshold
                    peaks.push({
                        bin: i,
                        magnitude: magnitude,
                        frequency: i * freqResolution
                    });
                }
            }

            if (peaks.length === 0) {
                return null;
            }

            // Sort peaks by magnitude
            peaks.sort((a, b) => b.magnitude - a.magnitude);

            // Use the strongest peak
            const strongestPeak = peaks[0];

            // Parabolic interpolation for sub-bin accuracy
            const bin = strongestPeak.bin;
            const y1 = this.frequencyData[bin - 1];
            const y2 = this.frequencyData[bin];
            const y3 = this.frequencyData[bin + 1];

            let frequency = strongestPeak.frequency;

            // Parabolic interpolation
            const denom = y1 - 2 * y2 + y3;
            if (Math.abs(denom) > 0.001) {
                const offset = (y1 - y3) / (2 * denom);
                frequency = (bin + offset) * freqResolution;
            }

            // Validate frequency
            if (frequency >= 50 && frequency <= 400) {
                // Additional validation: check if this peak is significantly stronger than noise
                // Compare with average energy in the range
                let rangeEnergy = 0;
                for (let i = minBin; i <= maxBin; i++) {
                    rangeEnergy += this.frequencyData[i];
                }
                rangeEnergy /= (maxBin - minBin + 1);

                // Peak should be at least 2x stronger than average
                if (strongestPeak.magnitude > rangeEnergy * 1.5) {
                    return frequency;
                }
            }

            return null;
        } catch (error) {
            console.error('Error detecting pitch:', error);
            return null;
        }
    }

    // Start tuning process
    startTuning() {
        this.updateUI();
        
        let detectionCount = 0;
        let lastLogTime = Date.now();
        
        // Start pitch detection and UI update interval (every 100ms)
        this.updateIntervalId = setInterval(() => {
            const frequency = this.detectPitch();
            detectionCount++;
            
            // Log detection status every 2 seconds for debugging
            if (Date.now() - lastLogTime > 2000) {
                console.log(`Pitch detection attempts: ${detectionCount}, Last frequency: ${frequency ? frequency.toFixed(2) + ' Hz' : 'none detected'}`);
                lastLogTime = Date.now();
                detectionCount = 0;
            }
            
            if (frequency && frequency > 0) {
                // Smooth frequency readings for more stable tuning
                if (this.smoothedFrequency === null) {
                    this.smoothedFrequency = frequency;
                } else {
                    // Only smooth if new frequency is reasonably close to smoothed value
                    // This prevents sudden jumps from affecting the smoothed value too much
                    const frequencyDiff = Math.abs(frequency - this.smoothedFrequency);
                    const maxDiff = this.smoothedFrequency * 0.1; // 10% tolerance
                    
                    if (frequencyDiff < maxDiff) {
                        // Smooth the frequency
                        this.smoothedFrequency = this.smoothedFrequency + (frequency - this.smoothedFrequency) * this.frequencySmoothingFactor;
                    } else {
                        // Large jump - likely a new note, update immediately but with some smoothing
                        this.smoothedFrequency = this.smoothedFrequency + (frequency - this.smoothedFrequency) * 0.5;
                    }
                }
                
                this.currentFrequency = this.smoothedFrequency;
                this.currentNote = this.frequencyToNote(this.smoothedFrequency);
                
                // Log to console as requested (show both raw and smoothed)
                console.log(`Frequency: ${frequency.toFixed(2)} Hz (smoothed: ${this.smoothedFrequency.toFixed(2)} Hz), Note: ${this.currentNote ? this.currentNote.name : 'N/A'}`);
                
                // Update UI with smoothed frequency
                this.updateTuning(this.smoothedFrequency);
            } else {
                // No frequency detected - reset smoothed frequency after a delay
                if (this.smoothedFrequency !== null) {
                    // Gradually reset smoothed frequency
                    this.smoothedFrequency = null;
                }
                this.currentFrequency = null;
                this.currentNote = null;
                this.updateTuning(null);
            }
        }, this.UPDATE_INTERVAL);
    }

    // Update tuning based on detected frequency
    updateTuning(frequency) {
        if (!frequency || frequency <= 0) {
            // No frequency detected, smoothly return circle to center
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
        
        // Determine tuning state
        const isSharp = cents > 0; // Positive cents = sharp (перетянута)
        const isFlat = cents < 0;  // Negative cents = flat (недотянута)
        const isWithinTolerance = Math.abs(cents) <= this.TUNING_TOLERANCE;
        
        // Log detailed tuning info for debugging (only log significant changes)
        if (isWithinTolerance) {
            // Only log when stable count changes significantly
            if (this.tuningStableCount % 5 === 0 || this.tuningStableCount === this.tuningStableThreshold) {
                console.log(`✓ String ${currentString.stringNumber} (${currentString.note}) tuned! Freq: ${frequency.toFixed(2)} Hz, Target: ${currentString.frequency.toFixed(2)} Hz, Cents: ${cents.toFixed(2)}, Stable: ${this.tuningStableCount}/${this.tuningStableThreshold}`);
            }
        } else {
            // Log tuning direction for debugging
            const direction = isSharp ? 'SHARP (перетянута → нужно ослабить)' : 'FLAT (недотянута → нужно затянуть)';
            if (Math.abs(cents) > 5) { // Only log significant deviations
                console.log(`→ ${direction} | Freq: ${frequency.toFixed(2)} Hz, Target: ${currentString.frequency.toFixed(2)} Hz, Cents: ${cents.toFixed(2)} (tolerance: ±${this.TUNING_TOLERANCE})`);
            }
        }
        
        // Update circle position (will center if within tolerance)
        this.updateCirclePosition(cents);
        
        // Update note text
        this.updateNoteText(frequency);
        
        // Check if tuned
        const isTuned = this.checkIfTuned(cents);
        
        // Track stable tuning state using consecutive readings
        if (isTuned) {
            this.tuningStableCount++;
            
            // Check if we've been tuned long enough to move to next string
            if (this.tuningStableCount >= this.tuningStableThreshold) {
                // We've been stable long enough - check if we need to initiate transition
                if (!this.isTuned) {
                    // Just reached stable tuned state for the first time
                    this.isTuned = true;
                    console.log(`✓✓ String ${currentString.stringNumber} (${currentString.note}) is STABLE and tuned! Stable count: ${this.tuningStableCount}/${this.tuningStableThreshold}, Cents: ${cents.toFixed(2)}`);
                    
                    // Clear any existing timeout
                    if (this.tuningTimeout) {
                        clearTimeout(this.tuningTimeout);
                    }
                    
                    // Add a short delay before moving to next string for visual feedback
                    this.tuningTimeout = setTimeout(() => {
                        // Final verification before moving
                        if (!this.allStringsTuned && this.currentFrequency) {
                            const finalCents = this.frequencyToCents(this.currentFrequency, currentString.frequency);
                            if (Math.abs(finalCents) <= this.TUNING_TOLERANCE) {
                                console.log(`✓✓✓ CONFIRMED: Moving to next string! Final cents: ${finalCents.toFixed(2)}, Target: ${currentString.frequency.toFixed(2)} Hz`);
                                this.moveToNextString();
                            } else {
                                console.log(`⚠ Verification failed: Final cents ${finalCents.toFixed(2)} is outside tolerance ±${this.TUNING_TOLERANCE}`);
                                this.isTuned = false;
                                this.tuningStableCount = Math.floor(this.tuningStableThreshold * 0.5); // Reset to halfway
                            }
                        } else if (this.allStringsTuned) {
                            console.log(`All strings already tuned, not moving`);
                        } else {
                            console.log(`⚠ No frequency available for verification`);
                            this.isTuned = false;
                            this.tuningStableCount = Math.floor(this.tuningStableThreshold * 0.5);
                        }
                        this.tuningTimeout = null;
                    }, 300); // 300ms delay for visual feedback
                }
                // If already marked as tuned, keep counting but don't reset
            }
        } else {
            // Not tuned - reset stable count and state
            if (this.tuningStableCount > 0) {
                console.log(`⚠ Tuning lost: Cents ${cents.toFixed(2)} is outside tolerance ±${this.TUNING_TOLERANCE}. Resetting stable count from ${this.tuningStableCount}.`);
            }
            this.tuningStableCount = 0;
            
            if (this.isTuned) {
                // Left tuned state
                console.log(`⚠ String ${currentString.stringNumber} (${currentString.note}) is no longer tuned. Cents: ${cents.toFixed(2)}`);
                if (this.tuningTimeout) {
                    clearTimeout(this.tuningTimeout);
                    this.tuningTimeout = null;
                }
                this.isTuned = false;
            }
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
        this.smoothedFrequency = null; // Reset frequency smoothing for new string
        this.tuningStableCount = 0; // Reset stable count for new string
        this.elements.orangeCircle.style.transform = 'translate(-50%, -50%)'; // Reset to center
        if (this.elements.noteText) {
            this.elements.noteText.textContent = '';
            this.elements.noteText.style.opacity = '0';
        }
        
        // Clear any pending timeouts
        if (this.tuningTimeout) {
            clearTimeout(this.tuningTimeout);
            this.tuningTimeout = null;
        }

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
            
            // Optional: Highlight if it matches the expected note for current string
            const currentString = this.STRING_FREQUENCIES[this.currentStringIndex];
            if (note.name === currentString.note) {
                // Correct note detected - could add visual feedback here if needed
            }
        } else {
            this.elements.noteText.textContent = '';
            this.elements.noteText.style.opacity = '0';
        }
    }

    // Update orange circle position based on tuning accuracy with smoothing
    updateCirclePosition(cents) {
        // Calculate maximum pixel offset based on circle sizes
        // Gray circle: 200px, Orange circle: 167px
        // Available space for movement: (200 - 167) / 2 = 16.5px on each side
        const maxOffset = 16; // Maximum pixel offset (slightly less than available space)
        
        // Calculate target position based on cents
        // IMPORTANT: Positive cents = sharp (перетянута) = move RIGHT (+)
        //            Negative cents = flat (недотянута) = move LEFT (-)
        
        let targetOffset = 0;
        
        if (Math.abs(cents) <= this.TUNING_TOLERANCE) {
            // Within tolerance - center the circle
            targetOffset = 0;
            // Use faster smoothing to center quickly
            const centerSmoothingFactor = 0.5;
            this.smoothedOffset = this.smoothedOffset + (targetOffset - this.smoothedOffset) * centerSmoothingFactor;
            
            // Snap to center if very close
            if (Math.abs(this.smoothedOffset) < 0.3) {
                this.smoothedOffset = 0;
            }
        } else {
            // Outside tolerance - move circle left or right
            // Clamp cents to maximum offset for display
            const clampedCents = Math.max(-this.MAX_OFFSET, Math.min(this.MAX_OFFSET, cents));
            
            // Map cents to pixel offset
            // Positive cents (sharp) -> positive offset (right)
            // Negative cents (flat) -> negative offset (left)
            targetOffset = (clampedCents / this.MAX_OFFSET) * maxOffset;
            
            // Use more responsive smoothing for out-of-tune detection
            // This makes the circle move faster when tuning is off
            // Increase responsiveness based on how far off we are
            const deviationRatio = Math.abs(cents) / this.MAX_OFFSET;
            const responsiveSmoothingFactor = Math.min(0.5, 0.25 + deviationRatio * 0.25); // More responsive for larger deviations
            this.smoothedOffset = this.smoothedOffset + (targetOffset - this.smoothedOffset) * responsiveSmoothingFactor;
            
            // Debug: Log movement direction and amount
            const direction = cents > 0 ? 'RIGHT (sharp)' : 'LEFT (flat)';
            if (Math.abs(cents) > 3) { // Log for any noticeable deviation
                console.log(`Circle: ${direction} | Cents=${cents.toFixed(2)}, Offset=${this.smoothedOffset.toFixed(2)}px`);
            }
        }
        
        // Apply transform
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
