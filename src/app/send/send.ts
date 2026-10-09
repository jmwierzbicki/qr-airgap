import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  signal,
  viewChild,
} from '@angular/core';
import QRCode from 'qrcode';
import { crc32, formatBytes, randomUint32, utf8Encode } from '../core/bytes';
import {
  COLOR_TEST_MODULES,
  COLOR_TEST_QR_VERSION,
  buildTestCard,
  colorTestText,
  paintTestCard,
} from '../core/colortest';
import { packContainer, type PackedContainer } from '../core/container';
import { FLAG_CALIBRATION, FLAG_COLOR, HEADER_SIZE, type FrameHeader } from '../core/frame';
import { LtEncoder } from '../core/lt';
import {
  CALIBRATION_MS,
  CALIBRATION_PROFILES,
  CALIBRATION_TABLE_VERSION,
  DEFAULT_PROFILE,
  calibrationCodes,
  calibrationDurationMs,
  calibrationPayload,
  calibrationRange,
  codesPerFrame,
  profileByName,
  profileName,
  type CalibrationKind,
  type Grid,
  type Profile,
} from '../core/profile';
import { encodeWire } from '../core/wire';
import {
  FEEDBACK_INTERVAL_MS,
  FeedbackPlanner,
  adjustFps,
  decodeFeedback,
  transferIdOf,
} from '../core/feedback';
import { AudioFeedbackListener } from '../audio/ggwave';

interface PreparedPayload {
  name: string;
  mime: string;
  size: number;
  packed: PackedContainer;
}

type EcLevel = 'L' | 'M' | 'Q';

export const BLOCK_PRESETS = [200, 400, 700, 1000, 1400, 2000];
const PROFILE_STORAGE_KEY = 'qr-airgap.profile';

interface CodeLayout {
  version: number;
  modules: number;
  margin: number;
  scale: number;
  cols: number;
  rows: number;
}

