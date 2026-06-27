// ─── WebSocket API Bridge (replaces Electron preload ncsAPI) ───
(function() {
  const wsUrl = `ws://${window.location.host}`;
  let ws = null;
  const mediaCallbacks = [];
  const audioCallbacks = [];
  const stateCallbacks = [];
  let volumeResolver = null;
  let settingsResolver = null;

  function connect() {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('[WS] Connected to backend');
      // Load settings from backend on connect
      ws.send(JSON.stringify({ type: 'settings:load' }));
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        const { type, data, value } = payload;

        if (type === 'media') {
          mediaCallbacks.forEach(cb => cb(data));
        } else if (type === 'audio') {
          audioCallbacks.forEach(cb => cb(data));
        } else if (type === 'volume') {
          if (volumeResolver) {
            volumeResolver(value);
            volumeResolver = null;
          }
        } else if (type === 'settings') {
          if (settingsResolver) {
            settingsResolver(value);
            settingsResolver = null;
          }
        }
      } catch (e) {
        console.error('[WS] Error processing message:', e);
      }
    };

    ws.onclose = () => {
      console.log('[WS] Disconnected, retrying in 2s...');
      setTimeout(connect, 2000);
    };
  }

  connect();

  window.ncsAPI = {
    // Media session
    onMediaUpdate: (callback) => mediaCallbacks.push(callback),
    mediaPlay: () => ws?.send(JSON.stringify({ type: 'command', action: 'play' })),
    mediaPause: () => ws?.send(JSON.stringify({ type: 'command', action: 'pause' })),
    mediaTogglePlayPause: () => ws?.send(JSON.stringify({ type: 'command', action: 'togglePlayPause' })),
    mediaNext: () => ws?.send(JSON.stringify({ type: 'command', action: 'next' })),
    mediaPrevious: () => ws?.send(JSON.stringify({ type: 'command', action: 'previous' })),
    mediaShuffle: () => ws?.send(JSON.stringify({ type: 'command', action: 'shuffle' })),
    mediaRepeat: () => ws?.send(JSON.stringify({ type: 'command', action: 'repeat' })),
    mediaSeek: (position) => ws?.send(JSON.stringify({ type: 'command', action: 'seek', value: position })),
    mediaVolume: (vol) => ws?.send(JSON.stringify({ type: 'command', action: 'volume', value: vol })),
    getVolume: () => new Promise(resolve => {
      volumeResolver = resolve;
      ws?.send(JSON.stringify({ type: 'command', action: 'getVolume' }));
    }),

    // Audio FFT data
    onAudioData: (callback) => audioCallbacks.push(callback),

    // Window controls (mocked or handled natively by browser)
    windowMinimize: () => {},
    windowMaximize: () => {},
    windowClose: () => {},
    windowFullscreen: () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    },
    isMaximized: () => Promise.resolve(false),
    isFullScreen: () => Promise.resolve(!!document.fullscreenElement),
    onWindowState: (callback) => {
      stateCallbacks.push(callback);
      document.addEventListener('fullscreenchange', () => {
        const isFS = !!document.fullscreenElement;
        callback({ fullscreen: isFS });
      });
    },

    // Settings
    loadSettings: () => new Promise(resolve => {
      settingsResolver = resolve;
      ws?.send(JSON.stringify({ type: 'settings:load' }));
    }),
    saveSettings: (settings) => {
      ws?.send(JSON.stringify({ type: 'settings:save', value: settings }));
      return Promise.resolve(true);
    }
  };
})();

/**
 * NCS Visualizer — Standalone Renderer
 *
 * Ports the WebGL2 particle sphere from the Spicetify version,
 * driven by real-time system audio via AudioEngine.
 *
 * Audio → Visual Mapping:
 *   Bass (low freq)  → Sphere SIZE (expansion)
 *   Mid (vocals)     → DOT intensity & brightness
 *   High (instr.)    → FLARE / glow bloom
 */

// ─── Global State ──────────────────────────────────────────
const audioEngine = new AudioEngine();
window.audioEngine = audioEngine; // Expose to window for other scripts (like antigravity.js)
let settingsManager = null;

let mediaState = {
  status: 'no_session',
  title: '',
  artist: '',
  album: '',
  thumbnail: '',
  isPlaying: false,
  position: 0,
  duration: 0,
  shuffleActive: false,
  repeatMode: 0,
  capabilities: {
    canPlay: true, canPause: true, canNext: false, canPrev: false,
    canShuffle: false, canRepeat: false, canSeek: false
  }
};

let themeColor = { r: 142, g: 149, b: 194 }; // Default purple-ish
window.themeColor = themeColor; // Expose to window for background gradient updates
let lastTitle = '';
let lastArtist = '';
let lastServerPosition = -1;
let isFullscreen = false;
let isDraggingSeek = false;
let dragProgress = 0;

// ─── DOM Elements ──────────────────────────────────────────
const canvas = document.getElementById('ncs-canvas');
const container = document.getElementById('visualizer-container');
const backdropImg = document.getElementById('backdrop-img');
const overlay = document.getElementById('visualizer-overlay');
const titleEl = document.getElementById('track-title');
const artistEl = document.getElementById('track-artist');
const timeCurrent = document.getElementById('time-current');
const timeDuration = document.getElementById('time-duration');
const progressBar = document.getElementById('progress-bar');
const progressContainer = document.getElementById('progress-bar-container');
const playIcon = document.getElementById('play-icon');
const waveIndicator = document.getElementById('wave-indicator');
const volumeSlider = document.getElementById('volume-slider');
const volumeIcon = document.getElementById('volume-icon');
const noMediaState = document.getElementById('no-media-state');

