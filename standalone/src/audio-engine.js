/**
 * AudioEngine — CAVA-level real-time audio analysis
 *
 * Processes FFT data from the main process and produces smoothed,
 * frequency-band-split values for driving the visualizer:
 *   - bass (sphere SIZE)
 *   - mid/vocals (DOT intensity)
 *   - high/instrumentals (FLARE glow)
 */
class AudioEngine {
  constructor() {
    // Default settings (CAVA-style knobs)
    this.settings = {
      // Frequency band ranges (Hz)
      bassMinHz: 20,
      bassMaxHz: 250,
      midMinHz: 250,
      midMaxHz: 4000,
      highMinHz: 4000,
      highMaxHz: 20000,

      // Sensitivity
      overallSensitivity: 1.5,
      bassSensitivity: 2.0,
      midSensitivity: 1.5,
      highSensitivity: 1.2,

      // Smoothing (0 = no smoothing, 0.99 = very smooth)
      smoothing: 0.65,

      // Attack/Decay (seconds)
      attackSpeed: 0.08,
      decaySpeed: 0.25,

      // Noise gate (ignore below this threshold)
      noiseGate: 0.005,

      // Visual tuning
      sphereBaseRadius: 0.73,
      sphereMaxExpansion: 0.20,
      dotBaseSize: 1.0,
      dotGlowRadius: 1.0,
      flareIntensity: 1.0,
      flareColorSpread: 1.0,
      particleCount: 322,  // Grid size (322x322 = ~103k particles)
      backgroundBlur: 60,

      // Colors
      autoColor: false,
      primaryColor: '#8e95c2',
      flareColor: '#8e95c2',
      backgroundTint: '#0e111a'
    };

    // Smoothed output values
    this.bass = 0;
    this.mid = 0;
    this.high = 0;
    this.rms = 0;

    // Internal state for attack/decay
    this._targetBass = 0;
    this._targetMid = 0;
    this._targetHigh = 0;
    this._targetRms = 0;
    this._lastTimestamp = performance.now();

    // Peak tracking for auto-sensitivity
    this._peakBass = 0.01;
    this._peakMid = 0.01;
    this._peakHigh = 0.01;
    this._peakDecayRate = 0.999;

    // History for beat detection
    this._bassHistory = new Float32Array(60);
    this._bassHistoryIdx = 0;
    this._beatDetected = false;
    this._beatCooldown = 0;

    // Accumulated integration for sphere animation
    this._accumulatedAmplitude = 0;

    // Velocities for spring physics
    this._bassVel = 0;
    this._midVel = 0;
    this._highVel = 0;
    this._rmsVel = 0;
  }

  /**
   * Update settings from the settings panel
   */
  updateSettings(newSettings) {
    Object.assign(this.settings, newSettings);
  }

  /**
   * Process raw FFT data from the audio capture
   * @param {Object} fftData - { bass, mid, high, rms, magnitudes, timestamp }
   */
  process(fftData) {
    this.receiveData(fftData);
  }

  /**
   * Receive raw FFT data from WebSockets and save target values
   */
  receiveData(fftData) {
    const s = this.settings;

    // Apply sensitivity multipliers
    let rawBass = fftData.bass * s.bassSensitivity * s.overallSensitivity;
    let rawMid = fftData.mid * s.midSensitivity * s.overallSensitivity;
    let rawHigh = fftData.high * s.highSensitivity * s.overallSensitivity;
    let rawRms = fftData.rms * s.overallSensitivity;

    // Apply noise gate
    if (rawBass < s.noiseGate) rawBass = 0;
    if (rawMid < s.noiseGate) rawMid = 0;
    if (rawHigh < s.noiseGate) rawHigh = 0;
    if (rawRms < s.noiseGate) rawRms = 0;

    // Clamp
    rawBass = Math.min(rawBass, 1);
    rawMid = Math.min(rawMid, 1);
    rawHigh = Math.min(rawHigh, 1);
    rawRms = Math.min(rawRms, 1);

    // Update peak tracking (slowly decay)
    this._peakBass = Math.max(this._peakBass * this._peakDecayRate, rawBass, 0.01);
    this._peakMid = Math.max(this._peakMid * this._peakDecayRate, rawMid, 0.01);
    this._peakHigh = Math.max(this._peakHigh * this._peakDecayRate, rawHigh, 0.01);

    // Normalize against peaks (auto-gain)
    rawBass /= this._peakBass;
    rawMid /= this._peakMid;
    rawHigh /= this._peakHigh;

    // Set targets
    this._targetBass = rawBass;
    this._targetMid = rawMid;
    this._targetHigh = rawHigh;
    this._targetRms = rawRms;

    // Store raw magnitudes
    this.magnitudes = fftData.magnitudes || [];
  }

