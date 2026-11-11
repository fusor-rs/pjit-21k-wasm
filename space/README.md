---
title: pjit-21k-wasm
short_description: Text to image on your own CPU
sdk: static
app_file: index.html
pinned: false
license: apache-2.0
models:
  - fusorlabs/pjit-21k-web
  - Linum-AI/pjit-21k
  - Qwen/Qwen3.5-4B
custom_headers:
  cross-origin-embedder-policy: require-corp
  cross-origin-opener-policy: same-origin
  cross-origin-resource-policy: cross-origin
---

Text to image with Linum's [P-JiT 21K](https://huggingface.co/Linum-AI/pjit-21k), computed on your
own CPU in the browser: the model and the [Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B)
text encoder it reads captions with, compiled to WebAssembly with fusor-ai, download once and then
run sealed from the network. P-JiT 21K denoises pixels directly, with no autoencoder: describe a
picture and watch it form step by step, then download it as a PNG. It runs as two instances, one for
the text encoder and one for the image model, so each stays under the 4 GiB a WebAssembly memory can
hold; the caption never leaves the page. Both models are Apache-2.0; Qwen3.5-4B's license ships
beside the bundles as `model/LICENSE`. The page's code is MIT; its source is
[github.com/fusor-rs/pjit-21k-wasm](https://github.com/fusor-rs/pjit-21k-wasm).
