/**
 * Windows Global System Media Transport Controls (GSMTC) Integration
 * Uses PowerShell to query the active media session for track info and capabilities.
 */
const { execFile, exec } = require('child_process');
const path = require('path');

const PS_MEDIA_SCRIPT = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Media.MediaPlaybackAutoRepeatMode, Windows.Media, ContentType = WindowsRuntime]

$asyncOp = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()

function Await($WinRtTask) {
  [System.WindowsRuntimeSystemExtensions]::GetAwaiter($WinRtTask).GetResult()
}

try {
  $sessionMgr = Await $asyncOp
  $session = $sessionMgr.GetCurrentSession()

  if ($null -eq $session) {
    Write-Output '{"status":"no_session"}'
    exit
  }

  $mediaProps = $null
  $timelineProps = $null
  $playbackInfo = $null

  try {
    $mediaPropsOp = $session.TryGetMediaPropertiesAsync()
    $mediaProps = Await $mediaPropsOp
  } catch {}

  try {
    $timelineProps = $session.GetTimelineProperties()
  } catch {}

  try {
    $playbackInfo = $session.GetPlaybackInfo()
  } catch {}

  $title = if ($mediaProps) { $mediaProps.Title } else { "" }
  $artist = if ($mediaProps) { $mediaProps.Artist } else { "" }
  $album = if ($mediaProps) { $mediaProps.AlbumTitle } else { "" }

  # Get album art thumbnail as base64
  $thumbBase64 = ""
  try {
    if ($mediaProps -and $mediaProps.Thumbnail) {
      if (($title -eq $env:LAST_TITLE) -and ($artist -eq $env:LAST_ARTIST)) {
        $thumbBase64 = "USE_CACHE"
      } else {
        $thumbStream = Await $mediaProps.Thumbnail.OpenReadAsync
        $netStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($thumbStream)
        $memStream = New-Object System.IO.MemoryStream
        $netStream.CopyTo($memStream)
        $thumbBase64 = [System.Convert]::ToBase64String($memStream.ToArray())
        $memStream.Dispose()
        $netStream.Dispose()
      }
    }
  } catch {}

  $isPlaying = $false
  $shuffleActive = $false
  $repeatMode = 0
  $canPlay = $true; $canPause = $true; $canNext = $false; $canPrev = $false
  $canShuffle = $false; $canRepeat = $false; $canSeek = $false

  if ($playbackInfo) {
    $status = $playbackInfo.PlaybackStatus
    $isPlaying = ($status -eq [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing)

    $controls = $playbackInfo.Controls
    if ($controls) {
      $canPlay = $controls.IsPlayEnabled
      $canPause = $controls.IsPauseEnabled
      $canNext = $controls.IsNextEnabled
      $canPrev = $controls.IsPreviousEnabled
      $canShuffle = $controls.IsShuffleEnabled
      $canRepeat = $controls.IsRepeatEnabled
      $canSeek = $controls.IsPlaybackPositionEnabled
    }

    $shuffleActive = if ($playbackInfo.IsShuffleActive) { $playbackInfo.IsShuffleActive } else { $false }
    $rm = $playbackInfo.AutoRepeatMode
    if ($rm -eq [Windows.Media.MediaPlaybackAutoRepeatMode]::Track) { $repeatMode = 2 }
    elseif ($rm -eq [Windows.Media.MediaPlaybackAutoRepeatMode]::List) { $repeatMode = 1 }
    else { $repeatMode = 0 }
  }

  $position = 0; $duration = 0
  if ($timelineProps) {
    $position = $timelineProps.Position.TotalSeconds
    $duration = $timelineProps.EndTime.TotalSeconds
  }

  $result = @{
    status = "ok"
    title = $title
    artist = $artist
    album = $album
    thumbnail = $thumbBase64
    isPlaying = $isPlaying
    position = [math]::Round($position, 2)
    duration = [math]::Round($duration, 2)
    shuffleActive = $shuffleActive
    repeatMode = $repeatMode
    capabilities = @{
      canPlay = $canPlay
      canPause = $canPause
      canNext = $canNext
      canPrev = $canPrev
      canShuffle = $canShuffle
      canRepeat = $canRepeat
      canSeek = $canSeek
    }
  } | ConvertTo-Json -Compress

  Write-Output $result
} catch {
  Write-Output ('{"status":"error","message":"' + ($_.Exception.Message -replace '"', "'") + '"}')
}
`;

const PS_COMMAND_SCRIPT = (command) => `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Media.MediaPlaybackAutoRepeatMode, Windows.Media, ContentType = WindowsRuntime]
$asyncOp = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()