// Dynamic control buttons
const btnShuffle = document.getElementById('btn-shuffle');
const btnPrev = document.getElementById('btn-prev');
const btnPlay = document.getElementById('btn-play');
const btnNext = document.getElementById('btn-next');
const btnRepeat = document.getElementById('btn-repeat');
const repeatIcon = document.getElementById('repeat-icon');

// ─── Color Extraction ──────────────────────────────────────
function extractDominantColor(imgElement) {
  return new Promise((resolve) => {
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = 64;
      canvas.height = 64;
      ctx.drawImage(imgElement, 0, 0, 64, 64);
      const data = ctx.getImageData(0, 0, 64, 64).data;

      // Simple dominant color: weighted average favoring saturated pixels
      let totalR = 0, totalG = 0, totalB = 0, totalWeight = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (a < 128) continue;

        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const saturation = max === 0 ? 0 : (max - min) / max;
        const lightness = (max + min) / 2;

        // Weight: prefer saturated, medium-brightness colors
        const weight = saturation * (1 - Math.abs(lightness / 255 - 0.5) * 2) + 0.1;
        totalR += r * weight;
        totalG += g * weight;
        totalB += b * weight;
        totalWeight += weight;
      }

      if (totalWeight > 0) {
        resolve({
          r: Math.round(totalR / totalWeight),
          g: Math.round(totalG / totalWeight),
          b: Math.round(totalB / totalWeight)
        });
      } else {
        resolve({ r: 142, g: 149, b: 194 }); // fallback
      }
    } catch (e) {
      resolve({ r: 142, g: 149, b: 194 });
    }
  });
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 142, g: 149, b: 194 };
}

// ─── WebGL2 Particle Sphere ────────────────────────────────

let gl = null;
let glState = null;