  /**
   * Physics update run on every requestAnimationFrame for buttery smooth interpolation
   */
  update(dt) {
    const s = this.settings;

    // Map smoothing (0 to 0.99) to spring speed (28 down to 4)
    // 0 smoothing -> speed 28 (very responsive, springy)
    // 0.99 smoothing -> speed 4 (ultra smooth, slow glide)
    const speed = 28 - s.smoothing * 24;

    this.bass = this._springUpdate(this.bass, '_bassVel', this._targetBass, dt, speed);
    this.mid = this._springUpdate(this.mid, '_midVel', this._targetMid, dt, speed);
    this.high = this._springUpdate(this.high, '_highVel', this._targetHigh, dt, speed);
    this.rms = this._springUpdate(this.rms, '_rmsVel', this._targetRms, dt, speed);

    // Beat detection (bass transient)
    this._bassHistory[this._bassHistoryIdx] = this._targetBass;
    this._bassHistoryIdx = (this._bassHistoryIdx + 1) % this._bassHistory.length;

    let avgBass = 0;
    for (let i = 0; i < this._bassHistory.length; i++) avgBass += this._bassHistory[i];
    avgBass /= this._bassHistory.length;

    this._beatCooldown = Math.max(0, this._beatCooldown - dt);
    this._beatDetected = (this._targetBass > avgBass * 1.8 && this._targetBass > 0.15 && this._beatCooldown <= 0);
    if (this._beatDetected) this._beatCooldown = 0.12;

    // Accumulated amplitude for time-based animation
    this._accumulatedAmplitude += this.rms * dt;
  }

  /**
   * Critically damped spring-damper solver for infinite smooth interpolation
   */
  _springUpdate(current, velocityName, target, dt, speed) {
    const vel = this[velocityName] || 0;
    const temp = (vel + speed * (current - target)) * dt;
    const newCurrent = (current - target + temp) * Math.exp(-speed * dt) + target;
    const newVelocity = (vel - speed * temp) * Math.exp(-speed * dt);
    this[velocityName] = newVelocity;
    return newCurrent;
  }

  /**
   * Apply attack/decay envelope (unused but kept for API compatibility)
   */
  _envelope(current, target, dt) {
    const s = this.settings;
    if (target > current) {
      const attackRate = 1.0 / Math.max(s.attackSpeed, 0.001);
      return current + (target - current) * Math.min(attackRate * dt, 1);
    } else {
      const decayRate = 1.0 / Math.max(s.decaySpeed, 0.001);
      return current + (target - current) * Math.min(decayRate * dt, 1);
    }
  }

  /**
   * Get the sphere radius based on bass
   */
  getSphereRadius() {
    const s = this.settings;
    return s.sphereBaseRadius + this.bass * s.sphereMaxExpansion;
  }

  /**
   * Get dot intensity based on mid/vocal frequencies
   */
  getDotIntensity() {
    return this.mid * this.settings.dotBaseSize;
  }

  /**
   * Get flare/glow intensity based on high/instrumental frequencies
   */
  getFlareIntensity() {
    return this.high * this.settings.flareIntensity;
  }

  /**
   * Whether a bass beat was just detected
   */
  isBeat() {
    return this._beatDetected;
  }

  /**
   * Get noise offset for shader (time-based + amplitude-driven)
   */
  getNoiseOffset() {
    return this._accumulatedAmplitude * 0.5;
  }

  /**
   * Get the overall amplitude for backward-compatible shader uniform
   */
  getAmplitude() {
    // Blend bass (dominant) with overall RMS
    return Math.min(this.bass * 0.6 + this.rms * 0.4, 1.0);
  }

  /**
   * Get feather amount (inverse of bass — tighter sphere on bass hits)
   */
  getFeather() {
    const amp = this.getAmplitude();
    return Math.pow(amp + 3, 2) * (45 / 1568);
  }

  /**
   * Reset all values (e.g., when no audio)
   */
  reset() {
    this.bass = 0;
    this.mid = 0;
    this.high = 0;
    this.rms = 0;
    this._targetBass = 0;
    this._targetMid = 0;
    this._targetHigh = 0;
    this._targetRms = 0;
    this._beatDetected = false;
  }
}

// Export globally
window.AudioEngine = AudioEngine;
