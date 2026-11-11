// The DiT's home: P-JiT 21K in a module Worker with its own runtime instance and memory. It denoises
// in pixel space, so there is no decoder.
//
// Load: fusor-ai's worker kit (`dist/host/worker.js`) starts the best runtime build and streams
// every part of the bundle into it; the runtime checks each part's size and BLAKE3.
//
// Generate: `start()` takes the text encoder's states, then one `step()` per macrotask, so a stop
// request is seen between steps. After each denoising step the page gets the clean image that step
// predicts, at full size; after the last, the image itself.
//
// After the model is loaded nothing else is fetched: generation is entirely local.

import { engine, load, post, requestsSinceReady, serve, yieldTask } from './dist/host/worker.js';

let stoppedJob = null;

serve({
  load: ({ modelUrl, threads, build }) =>
    load({
      modelUrl,
      threads,
      build,
      glueName: 'pjit_21k_runtime',
      className: 'ImageRuntime',
      cacheName: 'pjit-21k-image',
      distUrl: new URL('./dist/', import.meta.url),
      onRuntime: (started) => post({ type: 'runtime', build: started.build.name, threads: started.threads }),
      onReady: (progress) => post({ type: 'ready', ...progress }),
    }),
  generate,
  stop: ({ job }) => (stoppedJob = job),
});

async function generate({ job, request, prompt, negative }) {
  const { rt } = engine;
  let t0 = performance.now();
  const plan = JSON.parse(rt.start(request, prompt, negative));
  const timing = { computeMs: performance.now() - t0, step: 0 };
  post({ type: 'started', job, plan, ...timing });
  for (;;) {
    await yieldTask();
    if (stoppedJob === job) {
      rt.cancel();
      return post({ type: 'done', job, stopped: true, image: null, ...timing, networkRequests: requestsSinceReady() });
    }
    t0 = performance.now();
    const progress = JSON.parse(rt.step());
    timing.computeMs += performance.now() - t0;
    timing.step = progress.step;
    if (progress.done) {
      const image = { width: plan.width, height: plan.height, pixels: rt.take_image() };
      return post({ type: 'done', job, stopped: false, image, ...timing, networkRequests: requestsSinceReady() }, [image.pixels.buffer]);
    }
    const preview = { width: plan.width, height: plan.height, pixels: rt.preview() };
    post({ type: 'step', job, preview, ...timing, networkRequests: requestsSinceReady() }, [preview.pixels.buffer]);
  }
}
