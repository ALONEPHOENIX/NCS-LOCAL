/**
 * Settings Panel — CAVA-level customization UI
 * Builds the settings form and handles persistence.
 */
class SettingsManager {
  constructor(audioEngine) {
    this.audioEngine = audioEngine;
    this.panel = document.getElementById('settings-panel');
    this.body = document.getElementById('settings-body');
    this.isOpen = false;

    // Bind events
    document.getElementById('btn-settings').addEventListener('click', () => this.toggle());
    document.getElementById('btn-settings-close').addEventListener('click', () => this.close());

    // Click outside to close
    this.panel.addEventListener('click', (e) => {
      if (e.target === this.panel) this.close();
    });

    // Load saved settings
    this._loadSettings();
  }

  async _loadSettings() {
    try {
      const saved = await window.ncsAPI.loadSettings();
      if (saved) {
        saved.autoColor = false;
        this.audioEngine.updateSettings(saved);
        if (typeof window.onSettingsLoaded === 'function') {
          window.onSettingsLoaded(saved);
        }
      } else {
        if (typeof window.onSettingsLoaded === 'function') {
          window.onSettingsLoaded(this.audioEngine.settings);
        }
      }
    } catch (e) {
      console.warn('Failed to load settings:', e);
    }
    this._buildUI();
  }

  async _saveSettings() {
    try {
      await window.ncsAPI.saveSettings(this.audioEngine.settings);
    } catch (e) {
      console.warn('Failed to save settings:', e);
    }
  }

  toggle() {
    this.isOpen ? this.close() : this.open();
  }

  open() {
    this.isOpen = true;
    this.panel.style.display = 'flex';
    this._buildUI();
    requestAnimationFrame(() => this.panel.classList.add('is-open'));
  }

  close() {
    this.isOpen = false;
    this.panel.classList.remove('is-open');
    setTimeout(() => { this.panel.style.display = 'none'; }, 300);
    this._saveSettings();
  }

