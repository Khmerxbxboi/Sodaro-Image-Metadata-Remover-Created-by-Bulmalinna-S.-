  const MAX_MEGA_PIXELS = 40; // safety cap ~40MP (~8000x5000). Adjust if needed.
  const JPEG_QUALITY = 0.92;  // 0.8–0.95 is usually great

  const statusEl = document.getElementById('status');

  document.getElementById('download-button').addEventListener('click', handleDownload);

  async function handleDownload() {
    const files = document.getElementById('file-input').files;
    if (!files.length) {
      alert("Please select images first.");
      return;
    }

    // Defensive: limit to images
    const images = Array.from(files).filter(f => /^image\//i.test(f.type));
    if (!images.length) {
      alert("No valid images found.");
      return;
    }

    setStatus(`Processing ${images.length} image(s)...`);
    const zip = new JSZip();

    // Process sequentially to keep memory low
    for (let i = 0; i < images.length; i++) {
      const file = images[i];
      setStatus(`Processing ${i + 1} of ${images.length}: ${file.name}`);
      try {
        const blob = await processImage(file);
        const safeName = sanitizeName(file.name) || `image_${i + 1}.jpg`;
        zip.file(safeName.replace(/\.[^.]+$/, '') + '.jpg', blob);
      } catch (err) {
        console.error('Failed to process', file.name, err);
        // Skip this file but continue with others
      }
    }

    setStatus('Building ZIP...');
    const content = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });

    const downloadLink = document.createElement("a");
    downloadLink.href = URL.createObjectURL(content);
    downloadLink.download = "images_without_metadata.zip";
    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
    // Give the browser a tick to start download before revoking
    setTimeout(() => URL.revokeObjectURL(downloadLink.href), 10);

    setStatus('Done.');
  }

  function sanitizeName(name) {
    return name.replace(/[^\w.\-]+/g, '_').slice(0, 180);
  }

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
  }

  async function processImage(file) {
    // Create object URL to avoid big base64 strings in memory
    const url = URL.createObjectURL(file);
    try {
      // Prefer createImageBitmap for performance & memory; fallback to HTMLImageElement
      const { bitmap, width, height, closeBitmap } = await loadBitmap(url);

      // Downscale if too large (based on total pixels)
      const maxPixels = MAX_MEGA_PIXELS * 1_000_000;
      const { targetW, targetH } = fitWithinPixels(width, height, maxPixels);

      // OffscreenCanvas if available (saves layout thrash), else normal canvas
      const canvas = createCanvas(targetW, targetH);
      const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false });

      // Draw (this strips metadata). If we needed EXIF orientation correction,
      // we could add it here; this version focuses on robustness & stripping.
      if (bitmap) {
        ctx.drawImage(bitmap, 0, 0, targetW, targetH);
      } else {
        // Should not happen (we always return bitmap or throw), but guard anyway
        throw new Error('No image source to draw.');
      }

      // Convert to JPEG Blob (this also removes EXIF)
      const blob = await canvasToJpeg(canvas, JPEG_QUALITY);

      // Cleanup bitmap to free memory
      closeBitmap?.();

      return blob;
    } finally {
      // Always revoke URL
      URL.revokeObjectURL(url);
    }
  }

  function fitWithinPixels(w, h, maxPixels) {
    const pixels = w * h;
    if (pixels <= maxPixels) return { targetW: w, targetH: h };
    const scale = Math.sqrt(maxPixels / pixels);
    return {
      targetW: Math.max(1, Math.floor(w * scale)),
      targetH: Math.max(1, Math.floor(h * scale))
    };
  }

  function createCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') {
      return new OffscreenCanvas(w, h);
    }
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function canvasToJpeg(canvas, quality) {
    return new Promise((resolve, reject) => {
      // OffscreenCanvas uses convertToBlob; HTMLCanvas uses toBlob
      if (canvas.convertToBlob) {
        canvas.convertToBlob({ type: 'image/jpeg', quality })
          .then(resolve, reject);
      } else {
        canvas.toBlob(blob => {
          if (blob) resolve(blob);
          else reject(new Error('Canvas toBlob failed.'));
        }, 'image/jpeg', quality);
      }
    });
  }

  async function loadBitmap(url) {
    // Attempt createImageBitmap for best performance
    if (typeof createImageBitmap === 'function') {
      const img = await fetch(url).then(r => r.blob());
      const bitmap = await createImageBitmap(img); // browser-decoded; metadata ignored
      return {
        bitmap,
        width: bitmap.width,
        height: bitmap.height,
        closeBitmap: () => bitmap.close && bitmap.close()
      };
    }

    // Fallback to HTMLImageElement
    const imgEl = await loadImageElement(url);
    // Wrap into a CanvasImageSource-like object
    return {
      bitmap: imgEl,
      width: imgEl.naturalWidth,
      height: imgEl.naturalHeight,
      closeBitmap: null
    };
  }

  function loadImageElement(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      // For local file object URLs CORS is not needed.
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(new Error('Image load failed'));
      img.src = url;
      // For Safari, decode() helps prevent layout jank; ignore if unsupported
      if (img.decode) {
        img.decode().then(() => resolve(img)).catch(() => {/* onload will handle */});
      }
    });
  }