function Await($WinRtTask) {
  [System.WindowsRuntimeSystemExtensions]::GetAwaiter($WinRtTask).GetResult()
}

$sessionMgr = Await $asyncOp
$session = $sessionMgr.GetCurrentSession()
if ($session) { ${command} }
`;

class MediaSessionManager {
  constructor() {
    this._interval = null;
    this._callback = null;
    this._lastData = null;
  }

  start(callback) {
    this._callback = callback;
    this._poll();
    this._interval = setInterval(() => this._poll(), 500);
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  triggerPoll() {
    this._poll();
  }

  _poll() {
    const lastTitle = this._lastData ? this._lastData.title : '';
    const lastArtist = this._lastData ? this._lastData.artist : '';

    if (this._usePython === undefined) {
      this._usePython = true;
    }

    if (this._usePython) {
      const pyArgs = [path.join(__dirname, 'media-session.py')];
      execFile('python', pyArgs, {
        timeout: 4000,
        env: {
          ...process.env,
          LAST_TITLE: lastTitle,
          LAST_ARTIST: lastArtist
        }
      }, (err, stdout) => {
        if (err) {
          console.warn('[MediaSession] Python poll failed/not installed. Falling back to PowerShell...');
          this._usePython = false;
          this._poll();
          return;
        }
        try {
          const data = JSON.parse(stdout.trim());
          if (data.status === 'error') {
            console.warn('[MediaSession] Python WinRT error:', data.message);
            this._usePython = false;
            this._poll();
            return;
          }
          if (data.thumbnail === 'USE_CACHE' && this._lastData) {
            data.thumbnail = this._lastData.thumbnail;
          }
          this._callback?.(data);
          this._lastData = data;
        } catch (e) {
          this._usePython = false;
          this._poll();
        }
      });
      return;
    }

    const psArgs = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', PS_MEDIA_SCRIPT
    ];

    execFile('powershell.exe', psArgs, {
      timeout: 5000,
      windowsHide: true,
      env: {
        ...process.env,
        LAST_TITLE: lastTitle,
        LAST_ARTIST: lastArtist
      }
    }, (err, stdout) => {
      if (err) {
        this._callback?.({ status: 'error', message: err.message });
        return;
      }
      try {
        const data = JSON.parse(stdout.trim());
        if (data.thumbnail === 'USE_CACHE' && this._lastData) {
          data.thumbnail = this._lastData.thumbnail;
        }
        this._callback?.(data);
        this._lastData = data;
      } catch (e) {
        // Silently ignore parse errors — occasional PS output noise
      }
    });
  }

  sendCommand(command, value) {
    let psCmd = '';
    switch (command) {
      case 'play':
        psCmd = 'Await ($session.TryPlayAsync()) ([System.Boolean]) | Out-Null';
        break;
      case 'pause':
        psCmd = 'Await ($session.TryPauseAsync()) ([System.Boolean]) | Out-Null';
        break;
      case 'togglePlayPause':
        psCmd = 'Await ($session.TryTogglePlayPauseAsync()) ([System.Boolean]) | Out-Null';
        break;
      case 'next':
        psCmd = 'Await ($session.TrySkipNextAsync()) ([System.Boolean]) | Out-Null';
        break;
      case 'previous':
        psCmd = 'Await ($session.TrySkipPreviousAsync()) ([System.Boolean]) | Out-Null';
        break;
      case 'shuffle':
        psCmd = `
          $pi = $session.GetPlaybackInfo()
          $current = $pi.IsShuffleActive
          Await ($session.TryChangeShuffleActiveAsync(-not $current)) ([System.Boolean]) | Out-Null
        `;
        break;
      case 'repeat':
        psCmd = `
          $pi = $session.GetPlaybackInfo()
          $rm = $pi.AutoRepeatMode
          if ($rm -eq [Windows.Media.MediaPlaybackAutoRepeatMode]::None) {
            Await ($session.TryChangeAutoRepeatModeAsync([Windows.Media.MediaPlaybackAutoRepeatMode]::List)) ([System.Boolean]) | Out-Null
          } elseif ($rm -eq [Windows.Media.MediaPlaybackAutoRepeatMode]::List) {
            Await ($session.TryChangeAutoRepeatModeAsync([Windows.Media.MediaPlaybackAutoRepeatMode]::Track)) ([System.Boolean]) | Out-Null
          } else {
            Await ($session.TryChangeAutoRepeatModeAsync([Windows.Media.MediaPlaybackAutoRepeatMode]::None)) ([System.Boolean]) | Out-Null
          }
        `;
        break;
      case 'seek':
        psCmd = `
          $tp = $session.GetTimelineProperties()
          $pos = [TimeSpan]::FromSeconds(${value})
          Await ($session.TryChangePlaybackPositionAsync($pos.Ticks)) ([System.Boolean]) | Out-Null
        `;
        break;
      default:
        return;
    }

    const fullScript = PS_COMMAND_SCRIPT(psCmd);
    const psArgs = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', fullScript
    ];

    execFile('powershell.exe', psArgs, { timeout: 5000, windowsHide: true }, (err) => {
      if (err) console.error(`Media command '${command}' failed:`, err.message);
    });
  }

  setVolume(vol) {
    // Use nircmd or PowerShell audio cmdlet for system volume
    const percent = Math.round(vol * 100);
    const cmd = `
      $wshShell = New-Object -ComObject WScript.Shell
      # Set system volume via SendKeys approach
      # Use audio endpoint volume COM
      Add-Type -TypeDefinition @"
      using System;
      using System.Runtime.InteropServices;
      [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
      interface IAudioEndpointVolume {
        int f1(); int f2(); int f3(); int f4(); int f5(); int f6(); int f7(); int f8(); int f9(); int f10(); int f11(); int f12();
        int SetMasterVolumeLevelScalar(float fLevel, System.Guid pguidEventContext);
        int GetMasterVolumeLevelScalar(out float pfLevel);
      }
      [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
      interface IMMDevice { int Activate(ref System.Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
      [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
      interface IMMDeviceEnumerator { int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
      [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
      public class AudioManager {
        public static void SetVolume(float level) {
          var enumerator = new MMDeviceEnumerator() as IMMDeviceEnumerator;
          IMMDevice dev;
          enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
          var aevGuid = typeof(IAudioEndpointVolume).GUID;
          IAudioEndpointVolume aev;
          dev.Activate(ref aevGuid, 1, 0, out aev);
          aev.SetMasterVolumeLevelScalar(level, System.Guid.Empty);
        }
        public static float GetVolume() {
          var enumerator = new MMDeviceEnumerator() as IMMDeviceEnumerator;
          IMMDevice dev;
          enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
          var aevGuid = typeof(IAudioEndpointVolume).GUID;
          IAudioEndpointVolume aev;
          dev.Activate(ref aevGuid, 1, 0, out aev);
          float level;
          aev.GetMasterVolumeLevelScalar(out level);
          return level;
        }
      }
"@
      [AudioManager]::SetVolume(${vol})
    `;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { timeout: 5000, windowsHide: true }, () => {});
  }

  getVolume() {
    return new Promise((resolve) => {
      const cmd = `
        Add-Type -TypeDefinition @"
        using System;
        using System.Runtime.InteropServices;
        [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAudioEndpointVolume {
          int f1(); int f2(); int f3(); int f4(); int f5(); int f6(); int f7(); int f8(); int f9(); int f10(); int f11(); int f12();
          int SetMasterVolumeLevelScalar(float fLevel, System.Guid pguidEventContext);
          int GetMasterVolumeLevelScalar(out float pfLevel);
        }
        [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDevice { int Activate(ref System.Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
        [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDeviceEnumerator { int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
        [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
        public class AudioManager {
          public static float GetVolume() {
            var enumerator = new MMDeviceEnumerator() as IMMDeviceEnumerator;
            IMMDevice dev;
            enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
            var aevGuid = typeof(IAudioEndpointVolume).GUID;
            IAudioEndpointVolume aev;
            dev.Activate(ref aevGuid, 1, 0, out aev);
            float level;
            aev.GetMasterVolumeLevelScalar(out level);
            return level;
          }
        }
"@
        Write-Output ([AudioManager]::GetVolume())
      `;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
        { timeout: 5000, windowsHide: true }, (err, stdout) => {
          if (err) return resolve(0.5);
          const val = parseFloat(stdout.trim());
          resolve(isNaN(val) ? 0.5 : val);
        });
    });
  }
}

module.exports = { MediaSessionManager };