  _buildUI() {
    const s = this.audioEngine.settings;
    this.body.innerHTML = '';

    // Helper to create a section
    const section = (title, icon) => {
      const div = document.createElement('div');
      div.className = 'settings-section';
      div.innerHTML = `<h3 class="settings-section__title"><span class="material-symbols-outlined">${icon}</span>${title}</h3>`;
      this.body.appendChild(div);
      return div;
    };

    // Helper to create a slider
    const slider = (parent, label, key, min, max, step, unit = '') => {
      const row = document.createElement('div');
      row.className = 'settings-row';
      const val = s[key];
      row.innerHTML = `
        <label class="settings-row__label">${label}</label>
        <div class="settings-row__control">
          <input type="range" class="settings-slider" min="${min}" max="${max}" step="${step}" value="${val}"
                 data-key="${key}">
          <span class="settings-row__value" id="val-${key}">${Number(val).toFixed(step < 1 ? 2 : 0)}${unit}</span>
        </div>
      `;
      parent.appendChild(row);

      const input = row.querySelector('input');
      input.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        s[key] = v;
        this.audioEngine.updateSettings(s);
        document.getElementById(`val-${key}`).textContent = v.toFixed(step < 1 ? 2 : 0) + unit;
        this._saveSettings();
        if (typeof window.onSettingsLoaded === 'function') {
          window.onSettingsLoaded(s);
        }
      });
    };

    // Helper to create a color picker
    const colorPicker = (parent, label, key) => {
      const row = document.createElement('div');
      row.className = 'settings-row';
      row.innerHTML = `
        <label class="settings-row__label">${label}</label>
        <div class="settings-row__control">
          <input type="color" class="settings-color" value="${s[key]}" data-key="${key}">
        </div>
      `;
      parent.appendChild(row);

      row.querySelector('input').addEventListener('input', (e) => {
        s[key] = e.target.value;
        this.audioEngine.updateSettings(s);
        this._saveSettings();
        if (typeof window.onSettingsLoaded === 'function') {
          window.onSettingsLoaded(s);
        }
      });
    };

    // Helper to create a toggle
    const toggle = (parent, label, key) => {
      const row = document.createElement('div');
      row.className = 'settings-row';
      row.innerHTML = `
        <label class="settings-row__label">${label}</label>
        <div class="settings-row__control">
          <button class="settings-toggle ${s[key] ? 'is-on' : ''}" data-key="${key}">
            ${s[key] ? 'ON' : 'OFF'}
          </button>
        </div>
      `;
      parent.appendChild(row);

      row.querySelector('button').addEventListener('click', (e) => {
        s[key] = !s[key];
        e.target.className = `settings-toggle ${s[key] ? 'is-on' : ''}`;
        e.target.textContent = s[key] ? 'ON' : 'OFF';
        this.audioEngine.updateSettings(s);
        this._saveSettings();
        if (typeof window.onSettingsLoaded === 'function') {
          window.onSettingsLoaded(s);
        }
      });
    };

    // ── Frequency Bands ──
    const freqSec = section('Frequency Bands', 'equalizer');
    slider(freqSec, 'Bass Min', 'bassMinHz', 10, 200, 1, ' Hz');
    slider(freqSec, 'Bass Max', 'bassMaxHz', 100, 500, 1, ' Hz');
    slider(freqSec, 'Mid Min', 'midMinHz', 100, 1000, 10, ' Hz');
    slider(freqSec, 'Mid Max', 'midMaxHz', 1000, 8000, 100, ' Hz');
    slider(freqSec, 'High Min', 'highMinHz', 2000, 8000, 100, ' Hz');
    slider(freqSec, 'High Max', 'highMaxHz', 8000, 22000, 100, ' Hz');

    // ── Sensitivity & Response ──
    const sensSec = section('Sensitivity & Response', 'speed');
    slider(sensSec, 'Overall Sensitivity', 'overallSensitivity', 0.1, 5.0, 0.1, 'x');
    slider(sensSec, 'Bass Sensitivity', 'bassSensitivity', 0.1, 5.0, 0.1, 'x');
    slider(sensSec, 'Mid Sensitivity', 'midSensitivity', 0.1, 5.0, 0.1, 'x');
    slider(sensSec, 'High Sensitivity', 'highSensitivity', 0.1, 5.0, 0.1, 'x');
    slider(sensSec, 'Smoothing', 'smoothing', 0, 0.99, 0.01);
    slider(sensSec, 'Attack Speed', 'attackSpeed', 0.01, 0.5, 0.01, 's');
    slider(sensSec, 'Decay Speed', 'decaySpeed', 0.05, 1.0, 0.01, 's');
    slider(sensSec, 'Noise Gate', 'noiseGate', 0, 0.1, 0.001);

    // ── Visual Tuning ──
    const visSec = section('Visual Tuning', 'auto_awesome');
    slider(visSec, 'Sphere Base Radius', 'sphereBaseRadius', 0.3, 0.95, 0.01);
    slider(visSec, 'Bass → Sphere Expansion', 'sphereMaxExpansion', 0, 0.5, 0.01);
    slider(visSec, 'Dot Size', 'dotBaseSize', 0.2, 3.0, 0.1, 'x');
    slider(visSec, 'Dot Glow Radius', 'dotGlowRadius', 0.1, 3.0, 0.1, 'x');
    slider(visSec, 'Flare Intensity', 'flareIntensity', 0, 3.0, 0.1, 'x');
    slider(visSec, 'Flare Color Spread', 'flareColorSpread', 0.1, 3.0, 0.1, 'x');
    slider(visSec, 'Particle Density', 'particleCount', 100, 500, 1);
    slider(visSec, 'Background Blur', 'backgroundBlur', 0, 120, 1, 'px');

    // ── Colors ──
    const colorSec = section('Colors', 'palette');
    colorPicker(colorSec, 'Primary Color', 'primaryColor');
    colorPicker(colorSec, 'Flare Color', 'flareColor');
    colorPicker(colorSec, 'Background Tint', 'backgroundTint');

    // ── Reset button ──
    const resetRow = document.createElement('div');
    resetRow.className = 'settings-row settings-row--reset';
    resetRow.innerHTML = `<button class="settings-reset-btn">Reset to Defaults</button>`;
    this.body.appendChild(resetRow);

    resetRow.querySelector('button').addEventListener('click', () => {
      const defaults = new AudioEngine().settings;
      Object.assign(s, defaults);
      s.autoColor = false; // ensure autoColor remains false
      this.audioEngine.updateSettings(s);
      this._saveSettings();
      this._buildUI();
      if (typeof window.onSettingsLoaded === 'function') {
        window.onSettingsLoaded(s);
      }
    });
  }
}

window.SettingsManager = SettingsManager;