function initWebGL() {
  gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false });
  if (!gl) {
    console.error('WebGL2 not supported');
    return false;
  }

  if (!gl.getExtension('EXT_color_buffer_float')) {
    console.error('EXT_color_buffer_float not supported');
    return false;
  }

  // ── Compile shaders ──

  function compileShader(type, source, name) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error(`Shader '${name}' compile error:`, gl.getShaderInfoLog(shader));
      return null;
    }
    return shader;
  }

  function linkProgram(vs, fs, name) {
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error(`Program '${name}' link error:`, gl.getProgramInfoLog(prog));
      return null;
    }
    return prog;
  }

  function createFramebuffer(filter) {
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { framebuffer: fb, texture: tex };
  }

  // ── Particle shader (positions dots on sphere surface) ──
  const particleVS = compileShader(gl.VERTEX_SHADER, `#version 300 es
in vec2 inPosition;
out vec2 fragUV;
void main() {
    gl_Position = vec4(inPosition, 0.0, 1.0);
    fragUV = (inPosition + 1.0) / 2.0;
}`, 'particle vertex');

  const particleFS = compileShader(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;

uniform float uNoiseOffset;
uniform float uAmplitude;
uniform int uSeed;
uniform float uDotSpacing;
uniform float uDotOffset;
uniform float uSphereRadius;
uniform float uFeather;
uniform float uNoiseFrequency;
uniform float uNoiseAmplitude;

// Mid-freq driven intensity uniforms
uniform float uMidIntensity;

in vec2 fragUV;
out vec2 outColor;

const float FREQUENCY = 0.01;
const float GAIN = 0.5;
const float LACUNARITY = 1.5;
const float FRACTAL_BOUNDING = 1.0 / 1.75;
const ivec3 PRIMES = ivec3(501125321, 1136930381, 1720413743);

const float GRADIENTS_3D[] = float[](
    0., 1., 1., 0.,  0.,-1., 1., 0.,  0., 1.,-1., 0.,  0.,-1.,-1., 0.,
    1., 0., 1., 0., -1., 0., 1., 0.,  1., 0.,-1., 0., -1., 0.,-1., 0.,
    1., 1., 0., 0., -1., 1., 0., 0.,  1.,-1., 0., 0., -1.,-1., 0., 0.,
    0., 1., 1., 0.,  0.,-1., 1., 0.,  0., 1.,-1., 0.,  0.,-1.,-1., 0.,
    1., 0., 1., 0., -1., 0., 1., 0.,  1., 0.,-1., 0., -1., 0.,-1., 0.,
    1., 1., 0., 0., -1., 1., 0., 0.,  1.,-1., 0., 0., -1.,-1., 0., 0.,
    0., 1., 1., 0.,  0.,-1., 1., 0.,  0., 1.,-1., 0.,  0.,-1.,-1., 0.,
    1., 0., 1., 0., -1., 0., 1., 0.,  1., 0.,-1., 0., -1., 0.,-1., 0.,
    1., 1., 0., 0., -1., 1., 0., 0.,  1.,-1., 0., 0., -1.,-1., 0., 0.,
    0., 1., 1., 0.,  0.,-1., 1., 0.,  0., 1.,-1., 0.,  0.,-1.,-1., 0.,
    1., 0., 1., 0., -1., 0., 1., 0.,  1., 0.,-1., 0., -1., 0.,-1., 0.,
    1., 1., 0., 0., -1., 1., 0., 0.,  1.,-1., 0., 0., -1.,-1., 0., 0.,
    0., 1., 1., 0.,  0.,-1., 1., 0.,  0., 1.,-1., 0.,  0.,-1.,-1., 0.,
    1., 0., 1., 0., -1., 0., 1., 0.,  1., 0.,-1., 0., -1., 0.,-1., 0.,
    1., 1., 0., 0., -1., 1., 0., 0.,  1.,-1., 0., 0., -1.,-1., 0., 0.,
    1., 1., 0., 0.,  0.,-1., 1., 0., -1., 1., 0., 0.,  0.,-1.,-1., 0.
);

float smootherStep(float t) {
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}
vec3 smootherStep(vec3 coord) {
    return vec3(smootherStep(coord.x), smootherStep(coord.y), smootherStep(coord.z));
}

int hash(int seed, ivec3 primed) {
    return (seed ^ primed.x ^ primed.y ^ primed.z) * 0x27d4eb2d;
}

float gradCoord(int seed, ivec3 primed, vec3 d) {
    int hash = hash(seed, primed);
    hash ^= hash >> 15;
    hash &= 63 << 2;
    return d.x * GRADIENTS_3D[hash] + d.y * GRADIENTS_3D[hash | 1] + d.z * GRADIENTS_3D[hash | 2];
}

float perlinSingle(int seed, vec3 coord) {
    ivec3 coord0 = ivec3(floor(coord));
    vec3 d0 = coord - vec3(coord0);
    vec3 d1 = d0 - 1.0;
    vec3 s = smootherStep(d0);
    coord0 *= PRIMES;
    ivec3 coord1 = coord0 + PRIMES;
    float xf00 = mix(gradCoord(seed, coord0, d0), gradCoord(seed, ivec3(coord1.x, coord0.yz), vec3(d1.x, d0.yz)), s.x);
    float xf10 = mix(gradCoord(seed, ivec3(coord0.x, coord1.y, coord0.z), vec3(d0.x, d1.y, d0.z)), gradCoord(seed, ivec3(coord1.xy, coord0.z), vec3(d1.xy, d0.z)), s.x);
    float xf01 = mix(gradCoord(seed, ivec3(coord0.xy, coord1.z), vec3(d0.xy, d1.z)), gradCoord(seed, ivec3(coord1.x, coord0.y, coord1.z), vec3(d1.x, d0.y, d1.z)), s.x);
    float xf11 = mix(gradCoord(seed, ivec3(coord0.x, coord1.yz), vec3(d0.x, d1.yz)), gradCoord(seed, coord1, d1), s.x);
    float yf0 = mix(xf00, xf10, s.y);
    float yf1 = mix(xf01, xf11, s.y);
    return mix(yf0, yf1, s.z) * 0.964921414852142333984375f;
}

float fractalNoise(vec3 coord) {
    return perlinSingle(uSeed, coord) * FRACTAL_BOUNDING
        + perlinSingle(uSeed + 1, coord * LACUNARITY) * FRACTAL_BOUNDING * GAIN
        + perlinSingle(uSeed + 2, coord * LACUNARITY * LACUNARITY) * FRACTAL_BOUNDING * GAIN * GAIN;
}

void main() {
    float noise = fractalNoise(vec3(fragUV * uNoiseFrequency, uNoiseOffset)) * uNoiseAmplitude;

    // Mid intensity modulates noise displacement — vocals make dots dance more
    float midBoost = 1.0 + uMidIntensity * 0.5;
    noise *= midBoost;

    vec3 dotCenter = vec3(fragUV * uDotSpacing + uDotOffset + noise, (noise + 0.5 * uNoiseAmplitude) * uAmplitude * 0.4);

    float distanceFromCenter = length(dotCenter);
    dotCenter /= distanceFromCenter;
    distanceFromCenter = min(uSphereRadius, distanceFromCenter);
    dotCenter *= distanceFromCenter;

    float featherRadius = uSphereRadius - uFeather;
    float featherStrength = 1.0 - clamp((distanceFromCenter - featherRadius) / uFeather, 0.0, 1.0);
    dotCenter *= featherStrength * (uSphereRadius / distanceFromCenter - 1.0) + 1.0;

    dotCenter.y *= -1.0;
    outColor = dotCenter.xy;
}`, 'particle fragment');

  if (!particleVS || !particleFS) return false;
  const particleProgram = linkProgram(particleVS, particleFS, 'particle');
  if (!particleProgram) return false;

  // ── Dot shader (renders individual dots) ──
  const dotVS = compileShader(gl.VERTEX_SHADER, `#version 300 es
uniform int uDotCount;
uniform float uDotRadius;
uniform float uDotRadiusPX;
uniform sampler2D uParticleTexture;

// Mid-freq driven dot brightness
uniform float uDotBrightness;

in vec2 inPosition;
out vec2 fragUV;
out float fragDotRadiusPX;
out float fragBrightness;

void main() {
    ivec2 dotIndex = ivec2(gl_InstanceID % uDotCount, gl_InstanceID / uDotCount);
    vec2 dotCenter = texelFetch(uParticleTexture, dotIndex, 0).xy;

    // Scale dot size by mid intensity (vocals = bigger dots)
    float sizeScale = 1.0 + uDotBrightness * 0.3;

    gl_Position = vec4(dotCenter + inPosition * uDotRadius * sizeScale * (1.0 + 1.0 / uDotRadiusPX), 0.0, 1.0);
    fragUV = inPosition;
    fragDotRadiusPX = uDotRadiusPX * sizeScale + 1.0;
    fragBrightness = 0.7 + uDotBrightness * 0.3;
}`, 'dot vertex');

  const dotFS = compileShader(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
in vec2 fragUV;
in float fragDotRadiusPX;
in float fragBrightness;
out float outColor;
void main() {
    float t = clamp((1.0 - length(fragUV)) * fragDotRadiusPX, 0.0, 1.0);
    outColor = t * fragBrightness;
}`, 'dot fragment');

  if (!dotVS || !dotFS) return false;
  const dotProgram = linkProgram(dotVS, dotFS, 'dot');
  if (!dotProgram) return false;

  // ── Blur shader (Gaussian blur for flare/glow) ──
  const blurVS = compileShader(gl.VERTEX_SHADER, `#version 300 es
uniform float uBlurRadius;
uniform vec2 uBlurDirection;
in vec2 inPosition;
out vec2 fragUV;
flat out vec2 fragBlurDirection;
flat out int fragSupport;
flat out vec3 fragGaussCoefficients;

float calculateGaussianTotal(int support, vec3 gc) {
    float total = gc.x;
    for (int i = 1; i < support; i++) {
        gc.xy *= gc.yz;
        total += 2.0 * gc.x;
    }
    return total;
}

void main() {
    fragSupport = int(ceil(1.5 * uBlurRadius)) * 2;
    fragGaussCoefficients = vec3(
        1.0 / (sqrt(2.0 * 3.14159265) * uBlurRadius),
        exp(-0.5 / (uBlurRadius * uBlurRadius)),
        0.0
    );
    fragGaussCoefficients.z = fragGaussCoefficients.y * fragGaussCoefficients.y;
    fragGaussCoefficients.x /= calculateGaussianTotal(fragSupport, fragGaussCoefficients);

    gl_Position = vec4(inPosition, 0.0, 1.0);
    fragUV = (inPosition + 1.0) / 2.0;
    fragBlurDirection = uBlurDirection;
}`, 'blur vertex');

  const blurFS = compileShader(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
uniform sampler2D uInputTexture;
in vec2 fragUV;
flat in vec2 fragBlurDirection;
flat in int fragSupport;
flat in vec3 fragGaussCoefficients;
out float outColor;

void main() {
    vec3 gaussCoefficients = fragGaussCoefficients;
    outColor = gaussCoefficients.x * texture(uInputTexture, fragUV).r;
    for (int i = 1; i < fragSupport; i += 2) {
        gaussCoefficients.xy *= gaussCoefficients.yz;
        float coefficientSum = gaussCoefficients.x;
        gaussCoefficients.xy *= gaussCoefficients.yz;
        coefficientSum += gaussCoefficients.x;
        float pixelRatio = gaussCoefficients.x / coefficientSum;
        vec2 offset = (float(i) + pixelRatio) * fragBlurDirection;
        outColor += coefficientSum * (texture(uInputTexture, fragUV + offset).r + texture(uInputTexture, fragUV - offset).r);
    }
}`, 'blur fragment');

  if (!blurVS || !blurFS) return false;
  const blurProgram = linkProgram(blurVS, blurFS, 'blur');
  if (!blurProgram) return false;

  // ── Finalize shader (composites dots + blur with color, flare-driven) ──
  const finalVS = compileShader(gl.VERTEX_SHADER, `#version 300 es
uniform vec3 uOutputColor;
uniform vec3 uFlareColor;
uniform float uFlareIntensity;
in vec2 inPosition;
out vec2 fragUV;
out vec3 fragOutputColor;
out vec3 fragFlareColor;
out float fragFlareIntensity;

void main() {
    gl_Position = vec4(inPosition, 0.0, 1.0);
    fragUV = (inPosition + 1.0) / 2.0;
    fragOutputColor = uOutputColor;
    fragFlareColor = uFlareColor;
    fragFlareIntensity = uFlareIntensity;
}`, 'finalize vertex');

  const finalFS = compileShader(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
uniform sampler2D uBlurredTexture;
uniform sampler2D uOriginalTexture;
in vec2 fragUV;
in vec3 fragOutputColor;
in vec3 fragFlareColor;
in float fragFlareIntensity;
out vec4 outColor;

void main() {
    float original = texture(uOriginalTexture, fragUV).r;
    float blurred = texture(uBlurredTexture, fragUV).r;

    // Dots: colored by primary color, driven by original (mid-freq)
    vec3 dotColor = fragOutputColor * original;

    // Flare: colored by flare color, driven by blur (high-freq/instrumentals)
    // Add a baseline glow of 35% so it's always soft and glowing
    float flareFactor = 0.35 + fragFlareIntensity * 0.65;
    vec3 flareColor = fragFlareColor * blurred * flareFactor;

    // Composite
    vec3 combined = dotColor + flareColor;
    float alpha = max(original, blurred * flareFactor);

    outColor = vec4(combined, alpha);
}`, 'finalFS fragment');

  if (!finalVS || !finalFS) return false;
  const finalProgram = linkProgram(finalVS, finalFS, 'finalize');
  if (!finalProgram) return false;

  // ── Get uniform/attribute locations ──
  const state = {
    particleProgram,
    dotProgram,
    blurProgram,
    finalProgram,
    viewportSize: 0,
    particleTextureSize: 0,

    // Particle uniforms
    inPositionLoc: gl.getAttribLocation(particleProgram, 'inPosition'),
    uNoiseOffsetLoc: gl.getUniformLocation(particleProgram, 'uNoiseOffset'),
    uAmplitudeLoc: gl.getUniformLocation(particleProgram, 'uAmplitude'),
    uSeedLoc: gl.getUniformLocation(particleProgram, 'uSeed'),
    uDotSpacingLoc: gl.getUniformLocation(particleProgram, 'uDotSpacing'),
    uDotOffsetLoc: gl.getUniformLocation(particleProgram, 'uDotOffset'),
    uSphereRadiusLoc: gl.getUniformLocation(particleProgram, 'uSphereRadius'),
    uFeatherLoc: gl.getUniformLocation(particleProgram, 'uFeather'),
    uNoiseFrequencyLoc: gl.getUniformLocation(particleProgram, 'uNoiseFrequency'),
    uNoiseAmplitudeLoc: gl.getUniformLocation(particleProgram, 'uNoiseAmplitude'),
    uMidIntensityLoc: gl.getUniformLocation(particleProgram, 'uMidIntensity'),

    // Dot uniforms
    inPositionLocDot: gl.getAttribLocation(dotProgram, 'inPosition'),
    uDotCountLoc: gl.getUniformLocation(dotProgram, 'uDotCount'),
    uDotRadiusLoc: gl.getUniformLocation(dotProgram, 'uDotRadius'),
    uDotRadiusPXLoc: gl.getUniformLocation(dotProgram, 'uDotRadiusPX'),
    uParticleTextureLoc: gl.getUniformLocation(dotProgram, 'uParticleTexture'),
    uDotBrightnessLoc: gl.getUniformLocation(dotProgram, 'uDotBrightness'),

    // Blur uniforms
    inPositionLocBlur: gl.getAttribLocation(blurProgram, 'inPosition'),
    uBlurRadiusLoc: gl.getUniformLocation(blurProgram, 'uBlurRadius'),
    uBlurDirectionLoc: gl.getUniformLocation(blurProgram, 'uBlurDirection'),
    uBlurInputTextureLoc: gl.getUniformLocation(blurProgram, 'uInputTexture'),

    // Finalize uniforms
    inPositionLocFinal: gl.getAttribLocation(finalProgram, 'inPosition'),
    uOutputColorLoc: gl.getUniformLocation(finalProgram, 'uOutputColor'),
    uFlareColorLoc: gl.getUniformLocation(finalProgram, 'uFlareColor'),
    uFlareIntensityLoc: gl.getUniformLocation(finalProgram, 'uFlareIntensity'),
    uBlurredTextureLoc: gl.getUniformLocation(finalProgram, 'uBlurredTexture'),
    uOriginalTextureLoc: gl.getUniformLocation(finalProgram, 'uOriginalTexture'),
  };

  // Create framebuffers
  const particleFB = createFramebuffer(gl.NEAREST);
  const dotFB = createFramebuffer(gl.NEAREST);
  const blurXFB = createFramebuffer(gl.LINEAR);
  const blurYFB = createFramebuffer(gl.NEAREST);

  state.particleFramebuffer = particleFB.framebuffer;
  state.particleTexture = particleFB.texture;
  state.dotFramebuffer = dotFB.framebuffer;
  state.dotTexture = dotFB.texture;
  state.blurXFramebuffer = blurXFB.framebuffer;
  state.blurXTexture = blurXFB.texture;
  state.blurYFramebuffer = blurYFB.framebuffer;
  state.blurYTexture = blurYFB.texture;

  // Quad buffer
  state.quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, state.quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);

  gl.enable(gl.BLEND);
  gl.blendEquation(gl.MAX);

  glState = state;
  resizeCanvas();
  return true;
}

