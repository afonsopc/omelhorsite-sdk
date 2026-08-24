/**
 * QR code encoding. Local, offline, no credential.
 *
 * This module encodes a payload into a module matrix and renders it as SVG.
 * That is the whole isolate-safe surface: SVG is text, so it works in a Worker,
 * in the CLI and in a browser alike.
 *
 * Raster output (PNG, JPEG) is deliberately NOT here. It needs a canvas or an
 * image encoder, neither of which every target runtime has, and the host
 * already knows which it owns. Hand the host the matrix or the SVG and let it
 * rasterise.
 *
 * Encoding a QR symbol correctly (mode selection, Reed-Solomon over GF(256),
 * mask scoring against the four penalty rules) is not something to hand-roll,
 * so the encoder is `uqr`: MIT, zero runtime dependencies, pure TypeScript, and
 * it imports no `node:*` builtin and touches no DOM - which is why it, rather
 * than the older `qrcode-generator`, is the one dependency the core has. The
 * rendering below is ours, because `uqr`'s own `renderSVG` emits one `<rect>`
 * per module and offers no margin, shape or transparency control.
 *
 * Note the split of responsibilities with `oms.dynamicQrs`: this module draws
 * the image, that namespace manages the redirect the image points at. For a
 * dynamic code, encode `oms.dynamicQrs.publicUrl(qr)` here - never `qr.url`, or
 * the whole point of a re-pointable code is lost.
 */

import { encode as encodeUqr } from "uqr";

/** Error-correction level. Higher survives more damage and more logo. */
export type QrErrorCorrection = "L" | "M" | "Q" | "H";

/** Options for {@link encodeQr}. */
export interface EncodeQrOptions {
  /** Defaults to `"M"`. Use `"H"` when a logo covers the middle. */
  readonly ecc?: QrErrorCorrection;
  /**
   * Force a symbol version (1 to 40). Omit to let the encoder pick the
   * smallest that fits, which is almost always what you want. Forcing a
   * version that the payload does not fit in is a {@link RangeError}, not a
   * silent upgrade.
   */
  readonly version?: number;
}

/** An encoded QR symbol, as a square grid of modules. */
export interface QrMatrix {
  /** Modules per side, quiet zone excluded. `21 + 4 * (version - 1)`. */
  readonly size: number;
  /**
   * Row-major, `size * size` entries. `true` is a dark module.
   *
   * Flat rather than nested so it can be walked without allocating a row array
   * per line; index `y * size + x`.
   */
  readonly modules: ReadonlyArray<boolean>;
  readonly version: number;
  readonly ecc: QrErrorCorrection;
}

/** Options for {@link qrToSvg}. */
export interface QrSvgOptions {
  /**
   * Quiet zone in modules. Defaults to 4, which is what the specification
   * requires; scanners genuinely fail without it.
   */
  readonly margin?: number;
  /** Dark module colour. Defaults to `"#000000"`. */
  readonly color?: string;
  /**
   * Light module colour. Defaults to `"#ffffff"`. Pass `"transparent"` for a
   * background-free symbol; contrast is then the caller's problem, and a dark
   * symbol on a dark page does not scan.
   */
  readonly background?: string;
  /**
   * Pixel size of the `width`/`height` attributes. Omit to emit a `viewBox`
   * only, which scales to whatever box it is dropped into.
   */
  readonly size?: number;
  /**
   * Module shape. `"square"` is the safe default; `"rounded"` and `"dots"`
   * shrink the effective dark area and can push a low-ECC symbol below what a
   * phone camera will read. Raise `ecc` when you use them.
   */
  readonly shape?: "square" | "rounded" | "dots";
}

/** Smallest and largest symbol version the specification defines. */
const MIN_VERSION = 1;
const MAX_VERSION = 40;

/**
 * Encodes a payload into a QR matrix.
 *
 * ```ts
 * const qr = encodeQr("https://omelhor.site/abc");
 * qr.size;                       // 25 for a version-2 symbol
 * qr.modules[y * qr.size + x];   // true where the module is dark
 * ```
 *
 * The matrix carries NO quiet zone: {@link qrToSvg} adds one, and a caller
 * rendering the matrix by hand must add its own or the symbol will not scan.
 *
 * @param data The payload. A URL, plain text, a `WIFI:` string, whatever. The
 *   encoder picks the mode (numeric, alphanumeric, byte) that fits it best.
 * @throws {RangeError} when the payload does not fit at the requested version
 *   and error-correction level, or when `version` is outside 1-40.
 */
