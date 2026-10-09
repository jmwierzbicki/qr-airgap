import {
  analyzeColorTest,
  applyHomography,
  buildTestCard,
  colorTestText,
  homography,
  paintTestCard,
  parseColorTestModules,
  type Corners,
  type ImageLike,
  type RGB,
} from './colortest';

function renderCard(scale: number, ox: number, oy: number, mix?: number[][]): { img: ImageLike; corners: Corners } {
  const card = buildTestCard();
  const width = Math.ceil((card.width + 8) * scale) + ox;
  const height = Math.ceil((card.height + 8) * scale) + oy;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const put = (x: number, y: number, c: RGB) => {
    let { r, g, b } = c;
    if (mix) {
      const rr = mix[0][0] * r + mix[0][1] * g + mix[0][2] * b;
      const gg = mix[1][0] * r + mix[1][1] * g + mix[1][2] * b;
      const bb = mix[2][0] * r + mix[2][1] * g + mix[2][2] * b;
      r = rr;
      g = gg;
      b = bb;
    }
    const i = (y * width + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  };
  paintTestCard(card, {
    fillRect: (x, y, w, h, color) => {
      for (let py = Math.round(oy + y * scale); py < Math.round(oy + (y + h) * scale); py++) {
        for (let px = Math.round(ox + x * scale); px < Math.round(ox + (x + w) * scale); px++) {
          put(px, py, color);
        }
      }
    },
  });
  const n = card.modules * scale;
  const corners: Corners = [
    { x: ox, y: oy },
    { x: ox + n, y: oy },
    { x: ox + n, y: oy + n },
    { x: ox, y: oy + n },
  ];
  return { img: { width, height, data }, corners };
}

describe('color test card', () => {
  it('marker text round-trips the module count', () => {
    expect(parseColorTestModules(colorTestText())).toBe(57);
    expect(parseColorTestModules('something else')).toBeNull();
  });

  it('homography maps the four anchor points exactly', () => {
    const src = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const dst = [
      { x: 100, y: 120 },
      { x: 410, y: 130 },
      { x: 400, y: 450 },
      { x: 90, y: 430 },
    ];
    const h = homography(src, dst);
    src.forEach((p, i) => {
      const q = applyHomography(h, p.x, p.y);
      expect(q.x).toBeCloseTo(dst[i].x, 6);
      expect(q.y).toBeCloseTo(dst[i].y, 6);
    });
  });

  it('a perfect capture yields full margins and full stripe contrast', () => {
    const { img, corners } = renderCard(5, 12, 7);
    const result = analyzeColorTest(img, corners, buildTestCard());
    expect(result.verdict).toBe('good');
    expect(result.margins.r).toBeGreaterThan(0.95);
    expect(result.margins.g).toBeGreaterThan(0.95);
    expect(result.margins.b).toBeGreaterThan(0.95);
    for (const s of result.stripes) expect(s.contrast).toBeGreaterThan(0.9);
    expect(result.crosstalk[1][0]).toBeLessThan(0.05);
  });

  it('simulated channel crosstalk shows up in margins and the matrix', () => {
    const mix = [
      [0.8, 0.15, 0.05],
      [0.2, 0.7, 0.1],
      [0.05, 0.15, 0.8],
    ];
    const { img, corners } = renderCard(5, 0, 0, mix);
    const result = analyzeColorTest(img, corners, buildTestCard());
    expect(result.crosstalk[1][0]).toBeCloseTo(0.2, 1);
    expect(result.margins.g).toBeLessThan(0.8);
    expect(result.margins.g).toBeGreaterThan(0);
  });

  it('rejects a card that is out of frame', () => {
    const { img } = renderCard(5, 0, 0);
    const far: Corners = [
      { x: 5000, y: 0 },
      { x: 5285, y: 0 },
      { x: 5285, y: 285 },
      { x: 5000, y: 285 },
    ];
    expect(() => analyzeColorTest(img, far, buildTestCard())).toThrow();
  });
});
