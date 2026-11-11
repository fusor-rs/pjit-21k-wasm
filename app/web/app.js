import { ComputePool, SPAWN_COMPUTE } from '../../vendor/fusor-ai/packages/host/compute.js';

// The engine bridge. The page's state lives in Rust (src/app.rs); this module owns the two engine
// workers (the text encoder's and the image model's, each with its own memory) and, in threaded
// builds, their compute workers (fusor-ai's ComputePool). A generation encodes the caption and the
// negative prompt in the text worker, hands their states to the image worker, draws each step's
// preview and the finished image on the canvas, and makes the PNG. It measures each generation and
// reports back with `engine` events.

const params = new URLSearchParams(location.search);
const cores = navigator.hardwareConcurrency || 4;
// One compute worker per core minus two (the page and the engine worker), at most 8; `?threads=1`
// forces the single-threaded build. Never more than the cores: the barriers spin.
const requestedThreads = Number.parseInt(params.get('threads') ?? '', 10);
const THREADS = Math.min(cores, requestedThreads > 0 ? requestedThreads : Math.max(1, Math.min(8, cores - 2)));
// The bundles served next to the page (`just serve` mounts dist/model there); `?model=<url>` loads
// another one, `?build=web-single` pins a runtime build.
// A Hugging Face Space holds at most 1 GB, so the Space loads the bundles from the model repo
// fusorlabs/pjit-21k-web (`just deploy-model`) instead of from beside the page.
const HOSTED_MODEL = 'https://huggingface.co/fusorlabs/pjit-21k-web/resolve/main/';
const DEFAULT_MODEL = location.hostname.endsWith('.hf.space') ? HOSTED_MODEL : 'model/';
const MODEL_URL = new URL(params.get('model') ?? DEFAULT_MODEL, document.baseURI).href;

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

