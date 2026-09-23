/**
 * Sandesh 2.0 - Universal Offline QR Code Engine
 * ==================================================
 * 100% Offline, Zero-External-Network QR Code Generator & Scanner.
 *
 * Capabilities:
 * 1. Standard ISO/IEC 18004 QR Generation:
 *    - Powered by the JIS X 0510 / ISO 18004 compliant engine (`qrcode.min.js`).
 *    - Supports all standard QR versions (1 through 40) with Reed-Solomon ECC.
 *    - High-contrast, sharp rendering on HTML5 Canvas with proper quiet zone margin.
 *
 * 2. Universal Dual-Engine Camera Scanner:
 *    - Engine 1: Native BarcodeDetector API (hardware-accelerated on supported browsers).
 *    - Engine 2: Pure-JS `jsQR` Engine (`jsQR.min.js`) for iOS Safari, Firefox, and all
 *      browsers without BarcodeDetector support.
 *    - Throttled sampling loop for 60 FPS video smoothness with low CPU/battery consumption.
 *
 * 3. Advanced Mobile Controls:
 *    - Camera Flipping (Back / Environment camera <-> Front / User camera).
 *    - Flashlight / Torch toggle for low-light scanning.
 *    - Photo / Image File scanning from the device gallery.
 */

'use strict';

window.SDH = window.SDH || {};

