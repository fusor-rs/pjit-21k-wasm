#!/usr/bin/env bash
# Checks what `pjit-21k compile` and the reference read in $1 against the pinned sha256s,
# downloading any file missing (18.1 GB in all): Qwen/Qwen3.5-4B's weights, configs, tokenizer files
# and license into $1/qwen3.5-4b, and Linum-AI/pjit-21k's DiT and config into $1/pjit-21k.
set -euo pipefail
DIR="$1"
FILES="
26a93f066e1916adb13453dae5a0c707c0fbc71299ed98779571a907b8e74c61  qwen3.5-4b/model.safetensors-00001-of-00002.safetensors
cb544bd9bfae93dc59b0f22b292f5933573854a7f9b97835c67060d7d910e188  qwen3.5-4b/model.safetensors-00002-of-00002.safetensors
cf3f798ee02ba45f9622aa8892a47369ab667d0afbf154ee7c2212de42e6302d  qwen3.5-4b/model.safetensors.index.json
ddc63e1c717afa86c865bb5e01313d89d72bb53b97ad4a8a03ba8510c0621670  qwen3.5-4b/config.json
5f9e4d4901a92b997e463c1f46055088b6cca5ca61a6522d1b9f64c4bb81cb42  qwen3.5-4b/tokenizer.json
316230d6a809701f4db5ea8f8fc862bc3a6f3229c937c174e674ff3ca0a64ac8  qwen3.5-4b/tokenizer_config.json
a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715  qwen3.5-4b/chat_template.jinja
ce99b4cb2983d118806ce0a8b777a35b093e2000a503ebde25853284c9dfa003  qwen3.5-4b/vocab.json
a9d356d7bdf1ef4949e3e748e95b8e10ad9d4e2e838eddc38a0a7b6b94d1db8d  qwen3.5-4b/merges.txt
bbedc3fda3305820b977265f01b8619d87570a6739de3a5582c3464840f1e57a  qwen3.5-4b/LICENSE
8605f442a6278698481bd36b87013644354652a7647974b8f19764f5113a971c  pjit-21k/model.safetensors
a54f5971e67ce8c3b701dd95e3b3da9e27f88198df9065cc5f574ff560a216d0  pjit-21k/config.json
"
mkdir -p "$DIR/qwen3.5-4b" "$DIR/pjit-21k"
missing=()
while read -r _ file; do
  if [ -n "$file" ] && [ ! -s "$DIR/$file" ]; then missing+=("$file"); fi
done <<< "$FILES"
# huggingface_hub with hf_xet downloads the 18 GB several times faster than one curl connection.
if [ "${#missing[@]}" -gt 0 ]; then
  uv run --no-project --with huggingface_hub==0.36.2 --with hf_xet==1.8.0 python -I - \
    "$DIR" "${missing[@]}" <<'PY'
import sys
from huggingface_hub import hf_hub_download

SOURCES = {
    "qwen3.5-4b": ("Qwen/Qwen3.5-4B", "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a"),
    "pjit-21k": ("Linum-AI/pjit-21k", "251725ad9a0618f0a4ba3cdf4a488d35312be352"),
}
directory, *files = sys.argv[1:]
for path in files:
    folder, file = path.split("/", 1)
    repo, revision = SOURCES[folder]
    print(f"downloading {path}", flush=True)
    hf_hub_download(repo, file, revision=revision, local_dir=f"{directory}/{folder}")
PY
fi
(cd "$DIR" && awk 'NF { print $1 "  " $2 }' <<< "$FILES" | shasum -a 256 -c --quiet -)
