```
██╗      ██████╗ ███████╗████████╗██╗███╗   ███╗ ██████╗ ██╗    ██╗
██║     ██╔═══██╗██╔════╝╚══██╔══╝██║████╗ ████║██╔═══██╗██║    ██║
██║     ██║   ██║███████╗   ██║   ██║██╔████╔██║██║   ██║██║ █╗ ██║
██║     ██║   ██║╚════██║   ██║   ██║██║╚██╔╝██║██║   ██║██║███╗██║
███████╗╚██████╔╝███████║   ██║   ██║██║ ╚═╝ ██║╚██████╔╝╚███╔███╔╝
╚══════╝ ╚═════╝ ╚══════╝   ╚═╝   ╚═╝╚═╝     ╚═╝ ╚═════╝  ╚══╝╚══╝
```

# Ultimate Image Compressor - Pure JavaScript, Zero Server

---

## What is this ?

An "intelligent" client-side image compression engine built entirely in vanilla JavaScript. No server calls, no API keys, no external dependencies. Just raw browser power.

I built this for a personal project where the constraint was simple but brutal : everything must run on the client. No backend, no cloud function, no "just send it to a Lambda". Nothing. The user's machine does all the heavy lifting.

And honestly ? It works ridiculously well.

The result is a script that garantees full server availability even if 10,000 people use it at the same time. Because the server literally does nothing. All the compression, resizing, sharpening and format negotiation happens inside an inline Web Worker on the user's own device. Even on a mid-range phone from 2021, this thing flies.

Yeah I know, there's a million image compression scripts on the web. But I like to challenge myself, have some fun writing code late at night with a cup of coffee (or a good beer but... let's keep that between us 🤫).

---

## Why is this one different ?

Most client-side compressors do something like this :
1. Take an image
2. Throw it on a canvas
3. Call `toBlob()` with quality 0.7
4. Hope for the best

That's not compression. That's a coin flip.

This engine uses a 5-phase pipeline designed to hit your target file size with maximum visual quality preserved. Here's the philosophy : never sacrifice a single pixel of resolution until you've exhausted every other option first.

---

## The 5-Phase Pipeline

### Phase 1 - Format Negotiation

Instead of defaulting to a simple JPEG, the engine automatically tests AVIF then WebP then JPEG and picks the best format your browser supports. This alone can be a game changer. AVIF can divide the file size by 3x at perceptually equal quality. You didn't even resize anything yet and you already saved 60%. Not bad for Phase 1.

### Phase 2 - Binary Quality Search

Here's where most scripts get it wrong. They slap a fixed quality (0.7, 0.8, whatever) and move on. We don't do that here.

Instead the engine runs a binary search across 7 iterations (roughly 0.01 precision) to find the absolute highest quality that still fits under your target size. It does this BEFORE touching the dimensions. That means in many cases, your image stays at full resolution. The quality slider did all the work.

Think about it. Why resize a 4K photo to 1080p when you could just drop quality from 0.92 to 0.74 and already be under target ? Pixels are precious. We keep them.

### Phase 3 - Progressive Step-Down Resize

OK so quality alone wasn't enough ? No problem. But we're not gonna do what everyone else does, a brutal one-shot resize from 4000px to 800px. That's how you get blurry garbage.

Instead the canvas is reduced by half at each step until we reach the target dimensions. This gives you Lanczos-quality results without importing a single external library. The browser's built-in bilinear interpolation actually produces great results when you do it progressively. Each step only halves, so the filter has enough data to work with.

### Phase 4 - Convolution Sharpening

Downscaling always introduces some blur. Always. It's physics (well, math, but you get it).

So after resizing, we apply an Unsharp Mask 3x3 kernel directly on the pixel data via `getImageData`. This compensates the residual softness and brings back edge definition. The intensity is fully configurable (0 to turn it off, 0.1 to 0.6 for reasonable values) and it's automatically reduced during safety passes to avoid over-sharpening.