function resizeCanvas() {
  if (!gl || !glState) return;

  const parent = canvas.parentElement;
  if (!parent) return;
  const parentRect = parent.getBoundingClientRect();
  
  // Calculate sideMax using layout metrics from CSS
  const edgePad = parentRect.width * 0.06;
  const centerGap = parentRect.width * 0.08;
  const sideMax = parentRect.width * 0.5 - edgePad - (centerGap / 2);
  
  let cssSize;
  const isWidgetMode = window.innerWidth <= 900 || (window.innerWidth / window.innerHeight) < 1.4;
  
  if (isWidgetMode) {
    // Centered mobile widget size (60vh or 80% width)
    const maxHeight = parentRect.height * 0.6;
    const maxWidth = parentRect.width * 0.8;
    cssSize = Math.min(maxHeight, maxWidth);
  } else {
    // Normal desktop split screen size
    const maxHeight = parentRect.height * 0.9;
    const maxWidth = sideMax;
    cssSize = Math.min(maxHeight, maxWidth);
  }

  // Force perfect square to avoid stretched ovals
  canvas.style.setProperty('width', `${cssSize}px`, 'important');
  canvas.style.setProperty('height', `${cssSize}px`, 'important');

  // Enforce high-DPI render buffer
  const dpr = window.devicePixelRatio || 1;
  const renderSize = Math.round(cssSize * dpr);

  if (canvas.width !== renderSize || canvas.height !== renderSize) {
    canvas.width = renderSize;
    canvas.height = renderSize;
  }

  glState.viewportSize = renderSize;
  gl.viewport(0, 0, renderSize, renderSize);

  // Resize FBO textures
  gl.bindTexture(gl.TEXTURE_2D, glState.dotTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, renderSize, renderSize, 0, gl.RED, gl.UNSIGNED_BYTE, null);
  gl.bindTexture(gl.TEXTURE_2D, glState.blurXTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, renderSize, renderSize, 0, gl.RED, gl.UNSIGNED_BYTE, null);
  gl.bindTexture(gl.TEXTURE_2D, glState.blurYTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, renderSize, renderSize, 0, gl.RED, gl.UNSIGNED_BYTE, null);
}

