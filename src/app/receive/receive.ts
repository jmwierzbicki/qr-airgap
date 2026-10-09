import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  signal,
  viewChild,
} from '@angular/core';
import { AudioFeedbackPlayer, FEEDBACK_PROTOCOLS, type FeedbackProtocol } from '../audio/ggwave';
import { crc32, formatBytes, utf8Decode } from '../core/bytes';
import {
  analyzeColorTest,
  buildTestCard,
  parseColorTestModules,
  type ColorTestResult,
  type Corners,
} from '../core/colortest';
import { unpackContainer } from '../core/container';
import { FEEDBACK_INTERVAL_MS, FEEDBACK_MAX_MISSING, encodeFeedback, transferIdOf } from '../core/feedback';
import { FLAG_CALIBRATION, FLAG_COLOR, FLAG_TUNING, FRAME_VERSION, sameTransfer, type FrameHeader } from '../core/frame';
import { LtDecoder } from '../core/lt';
import {
  CALIBRATION_PROFILES,
  CALIBRATION_TABLE_VERSION,
  calibrationCodes,
  decodeTuningId,
  encodeTuningId,
  nominalBytesPerSecond,
  profileKey,
  profileLabel,
  profileName,
  type Profile,
} from '../core/profile';
import { decodeWire, diagnoseWire, type ScanHit } from '../core/wire';
import { createQrScanner, type QrScanner, type ScanEngine } from '../scan/qr-scanner';

interface ScanStats {
  frames: number;
  codes: number;
  useful: number;
  duplicates: number;
  invalid: number;
}

interface ReceivedFile {
  name: string;
  mime: string;
  size: number;
  url: string;
  text: string | null;
}

/** Pomiar jednej kombinacji parametrów: unikatowe kody w ruchomym oknie. */
interface Measurement {
  key: string;
  profile: Profile;
  label: string;
  named: boolean;
  seeds: Map<number, number>;
  firstAt: number;
  lastAt: number;
  last: number;
  best: number;
  codesPerSecond: number;
  uniqueTotal: number;
  sweepSent: number;
}

export interface RankingRow {
  key: string;
  label: string;
  named: boolean;
  profile: Profile;
  nominal: number;
  best: number;
  last: number;
  live: boolean;
  sweepReceived: number;
  sweepSent: number;
}

export interface LiveRate {
  label: string;
  bytesPerSecond: number;
  codesPerSecond: number;
  nominal: number;
}

type ColorMode = 'auto' | 'on' | 'off';

const TEXT_EXTENSIONS = /\.(txt|md|lua|json|js|ts|py|csv|xml|html|css|yml|yaml|ini|cfg|log|sh|bat)$/i;
const RESOLUTIONS = [
  { width: 1280, height: 720, label: '720p (szybki dekoder)' },
  { width: 1920, height: 1080, label: '1080p (zalecane)' },
  { width: 3840, height: 2160, label: '4K (gęste kody, wolniej)' },
];
/** Co ile klatek bez odczytu próbować dekodowania kolorowego w trybie auto. */
const COLOR_PROBE_EVERY = 3;
/** Po ilu kolorowych klatkach bez odczytu wrócić do trybu czarno-białego. */
const COLOR_IDLE_FRAMES = 40;
/** Okno pomiaru prędkości na żywo. */
const MEASURE_WINDOW_MS = 3000;
/** Po jakim czasie bez kodów wiersz przestaje być "na żywo". */
const LIVE_TIMEOUT_MS = 1500;

