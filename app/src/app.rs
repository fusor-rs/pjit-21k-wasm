use fusor::{JsInputs, Signal, signal};
use serde::{Deserialize, Serialize};

const SAMPLE_PROMPT: &str = "Close-up portrait of an elderly Middle Eastern woman looking calmly \
into the lens, her face filling the tall frame. A cream headscarf and the collar of a dark green \
cardigan frame her chin. Soft overcast daylight smooths the fine lines of her skin, and the olive \
grove behind melts into silvery blur.";
const DEFAULT_STEPS: f64 = 50.0;
const DEFAULT_GUIDANCE: f64 = 15.0;
const DEFAULT_SEED: &str = "2";
const DEFAULT_ASPECT: &str = "square";
// A step's seconds at the trained sizes, natively on an 8-core Apple M4 Pro: 9.1 s measured with
// the CLI at 1024 × 1024.
const NATIVE_STEP_SECONDS: f64 = 9.0;
const SECONDS_PER_MINUTE: f64 = 60.0;

/// The five sizes P-JiT 21K was trained at, the only ones it generates: id, label, width, height.
const ASPECTS: [(&str, &str, u32, u32); 5] = [
    ("square", "Square", 1024, 1024),
    ("tall", "Tall", 864, 1216),
    ("4:3", "4:3", 1152, 864),
    ("3:2", "3:2", 1248, 832),
    ("16:9", "16:9", 1280, 720),
];

#[derive(Clone, PartialEq)]
struct Choice {
    id: String,
    label: String,
    detail: String,
}

// The runtime build and the bundles, once loaded.
#[derive(Clone, PartialEq, Deserialize)]
struct Loaded {
    build: String,
    threads: u32,
    bundle_bytes: f64,
    load_ms: f64,
    // Every part of both bundles came from this device's storage.
    from_device: bool,
}

impl Loaded {
    fn summary(&self) -> String {
        let threads = match self.threads {
            1 => "1 thread".to_string(),
            count => format!("{count} threads"),
        };
        let source = if self.from_device {
            "model loaded from this device"
        } else {
            "model downloaded"
        };
        format!(
            "{} · {threads} · {:.0} MB bundles · {source} in {:.1} s",
            self.build,
            self.bundle_bytes / 1e6,
            self.load_ms / 1000.0
        )
    }
}

// One generation as `web/app.js` measures it, live while it runs: `wall_ms` on the page from the
// click (for a queued request, from the model being ready), `text_ms` (the text encoder) and
// `compute_ms` (time inside the image runtime's `start` and `step`, summed) inside the engine
// workers, and the network requests made since the model loaded.
#[derive(Clone, Default, PartialEq, Deserialize)]
struct Metrics {
    wall_ms: f64,
    text_ms: f64,
    compute_ms: f64,
    step: u32,
    steps: u32,
    width: u32,
    height: u32,
    requests: u32,
}

impl Metrics {
    fn time(&self) -> String {
        format!("{:.1} s", self.wall_ms / 1000.0)
    }

    fn compute(&self) -> String {
        format!(
            "{:.1} s computing, caption {:.1} s",
            self.compute_ms / 1000.0,
            self.text_ms / 1000.0
        )
    }

    fn per_step(&self) -> String {
        if self.step == 0 {
            return "–".into();
        }
        format!("{:.2} s", self.compute_ms / 1000.0 / f64::from(self.step))
    }

    fn steps(&self) -> String {
        format!("{} / {}", self.step, self.steps)
    }

    fn image(&self) -> String {
        if self.width == 0 {
            return "–".into();
        }
        format!("{}×{}", self.width, self.height)
    }

    fn requests(&self) -> String {
        self.requests.to_string()
    }
}