export function encodeQr(data: string, options: EncodeQrOptions = {}): QrMatrix {
  const ecc = options.ecc ?? "M";

  if (options.version !== undefined) {
    if (!Number.isInteger(options.version) || options.version < MIN_VERSION || options.version > MAX_VERSION) {
      throw new RangeError(`QR version must be an integer in [1, 40], got ${String(options.version)}.`);
    }
  }

  const result = encodeUqr(data, {
    ecc,
    // Our own quiet zone is applied at render time, so the matrix stays a bare
    // symbol that a caller can compose with.
    border: 0,
    ...(options.version === undefined ? {} : { minVersion: options.version, maxVersion: options.version }),
  });

  const size = result.size;
  const modules: boolean[] = new Array<boolean>(size * size);
  for (let y = 0; y < size; y += 1) {
    const row = result.data[y];
    for (let x = 0; x < size; x += 1) modules[y * size + x] = row[x];
  }

  return { size, modules: modules, version: result.version, ecc };
}

/**
 * Renders a matrix, or a payload, as an SVG document string.
 *
 * ```ts
 * const svg = qrToSvg("https://omelhor.site/abc", { ecc: "H", size: 512 });
 * ```
 *
 * Passing a payload string encodes it first, so {@link EncodeQrOptions} is
 * accepted here too; passing an already-encoded {@link QrMatrix} ignores those
 * fields, because the symbol is already fixed.
 *
 * Colours are escaped before they reach an attribute. They routinely come from
 * a `DynamicQrSettings` bag that a user typed, and an unescaped `"` there would
 * let that user close the attribute and write markup of their own into a page
 * that inlines the result.
 *
 * @throws {RangeError} propagated from {@link encodeQr}, or when `margin` or
 *   `size` is negative.
 */
export function qrToSvg(input: QrMatrix | string, options: QrSvgOptions & EncodeQrOptions = {}): string {
  const matrix = typeof input === "string" ? encodeQr(input, options) : input;

  const margin = options.margin ?? 4;
  if (!Number.isFinite(margin) || margin < 0) {
    throw new RangeError(`QR margin must be a non-negative number, got ${String(options.margin)}.`);
  }
  if (options.size !== undefined && (!Number.isFinite(options.size) || options.size <= 0)) {
    throw new RangeError(`QR size must be a positive number of pixels, got ${String(options.size)}.`);
  }

  const color = options.color ?? "#000000";
  const background = options.background ?? "#ffffff";
  const shape = options.shape ?? "square";
  const extent = matrix.size + margin * 2;

  const dimensions =
    options.size === undefined ? "" : ` width="${options.size}" height="${options.size}"`;

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${extent} ${extent}"${dimensions}` +
      ` shape-rendering="${shape === "square" ? "crispEdges" : "geometricPrecision"}" role="img">`,
  ];

  if (background !== "transparent" && background !== "none") {
    parts.push(`<rect width="${extent}" height="${extent}" fill="${escapeAttribute(background)}"/>`);
  }

  parts.push(renderModules(matrix, margin, shape, color));
  parts.push("</svg>");
  return parts.join("");
}

/**
 * Same as {@link qrToSvg}, wrapped in a `data:image/svg+xml` URI ready for an
 * `<img src>` or a CSS background.
 *
 * Percent-encoded rather than base64: `btoa` is not on every runtime this core
 * targets, the encoding survives being pasted into a stylesheet, and it stays
 * readable in a diff.
 */
export function qrToDataUri(input: QrMatrix | string, options: QrSvgOptions & EncodeQrOptions = {}): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrToSvg(input, options))}`;
}

/**
 * Draws the dark modules.
 *
 * Squares become a single `<path>` - one element for the whole symbol, which is
 * both far smaller than a thousand `<rect>`s and free of the hairline seams
 * that adjacent rects show at fractional zoom levels. The other shapes need one
 * element each by construction.
 */
function renderModules(matrix: QrMatrix, margin: number, shape: NonNullable<QrSvgOptions["shape"]>, color: string): string {
  const fill = escapeAttribute(color);

  if (shape === "square") {
    let path = "";
    for (let y = 0; y < matrix.size; y += 1) {
      for (let x = 0; x < matrix.size; x += 1) {
        if (!matrix.modules[y * matrix.size + x]) continue;
        path += `M${x + margin} ${y + margin}h1v1h-1z`;
      }
    }
    return path.length === 0 ? "" : `<path fill="${fill}" d="${path}"/>`;
  }

  const shapes: string[] = [];
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (!matrix.modules[y * matrix.size + x]) continue;
      shapes.push(
        shape === "dots"
          ? `<circle cx="${x + margin + 0.5}" cy="${y + margin + 0.5}" r="0.5"/>`
          : `<rect x="${x + margin}" y="${y + margin}" width="1" height="1" rx="0.3"/>`,
      );
    }
  }
  return shapes.length === 0 ? "" : `<g fill="${fill}">${shapes.join("")}</g>`;
}

/** Escapes a value going into a double-quoted XML attribute. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
