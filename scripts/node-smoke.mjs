// Runs a single-threaded wasm runtime build in Node against both bundles: the text runtime, in a
// worker thread (its own module instance and memory), encodes the caption and the negative prompt;
// the image runtime generates an image step by step, previewing each step, and the time of each
// stage is printed. Fails if a preview is missing or the image is blank. With `--out`, the image's
// RGBA is written to that file. The request's fields are options (the e2e run takes its reference
// from here).
//
//   node scripts/node-smoke.mjs dist/model --build web-single [--steps 2] [--out image.rgba]
//     [--prompt text] [--negative text] [--width 1280] [--height 720] [--guidance 15] [--seed 7]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const CAPTION = 'Close-up portrait of an elderly Middle Eastern woman looking calmly into the lens, her face filling the tall frame. A cream headscarf and the collar of a dark green cardigan frame her chin. Soft overcast daylight smooths the fine lines of her skin, and the olive grove behind melts into silvery blur.';
const CHUNK = 8 << 20;
const RGBA = 4;
const MIN_COLOURS = 2;

const seconds = (since) => ((performance.now() - since) / 1000).toFixed(2);

/** The class `className` of the runtime build, with the bundle at `bundle` pushed into it. */
async function load(className, bundle, build) {
  const dist = new URL(`../app/engine/dist/${build}/`, import.meta.url);
  const glue = await import(new URL('pjit_21k_runtime.js', dist));
  glue.initSync({ module: readFileSync(new URL('pjit_21k_runtime_bg.wasm', dist)) });
  const t0 = performance.now();
  const manifest = readFileSync(join(bundle, 'manifest.json'), 'utf8');
  const runtime = new glue[className](manifest);
  let ready = false;
  JSON.parse(manifest).parts.forEach((part, index) => {
    const bytes = readFileSync(join(bundle, part.file));
    for (let offset = 0; offset < bytes.length; offset += CHUNK) runtime.write_part(index, bytes.subarray(offset, offset + CHUNK));
    ready = runtime.end_part(index);
  });
  if (!ready) throw new Error(`${className} not ready after every part`);
  console.log(`${build} ${className}: load ${seconds(t0)}s`);
  return runtime;
}

/** In the worker thread: the states of the caption and of the negative prompt. */
async function encode({ bundle, build, prompt: promptText, negative: negativeText }) {
  const runtime = await load('TextRuntime', join(bundle, 'text'), build);
  const t0 = performance.now();
  const prompt = runtime.encode(promptText);
  const negative = runtime.encode(negativeText);
  parentPort.postMessage({ prompt, negative, seconds: seconds(t0) }, [prompt.buffer, negative.buffer]);
}

/** The colours an image has, up to `MIN_COLOURS`. */
function colours(image) {
  const seen = new Set();
  for (let at = 0; at < image.length && seen.size < MIN_COLOURS; at += RGBA) seen.add((image[at] << 16) | (image[at + 1] << 8) | image[at + 2]);
  return seen.size;
}

async function generate() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      build: { type: 'string', default: 'web-single' },
      steps: { type: 'string', default: '2' },
      prompt: { type: 'string', default: CAPTION },
      negative: { type: 'string', default: '' },
      width: { type: 'string', default: '1280' },
      height: { type: 'string', default: '720' },
      guidance: { type: 'string', default: '15' },
      seed: { type: 'string', default: '7' },
      out: { type: 'string' },
    },
  });
  const bundle = positionals[0] ?? 'dist/model';
  const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { bundle, build: values.build, prompt: values.prompt, negative: values.negative } });
  const states = await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  await worker.terminate();
  console.log(`  captions: ${states.seconds}s`);

  const runtime = await load('ImageRuntime', join(bundle, 'image'), values.build);
  const request = Object.fromEntries(['width', 'height', 'steps', 'guidance', 'seed'].map((field) => [field, Number(values[field])]));
  let t0 = performance.now();
  const plan = JSON.parse(runtime.start(JSON.stringify(request), states.prompt, states.negative));
  console.log(`  start: ${seconds(t0)}s`);
  const imageBytes = plan.width * plan.height * RGBA;
  let failed = false;
  for (let done = false; !done; ) {
    t0 = performance.now();
    const progress = JSON.parse(runtime.step());
    done = progress.done;
    const preview = done ? null : runtime.preview();
    failed ||= preview !== null && preview.length !== imageBytes;
    console.log(`  step ${progress.step}/${progress.steps}: ${seconds(t0)}s`);
  }
  const image = runtime.take_image();
  if (values.out) writeFileSync(values.out, image);
  const blank = colours(image) < MIN_COLOURS;
  console.log(`  ${plan.width}×${plan.height}, ${blank ? 'blank' : 'not blank'}`);
  failed ||= image.length !== imageBytes || blank;
  if (failed) process.exit(1);
}

if (isMainThread) await generate();
else await encode(workerData);