@Component({
  selector: 'app-send',
  imports: [DecimalPipe],
  templateUrl: './send.html',
  styleUrl: './send.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Send implements OnDestroy {
  readonly blockPresets = BLOCK_PRESETS;
  readonly formatBytes = formatBytes;
  readonly profileNames = CALIBRATION_PROFILES.map((p) => profileName(p)!);
  readonly calibrationSeconds = {
    bw: Math.round(calibrationDurationMs('bw') / 1000),
    color: Math.round(calibrationDurationMs('color') / 1000),
  };

  readonly text = signal('');
  readonly payload = signal<PreparedPayload | null>(null);
  readonly profile = signal<Profile>(loadProfile());
  readonly profileInput = signal('');
  readonly ecLevel = signal<EcLevel>('L');
  readonly running = signal(false);
  readonly calibrating = signal(false);
  readonly calibrationKind = signal<CalibrationKind>('bw');
  readonly colorTesting = signal(false);
  readonly calibrationIndex = signal(0);
  readonly framesSent = signal(0);
  readonly qrVersion = signal(0);
  readonly qrModules = signal(0);
  readonly error = signal('');
  readonly notice = signal('');

  // Kanał zwrotny (dźwięk): nadajnik słucha raportów odbiornika.
  readonly listening = signal(false);
  readonly listeningStatus = signal('');
  readonly autoStop = signal(true);
  readonly rateControl = signal(false);
  readonly lastReport = signal<{ decoded: number; blockCount: number; recentCodes: number; complete: boolean; at: number } | null>(null);
  readonly reportsReceived = signal(0);
  readonly transferId = signal(0);
  readonly now = signal(performance.now());
  readonly reportAgeSeconds = computed(() => {
    const r = this.lastReport();
    return r ? Math.max(0, (this.now() - r.at) / 1000) : null;
  });

  readonly blockSize = computed(() => this.profile().blockSize);
  readonly fps = computed(() => this.profile().fps);
  readonly grid = computed(() => this.profile().grid);
  readonly binary = computed(() => this.profile().binary);
  readonly color = computed(() => this.profile().color);
  readonly currentProfileName = computed(() => profileName(this.profile()));

  /** Dla małych wiadomości blok kurczy się do rozmiaru danych, żeby kod QR był jak najrzadszy. */
  readonly effectiveBlockSize = computed(() => {
    const p = this.payload();
    const size = this.blockSize();
    return p ? Math.max(1, Math.min(size, p.packed.bytes.length)) : size;
  });
  readonly blockCount = computed(() => {
    const p = this.payload();
    return p ? Math.max(1, Math.ceil(p.packed.bytes.length / this.effectiveBlockSize())) : 0;
  });
  readonly frameBytes = computed(() => HEADER_SIZE + this.effectiveBlockSize());
  readonly codesPerFrame = computed(() => codesPerFrame(this.profile()));
  readonly codesPerSecond = computed(() => this.fps() * this.codesPerFrame());
  readonly cycleSeconds = computed(() => this.blockCount() / this.codesPerSecond());
  readonly cycleProgress = computed(() => {
    const k = this.blockCount();
    return k ? Math.min(100, (this.framesSent() / k) * 100) : 0;
  });
  readonly throughput = computed(() => this.effectiveBlockSize() * this.codesPerSecond());
  readonly calibrationProfileName = computed(
    () => profileName(CALIBRATION_PROFILES[this.calibrationIndex()]) ?? '',
  );
  readonly calibrationPosition = computed(() => {
    const [from, to] = calibrationRange(this.calibrationKind());
    return { current: this.calibrationIndex() - from + 1, total: to - from };
  });
  readonly calibrationProgress = computed(() => {
    const { current, total } = this.calibrationPosition();
    return ((current - 1) / total) * 100;
  });

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly stageRef = viewChild<ElementRef<HTMLElement>>('stage');

  private timer: ReturnType<typeof setInterval> | null = null;
  private encoder: LtEncoder | null = null;
  private header: FrameHeader | null = null;
  private seed = 0;
  private layout: CodeLayout | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private busy = false;
  private readonly scratch = document.createElement('canvas');
  private calibrationStartedAt = 0;
  private calibrationCodeIndex = 0;
  private planner: FeedbackPlanner | null = null;
  private listener: AudioFeedbackListener | null = null;
  private nowTimer: ReturnType<typeof setInterval> | null = null;

  ngOnDestroy(): void {
    this.stop();
    this.stopListening();
  }

  // --- kanał zwrotny -------------------------------------------------------

  async startListening(): Promise<void> {
    if (this.listener) return;
    this.listeningStatus.set('Uruchamiam mikrofon…');
    try {
      this.listener = await AudioFeedbackListener.create(document.baseURI, (bytes) => this.onFeedback(bytes));
      this.listening.set(true);
      this.listeningStatus.set('Nasłuchuję raportów odbiornika.');
      this.nowTimer = setInterval(() => this.now.set(performance.now()), 500);
    } catch (err) {
      this.listeningStatus.set(`Nie udało się włączyć nasłuchu: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  stopListening(): void {
    this.listener?.destroy();
    this.listener = null;
    this.listening.set(false);
    if (this.nowTimer) {
      clearInterval(this.nowTimer);
      this.nowTimer = null;
    }
  }

  onAutoStop(event: Event): void {
    this.autoStop.set((event.target as HTMLInputElement).checked);
  }

  onRateControl(event: Event): void {
    this.rateControl.set((event.target as HTMLInputElement).checked);
  }

  private onFeedback(bytes: Uint8Array): void {
    const msg = decodeFeedback(bytes);
    if (!msg) return;
    const at = performance.now();
    this.reportsReceived.update((n) => n + 1);
    if (!this.planner || !this.planner.report(msg, at)) {
      this.listeningStatus.set(`Raport z innego transferu (#${msg.transferId.toString(16)}).`);
      return;
    }
    this.lastReport.set({ decoded: msg.decoded, blockCount: msg.blockCount, recentCodes: msg.recentCodes, complete: msg.complete, at });
    this.listeningStatus.set('');
    if (this.planner.complete && this.autoStop()) {
      this.stop();
      this.notice.set('Odbiornik potwierdził komplet. Nadawanie zatrzymane.');
      return;
    }
    if (this.rateControl() && this.running() && !this.calibrating()) {
      const sent = this.fps() * this.codesPerFrame() * (FEEDBACK_INTERVAL_MS / 1000);
      const fps = adjustFps(this.fps(), msg.recentCodes, sent);
      if (fps !== this.fps()) {
        // Bez restartu transferu: ten sam plik, tylko inne tempo.
        this.profile.set({ ...this.profile(), fps });
        this.scheduleTimer(fps);
      }
    }
  }

  // --- źródło danych -------------------------------------------------------

  async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const data = new Uint8Array(await file.arrayBuffer());
    this.setPayload(file.name, file.type || 'application/octet-stream', data);
    input.value = '';
  }

  useText(): void {
    const value = this.text();
    if (!value.trim()) {
      this.error.set('Wpisz jakiś tekst.');
      return;
    }
    this.setPayload('wiadomosc.txt', 'text/plain', utf8Encode(value));
  }

  onTextInput(event: Event): void {
    this.text.set((event.target as HTMLTextAreaElement).value);
  }

  // --- parametry -----------------------------------------------------------

  onProfileInput(event: Event): void {
    this.profileInput.set((event.target as HTMLInputElement).value);
  }

  applyProfileName(): void {
    const found = profileByName(this.profileInput());
    if (!found) {
      this.error.set(`Nie znam profilu "${this.profileInput()}". Nazwy to np. ${this.profileNames[0]}.`);
      return;
    }
    this.error.set('');
    this.notice.set(
      `Profil ${profileName(found)}: ${found.blockSize} B, ${found.fps} kl/s, ${found.grid} komórk(i), ` +
        `${found.color ? 'kolor RGB, ' : ''}${found.binary ? 'binarny' : 'base64'}.`,
    );
    this.updateProfile(found);
  }

  onBlockSize(event: Event): void {
    this.updateProfile({ ...this.profile(), blockSize: Number((event.target as HTMLSelectElement).value) });
  }

  onFps(event: Event): void {
    this.updateProfile({ ...this.profile(), fps: Number((event.target as HTMLInputElement).value) });
  }

  onGrid(event: Event): void {
    this.updateProfile({ ...this.profile(), grid: Number((event.target as HTMLSelectElement).value) as Grid });
  }

  onBinary(event: Event): void {
    this.updateProfile({ ...this.profile(), binary: (event.target as HTMLSelectElement).value === 'binary' });
  }

  onColor(event: Event): void {
    this.updateProfile({ ...this.profile(), color: (event.target as HTMLSelectElement).value === 'rgb' });
  }

  onEcLevel(event: Event): void {
    this.ecLevel.set((event.target as HTMLSelectElement).value as EcLevel);
    this.restartIfRunning();
  }

  private updateProfile(p: Profile): void {
    this.profile.set(p);
    saveProfile(p);
    this.restartIfRunning();
  }

  // --- nadawanie -----------------------------------------------------------

  start(): void {
    const payload = this.payload();
    if (!payload) return;
    this.stop();
    this.error.set('');

    const blockSize = this.effectiveBlockSize();
    this.encoder = new LtEncoder(payload.packed.bytes, blockSize);
    this.header = {
      fileId: randomUint32(),
      blockCount: this.encoder.blockCount,
      blockSize,
      dataLength: payload.packed.bytes.length,
      flags: payload.packed.flags | (this.color() ? FLAG_COLOR : 0),
      crc: crc32(payload.packed.bytes),
      seed: 0,
    };
    this.seed = 0;
    this.framesSent.set(0);
    this.planner = new FeedbackPlanner(this.encoder.blockCount, transferIdOf(this.header.fileId));
    this.transferId.set(transferIdOf(this.header.fileId));
    this.lastReport.set(null);
    if (!this.prepareLayout(blockSize, this.grid(), this.binary())) return;

    this.running.set(true);
    this.observeStage();
    this.renderNext();
    this.scheduleTimer(this.fps());
  }

  startCalibration(kind: CalibrationKind): void {
    this.stop();
    this.error.set('');
    this.notice.set('');
    this.calibrationKind.set(kind);
    const [from] = calibrationRange(kind);
    this.calibrationIndex.set(from);
    this.framesSent.set(0);
    this.calibrating.set(true);
    this.running.set(true);
    this.observeStage();
    this.enterCalibrationProfile(from);
  }

  /** Statyczna karta testowa do pomiaru koloru po stronie odbiornika. */
  startColorTest(): void {
    this.stop();
    this.error.set('');
    this.notice.set('');
    this.colorTesting.set(true);
    this.running.set(true);
    this.observeStage();
    this.drawColorCard();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.running.set(false);
    this.calibrating.set(false);
    this.colorTesting.set(false);
  }

  async toggleFullscreen(): Promise<void> {
    const stage = this.stageRef()?.nativeElement;
    if (!stage) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stage.requestFullscreen();
    } catch {
      /* brak API pełnego ekranu np. w iOS Safari */
    }
  }

  private setPayload(name: string, mime: string, data: Uint8Array): void {
    this.stop();
    this.error.set('');
    const packed = packContainer({ name, mime, data });
    this.payload.set({ name, mime, size: data.length, packed });
  }

  private restartIfRunning(): void {
    if (this.calibrating() || this.colorTesting()) return;
    if (this.running()) this.start();
  }

  private scheduleTimer(fps: number): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.renderNext(), Math.round(1000 / fps));
  }

  /** Wyznacza wersję QR dla ramki o zadanym rozmiarze i skalę, żeby siatka mieściła się na scenie. */
  private prepareLayout(blockSize: number, grid: Grid, binary: boolean): boolean {
    const probeHeader: FrameHeader = {
      fileId: 0,
      blockCount: 1,
      blockSize,
      dataLength: 0,
      flags: 0,
      crc: 0,
      seed: 0,
    };
    const probeWire = encodeWire({ header: probeHeader, payload: new Uint8Array(blockSize) }, binary);
    try {
      const probe = QRCode.create([{ mode: 'byte', data: probeWire }], {
        errorCorrectionLevel: this.ecLevel(),
      });
      const cols = grid === 1 ? 1 : 2;
      const rows = grid === 4 ? 2 : 1;
      this.layout = { version: probe.version, modules: probe.modules.size, margin: 3, scale: 2, cols, rows };
      this.qrVersion.set(probe.version);
      this.qrModules.set(probe.modules.size);
      this.fitScale();
      return true;
    } catch (err) {
      this.error.set(
        `Ramka ${HEADER_SIZE + blockSize} B nie mieści się w kodzie QR (${String(err)}). Zmniejsz rozmiar bloku, użyj trybu binarnego lub niższej korekcji.`,
      );
      this.stop();
      return false;
    }
  }

  private renderNext(): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas || !this.layout || this.busy) return;
    this.busy = true;
    try {
      if (this.calibrating()) this.renderCalibrationFrame(canvas);
      else this.renderTransferFrame(canvas);
    } catch (err) {
      this.error.set(String(err));
      this.stop();
    } finally {
      this.busy = false;
    }
  }

  private renderTransferFrame(canvas: HTMLCanvasElement): void {
    if (!this.encoder || !this.header || !this.planner) return;
    if (this.planner.complete && this.autoStop()) {
      this.stop();
      this.notice.set('Odbiornik potwierdził komplet. Nadawanie zatrzymane.');
      return;
    }
    const wires: Uint8Array[] = [];
    const now = performance.now();
    for (let i = 0; i < this.codesPerFrame(); i++) {
      const seed = this.planner.next(now);
      wires.push(
        encodeWire({ header: { ...this.header, seed }, payload: this.encoder.droplet(seed) }, this.binary()),
      );
    }
    this.drawCodes(canvas, wires, this.color());
    this.framesSent.update((n) => n + wires.length);
  }

  private renderCalibrationFrame(canvas: HTMLCanvasElement): void {
    const idx = this.calibrationIndex();
    const [, end] = calibrationRange(this.calibrationKind());
    const profile = CALIBRATION_PROFILES[idx];
    const total = calibrationCodes(profile);
    const elapsed = performance.now() - this.calibrationStartedAt;
    if (elapsed >= CALIBRATION_MS || this.calibrationCodeIndex >= total) {
      if (idx + 1 >= end) {
        this.stop();
        this.notice.set(
          'Kalibracja zakończona. Odczytaj ranking na odbiorniku i wpisz nazwę najlepszego profilu powyżej.',
        );
        return;
      }
      this.calibrationIndex.set(idx + 1);
      this.enterCalibrationProfile(idx + 1);
      return;
    }
    const wires: Uint8Array[] = [];
    const perFrame = codesPerFrame(profile);
    for (let i = 0; i < perFrame && this.calibrationCodeIndex < total; i++) {
      const seed = this.calibrationCodeIndex++;
      const header: FrameHeader = {
        fileId: idx,
        blockCount: total,
        blockSize: profile.blockSize,
        dataLength: CALIBRATION_TABLE_VERSION,
        flags: FLAG_CALIBRATION | (profile.color ? FLAG_COLOR : 0),
        crc: 0,
        seed,
      };
      wires.push(
        encodeWire({ header, payload: calibrationPayload(idx, seed, profile.blockSize) }, profile.binary),
      );
    }
    this.drawCodes(canvas, wires, profile.color);
    this.framesSent.update((n) => n + wires.length);
  }

  private enterCalibrationProfile(idx: number): void {
    const profile = CALIBRATION_PROFILES[idx];
    this.calibrationStartedAt = performance.now();
    this.calibrationCodeIndex = 0;
    if (!this.prepareLayout(profile.blockSize, profile.grid, profile.binary)) return;
    this.scheduleTimer(profile.fps);
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) return;
    try {
      this.renderCalibrationFrame(canvas);
    } catch (err) {
      this.error.set(String(err));
      this.stop();
    }
  }

  /**
   * Rysuje kody na wspólnym płótnie ostrymi modułami o całkowitej skali.
   * W trybie kolorowym każda komórka dostaje trzy kolejne kody: kanał R, G i B.
   * Wzorce pozycjonujące są wspólne, więc pozostają czarno-białe.
   */
  private drawCodes(canvas: HTMLCanvasElement, wires: Uint8Array[], color: boolean): void {
    const layout = this.layout!;
    const cellModules = layout.modules + 2 * layout.margin;
    const cellPx = cellModules * layout.scale;
    const width = layout.cols * cellPx;
    const height = layout.rows * cellPx;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);

    const size = layout.modules;
    if (this.scratch.width !== size) {
      this.scratch.width = size;
      this.scratch.height = size;
    }
    const sctx = this.scratch.getContext('2d')!;
    const image = sctx.createImageData(size, size);
    const px = image.data;
    const perCell = color ? 3 : 1;
    const cells = Math.ceil(wires.length / perCell);

    for (let cell = 0; cell < cells; cell++) {
      px.fill(255);
      for (let ch = 0; ch < perCell; ch++) {
        const wire = wires[cell * perCell + ch];
        if (!wire) break;
        const code = QRCode.create([{ mode: 'byte', data: wire }], {
          errorCorrectionLevel: this.ecLevel(),
          version: layout.version,
        });
        const data = code.modules.data;
        if (color) {
          // Moduł ciemny w kodzie kanału ch gasi tylko ten kanał.
          for (let m = 0; m < size * size; m++) {
            if (data[m]) px[m * 4 + ch] = 0;
          }
        } else {
          for (let m = 0; m < size * size; m++) {
            if (data[m]) {
              px[m * 4] = 0;
              px[m * 4 + 1] = 0;
              px[m * 4 + 2] = 0;
            }
          }
        }
      }
      sctx.putImageData(image, 0, 0);
      const col = cell % layout.cols;
      const row = Math.floor(cell / layout.cols);
      const x = col * cellPx + layout.margin * layout.scale;
      const y = row * cellPx + layout.margin * layout.scale;
      ctx.drawImage(this.scratch, x, y, size * layout.scale, size * layout.scale);
    }
  }

  /** Dobiera całkowitą skalę modułu tak, aby cała siatka mieściła się na scenie. */
  private fitScale(): void {
    const stage = this.stageRef()?.nativeElement;
    const layout = this.layout;
    if (!stage || !layout) return;
    const cellModules = layout.modules + 2 * layout.margin;
    const availW = stage.clientWidth - 16;
    const availH = (stage.clientHeight || stage.clientWidth) - 16;
    const scale = Math.floor(
      Math.min(availW / (layout.cols * cellModules), availH / (layout.rows * cellModules)),
    );
    layout.scale = Math.max(1, scale);
  }

  private observeStage(): void {
    const stage = this.stageRef()?.nativeElement;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => {
      if (this.colorTesting()) this.drawColorCard();
      else this.fitScale();
    });
    this.resizeObserver.observe(stage);
  }

  private drawColorCard(): void {
    const canvas = this.canvasRef()?.nativeElement;
    const stage = this.stageRef()?.nativeElement;
    if (!canvas || !stage) return;
    const card = buildTestCard();
    const quiet = 4;
    const cols = card.width + 2 * quiet;
    const rows = card.height + 2 * quiet;
    const availW = stage.clientWidth - 16;
    const availH = (stage.clientHeight || stage.clientWidth) - 16;
    const scale = Math.max(1, Math.floor(Math.min(availW / cols, availH / rows)));
    canvas.width = cols * scale;
    canvas.height = rows * scale;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    try {
      const code = QRCode.create(colorTestText(), {
        version: COLOR_TEST_QR_VERSION,
        errorCorrectionLevel: 'M',
      });
      const size = code.modules.size;
      if (size !== COLOR_TEST_MODULES) throw new Error(`Nieoczekiwany rozmiar kodu: ${size}`);
      ctx.fillStyle = '#000';
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (code.modules.data[y * size + x]) {
            ctx.fillRect((quiet + x) * scale, (quiet + y) * scale, scale, scale);
          }
        }
      }
    } catch (err) {
      this.error.set(String(err));
      this.stop();
      return;
    }

    paintTestCard(card, {
      fillRect: (x, y, w, h, c) => {
        ctx.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
        ctx.fillRect((quiet + x) * scale, (quiet + y) * scale, w * scale, h * scale);
      },
    });
    this.qrVersion.set(COLOR_TEST_QR_VERSION);
    this.qrModules.set(COLOR_TEST_MODULES);
  }
}

function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!raw) return DEFAULT_PROFILE;
    const p = JSON.parse(raw) as Partial<Profile>;
    if (
      typeof p.blockSize === 'number' &&
      typeof p.fps === 'number' &&
      (p.grid === 1 || p.grid === 2 || p.grid === 4) &&
      typeof p.binary === 'boolean'
    ) {
      return { blockSize: p.blockSize, fps: p.fps, grid: p.grid, binary: p.binary, color: p.color === true };
    }
  } catch {
    /* brak localStorage albo uszkodzony zapis */
  }
  return DEFAULT_PROFILE;
}

function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* ignoruj */
  }
}
