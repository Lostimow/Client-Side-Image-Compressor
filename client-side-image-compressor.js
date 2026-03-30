/**
   Client-Side-Image-Compressor
   Pure client-side image compression engine
   Zero server calls, zero dependencies, zero external files

   IMPORTANT NOTE ABOUT WEB WORKERS:
   A Web Worker is NOT a server. It's a second thread that runs entirely
   inside the user's browser, on the user's CPU, using the user's RAM.
   No network request is made. No data leaves the machine. Ever.
   It's a native browser API, just like localStorage or setTimeout.
   We use it here so the heavy pixel math doesn't freeze the UI.

   HOW THE 5-PHASE PIPELINE WORKS:
   Phase 1 - Format Negotiation: test AVIF > WebP > JPEG, pick the best
   Phase 2 - Binary Quality Search: find the highest quality that fits
   Phase 3 - Progressive Step-Down Resize: shrink by halves, not brute force
   Phase 4 - Convolution Sharpening: compensate the blur from downscaling
   Phase 5 - Quality Boost: if we're under target, push quality back up

   @param {HTMLCanvasElement|HTMLImageElement|ImageBitmap|Blob|File} source The image to compress. Accepts pretty much any visual source the browser can handle.
   @param {Object}   [options] Configuration object
   @param {number}   [options.targetSizeKB=500] Target file size in KB
   @param {string}   [options.format='auto'] 'auto' picks the best, or force: 'image/avif', 'image/webp', 'image/jpeg', 'image/png'
   @param {number}   [options.maxWidth=Infinity] Max output width in px
   @param {number}   [options.maxHeight=Infinity] Max output height in px
   @param {number}   [options.minQuality=0.10] Quality floor (0 to 1)
   @param {number}   [options.maxQuality=0.92] Quality ceiling (0 to 1)
   @param {number}   [options.sharpen=0.3] Sharpening strength, 0 = off, 0.1 to 0.6 = reasonable
   @param {boolean}  [options.preserveDisplayP3=true] Keep wide-gamut colors
   @param {Function} [options.onProgress] Callback (phase, detail) for real-time updates
   @returns {Promise<OptimizerResult>}
*/
async function ultimateImageOptimizer(source, options = {}) {

    // Start the global timer so we can report total execution time later
    const t0 = performance.now();
    const phaseTimes = {};

    // Clamp a value between min and max
    function clamp(v, min, max) {
        return Math.min(max, Math.max(min, v));
    }

    /**
       Merge user options with sensible defaults
       Object.freeze prevents accidental mutation during the pipeline
    */
    const config = Object.freeze({
        targetSizeKB:      Math.max(1, options.targetSizeKB ?? 500),
        format:            options.format ?? 'auto',
        maxWidth:          options.maxWidth ?? Infinity,
        maxHeight:         options.maxHeight ?? Infinity,
        minQuality:        clamp(options.minQuality ?? 0.10, 0.01, 1),
        maxQuality:        clamp(options.maxQuality ?? 0.92, 0.01, 1),
        sharpen:           clamp(options.sharpen ?? 0.3, 0, 1),
        preserveDisplayP3: options.preserveDisplayP3 ?? true,
        onProgress:        typeof options.onProgress === 'function' ? options.onProgress : null,
    });

    /**
       Safely call the user's progress callback if provided
       Wrapped in try/catch so a buggy callback can't crash the engine
    */
    const progress = (phase, detail) => {
        if (config.onProgress) {
            try { config.onProgress(phase, detail); } catch (_) {}
        }
    };


    /**
       PHASE 0: NORMALIZE THE SOURCE INTO AN ImageBitmap
       ImageBitmap is a browser-native object that can be transferred
       to a Web Worker with ZERO memory copy (Transferable Object).
       Whether the user gives us a File, a Blob, an <img> tag or a
       <canvas>, we convert it to ImageBitmap first.
    */
    progress('init', 'Normalizing the source...');
    const tP0 = performance.now();

    let bitmap;
    if (source instanceof ImageBitmap) {
        bitmap = source;
    } else if (source instanceof Blob || source instanceof File) {
        bitmap = await createImageBitmap(source);
    } else {
        bitmap = await createImageBitmap(source);
    }

    const originalWidth  = bitmap.width;
    const originalHeight = bitmap.height;

    /**
       Apply maxWidth/maxHeight constraints right away
       If the source is 6000x4000 and maxWidth is 1920, we scale down
       proportionally before entering the pipeline to avoid wasting CPU
       on pixels that would get thrown away anyway
    */
    let startW = originalWidth;
    let startH = originalHeight;
    if (startW > config.maxWidth || startH > config.maxHeight) {
        const scale = Math.min(config.maxWidth / startW, config.maxHeight / startH);
        startW = Math.round(startW * scale);
        startH = Math.round(startH * scale);
    }

    phaseTimes.init = performance.now() - tP0;


    /**
       BUILD THE INLINE WEB WORKER
       Instead of loading an external .js file, we embed the entire
       worker code as a string, turn it into a Blob, create a URL
       from that Blob and spawn a Worker from it.

       Why? Because this keeps the whole engine in a single file.
       No extra HTTP request, no CORS issue, no file path to manage.

       REMINDER: This Web Worker runs 100% inside the browser.
       It's a second thread on the user's CPU. Not a server.
       Not a cloud function. Not an API call. Pure client-side.
    */
    const workerSource = buildWorkerSource();
    const workerBlob   = new Blob([workerSource], { type: 'application/javascript' });
    const workerUrl    = URL.createObjectURL(workerBlob);
    const worker       = new Worker(workerUrl);


    /**
       COMMUNICATION WITH THE WORKER
       We send the ImageBitmap using postMessage with a "transfer list"
       [bitmap]. This transfers ownership to the worker WITHOUT copying.
       The worker sends back progress messages and one final message
       with the compressed blob.
    */
    return new Promise((resolve, reject) => {

        // Safety timeout: if something goes catastrophically wrong we don't hang forever
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Timeout: compression exceeded 30 seconds.'));
        }, 30_000);

        worker.onmessage = (e) => {
            const r = e.data;

            if (r.error) {
                clearTimeout(timeout);
                cleanup();
                reject(new Error(r.error));
                return;
            }

            // Progress message, not the final result yet
            if (r.type === 'progress') {
                progress(r.phase, r.detail);
                return;
            }

            // Final result received
            clearTimeout(timeout);
            const totalTime = performance.now() - t0;

            phaseTimes.formatNegotiation = r.phaseTimes.formatNegotiation;
            phaseTimes.qualitySearch     = r.phaseTimes.qualitySearch;
            phaseTimes.resize            = r.phaseTimes.resize;
            phaseTimes.sharpen           = r.phaseTimes.sharpen;
            phaseTimes.finalEncode       = r.phaseTimes.finalEncode;

            // Estimate raw uncompressed size (RGBA = 4 bytes per pixel)
            const originalSizeEstimate = originalWidth * originalHeight * 4 / 1024;
            const finalSizeKB = Number((r.blob.size / 1024).toFixed(2));

            cleanup();

            resolve({
                blob:             r.blob,
                sizeKB:           finalSizeKB,
                width:            r.width,
                height:           r.height,
                format:           r.format,
                quality:          r.quality,
                compressionRatio: Number((originalSizeEstimate / finalSizeKB).toFixed(1)),
                timeMs:           Number(totalTime.toFixed(1)),
                phases:           phaseTimes,
            });
        };

        // If the worker crashes (syntax error, out of memory, etc.)
        worker.onerror = (err) => {
            clearTimeout(timeout);
            cleanup();
            reject(new Error(`Critical worker error: ${err.message || 'Unknown'}`));
        };

        /**
           Send the image to the worker
           The second argument [bitmap] is the "transfer list"
           This transfers the bitmap WITHOUT copying it in memory
           After this line, the bitmap is no longer usable on the main thread
        */
        worker.postMessage({
            bitmap,
            startW,
            startH,
            config: {
                targetBytes:     config.targetSizeKB * 1024,
                format:          config.format,
                minQuality:      config.minQuality,
                maxQuality:      config.maxQuality,
                sharpenStrength: config.sharpen,
                useP3:           config.preserveDisplayP3,
            }
        }, [bitmap]);

        // Kill the worker thread and free the Blob URL from memory
        function cleanup() {
            worker.terminate();
            URL.revokeObjectURL(workerUrl);
        }
    });


    /**
       WORKER SOURCE CODE
       Everything below runs inside the Web Worker thread.
       It has NO access to the DOM, NO access to window, NO access
       to the page. It only sees what we send via postMessage.

       This is NOT server code. This runs on the user's browser,
       on the user's CPU. The "Worker" name is just the API name.
    */
    function buildWorkerSource() {
        return `
"use strict";


// Clamp a number between min and max
function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}

// Send a progress update back to the main thread
function report(phase, detail) {
    self.postMessage({ type: 'progress', phase, detail });
}

// Encode an OffscreenCanvas into a compressed Blob
// The browser handles JPEG/WebP/AVIF encoding internally (native C++ code)
function encodeCanvas(canvas, format, quality) {
    return canvas.convertToBlob({ type: format, quality });
}


/**
   FORMAT DETECTION

   Check if the browser can actually encode a given format.
   We create a tiny 1x1 canvas, encode it and check the MIME type.
   Some browsers claim support but silently fall back to PNG.
   This test catches that.
*/
async function supportsFormat(format) {
    try {
        const c = new OffscreenCanvas(1, 1);
        const blob = await c.convertToBlob({ type: format, quality: 0.5 });
        return blob.type === format;
    } catch {
        return false;
    }
}


/**
   PHASE 1: FORMAT NEGOTIATION

   Pick the best encoding format this browser supports.

   Priority: AVIF > WebP > JPEG
   AVIF  = best ratio, up to 3x smaller than JPEG, but Chrome 121+ / Edge 121+ only
   WebP  = great ratio, widely supported (Chrome, Firefox, Safari 16+)
   JPEG  = universal fallback, every browser since the 90s

   If the user forced a format that isn't supported, fall back silently.
*/
async function negotiateFormat(requested) {
    if (requested !== 'auto') {
        if (await supportsFormat(requested)) return requested;
    }
    if (await supportsFormat('image/avif'))  return 'image/avif';
    if (await supportsFormat('image/webp'))  return 'image/webp';
    return 'image/jpeg';
}


/**
   PHASE 2: BINARY QUALITY SEARCH

   Find the HIGHEST encoding quality that produces a file UNDER target size.

   Instead of trying 0.9, 0.8, 0.7, 0.6... one by one (linear = slow),
   we split the range in half each time:
     Iter 1: try 0.50 -> too big  -> search 0.10 to 0.50
     Iter 2: try 0.30 -> fits     -> search 0.30 to 0.50
     Iter 3: try 0.40 -> fits     -> search 0.40 to 0.50
     Iter 4: try 0.45 -> too big  -> search 0.40 to 0.45
     ... and so on

   7 iterations = ~0.01 precision across the full 0-1 range.

   This runs BEFORE any resizing so the image keeps full resolution
   whenever quality alone can hit the target.
*/
async function binaryQualitySearch(canvas, format, targetBytes, minQ, maxQ) {
    let lo = minQ;
    let hi = maxQ;
    let bestBlob = null;
    let bestQuality = lo;
    const MAX_ITER = 7;

    for (let i = 0; i < MAX_ITER; i++) {
        const mid = (lo + hi) / 2;
        const blob = await encodeCanvas(canvas, format, mid);

        if (blob.size <= targetBytes) {
            bestBlob = blob;       // This quality fits, save it
            bestQuality = mid;
            lo = mid + 0.005;      // Try to go higher
        } else {
            hi = mid - 0.005;      // Too big, go lower
        }

        // Early exit if we're within 5% of target
        if (bestBlob && bestBlob.size >= targetBytes * 0.95) break;
    }

    return { blob: bestBlob, quality: bestQuality };
}


/**
   PHASE 3: PROGRESSIVE STEP-DOWN RESIZE

   Resize by halving dimensions progressively instead of one brutal jump.

   When you resize 4000px directly to 800px, the browser's bilinear filter
   has to average huge pixel neighborhoods in one pass = blurry garbage.

   Going 4000 -> 2000 -> 1000 -> 800, each step only halves.
   Bilinear works perfectly at 2:1 ratios because each output pixel
   maps to exactly 4 input pixels.

   This produces Lanczos-quality results without any external library.
   Sometimes called "mipmap downscaling" in the image processing world.
*/
function stepDownResize(sourceBitmap, targetW, targetH, useP3) {
    let w = sourceBitmap.width;
    let h = sourceBitmap.height;
    let canvas = new OffscreenCanvas(w, h);
    let ctx = canvas.getContext('2d', useP3 ? { colorSpace: 'display-p3' } : {});
    ctx.drawImage(sourceBitmap, 0, 0);

    // Keep halving until we can't go below target anymore
    while (w / 2 > targetW && h / 2 > targetH) {
        const nw = Math.max(1, Math.floor(w / 2));
        const nh = Math.max(1, Math.floor(h / 2));
        const step = new OffscreenCanvas(nw, nh);
        const sCtx = step.getContext('2d', useP3 ? { colorSpace: 'display-p3' } : {});
        sCtx.drawImage(canvas, 0, 0, nw, nh);
        canvas = step;
        w = nw;
        h = nh;
    }

    // Final step to exact target size (small jump, bilinear handles it fine)
    if (w !== targetW || h !== targetH) {
        const final = new OffscreenCanvas(targetW, targetH);
        const fCtx = final.getContext('2d', useP3 ? { colorSpace: 'display-p3' } : {});
        fCtx.drawImage(canvas, 0, 0, targetW, targetH);
        canvas = final;
    }

    return canvas;
}


/**
   PHASE 4: SHARPENING (UNSHARP MASK 3x3 CONVOLUTION)

   Compensates the blur introduced by downscaling.

   For each pixel, we look at its 4 direct neighbors and apply:
     output = pixel * (1 + 4*s) - s * (top + bottom + left + right)

   This amplifies the difference between a pixel and its neighbors,
   which is what "sharpness" looks like to the human eye.
   Edges get enhanced, flat areas stay mostly unchanged.

   Only R, G, B channels are processed. Alpha stays untouched.

   We work directly on raw pixel data via getImageData/putImageData.
   Lowest level of image manipulation in the browser.
   No library, no WebGL, just math on a Uint8ClampedArray.
*/
function applySharpen(canvas, strength) {
    if (strength <= 0) return canvas;

    const w = canvas.width;
    const h = canvas.height;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, w, h);
    const src = imageData.data;
    const out = new Uint8ClampedArray(src.length);

    const s = strength;
    const center = 1 + 4 * s;

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;

            for (let c = 0; c < 3; c++) {
                const idx = i + c;
                const top    = y > 0     ? src[idx - w * 4] : src[idx];
                const bottom = y < h - 1 ? src[idx + w * 4] : src[idx];
                const left   = x > 0     ? src[idx - 4]     : src[idx];
                const right  = x < w - 1 ? src[idx + 4]     : src[idx];
                const pixel  = src[idx];

                out[idx] = clamp(
                    Math.round(center * pixel - s * (top + bottom + left + right)),
                    0, 255
                );
            }

            out[i + 3] = src[i + 3]; // Alpha unchanged
        }
    }

    imageData.data.set(out);
    ctx.putImageData(imageData, 0, 0);
    return canvas;
}


/**
   MAIN PIPELINE - Everything comes together here
*/
self.onmessage = async function(e) {
    try {
        const { bitmap, startW, startH, config } = e.data;
        const { targetBytes, format: reqFormat, minQuality, maxQuality,
                sharpenStrength, useP3 } = config;
        const phaseTimes = {};


        // PHASE 1: FORMAT
        let t1 = performance.now();
        report('format', 'Negotiating optimal format...');
        const format = await negotiateFormat(reqFormat);
        phaseTimes.formatNegotiation = performance.now() - t1;


        // Initial canvas at starting dimensions
        let currentW = startW;
        let currentH = startH;
        let canvas = new OffscreenCanvas(currentW, currentH);
        let ctx = canvas.getContext('2d', useP3 ? { colorSpace: 'display-p3' } : {});

        // JPEG has no transparency, fill white or transparent areas become black
        if (format === 'image/jpeg') {
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, currentW, currentH);
        }

        ctx.drawImage(bitmap, 0, 0, currentW, currentH);


        // PHASE 2: BINARY QUALITY SEARCH
        // Try to hit target by adjusting quality ONLY, preserve full resolution
        let t2 = performance.now();
        report('quality', 'Searching for optimal quality...');
        let result = await binaryQualitySearch(canvas, format, targetBytes, minQuality, maxQuality);
        phaseTimes.qualitySearch = performance.now() - t2;

        let finalBlob    = result.blob;
        let finalQuality = result.quality;


        // PHASE 3: RESIZE (only if quality alone wasn't enough)
        let t3 = performance.now();
        phaseTimes.resize = 0;
        phaseTimes.sharpen = 0;

        if (!finalBlob || finalBlob.size > targetBytes) {

            report('resize', 'Predictive resize in progress...');

            /**
               Predictive scale factor
               File size scales with pixel area (w * h)
               Area scales with the SQUARE of linear dimension
               So: scaleFactor = sqrt(targetSize / currentSize)
               The 0.88 adds 12% safety margin, better to overshoot compression
               and boost quality back up in Phase 5
            */
            const refBlob = finalBlob || await encodeCanvas(canvas, format, minQuality);
            const scaleFactor = Math.sqrt(targetBytes / refBlob.size) * 0.88;

            currentW = Math.max(16, Math.round(currentW * scaleFactor));
            currentH = Math.max(16, Math.round(currentH * scaleFactor));

            // Step-down from the ORIGINAL bitmap (not the compressed canvas)
            canvas = stepDownResize(bitmap, currentW, currentH, useP3);

            // White background for JPEG after resize
            if (format === 'image/jpeg') {
                const temp = new OffscreenCanvas(currentW, currentH);
                const tCtx = temp.getContext('2d', useP3 ? { colorSpace: 'display-p3' } : {});
                tCtx.fillStyle = '#FFFFFF';
                tCtx.fillRect(0, 0, currentW, currentH);
                tCtx.drawImage(canvas, 0, 0);
                canvas = temp;
            }

            phaseTimes.resize = performance.now() - t3;


            // PHASE 4: SHARPENING (only after resize, no point otherwise)
            let t4 = performance.now();
            if (sharpenStrength > 0) {
                report('sharpen', 'Applying adaptive sharpening...');
                canvas = applySharpen(canvas, sharpenStrength);
            }
            phaseTimes.sharpen = performance.now() - t4;

            // New binary search on the resized canvas
            report('quality', 'Final quality optimization...');
            result = await binaryQualitySearch(canvas, format, targetBytes, minQuality, maxQuality);
            finalBlob    = result.blob || await encodeCanvas(canvas, format, minQuality);
            finalQuality = result.quality;

            // Safety loop (max 2 extra passes)
            // If predictive math was off (screenshots, flat illustrations, etc.)
            let safetyPass = 0;
            while (finalBlob.size > targetBytes && safetyPass < 2) {
                const sf = Math.sqrt(targetBytes / finalBlob.size) * 0.85;
                currentW = Math.max(16, Math.round(currentW * sf));
                currentH = Math.max(16, Math.round(currentH * sf));
                canvas = stepDownResize(bitmap, currentW, currentH, useP3);
                if (sharpenStrength > 0) canvas = applySharpen(canvas, sharpenStrength * 0.5);
                finalBlob = await encodeCanvas(canvas, format, minQuality);
                finalQuality = minQuality;
                safetyPass++;
            }
        }


        /**
           PHASE 5: QUALITY BOOST WITH REMAINING MARGIN
           If we're under target (e.g. target 500KB, we're at 320KB)
           push quality back up to use that headroom instead of wasting it
        */
        let t5 = performance.now();
        if (finalBlob.size < targetBytes * 0.7) {
            report('finalize', 'Boosting quality with remaining margin...');
            const boost = await binaryQualitySearch(canvas, format, targetBytes, finalQuality, maxQuality);
            if (boost.blob && boost.blob.size <= targetBytes) {
                finalBlob    = boost.blob;
                finalQuality = boost.quality;
            }
        }
        phaseTimes.finalEncode = performance.now() - t5;


        // Send result back to the main thread
        self.postMessage({
            blob:       finalBlob,
            width:      currentW,
            height:     currentH,
            format:     format,
            quality:    Number(finalQuality.toFixed(3)),
            phaseTimes: phaseTimes,
        });

    } catch (err) {
        self.postMessage({ error: err.message || 'Unknown error in worker.' });
    }
};
`;
    }
}


