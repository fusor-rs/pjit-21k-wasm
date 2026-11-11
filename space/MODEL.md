---
license: apache-2.0
base_model:
  - Linum-AI/pjit-21k
  - Qwen/Qwen3.5-4B
pipeline_tag: text-to-image
library_name: fusor-ai
tags:
  - webassembly
  - wasm
  - on-device
  - text-to-image
  - pixel-space
---

# P-JiT 21K, compiled for the browser

Linum's [P-JiT 21K](https://huggingface.co/Linum-AI/pjit-21k) and the
[Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B) layers it reads captions with, compiled into
two [fusor-ai](https://github.com/fusor-rs/fusor-ai) bundles: the weights the browser runtime of
[pjit-21k-wasm](https://github.com/fusor-rs/pjit-21k-wasm) loads to turn a caption into an image on
the device's CPU. Try it in the Space
[fusorlabs/pjit-21k-wasm](https://huggingface.co/spaces/fusorlabs/pjit-21k-wasm).

- **Sources:** `Linum-AI/pjit-21k` at revision `251725ad9a0618f0a4ba3cdf4a488d35312be352` and
  `Qwen/Qwen3.5-4B` at revision `851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a`, compiled with the
  `mix` profile into two bundles, because one WebAssembly memory holds at most 4 GiB:
  - `text/`: the Qwen3.5-4B tokenizer, embeddings and layers 0 to 27. The embeddings and the
    feed-forwards' gate and up projections are 4-bit, every other matrix 7-bit (3266 MB).
  - `image/`: the P-JiT 21K diffusion transformer, every large matrix 7-bit (2626 MB). The patch
    embedding, the timestep MLP, the text projection and the head stay in f32.
- **Format:** each `manifest.json` lists every tensor and part; each part is named by its BLAKE3
  hash, which the runtime checks as it loads.
- **Reproduce it:** `just model` in pjit-21k-wasm downloads the checkpoints and compiles the same
  bundles.

This is not a PyTorch or safetensors checkpoint: it only loads in the pjit-21k-wasm runtime.

Both models are Apache-2.0; Qwen3.5-4B's license is [LICENSE](LICENSE).
