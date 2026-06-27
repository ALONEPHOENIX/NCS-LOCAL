# 🎬 Standalone NCS Visualizer
### *A Real-Time WebGL2 Audio Visualizer for Web Browsers*

A WebGL2-powered particle sphere audio visualizer running locally on a Node.js web server. It captures raw system audio output in real-time and synchronizes particle movements. Features an interactive cursor magnet attractor, a procedural WebGL2 watercolor paper background, dynamic controls, and volume adjustments—all rendered directly inside your favorite web browser.

---

## 📸 Preview

### Normal View
![Normal View](resources/image1.png)

### Standalone WebGL View (Watercolor + Antigravity Particles)
![Standalone View](resources/image2.png)

---

## ✨ Features

* 🔴 **NCS-Style Particle Sphere:** High-performance WebGL2 particle system driven by real-time amplitude curves from your system sound loopback.
* 🎨 **WebGL Animated Background:** A procedural WebGL2 fragment shader background simulating watercolor paint blending and soaking on textured paper, reacting dynamically to the music's mid-range/vocals.
* 🌌 **Antigravity Particle Attractor:** 1,800 high-density glowing white capsules that drift randomly, but pull together to form a wavy, pulsating 3D ring whenever you move your cursor near them. Includes alpha buffer trails for liquid-like motion ghosting.
* 🚪 **Symmetrical Staircase Preloader:** A curtain entrance/wipe loading transition that slides vertical bars from the outer edges to the center from both the top and bottom halves of the screen.
* 🖥️ **Stunning Fullscreen Mode:** Toggle a minimal overlay displaying the track name, artist, interactive seek bar, and playback controls.
* 🎛️ **Full Playback Controls:** Control your active media player directly from the visualizer with play/pause, next, previous, shuffle, and repeat buttons.
* 🔊 **Volume Controller:** Quick mute button with a smooth hover-reveal volume slider.
* 📐 **Responsive Design:** Completely fluid typography and layout scaling perfectly to any viewport size.

---

## 🚀 Quick Start

1. **Install Node.js dependencies**  
   Run the following command in your terminal inside the project directory:
   ```bash
   npm install --prefix standalone
   ```
2. **Start the local server**  
   Start the Node server process:
   ```bash
   npm start
   ```
3. **Open the App**  
   Open your browser and navigate to:  
   **[http://localhost:3000](http://localhost:3000)**

---

## 🚀 High-Performance Windows Media Integration (Optional)

By default, the server queries the **Windows Global System Media Transport Controls (GSMTC)** via an optimized PowerShell fallback script to retrieve active song info (title, artist, position, and album art). To achieve ultra-low latency, zero CPU usage, and high-speed media updates, you can install Python and its native WinRT bindings:

1. **Install Python**  
   Download and install [Python 3.9 - 3.13](https://www.python.org/downloads/) (ensure **"Add Python to PATH"** is checked during installation).
2. **Install Native Bindings**  
   Run the following command in your terminal/command prompt:
   ```bash
   pip install winrt-Windows.Media.Control winrt-Windows.Storage.Streams
   ```

> [!NOTE]
> If Python is not installed or the libraries are missing, the server will automatically fall back to the optimized PowerShell engine, meaning it will still work perfectly out-of-the-box!

---

## 📁 File Structure

```
visualizer/
├── resources/              # Preview screenshots
│   ├── image1.png
│   └── image2.png
├── standalone/             # Standalone Browser App
│   ├── backend/            # Audio capture & media session tools
│   │   ├── audio-capture.js
│   │   ├── AudioCapture.cs # WASAPI loopback C# source
│   │   ├── media-session.js
│   │   └── media-session.py
│   ├── src/                # Web visualizer client files
│   │   ├── index.html      # Main interface
│   │   ├── style.css       # Staircase preloader & HUD styles
│   │   ├── renderer.js     # WebGL circle particle visualizer
│   │   ├── antigravity.js  # Watercolor shader & Three.js particles
│   │   ├── audio-engine.js # FFT audio processing
│   │   └── settings.js     # Settings preference panel
│   ├── server.js           # Local HTTP & WebSocket Node server
│   └── package.json
├── LICENSE                 # License info
└── README.md               # Project documentation
```

---

## 🎨 Customization

You can customize the standalone browser visualizer's settings by editing these files directly:

* **Background Shaders & Particles:** Edit `standalone/src/antigravity.js` to change the colors of the watercolor shader, adjust particle count (`count`), or tune pointer magnet radius (`magnetRadius`).
* **Entry Preloader Curtains:** Edit `standalone/src/style.css` (search for `.preloader`) to tune transition times, column counts, or change keyframe easing parameters.
* **Circle Visualizer:** Edit `standalone/src/renderer.js` to adjust default WebGL settings or circle render properties.
* **Frequency Response & FFT:** Edit `standalone/src/audio-engine.js` to tune the CAVA sensitivity, frequency bands splitting, or smoothing multipliers.

---

## 🛠️ Usage & Controls

| Control / Action | Description |
| :--- | :--- |
| **Enter Fullscreen** | Click the fullscreen button (top-right) or press `F11`. |
| **Interactive Seek** | Click anywhere along the progress bar to seek playback time. |
| **Previous / Next** | Skip tracks using the overlay controls in fullscreen mode. |
| **Play / Pause** | Toggle playback using the fullscreen button or press `Space`. |
| **Shuffle / Repeat** | Toggle shuffle or repeat modes via fullscreen control toggles. |
| **Volume Control** | Hover over the volume icon to reveal the slider; click to mute/unmute. |

---

## 👥 Credits

* Built using vanilla WebGL2 and Three.js frameworks.
* WebGL2 particle rendering inspired by standard NCS visualizer designs.
* Audio capture and processing powered by Windows WASAPI interfaces.
* Typography: [Rubik Spray Paint](https://fonts.google.com/specimen/Rubik+Spray+Paint) & [Jua](https://fonts.google.com/specimen/Jua) via Google Fonts.
* Icons: [Material Icons](https://fonts.google.com/icons) by Google.

---

## 📄 License

This project is licensed under the Apache License 2.0. See the [LICENSE](LICENSE) file for details.
