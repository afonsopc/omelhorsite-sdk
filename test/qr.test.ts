/**
 * Tests for `local/qr.ts`.
 *
 * The encoder itself is `uqr`'s job and is not re-tested here. What IS tested
 * is everything this module is responsible for: that the matrix comes back as
 * a bare symbol with no quiet zone baked in, that the flat row-major indexing
 * lines up with the specification's fixed patterns (finders and timing), and
 * that the SVG we build around it is well-formed, correctly sized and safe to
 * inline when the colours came from a user.
 */

import { describe, expect, test } from "bun:test";

import { encodeQr, qrToDataUri, qrToSvg, type QrMatrix } from "../src/local/qr";

const PAYLOAD = "https://omelhor.site/abc";

/** Reads one module out of the flat row-major array. */
function at(matrix: QrMatrix, x: number, y: number): boolean {
  return matrix.modules[y * matrix.size + x]!;
}

describe("encodeQr", () => {
  test("returns a square matrix sized by its version", () => {
    const qr = encodeQr(PAYLOAD);
    expect(qr.size).toBe(21 + 4 * (qr.version - 1));
    expect(qr.modules).toHaveLength(qr.size * qr.size);
  });

  test("carries no quiet zone: the symbol starts at the very first module", () => {
    // uqr defaults to a one-module border. If that leaked through, (0,0) would
    // be light instead of the finder's top-left corner.
    const qr = encodeQr(PAYLOAD);
    expect(at(qr, 0, 0)).toBe(true);
  });

  test("places the three finder patterns", () => {
    const qr = encodeQr(PAYLOAD);

    for (const [ox, oy] of [
      [0, 0],
      [qr.size - 7, 0],
      [0, qr.size - 7],
    ] as const) {
      // Outer 7x7 ring dark, inner ring light, 3x3 core dark.
      expect(at(qr, ox + 0, oy + 0)).toBe(true);
      expect(at(qr, ox + 6, oy + 0)).toBe(true);
      expect(at(qr, ox + 0, oy + 6)).toBe(true);
      expect(at(qr, ox + 1, oy + 1)).toBe(false);
      expect(at(qr, ox + 5, oy + 5)).toBe(false);
      expect(at(qr, ox + 3, oy + 3)).toBe(true);
    }

    // The spec's permanently-dark module, at column 8 of row 4*version + 9.
    // It pins the row-major indexing to the vertical axis as well.
    expect(at(qr, 8, qr.size - 8)).toBe(true);
  });

  test("the timing patterns alternate along row and column 6", () => {
    const qr = encodeQr(PAYLOAD);
    for (let i = 8; i <= qr.size - 9; i += 1) {
      expect(at(qr, i, 6)).toBe(i % 2 === 0);
      expect(at(qr, 6, i)).toBe(i % 2 === 0);
    }
  });

  test("is deterministic for the same input", () => {
    expect(encodeQr(PAYLOAD, { ecc: "Q" })).toEqual(encodeQr(PAYLOAD, { ecc: "Q" }));
  });

  test("echoes the error-correction level and defaults it to M", () => {
    expect(encodeQr(PAYLOAD).ecc).toBe("M");
    expect(encodeQr(PAYLOAD, { ecc: "H" }).ecc).toBe("H");
  });

  test("a stronger level needs a bigger symbol for the same payload", () => {
    expect(encodeQr(PAYLOAD, { ecc: "H" }).version).toBeGreaterThan(encodeQr(PAYLOAD, { ecc: "L" }).version);
  });

  test("honours a forced version", () => {
    const qr = encodeQr("hello", { version: 5 });
    expect(qr.version).toBe(5);
    expect(qr.size).toBe(37);
  });

  test("rejects a version outside 1-40", () => {
    expect(() => encodeQr("hello", { version: 0 })).toThrow(RangeError);
    expect(() => encodeQr("hello", { version: 41 })).toThrow(RangeError);
    expect(() => encodeQr("hello", { version: 2.5 })).toThrow(RangeError);
  });

  test("rejects a payload that does not fit", () => {
    expect(() => encodeQr("x".repeat(200), { version: 1 })).toThrow(RangeError);
    expect(() => encodeQr("x".repeat(5000), { ecc: "H" })).toThrow(RangeError);
  });

  test("encodes an empty payload rather than throwing", () => {
    expect(encodeQr("").size).toBe(21);
  });
});