// What `web/app.js` reports, one JSON object per `engine` event.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Report {
    Loading {
        fraction: f64,
        detail: String,
    },
    Ready {
        loaded: Loaded,
    },
    Progress {
        status: String,
        metrics: Metrics,
    },
    // The image is drawn; `image` is the PNG's blob URL.
    Done {
        status: String,
        image: Option<String>,
        metrics: Metrics,
    },
    // A generation failed; the engine can run the next one.
    Error {
        message: String,
    },
    // The model could not load, or the engine died: nothing more can run in this page.
    Broken {
        message: String,
    },
}

// The image engine's request (`pjit_21k::session::Request` in the runtime), as `web/app.js` posts
// it.
#[derive(Serialize)]
struct Request {
    width: u32,
    height: u32,
    steps: u32,
    guidance: f32,
    seed: u64,
}

// What the text encoder reads, as `web/app.js` posts it.
#[derive(Serialize)]
struct Prompts {
    prompt: String,
    negative: String,
}

// One generation as JSON: the request and the prompts.
struct Job {
    request: String,
    prompts: String,
}

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Loading,
    Ready,
    Generating,
    Broken,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::Loading => "loading",
            Self::Ready => "ready",
            Self::Generating => "generating",
            Self::Broken => "broken",
        }
    }
}

#[derive(JsInputs)]
struct App {
    prompt: Signal<String>,
    negative: Signal<String>,
    aspect: Signal<String>,
    steps: Signal<f64>,
    guidance: Signal<f64>,
    seed: Signal<String>,
    // `web/app.js` acts on every new count: `starts` runs `request` on `prompts`, `stops` stops
    // the generation.
    #[js]
    request: Signal<String>,
    #[js]
    prompts: Signal<String>,
    #[js]
    starts: Signal<u32>,
    #[js]
    stops: Signal<u32>,
    phase: Signal<Phase>,
    // Generate was clicked while the model loaded: it runs as soon as the model is ready.
    queued: Signal<bool>,
    fraction: Signal<f64>,
    detail: Signal<String>,
    status: Signal<String>,
    image: Signal<Option<String>>,
    metrics: Signal<Metrics>,
    measured: Signal<bool>,
    loaded: Signal<Option<Loaded>>,
}

impl App {
    fn new() -> Self {
        Self {
            prompt: signal(SAMPLE_PROMPT.into()),
            negative: signal(String::new()),
            aspect: signal(DEFAULT_ASPECT.into()),
            steps: signal(DEFAULT_STEPS),
            guidance: signal(DEFAULT_GUIDANCE),
            seed: signal(DEFAULT_SEED.into()),
            request: signal(String::new()),
            prompts: signal(String::new()),
            starts: signal(0),
            stops: signal(0),
            phase: signal(Phase::Loading),
            queued: signal(false),
            fraction: signal(0.0),
            detail: signal("Starting…".into()),
            status: signal(String::new()),
            image: signal(None),
            metrics: signal(Metrics::default()),
            measured: signal(false),
            loaded: signal(None),
        }
    }

    fn aspects(&self) -> Vec<Choice> {
        let aspects = ASPECTS.iter().map(|&(id, label, width, height)| Choice {
            id: id.into(),
            label: label.into(),
            detail: format!("{width}×{height}"),
        });
        aspects.collect()
    }

    fn duration(&self) -> String {
        let steps = self.steps.get();
        format!(
            "Estimated: a step takes about {NATIVE_STEP_SECONDS:.0} s natively on an 8-core Apple \
             M4 Pro and longer in the browser, so {steps} steps take over {:.1} min.",
            steps * NATIVE_STEP_SECONDS / SECONDS_PER_MINUTE
        )
    }

    fn reset_prompt(&self) {
        self.prompt.set(SAMPLE_PROMPT.into());
    }

    fn generate(&self) {
        let Some(job) = self.job() else {
            return;
        };
        if self.phase.get() == Phase::Loading {
            self.queued.set(true);
            self.status
                .set("Queued: it starts the moment the model is ready.".into());
        } else {
            self.begin(job);
        }
    }

