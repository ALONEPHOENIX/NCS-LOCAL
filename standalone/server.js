const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { MediaSessionManager } = require('./backend/media-session');
const { AudioCapture } = require('./backend/audio-capture');

const PORT = 3000;
const SETTINGS_PATH = path.join(os.homedir(), '.ncs-visualizer-settings.json');

// Create HTTP server to serve frontend static files
const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'src', req.url === '/' ? 'index.html' : req.url);
  
  // Clean query strings if any
  filePath = filePath.split('?')[0];

  const extname = path.extname(filePath);
  let contentType = 'text/html';

  switch (extname) {
    case '.js':
      contentType = 'text/javascript';
      break;
    case '.css':
      contentType = 'text/css';
      break;
    case '.json':
      contentType = 'application/json';
      break;
    case '.png':
      contentType = 'image/png';
      break;
    case '.jpg':
      contentType = 'image/jpg';
      break;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found</h1>', 'utf-8');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

// Create WebSocket server
const wss = new WebSocketServer({ server });

let mediaSession = null;
let audioCapture = null;
let lastMediaData = null;

// Broadcast to all clients
function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
    }
  }
}

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  
  // Send current media state if available
  if (lastMediaData) {
    ws.send(JSON.stringify({ type: 'media', data: lastMediaData }));
  } else {
    mediaSession?.triggerPoll();
  }

  // Handle client messages
  ws.on('message', async (message) => {
    try {
      const payload = JSON.parse(message);
      const { type, action, value } = payload;

      if (type === 'command') {
        switch (action) {
          case 'play':
            mediaSession?.sendCommand('play');
            break;
          case 'pause':
            mediaSession?.sendCommand('pause');
            break;
          case 'togglePlayPause':
            mediaSession?.sendCommand('togglePlayPause');
            break;
          case 'next':
            mediaSession?.sendCommand('next');
            break;
          case 'previous':
            mediaSession?.sendCommand('previous');
            break;
          case 'shuffle':
            mediaSession?.sendCommand('shuffle');
            break;
          case 'repeat':
            mediaSession?.sendCommand('repeat');
            break;
          case 'seek':
            mediaSession?.sendCommand('seek', value);
            break;
          case 'volume':
            mediaSession?.setVolume(value);
            break;
          case 'getVolume':
            const vol = await mediaSession?.getVolume();
            ws.send(JSON.stringify({ type: 'volume', value: vol }));
            break;
        }
      } else if (type === 'settings:save') {
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(value, null, 2));
      } else if (type === 'settings:load') {
        let settings = null;
        if (fs.existsSync(SETTINGS_PATH)) {
          try {
            settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
          } catch (e) {}
        }
        ws.send(JSON.stringify({ type: 'settings', value: settings }));
      }
    } catch (e) {
      console.error('[WS] Error processing message:', e);
    }
  });
});

// Start loopback audio capture and media session tracking
function startServices() {
  mediaSession = new MediaSessionManager();
  mediaSession.start((data) => {
    lastMediaData = data;
    broadcast({ type: 'media', data });
  });

  let maxRms = 0;
  let lastLogTime = Date.now();
  audioCapture = new AudioCapture();
  audioCapture.start((fftData) => {
    broadcast({ type: 'audio', data: fftData });
    maxRms = Math.max(maxRms, fftData.rms);
    if (Date.now() - lastLogTime > 2000) {
      console.log(`[Audio Diagnostics] Max RMS in last 2s: ${maxRms.toFixed(4)}`);
      maxRms = 0;
      lastLogTime = Date.now();
    }
  });
}

// Start server
server.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(` NCS Visualizer Server is running local!`);
  console.log(` Open your web browser to: http://localhost:${PORT}`);
  console.log(`==================================================\n`);
  
  startServices();
});

// Handle exit cleanly
process.on('SIGINT', () => {
  console.log('Shutting down services...');
  mediaSession?.stop();
  audioCapture?.stop();
  process.exit(0);
});
