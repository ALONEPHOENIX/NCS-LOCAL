/**
 * WASAPI Loopback Audio Capture for Windows
 * 
 * Approach: Compile a small C# .exe on first run that handles WASAPI loopback
 * via proper COM interop, then spawn it as a child process that streams PCM data.
 */
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CAPTURE_EXE_DIR = path.join(os.tmpdir(), 'ncs-visualizer');
const CAPTURE_EXE = path.join(CAPTURE_EXE_DIR, 'AudioCapture.exe');
const CAPTURE_CS = path.join(CAPTURE_EXE_DIR, 'AudioCapture.cs');

const CS_SOURCE = `
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

class Program {
    // COM GUIDs
    static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");

    const int AUDCLNT_SHAREMODE_SHARED = 0;
    const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;

    [DllImport("ole32.dll")]
    static extern int CoInitializeEx(IntPtr pvReserved, uint dwCoInit);

    [DllImport("ole32.dll")]
    static extern int CoCreateInstance(
        ref Guid rclsid, IntPtr pUnkOuter, uint dwClsContext,
        ref Guid riid, out IntPtr ppv);

    // MMDeviceEnumerator
    static Guid CLSID_MMDeviceEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
    static Guid IID_IMMDeviceEnumerator = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEFORMATEX {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEFORMATEXTENSIBLE {
        public WAVEFORMATEX Format;
        public ushort wValidBitsPerSample;
        public uint dwChannelMask;
        public Guid SubFormat;
    }

    static Guid KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = new Guid("00000003-0000-0010-8000-00aa00389b71");

    static void Main() {
        CoInitializeEx(IntPtr.Zero, 0); // COINIT_MULTITHREADED

        // Create MMDeviceEnumerator
        IntPtr pEnumerator;
        Guid iidEnum = IID_IMMDeviceEnumerator;
        int hr = CoCreateInstance(ref CLSID_MMDeviceEnumerator, IntPtr.Zero, 1 | 2 | 4,
            ref iidEnum, out pEnumerator);
        if (hr < 0) { Console.Error.WriteLine("Failed CoCreateInstance: 0x" + hr.ToString("X")); return; }

        // Get default render endpoint (for loopback)
        IntPtr pDevice;
        hr = GetDefaultAudioEndpoint(pEnumerator, 0 /* eRender */, 1 /* eMultimedia */, out pDevice);
        if (hr < 0) { Console.Error.WriteLine("Failed GetDefaultAudioEndpoint: 0x" + hr.ToString("X")); return; }

        // Activate IAudioClient
        IntPtr pAudioClient;
        Guid iidClient = IID_IAudioClient;
        hr = ActivateDevice(pDevice, ref iidClient, 1 | 2 | 4, IntPtr.Zero, out pAudioClient);
        if (hr < 0) { Console.Error.WriteLine("Failed Activate: 0x" + hr.ToString("X")); return; }

        // Get mix format
        IntPtr pFormat;
        hr = GetMixFormat(pAudioClient, out pFormat);
        if (hr < 0) { Console.Error.WriteLine("Failed GetMixFormat: 0x" + hr.ToString("X")); return; }

        var fmt = Marshal.PtrToStructure<WAVEFORMATEX>(pFormat);
        int sampleRate = (int)fmt.nSamplesPerSec;
        int channels = fmt.nChannels;
        int bitsPerSample = fmt.wBitsPerSample;
        int bytesPerFrame = channels * (bitsPerSample / 8);
        bool isFloat = false;

        if (fmt.wFormatTag == 0xFFFE && fmt.cbSize >= 22) {
            var ext = Marshal.PtrToStructure<WAVEFORMATEXTENSIBLE>(pFormat);
            isFloat = (ext.SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
        } else if (fmt.wFormatTag == 3) {
            isFloat = true;
        }

        Console.Out.WriteLine("FORMAT:" + sampleRate + ":" + channels + ":" + bitsPerSample + ":" + (isFloat ? "float" : "pcm"));
        Console.Out.Flush();

        // Initialize loopback
        long duration = 200000; // 20ms in 100ns units
        hr = InitializeClient(pAudioClient, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
            duration, 0, pFormat, IntPtr.Zero);
        if (hr < 0) { Console.Error.WriteLine("Failed Initialize: 0x" + hr.ToString("X")); return; }

        // Get buffer size
        int bufferFrameCount;
        hr = GetBufferSize(pAudioClient, out bufferFrameCount);

        // Get capture client
        IntPtr pCaptureClient;
        Guid iidCapture = IID_IAudioCaptureClient;
        hr = GetService(pAudioClient, ref iidCapture, out pCaptureClient);
        if (hr < 0) { Console.Error.WriteLine("Failed GetService: 0x" + hr.ToString("X")); return; }

        // Start capture
        hr = StartClient(pAudioClient);
        if (hr < 0) { Console.Error.WriteLine("Failed Start: 0x" + hr.ToString("X")); return; }

        int fftSize = 2048;
        float[] accum = new float[fftSize];
        int accumPos = 0;

        Console.Error.WriteLine("Capture started: " + sampleRate + "Hz " + channels + "ch " + bitsPerSample + "bit " + (isFloat ? "float" : "pcm"));

        while (true) {
            Thread.Sleep(15);

            int packetLength;
            GetNextPacketSize(pCaptureClient, out packetLength);

            while (packetLength > 0) {
                IntPtr dataPtr;
                int numFrames, flags;
                long devPos, qpcPos;
                GetBuffer(pCaptureClient, out dataPtr, out numFrames, out flags, out devPos, out qpcPos);

                if (numFrames > 0) {
                    bool isSilent = (flags & 2) != 0;
                    if (!isSilent) {
                        int totalBytes = numFrames * bytesPerFrame;
                        byte[] sampleBytes = new byte[totalBytes];
                        Marshal.Copy(dataPtr, sampleBytes, 0, totalBytes);

                        for (int i = 0; i < numFrames && accumPos < fftSize; i++) {
                            float sample = 0;
                            if (isFloat) {
                                for (int ch = 0; ch < channels; ch++) {
                                    int offset = i * bytesPerFrame + ch * 4;
                                    if (offset + 4 <= totalBytes)
                                        sample += BitConverter.ToSingle(sampleBytes, offset);
                                }
                                sample /= channels;
                            } else {
                                for (int ch = 0; ch < channels; ch++) {
                                    int offset = i * bytesPerFrame + ch * 2;
                                    if (offset + 2 <= totalBytes)
                                        sample += BitConverter.ToInt16(sampleBytes, offset) / 32768.0f;
                                }
                                sample /= channels;
                            }
                            accum[accumPos++] = sample;
                        }
                    } else {
                        // Silent — fill with zeros
                        for (int i = 0; i < numFrames && accumPos < fftSize; i++)
                            accum[accumPos++] = 0;
                    }
                }

                ReleaseBuffer(pCaptureClient, numFrames);

                if (accumPos >= fftSize) {
                    byte[] output = new byte[fftSize * 4];
                    Buffer.BlockCopy(accum, 0, output, 0, fftSize * 4);
                    Console.Out.WriteLine("PCM:" + Convert.ToBase64String(output));
                    Console.Out.Flush();
                    accumPos = 0;
                }

                GetNextPacketSize(pCaptureClient, out packetLength);
            }
        }
    }

    // ── COM vtable method calls via Marshal ──

    static int GetDefaultAudioEndpoint(IntPtr pEnum, int dataFlow, int role, out IntPtr ppDevice) {
        // IMMDeviceEnumerator::GetDefaultAudioEndpoint is vtable index 4 (after IUnknown's 3)
        IntPtr vtable = Marshal.ReadIntPtr(pEnum);
        IntPtr fnPtr = Marshal.ReadIntPtr(vtable, 4 * IntPtr.Size);
        var fn = Marshal.GetDelegateForFunctionPointer<GetDefaultAudioEndpointDelegate>(fnPtr);
        return fn(pEnum, dataFlow, role, out ppDevice);
    }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int GetDefaultAudioEndpointDelegate(IntPtr self, int dataFlow, int role, out IntPtr ppDevice);

    static int ActivateDevice(IntPtr pDevice, ref Guid iid, uint clsCtx, IntPtr pActivationParams, out IntPtr ppInterface) {
        IntPtr vtable = Marshal.ReadIntPtr(pDevice);
        IntPtr fnPtr = Marshal.ReadIntPtr(vtable, 3 * IntPtr.Size); // IMMDevice::Activate is index 3
        var fn = Marshal.GetDelegateForFunctionPointer<ActivateDelegate>(fnPtr);
        return fn(pDevice, ref iid, clsCtx, pActivationParams, out ppInterface);
    }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int ActivateDelegate(IntPtr self, ref Guid iid, uint clsCtx, IntPtr activationParams, out IntPtr ppInterface);

    static int GetMixFormat(IntPtr pClient, out IntPtr ppFormat) {
        IntPtr vtable = Marshal.ReadIntPtr(pClient);
        IntPtr fnPtr = Marshal.ReadIntPtr(vtable, 8 * IntPtr.Size); // IAudioClient::GetMixFormat index 8
        var fn = Marshal.GetDelegateForFunctionPointer<GetMixFormatDelegate>(fnPtr);
        return fn(pClient, out ppFormat);
    }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int GetMixFormatDelegate(IntPtr self, out IntPtr ppFormat);

    static int InitializeClient(IntPtr pClient, int shareMode, int flags, long duration, long period, IntPtr pFormat, IntPtr guid) {
        IntPtr vtable = Marshal.ReadIntPtr(pClient);
        IntPtr fnPtr = Marshal.ReadIntPtr(vtable, 3 * IntPtr.Size); // IAudioClient::Initialize index 3
        var fn = Marshal.GetDelegateForFunctionPointer<InitializeDelegate>(fnPtr);
        return fn(pClient, shareMode, flags, duration, period, pFormat, guid);
    }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int InitializeDelegate(IntPtr self, int shareMode, int flags, long duration, long period, IntPtr pFormat, IntPtr guid);

    static int GetBufferSize(IntPtr pClient, out int pSize) {
        IntPtr vtable = Marshal.ReadIntPtr(pClient);
        IntPtr fnPtr = Marshal.ReadIntPtr(vtable, 4 * IntPtr.Size); // IAudioClient::GetBufferSize index 4
        var fn = Marshal.GetDelegateForFunctionPointer<GetBufferSizeDelegate>(fnPtr);
        return fn(pClient, out pSize);
    }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int GetBufferSizeDelegate(IntPtr self, out int pSize);

    static int GetService(IntPtr pClient, ref Guid iid, out IntPtr ppService) {
        IntPtr vtable = Marshal.ReadIntPtr(pClient);
        IntPtr fnPtr = Marshal.ReadIntPtr(vtable, 14 * IntPtr.Size); // IAudioClient::GetService index 14
        var fn = Marshal.GetDelegateForFunctionPointer<GetServiceDelegate>(fnPtr);
        return fn(pClient, ref iid, out ppService);
    }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int GetServiceDelegate(IntPtr self, ref Guid iid, out IntPtr ppService);

    static int StartClient(IntPtr pClient) {
        IntPtr vtable = Marshal.ReadIntPtr(pClient);
        IntPtr fnPtr = Marshal.ReadIntPtr(vtable, 10 * IntPtr.Size); // IAudioClient::Start index 10
        var fn = Marshal.GetDelegateForFunctionPointer<SimpleDelegate>(fnPtr);
        return fn(pClient);
    }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int SimpleDelegate(IntPtr self);

    static int GetNextPacketSize(IntPtr pCapture, out int pSize) {
        IntPtr vtable = Marshal.ReadIntPtr(pCapture);
        IntPtr fnPtr = Marshal.ReadIntPtr(vtable, 5 * IntPtr.Size); // IAudioCaptureClient::GetNextPacketSize index 5
        var fn = Marshal.GetDelegateForFunctionPointer<GetBufferSizeDelegate>(fnPtr);
        return fn(pCapture, out pSize);
    }

    static int GetBuffer(IntPtr pCapture, out IntPtr ppData, out int pFrames, out int pFlags, out long pDevPos, out long pQpcPos) {
        IntPtr vtable = Marshal.ReadIntPtr(pCapture);
        IntPtr fnPtr = Marshal.ReadIntPtr(vtable, 3 * IntPtr.Size); // IAudioCaptureClient::GetBuffer index 3
        var fn = Marshal.GetDelegateForFunctionPointer<GetBufferDelegate>(fnPtr);
        return fn(pCapture, out ppData, out pFrames, out pFlags, out pDevPos, out pQpcPos);
    }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int GetBufferDelegate(IntPtr self, out IntPtr ppData, out int pFrames, out int pFlags, out long pDevPos, out long pQpcPos);

    static int ReleaseBuffer(IntPtr pCapture, int numFrames) {
        IntPtr vtable = Marshal.ReadIntPtr(pCapture);
        IntPtr fnPtr = Marshal.ReadIntPtr(vtable, 4 * IntPtr.Size); // IAudioCaptureClient::ReleaseBuffer index 4
        var fn = Marshal.GetDelegateForFunctionPointer<ReleaseBufferDelegate>(fnPtr);
        return fn(pCapture, numFrames);
    }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int ReleaseBufferDelegate(IntPtr self, int numFrames);
}
`;