@Component({
  selector: 'app-receive',
  imports: [DecimalPipe],
  templateUrl: './receive.html',
  styleUrl: './receive.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Receive implements OnInit, OnDestroy {
  readonly formatBytes = formatBytes;
  readonly resolutions = RESOLUTIONS;
  readonly channelNames = ['R', 'G', 'B'];
  readonly stripeWidths = [1, 2, 3, 4];

  readonly cameras = signal<MediaDeviceInfo[]>([]);
  readonly selectedCamera = signal('');
  readonly resolution = signal(1920);
  readonly running = signal(false);
  readonly starting = signal(false);
  readonly engine = signal<ScanEngine | ''>('');
  readonly preferredEngine = signal<ScanEngine | 'auto'>('auto');
  readonly colorMode = signal<ColorMode>('auto');
  readonly colorActive = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly stats = signal<ScanStats>({ frames: 0, codes: 0, useful: 0, duplicates: 0, invalid: 0 });
  readonly transfer = signal<FrameHeader | null>(null);
  readonly decoded = signal(0);
  readonly elapsed = signal(0);
  readonly result = signal<ReceivedFile | null>(null);
  readonly lastCodeAt = signal(0);

  // Ranking na żywo (strojenie i auto-przebieg).
  readonly ranking = signal<RankingRow[]>([]);
  readonly live = signal<LiveRate | null>(null);
  readonly lastMeasureAt = signal(0);

  readonly feedbackProtocols = FEEDBACK_PROTOCOLS;
  readonly feedbackEnabled = signal(false);
  readonly feedbackProtocol = signal<FeedbackProtocol>('audible-fast');
  readonly feedbackVolume = signal(50);
  readonly feedbackStatus = signal('');
  readonly feedbackSent = signal(0);
  readonly colorTesting = signal(false);
  readonly colorResult = signal<ColorTestResult | null>(null);
  readonly colorError = signal('');
  readonly colorSamples = signal(0);

  readonly progress = computed(() => {
    const t = this.transfer();
    return t ? (this.decoded() / t.blockCount) * 100 : 0;
  });
  readonly scanRate = computed(() => (this.elapsed() > 0 ? this.stats().frames / this.elapsed() : 0));
  readonly codeRate = computed(() => (this.elapsed() > 0 ? this.stats().codes / this.elapsed() : 0));
  readonly etaSeconds = computed(() => {
    const t = this.transfer();
    const rate = this.stats().useful / Math.max(this.elapsed(), 0.001);
    if (!t || !rate) return null;
    return Math.max(0, (t.blockCount - this.decoded()) / rate);
  });
  readonly best = computed(() => this.ranking()[0] ?? null);
  /** Pomiar trwał, ale od dłuższej chwili nic nie dociera: kolejne parametry są za gęste. */
  readonly measureStalledSeconds = computed(() => {
    this.elapsed();
    const last = this.lastMeasureAt();
    if (!last || !this.running()) return 0;
    const idle = (performance.now() - last) / 1000;
    return idle > 6 ? Math.round(idle) : 0;
  });

  private readonly videoRef = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly gridRef = viewChild<ElementRef<HTMLCanvasElement>>('grid');

  private scanner: QrScanner | null = null;
  private stream: MediaStream | null = null;
  private decoder: LtDecoder | null = null;
  private startedAt = 0;
  private clock: ReturnType<typeof setInterval> | null = null;
  private gridDirty = false;
  private loopToken = 0;
  private readonly measurements = new Map<string, Measurement>();
  private currentKey = '';
  private readonly colorCanvas = document.createElement('canvas');
  private readonly colorCard = buildTestCard();
  private frameCounter = 0;
  private colorIdle = 0;
  private unreadableStreak = 0;
  private player: AudioFeedbackPlayer | null = null;
  private feedbackTimer: ReturnType<typeof setInterval> | null = null;
  private codeTimes: number[] = [];
  private completeReports = 0;

  async ngOnInit(): Promise<void> {
    await this.refreshCameras();
  }

  ngOnDestroy(): void {
    this.stop();
    this.revokeResult();
    this.disableFeedback();
  }

  // --- kamera i ustawienia ---------------------------------------------------

  onCamera(event: Event): void {
    this.selectedCamera.set((event.target as HTMLSelectElement).value);
    if (this.running()) void this.start();
  }

  onEngine(event: Event): void {
    this.preferredEngine.set((event.target as HTMLSelectElement).value as ScanEngine | 'auto');
    if (this.running()) void this.start();
  }

  onResolution(event: Event): void {
    this.resolution.set(Number((event.target as HTMLSelectElement).value));
    if (this.running()) void this.start();
  }

  onColorMode(event: Event): void {
    const mode = (event.target as HTMLSelectElement).value as ColorMode;
    this.colorMode.set(mode);
    this.colorActive.set(mode === 'on');
    this.colorIdle = 0;
  }

  async start(): Promise<void> {
    this.stop();
    this.error.set('');
    this.starting.set(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Przeglądarka nie udostępnia kamery (wymagane HTTPS lub localhost).');
      }
      const res = RESOLUTIONS.find((r) => r.width === this.resolution()) ?? RESOLUTIONS[1];
      const deviceId = this.selectedCamera();
      const size = { width: { ideal: res.width }, height: { ideal: res.height } };
      const video: MediaTrackConstraints = deviceId
        ? { deviceId: { exact: deviceId }, ...size }
        : { facingMode: 'environment', ...size };
      this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      const el = this.videoRef()?.nativeElement;
      if (!el) throw new Error('Brak elementu wideo');
      el.srcObject = this.stream;
      await el.play();
      await this.refreshCameras();

      const prefer = this.preferredEngine();
      this.scanner = await createQrScanner(document.baseURI, {
        prefer: prefer === 'auto' ? undefined : prefer,
        maxWidth: res.width,
      });
      this.engine.set(this.scanner.engine);

      this.running.set(true);
      this.startClock();
      void this.loop(++this.loopToken, el);
    } catch (err) {
      this.error.set(this.describeError(err));
      this.stop();
    } finally {
      this.starting.set(false);
    }
  }

  stop(): void {
    this.loopToken++;
    this.running.set(false);
    this.scanner?.destroy();
    this.scanner = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    const el = this.videoRef()?.nativeElement;
    if (el) el.srcObject = null;
    if (this.clock) {
      clearInterval(this.clock);
      this.clock = null;
    }
  }

  reset(): void {
    this.decoder = null;
    this.transfer.set(null);
    this.decoded.set(0);
    this.revokeResult();
    this.stats.set({ frames: 0, codes: 0, useful: 0, duplicates: 0, invalid: 0 });
    this.startedAt = performance.now();
    this.elapsed.set(0);
    this.measurements.clear();
    this.currentKey = '';
    this.ranking.set([]);
    this.live.set(null);
    this.lastMeasureAt.set(0);
    this.notice.set('');
    this.error.set('');
    this.colorActive.set(this.colorMode() === 'on');
    this.colorIdle = 0;
    this.codeTimes = [];
    this.drawGrid();
  }

  async copyText(): Promise<void> {
    const text = this.result()?.text;
    if (text) await navigator.clipboard.writeText(text);
  }

  async copyName(name: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(name);
      this.notice.set(`Skopiowano "${name}". Wpisz tę nazwę w polu profilu na nadajniku.`);
    } catch {
      this.notice.set(`Nazwa profilu: ${name}`);
    }
  }

  // --- kanał zwrotny (dźwięk) ---------------------------------------------

  async toggleFeedback(): Promise<void> {
    if (this.feedbackEnabled()) {
      this.disableFeedback();
      return;
    }
    this.feedbackStatus.set('Ładuję ggwave…');
    try {
      this.player = await AudioFeedbackPlayer.create(document.baseURI);
      this.feedbackEnabled.set(true);
      this.feedbackStatus.set('Raporty będą grane co 2,5 s, gdy trwa odbiór lub strojenie.');
      this.feedbackTimer = setInterval(() => this.sendFeedback(), FEEDBACK_INTERVAL_MS);
    } catch (err) {
      this.feedbackStatus.set(`Nie udało się włączyć: ${this.describeError(err)}`);
    }
  }

  disableFeedback(): void {
    if (this.feedbackTimer) {
      clearInterval(this.feedbackTimer);
      this.feedbackTimer = null;
    }
    this.player?.destroy();
    this.player = null;
    this.feedbackEnabled.set(false);
  }

  onFeedbackProtocol(event: Event): void {
    this.feedbackProtocol.set((event.target as HTMLSelectElement).value as FeedbackProtocol);
  }

  onFeedbackVolume(event: Event): void {
    this.feedbackVolume.set(Number((event.target as HTMLInputElement).value));
  }

  /** Gra przykładowy raport, żeby sprawdzić głośność i czy nadajnik słyszy. */
  testFeedback(): void {
    if (!this.player) return;
    const bytes = encodeFeedback({ transferId: 0, decoded: 0, blockCount: 0, recentCodes: 0, complete: false, missing: [] });
    const seconds = this.player.play(bytes, this.feedbackProtocol(), this.feedbackVolume());
    this.feedbackStatus.set(`Test: ${bytes.length} B w ${seconds.toFixed(1)} s.`);
  }

  private sendFeedback(): void {
    if (!this.player || this.player.busy) return;
    const since = performance.now() - FEEDBACK_INTERVAL_MS;
    this.codeTimes = this.codeTimes.filter((ts) => ts >= since);

    const t = this.transfer();
    const decoder = this.decoder;
    if (!t || !decoder) {
      // Strojenie: raport z tempem dla bieżącej kombinacji parametrów.
      const m = this.measurements.get(this.currentKey);
      if (!m || performance.now() - m.lastAt > LIVE_TIMEOUT_MS) return;
      const bytes = encodeFeedback({
        transferId: encodeTuningId(m.profile) & 0xffff,
        decoded: 0,
        blockCount: 0,
        recentCodes: this.codeTimes.length,
        complete: false,
        missing: [],
      });
      this.player.play(bytes, this.feedbackProtocol(), this.feedbackVolume());
      this.feedbackSent.update((n) => n + 1);
      this.feedbackStatus.set(`Raport strojenia #${this.feedbackSent()}: ${this.codeTimes.length} kodów w oknie.`);
      return;
    }
    if (decoder.isComplete) {
      if (this.completeReports >= 4) return;
      this.completeReports++;
    }
    const missing: number[] = [];
    const remaining = decoder.blockCount - decoder.decodedCount;
    if (remaining > 0 && remaining <= FEEDBACK_MAX_MISSING) {
      for (let i = 0; i < decoder.blockCount && missing.length < FEEDBACK_MAX_MISSING; i++) {
        if (!decoder.blocks[i]) missing.push(i);
      }
    }
    const bytes = encodeFeedback({
      transferId: transferIdOf(t.fileId),
      decoded: decoder.decodedCount,
      blockCount: decoder.blockCount,
      recentCodes: this.codeTimes.length,
      complete: decoder.isComplete,
      missing,
    });
    const seconds = this.player.play(bytes, this.feedbackProtocol(), this.feedbackVolume());
    this.feedbackSent.update((n) => n + 1);
    this.feedbackStatus.set(
      `Raport #${this.feedbackSent()}: ${decoder.decodedCount}/${decoder.blockCount}, ${this.codeTimes.length} kodów w oknie, ${bytes.length} B w ${seconds.toFixed(1)} s.`,
    );
  }

  // --- pomiar koloru ----------------------------------------------------------

  toggleColorTest(): void {
    this.colorTesting.update((v) => !v);
    this.colorResult.set(null);
    this.colorError.set('');
    this.colorSamples.set(0);
  }

  stripeContrast(result: ColorTestResult, kind: 'luma' | 'chroma', width: number): number {
    return result.stripes.find((s) => s.kind === kind && s.width === width)?.contrast ?? 0;
  }

  rgbCss(c: { r: number; g: number; b: number }): string {
    return `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;
  }

  async copyColorResult(): Promise<void> {
    const r = this.colorResult();
    if (!r) return;
    const payload = {
      engine: this.engine(),
      resolution: this.resolution(),
      userAgent: navigator.userAgent,
      verdict: r.verdict,
      margins: r.margins,
      crosstalk: r.crosstalk.map((row) => row.map((v) => Number(v.toFixed(3)))),
      stripes: r.stripes.map((s) => ({ ...s, contrast: Number(s.contrast.toFixed(3)) })),
      patches: r.patches.map((p) => ({
        key: p.key,
        measured: { r: Math.round(p.measured.r), g: Math.round(p.measured.g), b: Math.round(p.measured.b) },
      })),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      this.notice.set('Wynik pomiaru skopiowany jako JSON.');
    } catch {
      this.notice.set('Nie udało się skopiować do schowka.');
    }
  }

  // --- pętla skanowania -------------------------------------------------------

  private async loop(token: number, video: HTMLVideoElement): Promise<void> {
    while (token === this.loopToken && this.scanner) {
      if (this.colorTesting()) {
        await this.measureColor(video, this.scanner);
        if (token !== this.loopToken) return;
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      const hits = await this.scanFrame(video, this.scanner);
      if (token !== this.loopToken) return;
      this.stats.update((s) => ({ ...s, frames: s.frames + 1 }));
      for (const hit of hits) this.handleHit(hit);
      // setTimeout zamiast requestAnimationFrame: rAF zamiera w karcie w tle i przy ukrytym oknie.
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  /**
   * Jedna klatka: czarno-biało albo w kanałach RGB. W trybie auto przełącza się na
   * kanały, gdy odczytana ramka ma flagę koloru (dekoder czarno-biały widzi z
   * kompozytu tylko kanał G, bo zieleń dominuje w luminancji), a wraca, gdy
   * kanały przez dłuższy czas nic nie dają albo trafi się ramka bez tej flagi.
   */
  private async scanFrame(video: HTMLVideoElement, scanner: QrScanner): Promise<ScanHit[]> {
    this.frameCounter++;
    const mode = this.colorMode();
    try {
      if (mode === 'on' || (mode === 'auto' && this.colorActive())) {
        const hits = await scanner.scanColor(video);
        if (mode === 'auto') {
          const frames = hits.map((h) => decodeWire(h)).filter((f) => f !== null);
          this.colorIdle = frames.length ? 0 : this.colorIdle + 1;
          if (this.colorIdle > COLOR_IDLE_FRAMES || frames.some((f) => !(f.header.flags & FLAG_COLOR))) {
            this.colorActive.set(false);
            this.colorIdle = 0;
          }
        }
        return hits;
      }
      const hits = await scanner.scan(video);
      if (mode === 'auto') {
        const colorFlagged = hits.some((h) => {
          const f = decodeWire(h);
          return f !== null && (f.header.flags & FLAG_COLOR) !== 0;
        });
        if (colorFlagged) {
          this.colorActive.set(true);
          this.colorIdle = 0;
          this.notice.set('Wykryto transmisję kolorową (3 kanały RGB).');
          return scanner.scanColor(video);
        }
        if (hits.length === 0 && this.frameCounter % COLOR_PROBE_EVERY === 0) {
          const colorHits = await scanner.scanColor(video);
          if (colorHits.some((h) => decodeWire(h) !== null)) {
            this.colorActive.set(true);
            this.colorIdle = 0;
            this.notice.set('Wykryto transmisję kolorową (3 kanały RGB).');
            return colorHits;
          }
        }
      }
      return hits;
    } catch (err) {
      this.error.set(this.describeError(err));
      return [];
    }
  }

  private handleHit(hit: ScanHit): void {
    const frame = decodeWire(hit);
    if (!frame) {
      this.stats.update((s) => ({ ...s, invalid: s.invalid + 1 }));
      const problem = diagnoseWire(hit);
      if (problem === 'version') {
        this.error.set(
          `Nadajnik używa innej wersji formatu ramki (ta aplikacja: v${FRAME_VERSION}). Odśwież stronę na obu urządzeniach (czasem dwa razy, aż stopka pokaże tę samą wersję).`,
        );
        return;
      }
      if (this.engine() === 'native') {
        // BarcodeDetector nie oddaje bajtów: ramki binarne wracają jako pusty lub zniekształcony tekst.
        this.unreadableStreak++;
        if (problem === 'binary-as-text' || this.unreadableStreak >= 3) this.switchToWasm();
      }
      return;
    }
    this.unreadableStreak = 0;
    this.lastCodeAt.set(performance.now());

    if (frame.header.flags & FLAG_CALIBRATION) {
      this.stats.update((s) => ({ ...s, codes: s.codes + 1 }));
      this.codeTimes.push(performance.now());
      this.handleMeasurement(frame.header);
      return;
    }

    const current = this.transfer();
    if (!current || !this.decoder || !sameTransfer(current, frame.header)) {
      this.beginTransfer(frame.header);
    }
    this.stats.update((s) => ({ ...s, codes: s.codes + 1 }));
    this.codeTimes.push(performance.now());
    const decoder = this.decoder!;
    if (decoder.isComplete) return;

    const useful = decoder.addDroplet(frame.header.seed, frame.payload);
    this.stats.update((s) =>
      useful ? { ...s, useful: s.useful + 1 } : { ...s, duplicates: s.duplicates + 1 },
    );
    if (useful) {
      this.decoded.set(decoder.decodedCount);
      this.scheduleGrid();
      if (decoder.isComplete) this.finish(frame.header, decoder);
    }
  }

  /** Silnik natywny nie oddaje bajtów; przy ramkach binarnych przełącza się na ZXing. */
  private switchToWasm(): void {
    if (this.preferredEngine() === 'wasm') return;
    this.unreadableStreak = 0;
    this.notice.set('Silnik natywny nie czyta tych kodów (ramki binarne). Przełączam dekoder na ZXing WebAssembly.');
    this.preferredEngine.set('wasm');
    void this.start();
  }

  // --- pomiar prędkości i ranking -------------------------------------------

  /** Ramka strojeniowa (parametry w fileId) albo z auto-przebiegu (indeks tabeli w fileId). */
  private handleMeasurement(header: FrameHeader): void {
    if (header.dataLength !== CALIBRATION_TABLE_VERSION) {
      this.error.set('Nadajnik ma inną wersję tabeli profili. Zaktualizuj aplikację po obu stronach.');
      return;
    }
    const tuningFrame = (header.flags & FLAG_TUNING) !== 0;
    let profile: Profile;
    let sweepSent = 0;
    if (tuningFrame) {
      profile = decodeTuningId(header.fileId, header.blockSize);
    } else {
      const fromTable = CALIBRATION_PROFILES[header.fileId];
      if (!fromTable || fromTable.blockSize !== header.blockSize) return;
      profile = fromTable;
      sweepSent = calibrationCodes(profile);
    }
    const now = performance.now();
    const key = profileKey(profile);
    let m = this.measurements.get(key);
    if (!m) {
      m = {
        key,
        profile,
        label: profileLabel(profile),
        named: profileName(profile) !== null,
        seeds: new Map(),
        firstAt: now,
        lastAt: now,
        last: 0,
        best: 0,
        codesPerSecond: 0,
        uniqueTotal: 0,
        sweepSent,
      };
      this.measurements.set(key, m);
    }
    if (now - m.lastAt > LIVE_TIMEOUT_MS) {
      // Powrót do tej kombinacji po przerwie: okno liczy się od nowa.
      m.seeds.clear();
      m.firstAt = now;
    }
    if (!m.seeds.has(header.seed)) m.uniqueTotal++;
    m.seeds.set(header.seed, now);
    m.lastAt = now;
    if (sweepSent) m.sweepSent = sweepSent;
    this.currentKey = key;
    this.lastMeasureAt.set(now);
  }

  /** Co 250 ms: prędkości w ruchomym oknie, ranking i wiersz "na żywo". */
  private updateMeasurements(): void {
    const now = performance.now();
    const rows: RankingRow[] = [];
    for (const m of this.measurements.values()) {
      const cutoff = now - MEASURE_WINDOW_MS;
      for (const [seed, at] of m.seeds) if (at < cutoff) m.seeds.delete(seed);
      const liveNow = now - m.lastAt <= LIVE_TIMEOUT_MS;
      if (liveNow) {
        const span = Math.max(500, Math.min(MEASURE_WINDOW_MS, now - m.firstAt));
        const n = m.seeds.size;
        m.last = (n * m.profile.blockSize) / (span / 1000);
        m.codesPerSecond = n / (span / 1000);
        if (now - m.firstAt >= 1000) m.best = Math.max(m.best, m.last);
      } else {
        m.last = 0;
        m.codesPerSecond = 0;
      }
      rows.push({
        key: m.key,
        label: m.label,
        named: m.named,
        profile: m.profile,
        nominal: nominalBytesPerSecond(m.profile),
        best: m.best,
        last: m.last,
        live: liveNow,
        sweepReceived: Math.min(m.uniqueTotal, m.sweepSent || m.uniqueTotal),
        sweepSent: m.sweepSent,
      });
    }
    rows.sort((a, b) => b.best - a.best || b.last - a.last);
    this.ranking.set(rows);
    const current = this.measurements.get(this.currentKey);
    this.live.set(
      current && now - current.lastAt <= LIVE_TIMEOUT_MS
        ? {
            label: current.label,
            bytesPerSecond: current.last,
            codesPerSecond: current.codesPerSecond,
            nominal: nominalBytesPerSecond(current.profile),
          }
        : null,
    );
  }

  // --- pomiar koloru: próbka ----------------------------------------------------

  private async measureColor(video: HTMLVideoElement, scanner: QrScanner): Promise<void> {
    if (video.readyState < 2 || !video.videoWidth) return;
    const maxWidth = this.resolution();
    const ratio = Math.min(1, maxWidth / video.videoWidth);
    const width = Math.round(video.videoWidth * ratio);
    const height = Math.round(video.videoHeight * ratio);
    if (this.colorCanvas.width !== width || this.colorCanvas.height !== height) {
      this.colorCanvas.width = width;
      this.colorCanvas.height = height;
    }
    const ctx = this.colorCanvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(video, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    try {
      const hits = await scanner.scanImage(image);
      const anchor = hits.find((h) => parseColorTestModules(h.text) !== null && h.corners?.length === 4);
      if (!anchor) {
        this.colorError.set(
          'Nie widzę karty testowej. Skieruj kamerę na „Kartę koloru” z nadajnika (cała karta w kadrze).',
        );
        return;
      }
      const modules = parseColorTestModules(anchor.text)!;
      if (modules !== this.colorCard.modules) {
        this.colorError.set('Karta z innej wersji aplikacji.');
        return;
      }
      const corners = anchor.corners as Corners;
      this.colorResult.set(analyzeColorTest(image, corners, this.colorCard));
      this.colorSamples.update((n) => n + 1);
      this.colorError.set('');
      this.lastCodeAt.set(performance.now());
    } catch (err) {
      this.colorError.set(this.describeError(err));
    }
  }

  // --- transfer -----------------------------------------------------------------

  private beginTransfer(header: FrameHeader): void {
    this.revokeResult();
    this.decoder = new LtDecoder(header.blockCount, header.blockSize);
    this.transfer.set({ ...header, seed: 0 });
    this.decoded.set(0);
    this.stats.set({ frames: 0, codes: 0, useful: 0, duplicates: 0, invalid: 0 });
    this.startedAt = performance.now();
    this.elapsed.set(0);
    this.codeTimes = [];
    this.completeReports = 0;
    this.scheduleGrid();
  }

  private finish(header: FrameHeader, decoder: LtDecoder): void {
    try {
      const data = decoder.assemble(header.dataLength);
      const crc = crc32(data);
      if (crc !== header.crc) {
        throw new Error(
          `Suma kontrolna się nie zgadza (oczekiwano ${header.crc.toString(16)}, jest ${crc.toString(16)}).`,
        );
      }
      const payload = unpackContainer(data, header.flags);
      const blob = new Blob([payload.data as BlobPart], {
        type: payload.mime || 'application/octet-stream',
      });
      const isText =
        payload.mime.startsWith('text/') ||
        payload.mime === 'application/json' ||
        TEXT_EXTENSIONS.test(payload.name);
      this.result.set({
        name: payload.name,
        mime: payload.mime,
        size: payload.data.length,
        url: URL.createObjectURL(blob),
        text: isText && payload.data.length <= 512 * 1024 ? utf8Decode(payload.data) : null,
      });
      this.error.set('');
    } catch (err) {
      this.error.set(`Odbiór nieudany: ${this.describeError(err)}. Wciśnij "Wyczyść" i spróbuj ponownie.`);
    }
  }

  private revokeResult(): void {
    const r = this.result();
    if (r) URL.revokeObjectURL(r.url);
    this.result.set(null);
  }

  private startClock(): void {
    if (this.clock) clearInterval(this.clock);
    this.startedAt = performance.now();
    this.clock = setInterval(() => {
      this.elapsed.set((performance.now() - this.startedAt) / 1000);
      this.updateMeasurements();
    }, 250);
  }

  private scheduleGrid(): void {
    if (this.gridDirty) return;
    this.gridDirty = true;
    setTimeout(() => {
      this.gridDirty = false;
      this.drawGrid();
    }, 50);
  }

  private drawGrid(): void {
    const canvas = this.gridRef()?.nativeElement;
    if (!canvas) return;
    const width = canvas.clientWidth || 600;
    const decoder = this.decoder;
    if (!decoder) {
      canvas.width = width;
      canvas.height = 8;
      return;
    }
    const K = decoder.blockCount;
    const cols = Math.min(K, Math.max(1, Math.floor(width / 6)));
    const cell = Math.max(2, Math.floor(width / cols));
    const rows = Math.ceil(K / cols);
    canvas.width = cols * cell;
    canvas.height = rows * cell;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#16a34a';
    const mask = decoder.decodedMask();
    for (let i = 0; i < K; i++) {
      if (!mask[i]) continue;
      const x = (i % cols) * cell;
      const y = Math.floor(i / cols) * cell;
      ctx.fillRect(x, y, cell - 1, cell - 1);
    }
  }

  private async refreshCameras(): Promise<void> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.cameras.set(devices.filter((d) => d.kind === 'videoinput'));
    } catch {
      this.cameras.set([]);
    }
  }

  private describeError(err: unknown): string {
    if (err instanceof DOMException) {
      if (err.name === 'NotAllowedError') return 'Brak zgody na użycie kamery.';
      if (err.name === 'NotFoundError') return 'Nie znaleziono kamery.';
      if (err.name === 'NotReadableError') return 'Kamera jest zajęta przez inną aplikację.';
      return `${err.name}: ${err.message}`;
    }
    return err instanceof Error ? err.message : String(err);
  }
}