export function onMount({ root, inputs, onCleanup }) {
  const report = (detail) => root.dispatchEvent(new CustomEvent('engine', { detail: JSON.stringify(detail) }));
  let notice = '';
  let loaded = false;
  let broken = false;
  let jobs = 0;
  let job = null;
  let imageUrl = null;
  let readyAt = Infinity;

  const handlers = {
    text: {
      encoded: (message) => {
        if (message.job !== job?.id || job.stopped) return;
        job.textMs = message.textMs;
        job.textRequests = message.networkRequests;
        job.encoding = false;
        report({ type: 'progress', status: 'Denoising…', metrics: metrics() });
        const { prompt, negative } = message;
        bundles.image.worker.postMessage({ type: 'generate', job: job.id, request: inputs.request.get(), prompt, negative }, [prompt.buffer, negative.buffer]);
      },
    },
    image: {
      started: (message) => {
        if (message.job !== job?.id) return;
        job.plan = message.plan;
        job.engine = message;
      },
      step: (message) => {
        if (message.job !== job?.id) return;
        job.engine = message;
        draw(message.preview);
        report({ type: 'progress', status: `Step ${message.step} of ${job.plan.steps}`, metrics: metrics() });
      },
      done: (message) => finish(message),
    },
  };

  /** Starts the worker of bundle `name`, whose messages go to the page's loading and `handlers[name]`. */
  function start(name) {
    const worker = new Worker(new URL(`engine/${name}.js`, document.baseURI), { type: 'module', name: `pjit-21k-${name}` });
    const pool = new ComputePool(crash);
    const bundle = { name, worker, pool, build: null, progress: { done: 0, total: 0, network: 0, cache: 0 }, ready: null };
    const routes = {
      [SPAWN_COMPUTE]: (message) => pool.spawn(message),
      runtime: (message) => (bundle.build = message),
      warning: ({ message }) => {
        console.warn(message);
        notice = ` (${message})`;
      },
      progress: (message) => {
        bundle.progress = message;
        reportLoading();
      },
      ready: (message) => {
        bundle.ready = message;
        if (Object.values(bundles).every((each) => each.ready)) ready();
      },
      error: ({ message }) => {
        if (!loaded) return fail(message);
        if (job) job.encoding = false;
        report({ type: 'error', message });
      },
      fatal: ({ message }) => fail(message),
      ...handlers[name],
    };
    worker.onmessage = ({ data }) => {
      if (!broken) routes[data.type]?.(data);
    };
    worker.onerror = (event) => crash(event.message || 'an engine worker failed');
    worker.postMessage({ type: 'load', modelUrl: new URL(`${name}/`, MODEL_URL).href, threads: THREADS, build: params.get('build') });
    return bundle;
  }

  const total = (key) => Object.values(bundles).reduce((sum, bundle) => sum + bundle.progress[key], 0);

  function reportLoading() {
    const [done, size, network, cache] = ['done', 'total', 'network', 'cache'].map(total);
    const source = cache && !network ? 'from this device' : cache ? `${mb(network)} downloaded, ${mb(cache)} cached` : 'downloading';
    report({ type: 'loading', fraction: size ? done / size : 0, detail: `${mb(done)} / ${mb(size)} · ${source}` });
  }

  function ready() {
    loaded = true;
    readyAt = performance.now();
    const parts = Object.values(bundles);
    const bundleBytes = parts.reduce((sum, bundle) => sum + bundle.ready.total, 0);
    const cached = parts.reduce((sum, bundle) => sum + bundle.ready.cache, 0);
    const loadedInfo = {
      build: `${bundles.image.build.build}${notice}`,
      threads: bundles.image.build.threads,
      bundle_bytes: bundleBytes,
      load_ms: Math.max(...parts.map((bundle) => bundle.ready.ms)),
      from_device: cached === bundleBytes,
    };
    report({ type: 'ready', loaded: loadedInfo });
  }

  /** Runs the request the page holds, timed from now (the click, or the model being ready). */
  function dispatch() {
    job = { id: ++jobs, t0: performance.now(), encoding: true, stopped: false, plan: null, engine: null, textMs: 0, textRequests: 0 };
    bundles.text.worker.postMessage({ type: 'encode', job: job.id, ...JSON.parse(inputs.prompts.get()) });
  }

  function stop() {
    if (!job) return;
    job.stopped = true;
    if (job.encoding) {
      job.encoding = false;
      // A subscription callback runs inside Rust's update: report once it has returned.
      queueMicrotask(() => report({ type: 'done', status: 'Stopped.', image: null, metrics: metrics() }));
      return;
    }
    bundles.image.worker.postMessage({ type: 'stop', job: job.id });
  }

  const canvas = () => root.querySelector('#picture');

  /** Puts `{ width, height, pixels }` (RGBA) on the canvas, which takes the image's size. */
  function draw({ width, height, pixels }) {
    const picture = canvas();
    if (!picture) return;
    if (picture.width !== width || picture.height !== height) {
      picture.width = width;
      picture.height = height;
    }
    picture.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), width, height), 0, 0);
  }

  function metrics() {
    const engineStats = job.engine ?? {};
    const ownRequests = performance.getEntriesByType('resource').filter((entry) => entry.startTime >= readyAt).length;
    return {
      wall_ms: performance.now() - job.t0,
      text_ms: job.textMs,
      compute_ms: engineStats.computeMs ?? 0,
      step: engineStats.step ?? 0,
      steps: job.plan?.steps ?? 0,
      width: job.plan?.width ?? 0,
      height: job.plan?.height ?? 0,
      requests: ownRequests + job.textRequests + (engineStats.networkRequests ?? 0),
    };
  }

  async function finish(message) {
    if (message.job !== job?.id) return;
    job.engine = message;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = null;
    if (message.image) {
      draw(message.image);
      const blob = await new Promise((resolve) => canvas().toBlob(resolve, 'image/png'));
      imageUrl = URL.createObjectURL(blob);
    }
    report({ type: 'done', status: message.stopped ? 'Stopped.' : 'Done.', image: imageUrl, metrics: metrics() });
  }

  function terminate() {
    for (const bundle of Object.values(bundles)) {
      bundle.worker.terminate();
      bundle.pool.terminate();
    }
  }

  /** The model could not load, or an engine or a compute thread died. */
  function fail(message) {
    broken = true;
    terminate();
    report({ type: 'broken', message });
  }

  function crash(message) {
    fail(`The engine stopped: ${message}.`);
  }

  const bundles = {
    text: start('text'),
    image: start('image'),
  };

  onCleanup(onClicks(inputs.starts, dispatch));
  onCleanup(onClicks(inputs.stops, stop));
  onCleanup(() => {
    terminate();
    if (imageUrl) URL.revokeObjectURL(imageUrl);
  });
}

/** Runs `action` once per click a click counter counts, clicks before this module loaded included. */
function onClicks(counter, action) {
  let seen = 0;
  return counter.subscribe((count) => {
    for (; seen < count; seen++) action();
  });
}