class AudioCapture {
  constructor() {
    this._process = null;
    this._callback = null;
    this._sampleRate = 48000;
    this._channels = 2;
    this._fftSize = 2048;
    this._retryCount = 0;
    this._maxRetries = 5;
  }

  async start(callback) {
    this._callback = callback;
    this._retryCount = 0;

    // Compile capture exe if needed
    await this._ensureExe();
    this._startProcess();
  }

  stop() {
    const cb = this._callback;
    this._callback = null;
    if (this._process) {
      try { this._process.kill(); } catch (e) {}
      this._process = null;
    }
  }

  async _ensureExe() {
    if (!fs.existsSync(CAPTURE_EXE_DIR)) {
      fs.mkdirSync(CAPTURE_EXE_DIR, { recursive: true });
    }

    // Always rewrite source (in case we updated it)
    let needsCompile = !fs.existsSync(CAPTURE_EXE);
    if (fs.existsSync(CAPTURE_CS)) {
      const currentSource = fs.readFileSync(CAPTURE_CS, 'utf8');
      if (currentSource !== CS_SOURCE) {
        needsCompile = true;
      }
    } else {
      needsCompile = true;
    }

    fs.writeFileSync(CAPTURE_CS, CS_SOURCE);

    if (!needsCompile && fs.existsSync(CAPTURE_EXE)) {
      return;
    }

    // Compile with csc
    return new Promise((resolve, reject) => {
      // Find csc.exe
      const frameworkDir = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
      const csc = path.join(frameworkDir, 'csc.exe');

      if (!fs.existsSync(csc)) {
        console.error('[AudioCapture] csc.exe not found at', csc);
        // Try Framework (32-bit)
        const csc32 = 'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe';
        if (!fs.existsSync(csc32)) {
          reject(new Error('C# compiler not found'));
          return;
        }
        execFile(csc32, ['/out:' + CAPTURE_EXE, '/optimize+', '/platform:x64', CAPTURE_CS],
          { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
            if (err) { console.error('[AudioCapture] Compile error:', stderr); reject(err); }
            else { console.log('[AudioCapture] Compiled successfully (32-bit csc)'); resolve(); }
          });
        return;
      }

      execFile(csc, ['/out:' + CAPTURE_EXE, '/optimize+', '/platform:x64', CAPTURE_CS],
        { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
          if (err) { console.error('[AudioCapture] Compile error:', stderr); reject(err); }
          else { console.log('[AudioCapture] Compiled successfully'); resolve(); }
        });
    });
  }

