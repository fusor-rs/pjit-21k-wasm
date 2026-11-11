# AGENTS.md

Rules for coding agents in this repository that are its own. fusor-ai's
`vendor/fusor-ai/AGENTS.md` is the standard and binds here too (`CLAUDE.md`
imports both); this file adds what is particular to this product.

pjit-21k is the P-JiT 21K text-to-image app: Linum's pixel-space text-to-image
model (Linum-AI/pjit-21k) with Qwen3.5-4B as its text encoder, running in the
browser on the CPU, sealed from the network, the picture forming step by step.
The README describes what it does; don't invent scope, features or options
beyond the task.

## Repository

- `vendor/fusor-ai/models/pjit-21k/runtime`: the wasm-bindgen surface of the
  model, two runtimes of one model (the text encoder's and the image model's:
  bundle parts and a request in, text states, step previews and RGBA pixels out),
  each built as four browser runtimes.
- `vendor/fusor-ai/models/pjit-21k/cli`: the native CLI `pjit-21k` (`compile`,
  `generate`, `bench`, `parity`).
- `app/`: the page, a [fusor](https://github.com/fusor-rs/fusor) app with its own
  Cargo workspace: the form, the loading and the live measurements as Rust
  signals in `src/app.rs`, the template in `web/index.html` on fusor-ai's
  `packages/ui/base.css`, the engine bridge, the canvas and the PNG in
  `web/app.js`, and in `engine/` the two workers (`text.js`, `image.js`) on
  fusor-ai's worker kit, beside the runtimes `just runtimes` builds.
- `scripts/`: the checkpoint download (pinned to revisions, sha256-checked), the
  Node smoke test, the site bundle and the README's images; `e2e/run.mjs`: the
  headless Chrome run on fusor-ai's e2e kit.
- [fusor-ai](https://github.com/fusor-rs/fusor-ai): the model (`pjit-21k`), its
  compiler (`pjit-21k-compile`), the kernels, the blocks (`hybrid`,
  `pyramid_jit`, `apg`, `video`) and the bundle format come from
  `vendor/fusor-ai`, a git submodule pinned to a commit pushed to fusor-ai, with
  the browser loader and compute pool, the runtime build, the import check and
  the dev server.

What belongs where: model code (dimensions, tensor names, wiring, the caption
template, the sampler's settings) and anything another model could reuse go to
fusor-ai, following its `AGENTS.md`. This repository holds what turns the model
into an app: the page, the checks against the reference and the deployment. A
change to fusor-ai lands there first; this repository never patches it.

Constraints that hold everywhere:

- fusor-ai comes only from `vendor/fusor-ai`, never a crates.io version, a
  `[patch]` table or a sibling checkout. The submodule moves to another pushed
  fusor-ai commit in a change of its own, with the parity numbers and the e2e
  result it gave. No copies of fusor-ai code here.
- The page owns every capability: drawing on the canvas, making the PNG,
  caching the bundles (OPFS) and measuring itself. The runtimes receive a
  request and return text states, previews and pixels; they do no I/O.
- The model runs as two runtime instances, each in its own worker and memory,
  because Qwen3.5-4B and the DiT together do not fit in one wasm32 memory; the
  text states cross from one to the other as bytes through the page. Each
  instance's shared memory may grow to 4 GiB (`MAX_MEMORY` in the justfile): the
  text bundle (3.27 GB) with its activations, or the image bundle (2.63 GB) with
  the DiT's activations at the largest request. A change that grows the
  activations says by how much.
- Generation matches Linum's reference (its own modules, pinned in the
  justfile) stage by stage up to the int8 attention and the quantized weights;
  an image of the same seed differs from the reference's, whose noise
  reproduces an H100's draw. Say so where a comparison could suggest otherwise.
- The e2e compares the page's image byte for byte with the same build's
  single-threaded runtime in Node, and `MIN_SPREAD` (the image is a picture) is
  never loosened.
- Both models are Apache-2.0. The page, the README and the Space credit Linum
  and Qwen, with links.

## Checks

A change is done only when this passes:

```sh
just check
```

It runs formatting and Clippy on the page and syntax checks of the scripts;
fusor-ai's `just check` covers the runtimes and the CLI. A change to the
runtimes, the page, the CLI or fusor-ai also needs `just runtimes`, `just
smoke`, `just parity` (the same numbers as before unless the change is meant to
move them) and `just e2e`; a change meant to move speed also needs `just
bench`. The model is checked stage by stage against the reference goldens by
`pjit-21k parity`; extend it rather than adding a parallel harness.

## Commits

- Don't commit, push, tag, release or deploy unless asked. Deploying is
  described in the justfile (`deploy-model`, then `deploy-space`) and is done by
  the maintainer.