/**
   BATCH PROCESSING WITH CONCURRENCY CONTROL

   Compress multiple images in parallel with controlled concurrency.
   Instead of processing 50 images one by one (slow) or all at once
   (will crash the browser), this runs N images in parallel where N
   defaults to the number of CPU cores available.

   Each image gets its own Web Worker, so they truly run in parallel.
   On a 4-core phone = 4 images at once. 8-core desktop = 8 at once.

   @param {Array<{source: *, options?: Object}>} items
   @param {number} [concurrency]       Defaults to navigator.hardwareConcurrency or 4
   @param {Function} [onItemComplete]  Callback (index, result|error) after each image
   @returns {Promise<Array<OptimizerResult|Error>>}
*/
async function batchOptimize(items, concurrency, onItemComplete) {
    const maxConcurrency = concurrency ?? (navigator.hardwareConcurrency || 4);
    const results = new Array(items.length);
    let cursor = 0;

    // Each runner grabs the next unprocessed item and compresses it
    // Multiple runners work in parallel
    async function runNext() {
        while (cursor < items.length) {
            const idx = cursor++;
            try {
                results[idx] = await ultimateImageOptimizer(items[idx].source, items[idx].options || {});
            } catch (err) {
                results[idx] = err instanceof Error ? err : new Error(String(err));
            }
            if (onItemComplete) {
                try { onItemComplete(idx, results[idx]); } catch (_) {}
            }
        }
    }

    // Spawn N concurrent runners
    const workers = Array.from(
        { length: Math.min(maxConcurrency, items.length) },
        () => runNext()
    );
    await Promise.all(workers);
    return results;
}


/**
   USAGE EXAMPLES (uncomment to try)
*/

/*
// Single image
const input = document.querySelector('input[type="file"]');
input.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const result = await ultimateImageOptimizer(file, {
        targetSizeKB: 200,
        format: 'auto',
        maxWidth: 1920,
        sharpen: 0.3,
        onProgress: (phase, detail) => console.log(`[${phase}] ${detail}`),
    });

    console.log(`Done: ${result.sizeKB} KB | ${result.width}x${result.height} | ${result.format}`);
    console.log(`Time: ${result.timeMs}ms | Ratio: x${result.compressionRatio}`);

    const url = URL.createObjectURL(result.blob);
    document.getElementById('preview').src = url;
});

// Batch
const files = Array.from(document.querySelector('#multi').files);
const items = files.map(f => ({ source: f, options: { targetSizeKB: 300 } }));

const results = await batchOptimize(items, 4, (i, r) => {
    if (r instanceof Error) console.error(`Failed image ${i}: ${r.message}`);
    else console.log(`Image ${i}: ${r.sizeKB} KB`);
});
*/