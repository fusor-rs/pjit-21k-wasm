<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/banner-dark.png">
    <img src="assets/brand/banner.png" alt="fusor-ai × P-JiT 21K: pjit-21k" width="640">
  </picture>
</p>

# Text to image in the browser, on the CPU

Describe a picture and watch it form, made by [P-JiT 21K](https://huggingface.co/Linum-AI/pjit-21k), Linum's open text-to-image model that denoises pixels directly, with [Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B) reading the caption, computed on your own device. No server, no API key, no GPU required, and once the model has loaded, nothing you type leaves the page.

pjit-21k is the app around the model: a [fusor](https://github.com/fusor-rs/fusor) page, the browser runtimes and a native CLI. The model itself, compiled to WebAssembly, is built with [fusor-ai](https://github.com/fusor-rs/fusor-ai), the toolkit for AI runtimes in Rust and WebAssembly, from the published weights.

**In development · v0.1**: this is experimental software. See [status and known limitations](#status-and-known-limitations).

[Run it](#run-it-locally) · [How it works](#how-it-works) · [How fast is it](#how-fast-is-it) · [Status](#status-and-known-limitations)

## Run it locally

You need Rust 1.99 or newer, installed with [rustup](https://rustup.rs), Node.js 22 or newer and [`just`](https://github.com/casey/just). Then:

```sh
git clone --recurse-submodules https://github.com/fusor-rs/pjit-21k-wasm && cd pjit-21k-wasm
just ui
```

and open the address it prints. `just ui` installs the pinned tools, downloads the two checkpoints at pinned revisions (18.1 GB, each file sha256-checked), compiles them into two bundles (3.27 GB for the text encoder, 2.63 GB for the image model), builds the browser runtimes and the page, and serves it on `http://localhost:8787` with the bundles beside it.

Write a caption and press **Generate**, even while the model is still loading: the request waits and starts the moment the model is ready. A dense caption of 50 to 80 words works best: the subject, the framing, the light and the medium. After every step the page draws the clean image that step predicts, and the last step's image is ready to download as a PNG. Shape (the five sizes P-JiT 21K was trained at, the only ones it generates), steps (the model card's 50 by default), guidance and the seed are yours to change, and the same seed and settings give the same image. Every generation is measured live: the time, the seconds per step, the steps done, and the network requests since the model loaded, which stay at zero.

## More ways to run it

### Build everything from source

```sh
just build    # also downloads the checkpoints and compiles the bundles
just serve
```

`CHECKPOINT=<dir>` reuses checkpoints you already have, and `PROFILE=f32` compiles the full-precision image bundle that `just parity` checks against the reference.

### The CLI

The CLI generates an image without a browser, as a PNG:

```sh
target/release/pjit-21k generate dist/model --prompt "a lighthouse on a rocky coast at dusk" --width 864 --height 1216
target/release/pjit-21k generate dist/model --prompt "a red fox in the snow" --width 1280 --height 720 --guidance 10 --seed 7
```

`--width` and `--height` take the five trained sizes, 1024 × 1024 by default.

`pjit-21k bench` times each stage and `pjit-21k parity` compares every stage with the reference's outputs.

## How it works

- **Two runtimes, two memories.** A WebAssembly memory holds at most 4 GiB, and the model's text encoder (Qwen3.5-4B, 4 billion parameters) and its image model (a 2.2 billion parameter diffusion transformer) together do not fit in one. The page runs them as two instances in two workers; the encoder's output, the caption's and the negative prompt's hidden states, crosses to the image instance as bytes through the page.
- **Quantized, mixed.** The text bundle stores Qwen3.5-4B's embeddings and feed-forward gate and up projections in 4 bits and its other matrices in 7; the image bundle stores the transformer's large matrices in 7 bits and its patch embedding, timestep MLP, text projection and head in f32. Each has a scale per 32 values (fusor-ai's `Q4b32` and `Q7b32`); the matrix multiply quantizes activations to int8 on the fly and adds up each group's products as integers.
- **No autoencoder.** P-JiT 21K denoises pixels, so the image the last step predicts is the picture: there is no decoder, and every step's clean-image estimate is drawn as a preview.
- **The text.** Qwen3.5-4B runs through its 28th layer; the hidden states after layers 7, 15 and 27 are the DiT's text conditioning. The first layers are the Qwen3.5 hybrid stack (gated delta-rule and gated attention layers) of fusor-ai's other Qwen3.5 models.
- **The sampler.** From seeded noise, Euler steps over the flow-matching timesteps ask the transformer for the prediction of the caption and of the negative prompt at every step and steer between them with adaptive projected guidance.
- **Checked against the reference.** Every stage agrees with Linum's own modules in full precision: the tokens, the knots and the timesteps exactly, the text states within 1.2·10⁻¹ (relative, from the 4-bit embeddings and feed-forwards; the same states at 7 bits agree within 3.4·10⁻²), the transformer's prediction within 9.9·10⁻³ and the sampler's image within 4.7·10⁻².
- **Threads and SIMD where the browser has them.** The page picks one of four builds: worker threads when it is cross-origin isolated, relaxed SIMD when the engine supports it, plain SIMD128 everywhere else. The page's image equals, byte for byte, that of the same build run single-threaded in Node.
- **Downloaded once, verified always.** The bundles stream in parts, each checked against its BLAKE3 hash, and stay in the browser's origin-private storage, so the next visit loads from this device.
- **Sealed.** The runtimes import no network, storage, clock or entropy capability; fusor-ai's import check proves it on every build. The page counts its network requests while it generates, and the count is zero.
- **A fusor page.** The form, the loading and the measurements are Rust signals with HTML templates; a small JavaScript module runs the engine workers and draws on the canvas.

## How fast is it

Measured on an Apple M4 Pro, eight threads:

- **Natively**, the CLI generates a 1024 × 1024 image in 50 steps at guidance 15 in 459.2 s: 3.3 s to load the text encoder and read both captions, and 9.1 s a step (both guidance branches).
- **In Chrome** the page has not been timed; beside the steps it shows an estimate from the native step. The download is 5.9 GB: 3266 MB of text encoder and 2626 MB of image model.

Both guidance branches run at every step, as in the reference; a guidance of 1 runs only the caption's and takes half the time.

## Status and known limitations

pjit-21k is v0.1 and experimental.

### Platform status

| Platform or capability | Status |
| --- | --- |
| Chrome and Edge, threads and relaxed SIMD | Headless Chrome end-to-end check (`just e2e`): generate while loading, preview, the image equal to the same build in Node, the PNG, revisit |
| Browsers without relaxed SIMD (Safari, older Firefox) | SIMD128 builds, checked in Chrome with threads and in Node single-threaded (`just smoke`); not tested in those browsers |
| Native CLI (macOS on Apple silicon) | Built and measured; no release archives yet |
| Phones and small machines | Not supported: the two instances need about 6.5 GB of memory in one tab (an estimate from the memory arithmetic, not a measurement) |

**Not supported yet:**

- Sizes other than the five P-JiT 21K was trained at: 1024 × 1024, 864 × 1216, 1152 × 864, 1248 × 832 and 1280 × 720.
- The first download is 5.9 GB.
- Captions are cut at 256 tokens with the template; there is no prompt upsampler (the reference calls an LLM over the network for it).
- P-JiT 21K cannot write text in an image.
- The same seed does not give the reference's image: its noise reproduces an H100's random draw.
- A GPU backend.

Both models are Apache-2.0: [P-JiT 21K](https://huggingface.co/Linum-AI/pjit-21k) by Linum and [Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B) by Qwen; Qwen3.5-4B's license ships with the bundles as `model/LICENSE`.

## How is this different from Linum's own code?

[pjit-21k](https://github.com/Linum-AI/pjit-21k) is the reference: Python on PyTorch, on GPUs. pjit-21k-wasm is a separate implementation on fusor-ai: the same weights and the same sampler's maths, its own kernels, checked stage by stage against Linum's modules, running in the browser on the CPU. It is far slower than a GPU; it needs no GPU and no server.

## Contributing

pjit-21k-wasm is an open source project in early development. The page lives in `app/`; the runtimes and the CLI live in fusor-ai's `models/pjit-21k`; the model and its toolkit come from fusor-ai, its crates and browser scripts from the `vendor/fusor-ai` submodule. [AGENTS.md](AGENTS.md) is the code standard every change follows, and `just check` its check.

pjit-21k-wasm is built with the help of AI tools, mainly Claude Code, under the same rules the project asks of contributors.

## License

Licensed under the [MIT License](LICENSE).