No library. No WebGL. Just a nested loop, a convolution kernel and `Uint8ClampedArray` doing its thing.

### Phase 5 - Quality Boost with Remaining Margin

Here's the cherry on top. After all the work above, if the final blob is significantly under target (let's say you asked for 500KB and we're at 320KB) the engine runs another binary search to push the quality back up and use that remaining headroom. Why waste it ?

Most compressors leave 30-40% of unused margin on the table. We don't.

---

## Features

- Auto Format Negotiation : AVIF > WebP > JPEG, tested at runtime
- Binary Quality Search : 7-iteration precision before any resize happens
- Progressive Step-Down : half-by-half resize, no brutal jumps
- Adaptive Sharpening : Unsharp Mask 3x3 kernel, configurable strength
- Display P3 Color Space : preserves wide-gamut colors on supported browsers
- Inline Web Worker : zero DOM blocking, Transferable Objects (zero memory copy)
- Phase-by-Phase Metrics : detailed timing for each pipeline stage
- Progress Callbacks : real-time feedback on what the engine is doing
- 30s Timeout : safety net so nothing hangs forever
- Batch Processing : `batchOptimize()` with concurrency control via `navigator.hardwareConcurrency`
- Safety Passes : if math predictions miss, up to 2 additional correction passes kick in

---

## Usage

### Basic

```javascript
const file = document.querySelector('input[type="file"]').files[0];

const result = await ultimateImageOptimizer(file, {
    targetSizeKB: 200,
    format: 'auto',        // Let the engine pick the best format
    maxWidth: 1920,
    sharpen: 0.3,
    onProgress: (phase, detail) => console.log(`[${phase}] ${detail}`),
});

console.log(`Done: ${result.sizeKB} KB | ${result.width}x${result.height} | ${result.format}`);
console.log(`Time: ${result.timeMs}ms | Compression ratio: x${result.compressionRatio}`);
```

### Batch (multiple images)

```javascript
const files = Array.from(document.querySelector('#multi').files);
const items = files.map(f => ({ source: f, options: { targetSizeKB: 300 } }));

const results = await batchOptimize(items, 4, (i, r) => {
    if (r instanceof Error) console.error(`Failed image ${i}: ${r.message}`);
    else console.log(`Image ${i}: ${r.sizeKB} KB`);
});
```

---

## Options

| Parameter | Type | Default | Description |
|---|---|---|---|
| `targetSizeKB` | `number` | `500` | Target file size in KB |
| `format` | `string` | `'auto'` | `'auto'`, `'image/avif'`, `'image/webp'`, `'image/jpeg'`, `'image/png'` |
| `maxWidth` | `number` | `Infinity` | Maximum output width in pixels |
| `maxHeight` | `number` | `Infinity` | Maximum output height in pixels |
| `minQuality` | `number` | `0.10` | Quality floor (0-1) |
| `maxQuality` | `number` | `0.92` | Quality ceiling (0-1) |
| `sharpen` | `number` | `0.3` | Sharpening strength (0 = off, 0.1 to 0.6 = reasonable range) |
| `preserveDisplayP3` | `boolean` | `true` | Keep Display P3 wide-gamut colors |
| `onProgress` | `function` | `null` | Callback `(phase, detail)` for real-time updates |

---

## What you get back

```javascript
{
    blob:             Blob,      // The compressed image, ready to use
    sizeKB:           number,    // Final size in KB
    width:            number,    // Final width in px
    height:           number,    // Final height in px
    format:           string,    // MIME type used (e.g. 'image/webp')
    quality:          number,    // Final quality value applied
    compressionRatio: number,    // How much smaller vs raw RGBA
    timeMs:           number,    // Total processing time
    phases: {                    // Detailed timing breakdown
        init, formatNegotiation, qualitySearch, resize, sharpen, finalEncode
    }
}
```

---

## Accepted sources

You can feed it pretty much anything visual :