    // The generation for the form's settings, or `None` after telling what is wrong.
    fn job(&self) -> Option<Job> {
        let prompt = self.prompt.get().trim().to_string();
        if prompt.is_empty() {
            self.status.set("Describe the image first.".into());
            return None;
        }
        let Ok(seed) = self.seed.get().trim().parse::<u64>() else {
            self.status
                .set("The seed is a whole number from 0 to 18446744073709551615.".into());
            return None;
        };
        let (width, height) = self.dimensions();
        let request = Request {
            width,
            height,
            steps: self.steps.get() as u32,
            guidance: self.guidance.get() as f32,
            seed,
        };
        let prompts = Prompts {
            prompt,
            negative: self.negative.get().trim().to_string(),
        };
        Some(Job {
            request: serde_json::to_string(&request).expect("plain data serializes"),
            prompts: serde_json::to_string(&prompts).expect("plain data serializes"),
        })
    }

    fn begin(&self, job: Job) {
        self.request.set(job.request);
        self.prompts.set(job.prompts);
        self.phase.set(Phase::Generating);
        self.measured.set(true);
        self.image.set(None);
        self.metrics.set(Metrics::default());
        self.status.set("Reading the caption…".into());
        self.starts.update(|count| *count += 1);
    }

    fn stop(&self) {
        if self.queued.get() {
            self.queued.set(false);
            self.status.set("Cancelled.".into());
            return;
        }
        self.stops.update(|count| *count += 1);
    }

    fn receive(&self, event: web_sys::Event) {
        let json = fusor::js::event_detail::<String>(&event).expect("web/app.js sends strings");
        let report = serde_json::from_str(&json).expect("web/app.js sends engine reports");
        match report {
            Report::Loading { fraction, detail } => {
                self.fraction.set(fraction);
                self.detail.set(detail);
            }
            Report::Ready { loaded } => self.ready(loaded),
            Report::Progress { status, metrics } => {
                self.status.set(status);
                self.metrics.set(metrics);
            }
            Report::Done {
                status,
                image,
                metrics,
            } => {
                self.status.set(status);
                self.image.set(image);
                self.metrics.set(metrics);
                self.phase.set(Phase::Ready);
            }
            Report::Error { message } => {
                self.status.set(format!("error: {message}"));
                self.phase.set(Phase::Ready);
            }
            Report::Broken { message } => {
                self.detail.set(message);
                self.phase.set(Phase::Broken);
            }
        }
    }

    fn ready(&self, loaded: Loaded) {
        self.loaded.set(Some(loaded));
        self.phase.set(Phase::Ready);
        let queued = self.queued.get();
        self.queued.set(false);
        if queued && let Some(job) = self.job() {
            self.begin(job);
        }
    }

    fn summary(&self) -> String {
        self.loaded
            .get()
            .map_or(String::new(), |loaded| loaded.summary())
    }

    fn generate_label(&self) -> &'static str {
        match (self.phase.get(), self.queued.get()) {
            (Phase::Loading, true) => "Queued",
            (Phase::Loading, false) => "Generate when ready",
            _ => "Generate",
        }
    }

    fn can_stop(&self) -> bool {
        self.phase.get() == Phase::Generating || self.queued.get()
    }

    // The model never loaded: likely a bundle that does not match the runtime.
    fn failed_to_load(&self) -> bool {
        self.loaded.get().is_none()
    }

    fn can_generate(&self) -> bool {
        match self.phase.get() {
            Phase::Loading => !self.queued.get(),
            Phase::Ready => true,
            Phase::Generating | Phase::Broken => false,
        }
    }

    fn dimensions(&self) -> (u32, u32) {
        let aspect = self.aspect.get();
        let &(_, _, width, height) = ASPECTS
            .iter()
            .find(|(id, ..)| *id == aspect)
            .expect("the aspect radio's values are the ids of ASPECTS");
        (width, height)
    }

    // The picture's aspect ratio, from the chosen size, so it keeps its shape before the first
    // preview.
    fn aspect_style(&self) -> String {
        let (width, height) = self.dimensions();
        format!("aspect-ratio: {width} / {height}")
    }
}

fusor::template!("web/index.html");