SDH.QRCode = (() => {

  let currentMediaStream = null;
  let scanAnimationId = null;
  let isScanning = false;
  let currentFacingMode = 'environment';
  let isTorchOn = false;
  let offscreenCanvas = null;
  let offscreenCtx = null;
  let nativeBarcodeDetector = null;

  // Initialize offscreen canvas for frame extraction
  function _getOffscreenCanvas() {
    if (!offscreenCanvas) {
      offscreenCanvas = document.createElement('canvas');
      offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
    }
    return { canvas: offscreenCanvas, ctx: offscreenCtx };
  }

  // Check and initialize native BarcodeDetector if available
  function _initBarcodeDetector() {
    if (nativeBarcodeDetector) return nativeBarcodeDetector;
    if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
      try {
        nativeBarcodeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch (err) {
        nativeBarcodeDetector = null;
      }
    }
    return nativeBarcodeDetector;
  }

  // ── 1. QR Code Generation ─────────────────────────────────────────────

  /**
   * Generates a standard ISO/IEC 18004 QR code on an HTML5 canvas.
   *
   * @param {string} text - The payload string or token to encode
   * @param {HTMLCanvasElement} canvas - Target canvas element
   * @param {Object} options - { size: 260, margin: 4, errorLevel: 'M', fgColor: '#000', bgColor: '#fff' }
   */
  function generate(text, canvas, options = {}) {
    if (!text) {
      console.warn('[SDH.QRCode] generate called with empty text.');
      return;
    }

    const errorLevel = options.errorLevel || 'M'; // 'L', 'M', 'Q', 'H'
    const size = options.size || 260;
    const margin = options.margin !== undefined ? options.margin : 4; // ISO quiet zone
    const fgColor = options.fgColor || '#000000';
    const bgColor = options.bgColor || '#ffffff';

    // Verify qrcode library is loaded
    const qrcodeFn = typeof window !== 'undefined' && window.qrcode ? window.qrcode : null;

    if (!qrcodeFn) {
      console.error('[SDH.QRCode] qrcode library (qrcode.min.js) is not loaded.');
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fee2e2';
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = '#991b1b';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('QR Engine Unavailable', size / 2, size / 2);
      }
      return;
    }

    try {
      // Type number 0 auto-detects minimum required version
      const qr = qrcodeFn(0, errorLevel);
      qr.addData(text);
      qr.make();

      if (canvas) {
        const moduleCount = qr.getModuleCount();
        const totalModules = moduleCount + margin * 2;
        const cellSize = Math.max(1, Math.floor(size / totalModules));
        const renderedSize = cellSize * totalModules;

        canvas.width = renderedSize;
        canvas.height = renderedSize;
        canvas.style.width = size + 'px';
        canvas.style.height = size + 'px';

        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;

        // Draw crisp background
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, renderedSize, renderedSize);

        // Draw QR modules
        ctx.fillStyle = fgColor;
        for (let row = 0; row < moduleCount; row++) {
          for (let col = 0; col < moduleCount; col++) {
            if (qr.isDark(row, col)) {
              ctx.fillRect(
                (col + margin) * cellSize,
                (row + margin) * cellSize,
                cellSize,
                cellSize
              );
            }
          }
        }
      }

      return qr;
    } catch (err) {
      console.error('[SDH.QRCode] Error generating QR code:', err);
      throw err;
    }
  }

  // ── 2. Universal Dual-Engine QR Scanner ───────────────────────────────

  /**
   * Starts real-time camera scanning with automatic dual-engine decoding.
   *
   * @param {HTMLVideoElement} videoElement
   * @param {Function} onResult - callback(decodedString)
   * @param {Function} onError - callback(error)
   */
  async function startScanner(videoElement, onResult, onError) {
    stopScanner();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const err = new Error('Camera access is not supported by your browser.');
      if (onError) onError(err);
      return;
    }

    try {
      isScanning = true;
      isTorchOn = false;

      const constraints = {
        video: {
          facingMode: { ideal: currentFacingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      };

      currentMediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      videoElement.srcObject = currentMediaStream;
      videoElement.setAttribute('playsinline', 'true');
      videoElement.setAttribute('autoplay', 'true');
      videoElement.muted = true;

      try {
        await videoElement.play();
      } catch (playErr) {
        console.warn('[SDH.QRCode] Video autoplay notice:', playErr);
      }

      const detector = _initBarcodeDetector();
      const { canvas, ctx } = _getOffscreenCanvas();

      let lastScanTime = 0;
      const SCAN_INTERVAL_MS = 40; // ~25 scans/sec (optimal for mobile responsiveness & battery)

      const scanLoop = async () => {
        if (!isScanning || !currentMediaStream) return;

        const now = Date.now();
        if (now - lastScanTime >= SCAN_INTERVAL_MS) {
          lastScanTime = now;

          if (videoElement.readyState >= 2 && videoElement.videoWidth > 0) {
            let detectedText = null;

            // Strategy 1: Fast hardware BarcodeDetector if available
            if (detector) {
              try {
                const barcodes = await detector.detect(videoElement);
                if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
                  detectedText = barcodes[0].rawValue;
                }
              } catch (e) {
                // If native detector fails or throws on frame, fallback to jsQR
              }
            }

            // Strategy 2: Pure-JS jsQR Engine (universal across all browsers & iOS)
            if (!detectedText && typeof window !== 'undefined' && window.jsQR) {
              try {
                const vw = videoElement.videoWidth;
                const vh = videoElement.videoHeight;

                // Scale down large frames (max dimension 640px) for high-speed analysis
                const maxDim = 640;
                let targetW = vw;
                let targetH = vh;
                if (vw > maxDim || vh > maxDim) {
                  if (vw >= vh) {
                    targetW = maxDim;
                    targetH = Math.round((vh / vw) * maxDim);
                  } else {
                    targetH = maxDim;
                    targetW = Math.round((vw / vh) * maxDim);
                  }
                }

                canvas.width = targetW;
                canvas.height = targetH;
                ctx.drawImage(videoElement, 0, 0, targetW, targetH);

                const imageData = ctx.getImageData(0, 0, targetW, targetH);
                const code = window.jsQR(imageData.data, targetW, targetH, {
                  inversionAttempts: 'attemptBoth'
                });

                if (code && code.data) {
                  detectedText = code.data;
                }
              } catch (jsQrErr) {
                // Ignore transient frame extraction errors
              }
            }

            if (detectedText) {
              console.log('[SDH.QRCode] Successfully scanned QR code!');
              stopScanner();
              if (onResult) onResult(detectedText);
              return;
            }
          }
        }

        scanAnimationId = requestAnimationFrame(scanLoop);
      };

      scanAnimationId = requestAnimationFrame(scanLoop);

    } catch (err) {
      console.warn('[SDH.QRCode] Camera access error:', err);
      isScanning = false;
      if (onError) onError(err);
    }
  }

  /**
   * Stops camera streams and cancels scanning loop.
   */
  function stopScanner() {
    isScanning = false;
    if (scanAnimationId) {
      cancelAnimationFrame(scanAnimationId);
      scanAnimationId = null;
    }
    if (currentMediaStream) {
      try {
        currentMediaStream.getTracks().forEach((track) => track.stop());
      } catch (e) { }
      currentMediaStream = null;
    }
    isTorchOn = false;
  }

  // ── 3. Mobile Camera Controls ─────────────────────────────────────────

  /**
   * Toggles camera torch/flashlight on supported mobile devices.
   *
   * @returns {Promise<boolean>} Current torch status (true = on, false = off)
   */
  async function toggleTorch() {
    if (!currentMediaStream) return false;
    const track = currentMediaStream.getVideoTracks()[0];
    if (!track) return false;

    try {
      const capabilities = track.getCapabilities ? track.getCapabilities() : {};
      if (!capabilities.torch) {
        console.log('[SDH.QRCode] Flashlight/torch is not supported on this camera.');
        return false;
      }

      isTorchOn = !isTorchOn;
      await track.applyConstraints({
        advanced: [{ torch: isTorchOn }]
      });
      return isTorchOn;
    } catch (err) {
      console.warn('[SDH.QRCode] Torch toggle error:', err);
      return false;
    }
  }

  /**
   * Flips between rear/environment and front/user camera.
   *
   * @param {HTMLVideoElement} videoElement
   * @param {Function} onResult
   * @param {Function} onError
   */
  async function switchCamera(videoElement, onResult, onError) {
    currentFacingMode = (currentFacingMode === 'environment') ? 'user' : 'environment';
    console.log('[SDH.QRCode] Switching camera facingMode to:', currentFacingMode);
    await startScanner(videoElement, onResult, onError);
    return currentFacingMode;
  }

  /**
   * Scans a QR code from an image file (e.g. user gallery / screenshot).
   *
   * @param {File|Blob} file
   * @returns {Promise<string>} Decoded string payload
   */
  function scanImageFile(file) {
    return new Promise((resolve, reject) => {
      if (!file) {
        reject(new Error('No image file selected.'));
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = async () => {
          try {
            const { canvas, ctx } = _getOffscreenCanvas();
            canvas.width = img.naturalWidth || img.width;
            canvas.height = img.naturalHeight || img.height;
            ctx.drawImage(img, 0, 0);

            // Try BarcodeDetector first
            const detector = _initBarcodeDetector();
            if (detector) {
              try {
                const barcodes = await detector.detect(canvas);
                if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
                  resolve(barcodes[0].rawValue);
                  return;
                }
              } catch (e) { }
            }

            // Fallback to jsQR
            if (typeof window !== 'undefined' && window.jsQR) {
              const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const code = window.jsQR(imageData.data, canvas.width, canvas.height, {
                inversionAttempts: 'attemptBoth'
              });
              if (code && code.data) {
                resolve(code.data);
                return;
              }
            }

            reject(new Error('No valid QR code was detected in the selected image.'));
          } catch (decodeErr) {
            reject(decodeErr);
          }
        };
        img.onerror = () => reject(new Error('Failed to load image file.'));
        img.src = reader.result;
      };
      reader.onerror = () => reject(new Error('Failed to read image file.'));
      reader.readAsDataURL(file);
    });
  }

  // ── Public API ───────────────────────────────────────────────────────

  return {
    generate,
    startScanner,
    stopScanner,
    toggleTorch,
    switchCamera,
    scanImageFile,
    isScanning: () => isScanning,
    getFacingMode: () => currentFacingMode
  };

})();