  _startProcess() {
    if (!this._callback) return;

    if (!fs.existsSync(CAPTURE_EXE)) {
      console.error('[AudioCapture] Capture exe not found, cannot start');
      return;
    }

    this._process = spawn(CAPTURE_EXE, [], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let lineBuffer = '';

    this._process.stdout.on('data', (chunk) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('FORMAT:')) {
          const parts = trimmed.split(':');
          this._sampleRate = parseInt(parts[1]) || 48000;
          this._channels = parseInt(parts[2]) || 2;
          console.log(`[AudioCapture] Format: ${this._sampleRate}Hz, ${this._channels}ch`);
        } else if (trimmed.startsWith('PCM:')) {
          try {
            const b64 = trimmed.substring(4);
            const buffer = Buffer.from(b64, 'base64');
            const floats = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
            const fftResult = this._performFFT(floats);
            this._callback?.(fftResult);
          } catch (e) {
            console.error('[AudioCapture] PCM Parse Error:', e);
          }
        }
      }
    });

    this._process.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.log('[AudioCapture]', msg);
    });

    this._process.on('exit', (code) => {
      console.log(`[AudioCapture] Process exited with code ${code}`);
      if (this._callback && this._retryCount < this._maxRetries) {
        this._retryCount++;
        const delay = Math.min(2000 * this._retryCount, 10000);
        console.log(`[AudioCapture] Retrying in ${delay}ms (attempt ${this._retryCount}/${this._maxRetries})`);
        setTimeout(() => {
          if (this._callback) this._startProcess();
        }, delay);
      }
    });
  }

  /**
   * Perform FFT using Goertzel algorithm for log-spaced frequency bins.
   */
  _performFFT(samples) {
    const N = samples.length;
    const halfN = N / 2;

    // Apply Hann window
    const windowed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      windowed[i] = samples[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
    }

    const numBins = 128;
    const magnitudes = new Float32Array(numBins);
    const freqPerBin = this._sampleRate / N;

    for (let i = 0; i < numBins; i++) {
      const freq = 20 * Math.pow(1000, i / (numBins - 1));
      const binIndex = Math.round(freq / freqPerBin);

      if (binIndex >= 0 && binIndex < halfN) {
        const k = binIndex;
        const w = 2 * Math.PI * k / N;
        const coeff = 2 * Math.cos(w);
        let s0 = 0, s1 = 0, s2 = 0;

        for (let n = 0; n < N; n++) {
          s0 = windowed[n] + coeff * s1 - s2;
          s2 = s1;
          s1 = s0;
        }

        const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
        magnitudes[i] = Math.sqrt(Math.abs(power)) / N;
      }
    }

    // Compute band energies
    const bassEnd = Math.round(250 / (20000 / numBins));
    const midEnd = Math.round(4000 / (20000 / numBins));

    let bass = 0, mid = 0, high = 0, overall = 0;
    let bassCount = 0, midCount = 0, highCount = 0;

    for (let i = 0; i < numBins; i++) {
      const mag = magnitudes[i];
      overall += mag;

      if (i <= bassEnd) { bass += mag; bassCount++; }
      else if (i <= midEnd) { mid += mag; midCount++; }
      else { high += mag; highCount++; }
    }

    bass = bassCount > 0 ? bass / bassCount : 0;
    mid = midCount > 0 ? mid / midCount : 0;
    high = highCount > 0 ? high / highCount : 0;

    // RMS
    let rms = 0;
    for (let i = 0; i < N; i++) rms += samples[i] * samples[i];
    rms = Math.sqrt(rms / N);

    return {
      bass: Math.min(bass * 20, 1),
      mid: Math.min(mid * 30, 1),
      high: Math.min(high * 40, 1),
      rms: Math.min(rms * 3, 1),
      magnitudes: Array.from(magnitudes),
      timestamp: Date.now()
    };
  }
}

module.exports = { AudioCapture };
