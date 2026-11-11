# P-JiT 21K in the browser. `just ui` builds everything, the models included, and serves the page;
# `just build` then `just serve` do the same in two steps.

import 'vendor/fusor-ai/just/product.just'

name := "pjit-21k"
# Each runtime instance's shared memory may grow to all of wasm32's 4 GiB: the text encoder's 3.3 GB
# bundle, or the DiT's 2.6 GB with its activations.
export MAX_MEMORY := "4294967296"
checkpoint := env_var_or_default("CHECKPOINT", ".cache/checkpoint")
profile := env_var_or_default("PROFILE", "mix")
model_f32 := "dist/model-f32"
goldens := "fixtures/goldens"
# The reference the goldens come from (vendor/fusor-ai/models/pjit-21k/reference): Linum's
# pjit-21k repository at a pinned commit, under pinned packages.
pjit_repository := ".cache/pjit-21k-code"
pjit_commit := "95403933f3727abe947977c75915a53292e1d841"
reference := "uv run --no-project --python 3.12 --with torch==2.14.1 --with transformers==5.19.0 --with safetensors==0.8.0 --with numpy==2.5.4 --with tqdm==4.67.1 --with jinja2==3.1.6 python -I"

host:
    bash -n scripts/fetch-checkpoint.sh
    for file in app/web/app.js app/engine/text.js app/engine/image.js scripts/node-smoke.mjs scripts/site-bundle.mjs scripts/render-images.mjs e2e/run.mjs; do node --check "$file" || exit 1; done

# Checks the pinned checkpoints (18.1 GB, sha256, downloading what is missing), then compiles the
# text and image bundles into dist/model, the license beside them.
model: native
    scripts/fetch-checkpoint.sh {{checkpoint}}
    rm -rf {{model}}
    target/release/pjit-21k compile {{checkpoint}} {{model}} --profile {{profile}}
    cp {{checkpoint}}/qwen3.5-4b/LICENSE {{model}}/LICENSE

# Try it on localhost. The bundles and the runtimes are rebuilt every time (incremental, seconds
# when nothing changed), so they always come from the same fusor-ai.
ui: model runtimes page serve

# The shipped and the f32 bundles, one checkpoint at a time, each checkpoint's weights deleted once
# its last bundle is written: the 18.1 GB of weights beside the 17.9 GB of bundles do not fit this
# machine's disk (fetch-checkpoint.sh downloads them again when a recipe needs them). The text
# bundle is the same in both profiles (`Profile::F32`'s doc), so it is compiled once and copied.
bundles: native
    scripts/fetch-checkpoint.sh {{checkpoint}}
    rm -rf {{model}} {{model_f32}}
    target/release/pjit-21k compile {{checkpoint}} {{model}} --bundle text --profile {{profile}}
    rm {{checkpoint}}/qwen3.5-4b/model.safetensors-0000*-of-00002.safetensors
    target/release/pjit-21k compile {{checkpoint}} {{model}} --bundle image --profile {{profile}}
    target/release/pjit-21k compile {{checkpoint}} {{model_f32}} --bundle image --profile f32
    rm {{checkpoint}}/pjit-21k/model.safetensors
    cp -R {{model}}/text {{model_f32}}/text
    cp {{checkpoint}}/qwen3.5-4b/LICENSE {{model}}/LICENSE

# Every stage against the reference's goldens, with the f32 DiT (`just bundles` first).
parity: native
    test -f {{goldens}}/golden_f32.safetensors || just fusor_ai={{fusor_ai}} goldens
    test -d {{model_f32}}/text -a -d {{model_f32}}/image || just fusor_ai={{fusor_ai}} bundles
    target/release/pjit-21k parity {{model_f32}} {{goldens}}/golden_f32.safetensors

# Golden tensors from P-JiT 21K's reference in f32 on the CPU (a few minutes).
goldens:
    scripts/fetch-checkpoint.sh {{checkpoint}}
    test -d {{pjit_repository}} || git clone --quiet https://github.com/Linum-AI/pjit-21k.git {{pjit_repository}}
    git -C {{pjit_repository}} checkout --quiet {{pjit_commit}}
    mkdir -p {{goldens}}
    {{nice}} {{reference}} {{fusor_ai}}/models/pjit-21k/reference/dump.py {{pjit_repository}} {{checkpoint}} {{goldens}}/golden_f32.safetensors

# An image with the native CLI: `just generate --prompt "…" --width 864 --height 1216`.
generate *arguments: model
    target/release/pjit-21k generate {{model}} {{arguments}}

bench: model
    target/release/pjit-21k bench {{model}}

images:
    cd vendor/fusor-ai/packages/e2e && npm ci --no-audit --no-fund --silent && npx playwright install chromium
    node scripts/render-images.mjs

site: runtimes page
    rm -rf target/site
    mkdir -p target/site
    cp -R {{app}}/dist/. target/site/
    find target/site -name '.fusor-*.json' -delete
    for bundle in text image; do node scripts/site-bundle.mjs {{model}}/$bundle target/site/model/$bundle || exit 1; done
    cp {{model}}/LICENSE target/site/model/

# The Space holds at most 1 GB, so it gets the page, the runtimes and the license, and the page
# loads the bundles from the model repo fusorlabs/pjit-21k-web (`just deploy-model`). The Space is
# created as a static Space first: creating it with the upload makes a Gradio Space, which Hugging
# Face refuses for a free organization.
# The site to the Hugging Face Space fusorlabs/pjit-21k-wasm, configured by space/README.md.
deploy-space: site
    #!/usr/bin/env bash
    set -euo pipefail
    rm -rf target/space
    rsync -a --exclude /model target/site/ target/space/
    rsync -a --include '*/' --include 'LICENSE*' --exclude '*' target/site/model/ target/space/model/
    cp space/README.md target/space/
    uv run --no-project --with huggingface_hub==0.36.2 python - target/space <<'PY'
    import sys
    from huggingface_hub import HfApi

    api = HfApi()
    api.create_repo("fusorlabs/pjit-21k-wasm", repo_type="space", space_sdk="static", exist_ok=True)
    api.upload_folder(
        repo_id="fusorlabs/pjit-21k-wasm",
        repo_type="space",
        folder_path=sys.argv[1],
        delete_patterns="*",
        commit_message="Deploy pjit-21k-wasm {{version}}",
    )
    PY

# Deploy them before the Space whenever a bundle changes: a runtime only loads a bundle compiled
# with the same fusor-ai.
# The site's two bundles, with space/MODEL.md as their card, to the model repo
# fusorlabs/pjit-21k-web.
deploy-model: site
    #!/usr/bin/env bash
    set -euo pipefail
    cp space/MODEL.md target/site/model/README.md
    uv run --no-project --with huggingface_hub==0.36.2 python - target/site/model <<'PY'
    import sys
    from huggingface_hub import HfApi

    api = HfApi()
    api.create_repo("fusorlabs/pjit-21k-web", exist_ok=True)
    api.upload_folder(
        repo_id="fusorlabs/pjit-21k-web",
        folder_path=sys.argv[1],
        delete_patterns="*",
        commit_message="Deploy the pjit-21k-wasm {{version}} bundles",
    )
    PY

# No fixed inputs: the e2e makes its reference with the same build's single-threaded runtime in
# Node.
fixtures:
