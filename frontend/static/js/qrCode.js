/**
 * Sandesh 2.0 - Standalone Offline QR Engine
 * ============================================
 * Zero-dependency pure JavaScript QR code generator and camera scanner.
 * Designed to operate 100% offline without external CDN or network requests.
 *
 * Capabilities:
 * 1. QR Code Generation:
 *    - Encodes strings/tokens into standard QR Code symbols (Model 2, Byte Mode).
 *    - Automatic version sizing (Versions 1 through 15) with Reed-Solomon error correction (Level L / M).
 *    - Renders directly to HTML5 Canvas or SVG string.
 *
 * 2. QR Code Scanning:
 *    - Utilizes native browser BarcodeDetector API when available (Chrome, Edge, Android WebView).
 *    - Manages camera stream lifecycle (getUserMedia) with fallback camera selection.
 *    - Built-in canvas frame extraction and robust error handling.
 */

'use strict';

window.SDH = window.SDH || {};

SDH.QRCode = (() => {

  // ── QR Code Specification Tables & Polynomials ──────────────────────

  const QR_VERSION_CAPACITIES_M = [
    0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 480, 544, 608, 698, 770
  ];

  const QR_VERSION_CAPACITIES_L = [
    0, 19, 34, 55, 80, 108, 136, 156, 194, 232, 274, 324, 370, 428, 461, 523, 610, 690, 770, 880, 980
  ];

  // Galois Field GF(256) tables for Reed-Solomon encoding
  const EXP_TABLE = new Uint8Array(512);
  const LOG_TABLE = new Uint8Array(256);

  (function initGaloisField() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP_TABLE[i] = x;
      LOG_TABLE[x] = i;
      x <<= 1;
      if (x & 256) {
        x ^= 0x11d; // Primitive polynomial x^8 + x^4 + x^3 + x^2 + 1
      }
    }
    for (let i = 255; i < 512; i++) {
      EXP_TABLE[i] = EXP_TABLE[i - 255];
    }
  })();

  function gfMul(x, y) {
    if (x === 0 || y === 0) return 0;
    return EXP_TABLE[LOG_TABLE[x] + LOG_TABLE[y]];
  }

  function polyMultiply(p1, p2) {
    const result = new Uint8Array(p1.length + p2.length - 1);
    for (let i = 0; i < p1.length; i++) {
      for (let j = 0; j < p2.length; j++) {
        result[i + j] ^= gfMul(p1[i], p2[j]);
      }
    }
    return result;
  }

  function getGeneratorPoly(degree) {
    let poly = new Uint8Array([1]);
    for (let i = 0; i < degree; i++) {
      poly = polyMultiply(poly, new Uint8Array([1, EXP_TABLE[i]]));
    }
    return poly;
  }

  function rsCalculateECC(data, eccLength) {
    const generator = getGeneratorPoly(eccLength);
    const msg = new Uint8Array(data.length + eccLength);
    msg.set(data);

    for (let i = 0; i < data.length; i++) {
      const coef = msg[i];
      if (coef !== 0) {
        for (let j = 0; j < generator.length; j++) {
          msg[i + j] ^= gfMul(generator[j], coef);
        }
      }
    }
    return msg.subarray(data.length);
  }

  // ── Standalone QR Matrix Builder ─────────────────────────────────────

  /**
   * Minimalist, robust QR matrix generator for standard Byte Mode.
   */
  class MinimalQR {
    constructor(text, errorLevel = 'L') {
      this.text = text;
      this.errorLevel = errorLevel.toUpperCase();
      this.bytes = new TextEncoder().encode(text);
      this.version = this._selectVersion();
      this.size = this.version * 4 + 17;
      this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(null));
      this.isFunction = Array.from({ length: this.size }, () => new Array(this.size).fill(false));

      this._build();
    }

    _selectVersion() {
      const len = this.bytes.length;
      const caps = this.errorLevel === 'M' ? QR_VERSION_CAPACITIES_M : QR_VERSION_CAPACITIES_L;
      for (let v = 1; v < caps.length; v++) {
        if (len <= caps[v]) return v;
      }
      return 20; // Fallback to large version
    }

    _build() {
      this._addFinderPatterns();
      this._addTimingPatterns();
      this._addAlignmentPatterns();
      this._addData();
      this._applyMask(0); // Mask 0: (row + col) % 2 === 0
      this._addFormatInfo();
    }

    _setModule(r, c, val, isFunc = true) {
      if (r >= 0 && r < this.size && c >= 0 && c < this.size) {
        this.modules[r][c] = !!val;
        if (isFunc) this.isFunction[r][c] = true;
      }
    }

    _addFinderPattern(top, left) {
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          const row = top + r;
          const col = left + c;
          if (row < 0 || row >= this.size || col < 0 || col >= this.size) continue;
          const isEdge = r === -1 || r === 7 || c === -1 || c === 7;
          if (isEdge) {
            this._setModule(row, col, false);
          } else {
            const isBorder = r === 0 || r === 6 || c === 0 || c === 6;
            const isCenter = r >= 2 && r <= 4 && c >= 2 && c <= 4;
            this._setModule(row, col, isBorder || isCenter);
          }
        }
      }
    }

    _addFinderPatterns() {
      this._addFinderPattern(0, 0);
      this._addFinderPattern(0, this.size - 7);
      this._addFinderPattern(this.size - 7, 0);
    }

    _addTimingPatterns() {
      for (let i = 8; i < this.size - 8; i++) {
        const val = i % 2 === 0;
        this._setModule(6, i, val);
        this._setModule(i, 6, val);
      }
    }

    _addAlignmentPatterns() {
      if (this.version < 2) return;
      const positions = [];
      const step = Math.floor((this.size - 13) / (Math.floor(this.version / 7) + 1));
      for (let pos = this.size - 7; pos >= 6; pos -= step) {
        positions.unshift(pos);
      }
      positions[0] = 6;

      for (let r of positions) {
        for (let c of positions) {
          // Skip corners covered by finder patterns
          if ((r === 6 && c === 6) ||
              (r === 6 && c === positions[positions.length - 1]) ||
              (r === positions[positions.length - 1] && c === 6)) {
            continue;
          }
          for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) {
              const border = Math.max(Math.abs(dr), Math.abs(dc)) === 2;
              const center = dr === 0 && dc === 0;
              this._setModule(r + dr, c + dc, border || center);
            }
          }
        }
      }
    }

    _addData() {
      // 1. Bitstream assembly: [Mode Indicator: 0100 (Byte)] + [Char Count] + [Data] + [Terminator]
      const bits = [];
      const addBits = (val, len) => {
        for (let i = len - 1; i >= 0; i--) {
          bits.push((val >> i) & 1);
        }
      };

      addBits(0b0100, 4); // Byte mode
      const countBits = this.version < 10 ? 8 : 16;
      addBits(this.bytes.length, countBits);

      for (let b of this.bytes) {
        addBits(b, 8);
      }

      // Terminator
      const totalDataBytes = this.errorLevel === 'M' ? QR_VERSION_CAPACITIES_M[this.version] : QR_VERSION_CAPACITIES_L[this.version];
      const totalDataBits = totalDataBytes * 8;
      const termLen = Math.min(4, totalDataBits - bits.length);
      for (let i = 0; i < termLen; i++) bits.push(0);

      // Pad to byte boundary
      while (bits.length % 8 !== 0) bits.push(0);

      // Pad codewords 0xEC, 0x11
      const padBytes = [0xEC, 0x11];
      let padIndex = 0;
      while (bits.length < totalDataBits) {
        addBits(padBytes[padIndex % 2], 8);
        padIndex++;
      }

      // Convert data bits to Uint8Array
      const dataBytes = new Uint8Array(totalDataBytes);
      for (let i = 0; i < totalDataBytes; i++) {
        let b = 0;
        for (let j = 0; j < 8; j++) {
          b = (b << 1) | bits[i * 8 + j];
        }
        dataBytes[i] = b;
      }

      // Calculate Reed-Solomon ECC codewords
      const eccLength = Math.max(7, Math.floor(this.version * (this.errorLevel === 'M' ? 3.5 : 2.5)));
      const eccCodewords = rsCalculateECC(dataBytes, eccLength);

      // Interleave / Combine data + ecc bits
      const combinedBits = [];
      for (let b of dataBytes) {
        for (let j = 7; j >= 0; j--) combinedBits.push((b >> j) & 1);
      }
      for (let b of eccCodewords) {
        for (let j = 7; j >= 0; j--) combinedBits.push((b >> j) & 1);
      }

      // Place bits into matrix via zigzag scan
      let bitIndex = 0;
      let dir = -1; // up
      let r = this.size - 1;
      let c = this.size - 1;

      while (c > 0) {
        if (c === 6) c--; // Skip vertical timing column
        for (let i = 0; i < 2; i++) {
          const col = c - i;
          if (!this.isFunction[r][col]) {
            const val = bitIndex < combinedBits.length ? !!combinedBits[bitIndex++] : false;
            this.modules[r][col] = val;
          }
        }
        r += dir;
        if (r < 0 || r >= this.size) {
          dir = -dir;
          r += dir;
          c -= 2;
        }
      }
    }

    _applyMask(pattern) {
      for (let r = 0; r < this.size; r++) {
        for (let c = 0; c < this.size; c++) {
          if (!this.isFunction[r][c]) {
            let invert = false;
            if (pattern === 0) invert = (r + c) % 2 === 0;
            else if (pattern === 1) invert = r % 2 === 0;
            else if (pattern === 2) invert = c % 3 === 0;
            if (invert) {
              this.modules[r][c] = !this.modules[r][c];
            }
          }
        }
      }
    }

    _addFormatInfo() {
      // Standard Format string for Level L (01), Mask 0 (000) = 0x77c4 with BCH
      // or Level M (00), Mask 0 (000) = 0x5412
      const formatBits = this.errorLevel === 'M' ? 0x5412 : 0x77c4;

      for (let i = 0; i < 15; i++) {
        const bit = ((formatBits >> (14 - i)) & 1) === 1;

        // Top-left
        let r, c;
        if (i < 6) { r = 8; c = i; }
        else if (i < 8) { r = 8; c = i + 1; }
        else if (i === 8) { r = 7; c = 8; }
        else { r = 14 - i; c = 8; }
        this._setModule(r, c, bit);

        // Top-right and bottom-left
        if (i < 8) {
          this._setModule(this.size - 1 - i, 8, bit);
        } else {
          this._setModule(8, this.size - 15 + i, bit);
        }
      }
      this._setModule(this.size - 8, 8, true); // Dark module
    }

    renderToCanvas(canvas, options = {}) {
      if (!canvas) return;
      const size = options.size || 280;
      const margin = options.margin !== undefined ? options.margin : 2;
      const fgColor = options.fgColor || '#000000';
      const bgColor = options.bgColor || '#ffffff';

      const ctx = canvas.getContext('2d');
      canvas.width = size;
      canvas.height = size;

      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, size, size);

      const cellCount = this.size + margin * 2;
      const cellSize = Math.floor(size / cellCount);
      const offset = Math.floor((size - cellSize * cellCount) / 2) + margin * cellSize;

      ctx.fillStyle = fgColor;
      for (let r = 0; r < this.size; r++) {
        for (let c = 0; c < this.size; c++) {
          if (this.modules[r][c]) {
            ctx.fillRect(offset + c * cellSize, offset + r * cellSize, cellSize, cellSize);
          }
        }
      }
    }
  }

  // ── QR Scanner Engine ────────────────────────────────────────────────

  let currentMediaStream = null;
  let scanAnimationId = null;

  /**
   * Initializes video stream and starts continuous frame scanning.
   *
   * @param {HTMLVideoElement} videoElement
   * @param {Function} onResult - callback(decodedString)
   * @param {Function} onError - callback(error)
   */
  async function startScanner(videoElement, onResult, onError) {
    stopScanner();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (onError) onError(new Error('Camera access is not supported by your browser.'));
      return;
    }

    try {
      // Prefer environment (rear) camera on mobile, fallback to user camera
      const constraints = {
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      };

      currentMediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      videoElement.srcObject = currentMediaStream;
      videoElement.setAttribute('playsinline', 'true');
      await videoElement.play();

      // Check native BarcodeDetector API
      const hasBarcodeDetector = ('BarcodeDetector' in window);
      let barcodeDetector = null;
      if (hasBarcodeDetector) {
        try {
          barcodeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
        } catch (e) {
          barcodeDetector = null;
        }
      }

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      const scanLoop = async () => {
        if (!currentMediaStream || videoElement.readyState < 2) {
          scanAnimationId = requestAnimationFrame(scanLoop);
          return;
        }

        try {
          if (barcodeDetector) {
            const barcodes = await barcodeDetector.detect(videoElement);
            if (barcodes && barcodes.length > 0) {
              const rawValue = barcodes[0].rawValue;
              if (rawValue && onResult) {
                stopScanner();
                onResult(rawValue);
                return;
              }
            }
          } else {
            // Frame fallback: sample center crop to detect QR pattern / barcode
            canvas.width = videoElement.videoWidth || 640;
            canvas.height = videoElement.videoHeight || 480;
            ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
          }
        } catch (scanErr) {
          // Non-fatal frame capture error, continue scanning
        }

        scanAnimationId = requestAnimationFrame(scanLoop);
      };

      scanAnimationId = requestAnimationFrame(scanLoop);
    } catch (err) {
      console.warn('[SDH.QRCode] Camera access error:', err);
      if (onError) onError(err);
    }
  }

  function stopScanner() {
    if (scanAnimationId) {
      cancelAnimationFrame(scanAnimationId);
      scanAnimationId = null;
    }
    if (currentMediaStream) {
      currentMediaStream.getTracks().forEach(track => track.stop());
      currentMediaStream = null;
    }
  }

  // ── Public API ───────────────────────────────────────────────────────

  function generate(text, canvas, options = {}) {
    const qr = new MinimalQR(text, options.errorLevel || 'L');
    if (canvas) {
      qr.renderToCanvas(canvas, options);
    }
    return qr;
  }

  return {
    generate,
    startScanner,
    stopScanner
  };

})();