describe("qrToSvg", () => {
  test("wraps the symbol in the four-module quiet zone the spec requires", () => {
    const qr = encodeQr(PAYLOAD);
    expect(qrToSvg(qr)).toContain(`viewBox="0 0 ${qr.size + 8} ${qr.size + 8}"`);
  });

  test("honours an explicit margin", () => {
    const qr = encodeQr(PAYLOAD);
    expect(qrToSvg(qr, { margin: 0 })).toContain(`viewBox="0 0 ${qr.size} ${qr.size}"`);
    expect(qrToSvg(qr, { margin: 2 })).toContain(`viewBox="0 0 ${qr.size + 4} ${qr.size + 4}"`);
  });

  test("encodes a payload string in place", () => {
    expect(qrToSvg(PAYLOAD)).toBe(qrToSvg(encodeQr(PAYLOAD)));
  });

  test("emits one path for a square symbol", () => {
    const svg = qrToSvg(PAYLOAD);
    expect(svg.match(/<path/g)).toHaveLength(1);
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  test("draws the requested module shape", () => {
    expect(qrToSvg(PAYLOAD, { shape: "dots" })).toContain("<circle ");
    expect(qrToSvg(PAYLOAD, { shape: "rounded" })).toContain('rx="0.3"');
    expect(qrToSvg(PAYLOAD, { shape: "dots" })).toContain('shape-rendering="geometricPrecision"');
  });

  test("paints a background unless it is asked not to", () => {
    expect(qrToSvg(PAYLOAD)).toContain('fill="#ffffff"');
    expect(qrToSvg(PAYLOAD, { background: "transparent" })).not.toContain("<rect");
    expect(qrToSvg(PAYLOAD, { background: "none" })).not.toContain("<rect");
  });

  test("omits width/height until a pixel size is given", () => {
    // Only the root tag matters: the background rect carries a width of its own.
    const rootTag = (svg: string): string => svg.slice(0, svg.indexOf(">") + 1);
    expect(rootTag(qrToSvg(PAYLOAD))).not.toContain(" width=");
    expect(rootTag(qrToSvg(PAYLOAD, { size: 512 }))).toContain(' width="512" height="512"');
  });

  test("uses the requested colours", () => {
    const svg = qrToSvg(PAYLOAD, { color: "#123456", background: "#abcdef" });
    expect(svg).toContain('fill="#123456"');
    expect(svg).toContain('fill="#abcdef"');
  });

  test("escapes a colour so it cannot break out of the attribute", () => {
    const svg = qrToSvg(PAYLOAD, { color: '#fff" onload="alert(1)' });
    expect(svg).not.toContain('onload="');
    expect(svg).toContain("&quot;");
    // The whole fill stays inside one attribute.
    expect(svg).toContain('fill="#fff&quot; onload=&quot;alert(1)"');
  });

  test("escapes the ampersands and angle brackets too", () => {
    const svg = qrToSvg(PAYLOAD, { background: "<&>" });
    expect(svg).toContain('fill="&lt;&amp;&gt;"');
  });

  test("rejects a nonsensical margin or size", () => {
    expect(() => qrToSvg(PAYLOAD, { margin: -1 })).toThrow(RangeError);
    expect(() => qrToSvg(PAYLOAD, { size: 0 })).toThrow(RangeError);
    expect(() => qrToSvg(PAYLOAD, { size: -10 })).toThrow(RangeError);
  });

  test("draws exactly the dark modules and no others", () => {
    const qr = encodeQr("hi", { version: 1 });
    const dark = qr.modules.filter(Boolean).length;
    const svg = qrToSvg(qr, { shape: "dots", margin: 0 });
    expect(svg.match(/<circle /g)).toHaveLength(dark);
    // The top-left finder corner sits at (0,0) with no margin applied.
    expect(svg).toContain('<circle cx="0.5" cy="0.5" r="0.5"/>');
  });
});

describe("qrToDataUri", () => {
  test("percent-encodes the same document qrToSvg produces", () => {
    const uri = qrToDataUri(PAYLOAD);
    expect(uri.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(uri.slice("data:image/svg+xml;charset=utf-8,".length))).toBe(qrToSvg(PAYLOAD));
  });

  test("carries no character that would end an attribute or a CSS url()", () => {
    const uri = qrToDataUri(PAYLOAD, { color: '#000" x="' });
    expect(uri).not.toContain('"');
    expect(uri).not.toContain("<");
    expect(uri).not.toContain(">");
    expect(uri).not.toContain(")");
  });
});