function renderFrame() {
  if (!gl || !glState) return;

  const s = audioEngine.settings;
  const L = s.particleCount;
  const dotRadius = 0.9 / L;
  const dotRadiusPX = 0.5 * dotRadius * glState.viewportSize;

  // Audio-driven values
  const sphereRadius = audioEngine.getSphereRadius();
  const feather = audioEngine.getFeather();
  const noiseOffset = audioEngine.getNoiseOffset();
  const amplitude = audioEngine.getAmplitude();
  const dotBrightness = audioEngine.getDotIntensity();
  const flareIntensity = audioEngine.getFlareIntensity();
  const midIntensity = audioEngine.mid;

  // Seed from time
  const seed = Math.floor(Date.now() / 1000) % 1000000;

  // Resize particle texture if needed
  if (glState.particleTextureSize !== L) {
    glState.particleTextureSize = L;
    gl.bindTexture(gl.TEXTURE_2D, glState.particleTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, L, L, 0, gl.RG, gl.FLOAT, null);
  }

  // ── Pass 1: Particle positions ──
  gl.disable(gl.BLEND);
  gl.bindFramebuffer(gl.FRAMEBUFFER, glState.particleFramebuffer);
  gl.viewport(0, 0, L, L);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.useProgram(glState.particleProgram);
  gl.uniform1f(glState.uNoiseOffsetLoc, noiseOffset);
  gl.uniform1f(glState.uAmplitudeLoc, amplitude);
  gl.uniform1i(glState.uSeedLoc, seed);
  gl.uniform1f(glState.uDotSpacingLoc, 0.9);
  gl.uniform1f(glState.uDotOffsetLoc, -0.45);
  gl.uniform1f(glState.uSphereRadiusLoc, sphereRadius);
  gl.uniform1f(glState.uFeatherLoc, feather);
  gl.uniform1f(glState.uNoiseFrequencyLoc, 4);
  gl.uniform1f(glState.uNoiseAmplitudeLoc, 0.32 * 0.9);
  gl.uniform1f(glState.uMidIntensityLoc, midIntensity);

  gl.bindBuffer(gl.ARRAY_BUFFER, glState.quadBuffer);
  gl.enableVertexAttribArray(glState.inPositionLoc);
  gl.vertexAttribPointer(glState.inPositionLoc, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);

  // ── Pass 2: Render dots ──
  gl.enable(gl.BLEND);
  gl.bindFramebuffer(gl.FRAMEBUFFER, glState.dotFramebuffer);
  gl.viewport(0, 0, glState.viewportSize, glState.viewportSize);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.useProgram(glState.dotProgram);
  gl.uniform1i(glState.uDotCountLoc, L);
  gl.uniform1f(glState.uDotRadiusLoc, dotRadius * s.dotBaseSize);
  gl.uniform1f(glState.uDotRadiusPXLoc, dotRadiusPX * s.dotBaseSize);
  gl.uniform1i(glState.uParticleTextureLoc, 0);
  gl.uniform1f(glState.uDotBrightnessLoc, dotBrightness);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, glState.particleTexture);
  gl.bindBuffer(gl.ARRAY_BUFFER, glState.quadBuffer);
  gl.enableVertexAttribArray(glState.inPositionLocDot);
  gl.vertexAttribPointer(glState.inPositionLocDot, 2, gl.FLOAT, false, 0, 0);
  gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, L * L);

  // ── Pass 3: Gaussian blur (flare) ──
  // Blur radius scales with high-freq (instrumentals drive flare spread)
  const blurRadius = (0.015 + flareIntensity * 0.02 * s.dotGlowRadius) * glState.viewportSize;

  // Horizontal blur
  gl.bindFramebuffer(gl.FRAMEBUFFER, glState.blurXFramebuffer);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(glState.blurProgram);
  gl.uniform1f(glState.uBlurRadiusLoc, Math.max(blurRadius, 0.5));
  gl.uniform2f(glState.uBlurDirectionLoc, 1 / glState.viewportSize, 0);
  gl.uniform1i(glState.uBlurInputTextureLoc, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, glState.dotTexture);
  gl.bindBuffer(gl.ARRAY_BUFFER, glState.quadBuffer);
  gl.enableVertexAttribArray(glState.inPositionLocBlur);
  gl.vertexAttribPointer(glState.inPositionLocBlur, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);

  // Vertical blur
  gl.bindFramebuffer(gl.FRAMEBUFFER, glState.blurYFramebuffer);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.uniform2f(glState.uBlurDirectionLoc, 0, 1 / glState.viewportSize);
  gl.bindTexture(gl.TEXTURE_2D, glState.blurXTexture);
  gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);

  // ── Pass 4: Finalize (composite with color) ──
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.useProgram(glState.finalProgram);

  // Primary color (dots)
  gl.uniform3f(glState.uOutputColorLoc, themeColor.r / 255, themeColor.g / 255, themeColor.b / 255);

  // Flare color (can be different from primary)
  const flareColor = s.autoColor ? themeColor : hexToRgb(s.flareColor);
  gl.uniform3f(glState.uFlareColorLoc, flareColor.r / 255, flareColor.g / 255, flareColor.b / 255);
  gl.uniform1f(glState.uFlareIntensityLoc, flareIntensity * s.flareColorSpread);

  gl.uniform1i(glState.uBlurredTextureLoc, 0);
  gl.uniform1i(glState.uOriginalTextureLoc, 1);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, glState.blurYTexture);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, glState.dotTexture);
  gl.bindBuffer(gl.ARRAY_BUFFER, glState.quadBuffer);
  gl.enableVertexAttribArray(glState.inPositionLocFinal);
  gl.vertexAttribPointer(glState.inPositionLocFinal, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
}