- `File` or `Blob` (from an `<input type="file">`)
- `HTMLImageElement` (an `<img>` tag)
- `HTMLCanvasElement`
- `OffscreenCanvas`
- `ImageBitmap`
- `HTMLVideoElement` (grabs current frame)

---

## How it works under the hood

The entire compression pipeline runs inside an inline Web Worker. The code is injected as a Blob URL at runtime, no external file needed. The source image is sent to the worker as an `ImageBitmap` via Transferable Objects, which means zero memory copy. The main thread stays completely free, your UI never freezes and the garbage collector has less work to do.

```
Main Thread                         Worker Thread
    |                                    |
    +-- createImageBitmap()              |
    +-- postMessage(bitmap) --transfer-> |
    |   (zero copy!)                     +-- Phase 1: Format negotiation
    |                                    +-- Phase 2: Binary quality search
    |   <-- progress messages ---------- +-- Phase 3: Step-down resize
    |                                    +-- Phase 4: Sharpening kernel
    |   <-- final result --------------- +-- Phase 5: Quality boost
    +-- worker.terminate()               |
    +-- URL.revokeObjectURL()            |
    +-- bitmap.close()                   |
```

---

## Browser support

| Feature | Chrome | Firefox | Safari | Edge |
|---|---|---|---|---|
| Web Workers | Yes | Yes | Yes | Yes |
| OffscreenCanvas | 69+ | 105+ | 16.4+ | 79+ |
| ImageBitmap (transfer) | Yes | Yes | 15+ | Yes |
| AVIF encoding | 121+ | No | No | 121+ |
| WebP encoding | Yes | 96+ | 16+ | Yes |
| Display P3 | 104+ | Partial | Yes | 104+ |

The engine always falls back gracefully. If AVIF isn't supported it tries WebP. If WebP isn't supported, JPEG is always there. No crash, no error, just the best your browser can do.

---

## The math behind the predictive resize

When quality-only compression isn't enough and we need to shrink dimensions, we don't guess randomly. We use this formula :

```
scaleFactor = sqrt(targetSize / currentSize) * 0.88
```

Why square root ? Because image file size scales roughly with the area (width x height) and area scales with the square of the linear dimension. So if you need to cut file size in half, you only need to reduce each dimension by about 29%, not 50%.

The 0.88 multiplier adds a 12% safety margin so we slightly overshoot the compression. It's way better to be a bit under target and then boost quality back up in Phase 5 than to be over target and need another expensive resize pass.

---

## Why not just use library X ?

Valid question. Here's the honest answer :

1. **Zero dependencies.** No npm install, no bundler config, no version conflicts. Copy one file and it's done.
2. **Web Worker isolation.** The main thread never touches pixel data. Your scroll stays smooth. Your animations don't skip. Your users don't notice anything.
3. **It was fun to build.** Sometimes you just want to understand how things work from the ground up. Late night, good beer, some math and a text editor. That's the whole stack.

---

## License

MIT. Do whatever you want with it. If it helps you, that makes my night coding sessions worth it.

---

## Let's Be Honest

Every line of code : me.

Every algorithm : me.

Every late night debug session : me and my beer.

**AI was only used to proofread this README because my English has more bugs than my first JavaScript project in 2008 approximately... OH DAMN !**

BTW, I'm French. I try to make my variables clean but my grammar is... Well, **you understand what I mean**.

```
// TODO: learn english
// FIXME: probably never gonna happen :)
```

---

<p align="center">
Built with beer, curiosity and a questionable sleep schedule.
<br><br>
Also built with real passion and a sudden burst of enthusiasm to finally join the Github community as a contributor.
<br>
After mass consuming repos, issues and Stack Overflow answers for so many years without giving anything back...
<br>
Let's just say my ratio of git clone vs git push was mass embarrassing.
<br>
It's time to fix that. I've got full scripts on my hard drive to share... You're welcome. Sorry for the delay.
</p>