// ─── UI Updates ────────────────────────────────────────────

function formatTime(s) {
  if (!s || !isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
}

function updateUI() {
  const ms = mediaState;
  const hasMedia = ms.status === 'ok' && ms.title;

  // No media state
  noMediaState.style.display = hasMedia ? 'none' : 'flex';
  overlay.style.opacity = hasMedia ? '1' : '0';
  overlay.style.pointerEvents = hasMedia ? '' : 'none';

  if (!hasMedia) return;

  // Title & artist
  titleEl.textContent = ms.title || 'Unknown';
  titleEl.style.setProperty('--title-length', (ms.title || '').length);
  artistEl.textContent = ms.artist || '';

  // Playing indicator
  waveIndicator.className = 'visualizer-overlay__wave' + (ms.isPlaying ? ' is-playing' : '');
  playIcon.textContent = ms.isPlaying ? 'pause' : 'play_arrow';

  // Progress
  if (!isDraggingSeek) {
    timeCurrent.textContent = formatTime(ms.position);
    const pct = ms.duration > 0 ? (ms.position / ms.duration * 100) : 0;
    progressBar.style.width = pct + '%';
  }
  timeDuration.textContent = formatTime(ms.duration);

  // Dynamic control visibility
  const cap = ms.capabilities;
  btnPrev.style.display = cap.canPrev ? '' : 'none';
  btnNext.style.display = cap.canNext ? '' : 'none';
  btnShuffle.style.display = cap.canShuffle ? '' : 'none';
  btnRepeat.style.display = cap.canRepeat ? '' : 'none';

  // Seek availability
  progressContainer.style.pointerEvents = cap.canSeek ? 'auto' : 'none';
  progressContainer.style.opacity = cap.canSeek ? '1' : '0.4';

  // Active states
  btnShuffle.className = 'visualizer-overlay__ctrl-btn' + (ms.shuffleActive ? ' visualizer-overlay__ctrl-btn--active' : '');
  btnRepeat.className = 'visualizer-overlay__ctrl-btn' + (ms.repeatMode ? ' visualizer-overlay__ctrl-btn--active' : '');
  repeatIcon.textContent = ms.repeatMode === 2 ? 'repeat_one' : 'repeat';

  // Theme color on overlay
  const colorStr = `rgb(${themeColor.r},${themeColor.g},${themeColor.b})`;
  overlay.style.setProperty('--theme-color', colorStr);

  // Background tint
  const bgTint = audioEngine.settings.backgroundTint;
  container.style.backgroundColor = bgTint;

  // Backdrop blur
  if (backdropImg.style.display !== 'none') {
    backdropImg.style.filter = `blur(${audioEngine.settings.backgroundBlur}px) brightness(0.4)`;
  }
}

function updateTimeline(dt) {
  const ms = mediaState;
  const hasMedia = ms.status === 'ok' && ms.title;
  if (!hasMedia || !ms.isPlaying || isDraggingSeek) return;

  // Increment local position smoothly by dt
  ms.position = Math.min(ms.position + dt, ms.duration);

  // Update DOM progress
  timeCurrent.textContent = formatTime(ms.position);
  const pct = ms.duration > 0 ? (ms.position / ms.duration * 100) : 0;
  progressBar.style.width = pct + '%';
}

// ─── Event Bindings ────────────────────────────────────────

function initControls() {
  // Playback
  btnPlay.addEventListener('click', () => window.ncsAPI.mediaTogglePlayPause());
  btnNext.addEventListener('click', () => window.ncsAPI.mediaNext());
  btnPrev.addEventListener('click', () => window.ncsAPI.mediaPrevious());
  btnShuffle.addEventListener('click', () => window.ncsAPI.mediaShuffle());
  btnRepeat.addEventListener('click', () => window.ncsAPI.mediaRepeat());

  // Volume
  window.ncsAPI.getVolume().then(v => { volumeSlider.value = v; updateVolumeIcon(v); });

  volumeSlider.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    window.ncsAPI.mediaVolume(v);
    updateVolumeIcon(v);
  });

  document.getElementById('btn-volume').addEventListener('click', () => {
    const current = parseFloat(volumeSlider.value);
    if (current > 0) {
      volumeSlider.dataset.prevVolume = current;
      volumeSlider.value = 0;
      window.ncsAPI.mediaVolume(0);
      updateVolumeIcon(0);
    } else {
      const prev = parseFloat(volumeSlider.dataset.prevVolume || 0.5);
      volumeSlider.value = prev;
      window.ncsAPI.mediaVolume(prev);
      updateVolumeIcon(prev);
    }
  });

  // Seek
  progressContainer.addEventListener('mousedown', (e) => {
    if (!mediaState.capabilities.canSeek || mediaState.duration <= 0) return;

    isDraggingSeek = true;
    const rect = progressContainer.getBoundingClientRect();

    const calculatePos = (clientX) => {
      let frac = (clientX - rect.left) / rect.width;
      frac = Math.max(0, Math.min(1, frac));
      return frac * mediaState.duration;
    };

    dragProgress = calculatePos(e.clientX);
    progressBar.style.width = (dragProgress / mediaState.duration * 100) + '%';
    timeCurrent.textContent = formatTime(dragProgress);

    const onMove = (me) => {
      dragProgress = calculatePos(me.clientX);
      progressBar.style.width = (dragProgress / mediaState.duration * 100) + '%';
      timeCurrent.textContent = formatTime(dragProgress);
    };

    const onUp = (ue) => {
      const finalPos = calculatePos(ue.clientX);
      window.ncsAPI.mediaSeek(finalPos);
      isDraggingSeek = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  // Window controls
  const btnMin = document.getElementById('btn-minimize');
  if (btnMin) btnMin.addEventListener('click', () => window.ncsAPI.windowMinimize());
  const btnMax = document.getElementById('btn-maximize');
  if (btnMax) btnMax.addEventListener('click', () => window.ncsAPI.windowMaximize());
  const btnClose = document.getElementById('btn-close');
  if (btnClose) btnClose.addEventListener('click', () => window.ncsAPI.windowClose());

  const btnFS = document.getElementById('btn-fullscreen');
  if (btnFS) {
    btnFS.addEventListener('click', () => {
      window.ncsAPI.windowFullscreen();
    });
  }

  window.ncsAPI.onWindowState((state) => {
    const maxIcon = document.getElementById('maximize-icon');
    if (maxIcon && 'maximized' in state) {
      maxIcon.textContent = state.maximized ? 'filter_none' : 'crop_square';
    }
    if ('fullscreen' in state) {
      isFullscreen = state.fullscreen;
      const fsIcon = document.getElementById('fullscreen-icon');
      if (fsIcon) fsIcon.textContent = state.fullscreen ? 'fullscreen_exit' : 'fullscreen';
      const titlebar = document.getElementById('titlebar');
      if (titlebar) titlebar.style.display = state.fullscreen ? 'none' : '';
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        window.ncsAPI.mediaTogglePlayPause();
        break;
      case 'F11':
        e.preventDefault();
        window.ncsAPI.windowFullscreen();
        break;
      case 'Escape':
        if (settingsManager?.isOpen) settingsManager.close();
        break;
    }
  });

  // Resize handler
  const resizeObserver = new ResizeObserver(() => {
    const rect = container.getBoundingClientRect();
    container.style.setProperty('--vis-w', rect.width);
    container.style.setProperty('--vis-h', rect.height);
    resizeCanvas();
  });
  resizeObserver.observe(container);
}

function updateVolumeIcon(vol) {
  volumeIcon.textContent = vol === 0 ? 'volume_off' : vol < 0.5 ? 'volume_down' : 'volume_up';
}

// ─── IPC Handlers ──────────────────────────────────────────

function initIPC() {
  // Media session updates
  window.ncsAPI.onMediaUpdate((data) => {
    if (!data || typeof data !== 'object') return;

    const title = data.title || '';
    const artist = data.artist || '';
    const position = typeof data.position === 'number' ? data.position : 0;

    const hasSongChanged = (title !== lastTitle || artist !== lastArtist);
    const hasSeeked = (position !== lastServerPosition);

    // Save previous local position
    const prevPosition = mediaState && typeof mediaState.position === 'number' ? mediaState.position : 0;

    // Update state
    mediaState = data;

    // Timeline position synchronization logic:
    // If the song changed or a real manual seek occurred, update to the new position.
    // Otherwise (normal playback), preserve the client's local smoothly-interpolated position
    // to prevent Brave/Chrome's lack of continuous timeline updates from snapping the timeline back to 0.01.
    if (hasSongChanged || hasSeeked) {
      mediaState.position = position;
      lastServerPosition = position;
    } else {
      mediaState.position = prevPosition;
    }

    updateUI();

    // Update album art & extract color only when song changes
    if (hasSongChanged) {
      lastTitle = title;
      lastArtist = artist;

      if (data.thumbnail) {
        backdropImg.src = 'data:image/png;base64,' + data.thumbnail;
        backdropImg.style.display = '';
      } else {
        backdropImg.style.display = 'none';
      }
      updateUI();
    }
  });

  // Audio FFT data
  window.ncsAPI.onAudioData((fftData) => {
    audioEngine.process(fftData);
  });
}

// ─── Animation Loop ────────────────────────────────────────

let lastFrameTime = performance.now();

function animate() {
  const now = performance.now();
  const dt = Math.min((now - lastFrameTime) / 1000, 0.1);
  lastFrameTime = now;

  audioEngine.update(dt);
  updateTimeline(dt);
  renderFrame();
  requestAnimationFrame(animate);
}

// ─── Preloader Exit Trigger ────────────────────────────────

function initPreloader() {
  const hidePreloader = () => {
    // Hold preloader for 1.5s to display loading sequence smoothly
    setTimeout(() => {
      const preloader = document.getElementById('preloader');
      if (preloader) {
        preloader.classList.add('preloader--hidden');
        // Delete preloader from DOM after slide animations complete (1.2s transition)
        setTimeout(() => {
          preloader.remove();
        }, 1200);
      }
    }, 1500);
  };

  if (document.readyState === 'complete') {
    hidePreloader();
  } else {
    window.addEventListener('load', hidePreloader);
  }
}

// ─── Init ──────────────────────────────────────────────────

window.onSettingsLoaded = (settings) => {
  themeColor = hexToRgb(settings.primaryColor || '#8e95c2');
  window.themeColor = themeColor;
  updateUI();
  if (typeof window.updateBackgroundColors === 'function') {
    window.updateBackgroundColors();
  }
};

function init() {
  if (!initWebGL()) {
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#fff;font-family:Inter;font-size:24px;background:#0e111a;">WebGL2 is not supported on this device.</div>';
    return;
  }

  themeColor = hexToRgb(audioEngine.settings.primaryColor);
  window.themeColor = themeColor;

  settingsManager = new SettingsManager(audioEngine);
  initControls();
  initIPC();
  initPreloader();
  animate();
}

// Wait for DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
