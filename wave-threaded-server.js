#!/usr/bin/env node
// wave-threaded-router.js
// Full-stack library: combining wave-driven server concurrency with client-side routing

/**
 * @module wave-threaded-router
 */
const express = require("express");
const path = require("path");
const fs = require("fs");
const {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} = require("worker_threads");
const os = require("os");
const program = require("commander");
const EventEmitter = require("events");

// === Config Parsing ===
const DEFAULTS = {
  PERIOD: 10000,
  AMPLITUDE: os.cpus().length,
  OFFSET: 0,
  MIN_THREADS: 1,
  LATENCY_TARGET_MS: 200,
  LATENCY_WINDOW: 50,
  AMPLITUDE_STEP: 1,
  PERIOD_MIN: 2000,
  PERIOD_MAX: 60000,
  QUEUE_PROCESS_INTERVAL: 1000,
  QUEUE_MAX_SIZE: 1000,
  QUEUE_RETRY_AFTER: 5,
  SHAPE_DRIVE_THRESHOLD: 0.75,
  WORKER_TIMEOUT_MS: 30000,
  WORKER_RETRY_ATTEMPTS: 3,
  WORKER_RETRY_DELAY_MS: 100,
  CLIENT_ROUTER_MODE: "hash", // 'hash' or 'history'
  CLIENT_ROUTER_ROOT: "/",
  CLIENT_ROUTER_INTERVAL: 50,
};

function getConfig() {
  return {
    period: +(process.env.WAVE_PERIOD || DEFAULTS.PERIOD),
    amplitude: +(process.env.WAVE_AMPLITUDE || DEFAULTS.AMPLITUDE),
    offset: +(process.env.WAVE_OFFSET || DEFAULTS.OFFSET),
    minThreads: +(process.env.WAVE_MIN_THREADS || DEFAULTS.MIN_THREADS),
    latencyTarget: +(
      process.env.WAVE_LATENCY_TARGET_MS || DEFAULTS.LATENCY_TARGET_MS
    ),
    latencyWindow: +(
      process.env.WAVE_LATENCY_WINDOW || DEFAULTS.LATENCY_WINDOW
    ),
    amplitudeStep: +(
      process.env.WAVE_AMPLITUDE_STEP || DEFAULTS.AMPLITUDE_STEP
    ),
    periodMin: +(process.env.WAVE_PERIOD_MIN || DEFAULTS.PERIOD_MIN),
    periodMax: +(process.env.WAVE_PERIOD_MAX || DEFAULTS.PERIOD_MAX),
    queueInterval: +(
      process.env.WAVE_QUEUE_INTERVAL || DEFAULTS.QUEUE_PROCESS_INTERVAL
    ),
    queueMax: +(process.env.WAVE_QUEUE_MAX_SIZE || DEFAULTS.QUEUE_MAX_SIZE),
    retryAfter: +(
      process.env.WAVE_QUEUE_RETRY_AFTER || DEFAULTS.QUEUE_RETRY_AFTER
    ),
    shapeDriveThreshold: +(
      process.env.WAVE_SHAPE_DRIVE_THRESHOLD || DEFAULTS.SHAPE_DRIVE_THRESHOLD
    ),
    workerTimeout: +(
      process.env.WAVE_WORKER_TIMEOUT_MS || DEFAULTS.WORKER_TIMEOUT_MS
    ),
    workerRetryAttempts: +(
      process.env.WAVE_WORKER_RETRY_ATTEMPTS || DEFAULTS.WORKER_RETRY_ATTEMPTS
    ),
    workerRetryDelay: +(
      process.env.WAVE_WORKER_RETRY_DELAY_MS || DEFAULTS.WORKER_RETRY_DELAY_MS
    ),
    clientRouterMode:
      process.env.CLIENT_ROUTER_MODE || DEFAULTS.CLIENT_ROUTER_MODE,
    clientRouterRoot:
      process.env.CLIENT_ROUTER_ROOT || DEFAULTS.CLIENT_ROUTER_ROOT,
    clientRouterInterval: +(
      process.env.CLIENT_ROUTER_INTERVAL || DEFAULTS.CLIENT_ROUTER_INTERVAL
    ),
  };
}

// === WaveController ===
class WaveController {
  constructor(options = {}) {
    const cfg = getConfig();
    this.period = options.period || cfg.period;
    this.amplitude = options.amplitude || cfg.amplitude;
    this.offset = options.offset || cfg.offset;
    this.shapeFn =
      options.shapeFn || ((phase) => (Math.sin(phase * 2 * Math.PI) + 1) / 2);
    this.startTime = Date.now();
    this.minThreads = cfg.minThreads;
    this.latencyTarget = cfg.latencyTarget;
    this.latencyWindow = cfg.latencyWindow;
    this.amplitudeStep = cfg.amplitudeStep;
    this.periodMin = cfg.periodMin;
    this.periodMax = cfg.periodMax;
    this.latencies = [];
    this.shapeDriveThreshold = cfg.shapeDriveThreshold;
    this.workerFailures = 0;
    this.lastWorkerReset = Date.now();
    this.emitter = new EventEmitter();
  }
  getPhase() {
    const t = Date.now() - this.startTime;
    return ((t + this.offset) % this.period) / this.period;
  }
  getLevel() {
    const phase = this.getPhase();
    let factor = this.shapeFn(phase);
    const load = os.loadavg()[0] / os.cpus().length;
    if (load > this.shapeDriveThreshold) factor = Math.max(factor, load);
    const level = factor * this.amplitude;
    this.recordLoad(load);
    return Math.max(this.minThreads, level);
  }
  recordLatency(ms) {
    this.latencies.push(ms);
    if (this.latencies.length > this.latencyWindow) this.latencies.shift();
    this.adjustParameters();
  }
  recordLoad(load) {
    this.lastLoad = load;
  }
  recordWorkerFailure(error) {
    this.workerFailures++;
    // If we're seeing high failure rates, adjust amplitude downward temporarily
    if (this.workerFailures > 5 && Date.now() - this.lastWorkerReset < 60000) {
      this.amplitude = Math.max(this.minThreads, this.amplitude * 0.8);
      this.emitter.emit("worker-failure-throttle", {
        failures: this.workerFailures,
        newAmplitude: this.amplitude,
      });
    }
    // Reset failure counter periodically
    if (Date.now() - this.lastWorkerReset > 60000) {
      this.lastWorkerReset = Date.now();
      this.workerFailures = 0;
    }
    return this.workerFailures;
  }
  adjustParameters() {
    const avg =
      this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length || 0;
    if (!avg) return;
    if (avg > this.latencyTarget) {
      this.amplitude += this.amplitudeStep;
      this.period = Math.max(
        this.periodMin,
        this.period - this.amplitudeStep * 100
      );
    } else {
      this.amplitude = Math.max(
        this.minThreads,
        this.amplitude - this.amplitudeStep
      );
      this.period = Math.min(
        this.periodMax,
        this.period + this.amplitudeStep * 100
      );
    }
  }
  on(event, callback) {
    this.emitter.on(event, callback);
  }
}

// === Worker Management ===
class WorkerManager {
  constructor() {
    this.cfg = getConfig();
    this.activeWorkers = new Map();
    this.errorLog = [];
    this.healthCheck();
  }

  healthCheck() {
    // Periodically check for hanging/zombie workers
    setInterval(() => {
      const now = Date.now();
      this.activeWorkers.forEach((workerInfo, workerId) => {
        if (now - workerInfo.startTime > this.cfg.workerTimeout) {
          console.warn(
            `Worker ${workerId} timed out after ${this.cfg.workerTimeout}ms - terminating`
          );
          try {
            workerInfo.worker.terminate();
          } catch (err) {
            console.error(`Error terminating worker ${workerId}:`, err);
          }
          this.activeWorkers.delete(workerId);

          // If a callback was set, reject it
          if (workerInfo.reject) {
            workerInfo.reject(
              new Error(`Worker timeout after ${this.cfg.workerTimeout}ms`)
            );
          }
        }
      });
    }, 5000);
  }

  async runStatelessTask(data, waveController) {
    const workerId = `worker-${Date.now()}-${Math.random()
      .toString(36)
      .substring(2, 9)}`;
    let attempts = 0;
    const maxAttempts = this.cfg.workerRetryAttempts;

    const runWithRetry = async () => {
      attempts++;

      return new Promise((resolve, reject) => {
        try {
          const worker = new Worker(__filename, { workerData: data });
          const startTime = Date.now();

          // Save worker reference for management
          this.activeWorkers.set(workerId, {
            worker,
            startTime,
            data,
            resolve,
            reject,
          });

          worker.on("message", (message) => {
            this.activeWorkers.delete(workerId);
            resolve(message);
          });

          worker.on("error", (error) => {
            this.activeWorkers.delete(workerId);

            // Log error
            const errorDetails = {
              error: error.message,
              workerId,
              timestamp: new Date().toISOString(),
              data: JSON.stringify(data).substring(0, 200), // Truncate for log safety
            };

            this.errorLog.push(errorDetails);
            if (this.errorLog.length > 100) this.errorLog.shift(); // Keep log size reasonable

            // Record failure in wave controller
            if (waveController) {
              waveController.recordWorkerFailure(error);
            }

            if (attempts < maxAttempts) {
              setTimeout(() => {
                runWithRetry().then(resolve).catch(reject);
              }, this.cfg.workerRetryDelay * attempts); // Progressive backoff
            } else {
              reject(
                new Error(
                  `Worker failed after ${attempts} attempts: ${error.message}`
                )
              );
            }
          });

          worker.on("exit", (code) => {
            this.activeWorkers.delete(workerId);
            if (code !== 0) {
              const error = new Error(`Worker exited with code ${code}`);

              if (waveController) {
                waveController.recordWorkerFailure(error);
              }

              if (attempts < maxAttempts) {
                setTimeout(() => {
                  runWithRetry().then(resolve).catch(reject);
                }, this.cfg.workerRetryDelay * attempts); // Progressive backoff
              } else {
                reject(error);
              }
            }
          });
        } catch (error) {
          // Handle worker creation failure
          if (attempts < maxAttempts) {
            setTimeout(() => {
              runWithRetry().then(resolve).catch(reject);
            }, this.cfg.workerRetryDelay * attempts); // Progressive backoff
          } else {
            reject(
              new Error(
                `Failed to create worker after ${attempts} attempts: ${error.message}`
              )
            );
          }
        }
      });
    };

    return runWithRetry();
  }

  getWorkerStats() {
    return {
      activeWorkers: this.activeWorkers.size,
      recentErrors: this.errorLog.slice(-10),
    };
  }

  terminateAll() {
    this.activeWorkers.forEach((workerInfo, workerId) => {
      try {
        workerInfo.worker.terminate();
      } catch (err) {
        console.error(`Error terminating worker ${workerId}:`, err);
      }
    });
    this.activeWorkers.clear();
  }
}

// Initialize global worker manager
const workerManager = new WorkerManager();

// === Worker Runner ===
function runStatelessTask(data, waveController) {
  return workerManager.runStatelessTask(data, waveController);
}

if (!isMainThread) {
  (async () => {
    try {
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      await delay(workerData.delay || 100);

      // If in test mode, simulate occasional failure
      if (workerData.testMode === "failure" && Math.random() < 0.3) {
        throw new Error("Simulated worker failure for testing");
      }

      const out = workerData.fn
        ? await workerData.fn(workerData.value)
        : workerData.value ** 2;
      parentPort.postMessage({ result: out, threadId: process.pid });
    } catch (error) {
      // Signal error back to parent
      if (parentPort) {
        parentPort.postMessage({ error: error.message });
      }
      // Exit with non-zero for the 'exit' event to pick up
      process.exit(1);
    }
  })();
  return;
}

// === Default Handlers ===
async function defaultStatelessHandler(req, res, next, maxWorkers, wave) {
  const start = Date.now();
  try {
    const inputs = Array.from({ length: maxWorkers }, (_, i) => i + 1);
    const results = await Promise.all(
      inputs.map((i) =>
        runStatelessTask(
          {
            value: i,
            fn: req.app.locals.taskFn,
            testMode: req.query.testMode,
          },
          wave
        )
      )
    );

    const latency = Date.now() - start;
    wave.recordLatency(latency);

    // Check for errors in results
    const errors = results.filter((r) => r.error).map((r) => r.error);
    if (errors.length) {
      res.status(500).json({
        level: wave.getLevel(),
        phase: wave.getPhase(),
        errors,
        partialResults: results.filter((r) => !r.error),
        latency,
      });
    } else {
      res.json({
        level: wave.getLevel(),
        phase: wave.getPhase(),
        results,
        latency,
      });
    }
  } catch (error) {
    const latency = Date.now() - start;
    wave.recordLatency(latency * 1.5); // Penalize errors in the wave model
    console.error("Error in stateless handler:", error);
    res.status(500).json({
      error: error.message,
      level: wave.getLevel(),
      phase: wave.getPhase(),
      latency,
    });
  }
}

async function defaultStatefulHandler(req, res, next, _, wave) {
  const start = Date.now();
  try {
    const result = { ok: true };
    const latency = Date.now() - start;
    wave.recordLatency(latency);
    res.json({
      level: wave.getLevel(),
      phase: wave.getPhase(),
      result,
      latency,
    });
  } catch (error) {
    const latency = Date.now() - start;
    wave.recordLatency(latency * 1.5); // Penalize errors in the wave model
    console.error("Error in stateful handler:", error);
    res.status(500).json({
      error: error.message,
      level: wave.getLevel(),
      phase: wave.getPhase(),
      latency,
    });
  }
}

// === Request Queue & Backpressure ===
function initQueue(app) {
  const cfg = getConfig();
  app.locals.queue = [];
  setInterval(() => processQueue(app), cfg.queueInterval);
}

function processQueue(app) {
  const wave = app.locals.wave;
  const maxWorkers = Math.floor(wave.getLevel());
  const queue = app.locals.queue;
  const toProcess = queue.splice(0, maxWorkers);
  toProcess.forEach(({ req, res, next }) => app._router.handle(req, res, next));
}

// === Middleware Factory ===
function waveMiddleware({
  waveController = new WaveController(),
  isStateless = (req) => req.method === "GET",
} = {}) {
  const cfg = getConfig();
  return async (req, res, next) => {
    req.app.locals.wave = waveController;
    if (!req.app.locals.queue) initQueue(req.app);
    req.app.locals.inflight = req.app.locals.inflight || 0;
    const level = waveController.getLevel();
    const capacity = Math.floor(level);

    // Add error handler for connection closing unexpectedly
    req.on("close", () => {
      if (!res.headersSent) {
        req.app.locals.inflight--;
      }
    });

    if (req.app.locals.queue.length >= cfg.queueMax) {
      res.set("Retry-After", cfg.retryAfter);
      return res.status(503).send("Server Busy");
    }

    if (req.app.locals.inflight >= capacity) {
      req.app.locals.queue.push({ req, res, next });
      return res.status(202).send("Accepted");
    }

    req.app.locals.inflight++;
    const startReq = Date.now();

    const done = () => {
      waveController.recordLatency(Date.now() - startReq);
      req.app.locals.inflight--;
    };

    res.on("finish", () => {
      if (!res.headersSent) done();
    });

    try {
      if (isStateless(req)) {
        return defaultStatelessHandler(req, res, next, capacity, waveController)
          .then(done)
          .catch((err) => {
            // Error already handled in defaultStatelessHandler
            if (!res.headersSent) done();
          });
      } else {
        return defaultStatefulHandler(req, res, next, capacity, waveController)
          .then(done)
          .catch((err) => {
            // Error already handled in defaultStatefulHandler
            if (!res.headersSent) done();
          });
      }
    } catch (error) {
      console.error("Middleware error:", error);
      if (!res.headersSent) {
        done();
        res.status(500).json({ error: "Internal server error" });
      }
    }
  };
}

// === Route Helpers ===
function autoMount(app, routes) {
  routes.forEach((r) => app[r.method](r.path, r.handler));
}

// === Metrics ===
function exposeMetrics(app, path = "/metrics") {
  app.get(path, (req, res) => {
    const w = req.app.locals.wave;
    const workerStats = workerManager.getWorkerStats();

    res.json({
      level: w.getLevel(),
      phase: w.getPhase(),
      amp: w.amplitude,
      period: w.period,
      queue: req.app.locals.queue.length,
      load: w.lastLoad,
      workerFailures: w.workerFailures,
      activeWorkers: workerStats.activeWorkers,
      recentErrors: workerStats.recentErrors,
    });
  });
}

// === Health Check ===
function exposeHealthCheck(app, path = "/health") {
  app.get(path, (req, res) => {
    const healthy =
      workerManager.getWorkerStats().activeWorkers < getConfig().amplitude * 2;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? "healthy" : "unhealthy",
      timestamp: new Date().toISOString(),
    });
  });
}

// === Graceful Shutdown ===
function setupGracefulShutdown(app, server) {
  function shutdown() {
    console.log("Shutting down...");
    server.close(() => {
      console.log("HTTP server closed");
      workerManager.terminateAll();
      console.log("All workers terminated");
      process.exit(0);
    });

    // Force shutdown after timeout
    setTimeout(() => {
      console.error("Forced shutdown after timeout");
      process.exit(1);
    }, 30000);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// ========================================
// === Client-Side Router Integration ====
// ========================================

/**
 * Generate client-side router script to inject into pages
 * @param {Object} options - Router configuration options
 * @returns {string} The client-side router script
 */
function generateClientRouterScript(options = {}) {
  const cfg = getConfig();
  const mode = options.mode || cfg.clientRouterMode;
  const root = options.root || cfg.clientRouterRoot;
  const interval = options.interval || cfg.clientRouterInterval;

  return `
// Client-side Router
var Router = {
  routes: [],
  mode: "${mode}",
  root: "${root}",
  interval: null,
  config: function (options) {
    this.mode = options && options.mode ? options.mode : this.mode;
    this.root =
      options && options.root
        ? "/" + this.clearSlashes(options.root) + "/"
        : "/";
    return this;
  },
  getFragment: function () {
    var fragment = "";
    if (this.mode === "history") {
      fragment = this.clearSlashes(
        decodeURI(location.pathname + location.search)
      );
      fragment = fragment.replace(/\\?(.*)$/, "");
      fragment = this.root !== "/" ? fragment.replace(this.root, "") : fragment;
    } else {
      var match = window.location.href.match(/#(.*)$/);
      fragment = match ? match[1] : "";
    }
    return this.clearSlashes(fragment);
  },
  clearSlashes: function (path) {
    return path.toString().replace(/\/$/, "").replace(/^\//, "");
  },
  add: function (re, handler) {
    if (typeof re === "function") {
      handler = re;
      re = "";
    }
    this.routes.push({ re: re, handler: handler });
    return this;
  },
  check: function (f) {
    var fragment = f || this.getFragment();
    for (var i = 0; i < this.routes.length; i++) {
      var match = fragment.match(this.routes[i].re);
      if (match) {
        match.shift();
        this.routes[i].handler.apply({}, match);
        return this;
      }
    }
    return this;
  },
  listen: function () {
    var self = this;
    var current = self.getFragment();
    var fn = function () {
      if (current !== self.getFragment()) {
        current = self.getFragment();
        self.check(current);
      }
    };
    clearInterval(this.interval);
    this.interval = setInterval(fn, ${interval});
    return this;
  },
  navigate: function (path) {
    path = path ? path : "";
    if (this.mode === "history") {
      history.pushState(null, null, this.root + this.clearSlashes(path));
    } else {
      window.location.href =
        window.location.href.replace(/#(.*)$/, "") + "#" + path;
    }
    return this;
  },
  // Helper methods
  addRoute: function(path, handler) {
    return this.add(path, handler);
  },
  loadPage: function(url, targetElement) {
    const target = targetElement || "app";
    fetch(url)
      .then((response) => response.text())
      .then((html) => {
        document.getElementById(target).innerHTML = html;
      })
      .catch((err) => {
        console.warn("Error loading page:", err);
        document.getElementById(target).innerHTML = "<h1>Page not found!</h1>";
      });
  }
};

// Initialize router if specified in the data-auto-init attribute
document.addEventListener("DOMContentLoaded", function() {
  var routerElement = document.querySelector("[data-router-init]");
  if (routerElement) {
    Router.config({
      mode: routerElement.getAttribute("data-router-mode") || "${mode}",
      root: routerElement.getAttribute("data-router-root") || "${root}"
    }).listen();
    
    // Auto-setup routes from data attributes if present
    var routeElements = document.querySelectorAll("[data-route]");
    routeElements.forEach(function(el) {
      var path = el.getAttribute("data-route");
      var targetId = el.getAttribute("data-target") || "app";
      var templateUrl = el.getAttribute("data-template");
      if (path && templateUrl) {
        Router.add(path, function() {
          Router.loadPage(templateUrl, targetId);
        });
      }
    });
  }
});
`;
}

/**
 * Middleware to inject client router script into HTML responses
 * @param {Object} options - Router configuration options
 * @returns {Function} Express middleware
 */
function injectClientRouter(options = {}) {
  const routerScript = generateClientRouterScript(options);

  return (req, res, next) => {
    // Store original send function
    const originalSend = res.send;

    // Override send method to inject router script into HTML pages
    res.send = function (body) {
      // Only modify HTML responses
      if (
        this.get("Content-Type") &&
        this.get("Content-Type").includes("text/html")
      ) {
        if (typeof body === "string" && body.includes("</head>")) {
          body = body.replace(
            "</head>",
            `<script>${routerScript}</script></head>`
          );
        }
      }
      return originalSend.call(this, body);
    };

    next();
  };
}

/**
 * Create a static HTML page with router support
 * @param {Object} options - Router configuration options
 * @returns {string} HTML template with router support
 */
function createRouterPage(options = {}) {
  const cfg = getConfig();
  const mode = options.mode || cfg.clientRouterMode;
  const root = options.root || cfg.clientRouterRoot;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${options.title || "Wave Threaded Router App"}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; margin: 0; padding: 20px; }
    nav { margin-bottom: 20px; }
    nav a { margin-right: 15px; color: #0066cc; text-decoration: none; }
    nav a:hover { text-decoration: underline; }
    #app { padding: 20px; border-radius: 8px; background: #f5f5f5; min-height: 300px; }
  </style>
</head>
<body>
  <div data-router-init data-router-mode="${mode}" data-router-root="${root}">
    <h1>${options.heading || "Wave Threaded Router"}</h1>
    
    <nav>
      ${
        options.routes
          ? options.routes
              .map(
                (route) =>
                  `<a href="#${route.path}" onclick="Router.navigate('${route.path}'); return false;">${route.title}</a>`
              )
              .join("\n      ")
          : ""
      }
    </nav>
    
    <div id="app">
      <p>Loading application...</p>
    </div>
  </div>
  
  ${
    options.routes
      ? options.routes
          .map(
            (route) =>
              `<div style="display:none" data-route="${route.path}" data-template="${route.template}"></div>`
          )
          .join("\n  ")
      : ""
  }
  
  <script>
    // Initialize default route
    document.addEventListener("DOMContentLoaded", function() {
      setTimeout(() => {
        const defaultPath = "${options.defaultRoute || ""}";
        if (Router.getFragment() === '') {
          Router.navigate(defaultPath);
        }
        Router.check();
      }, 100);
    });
  </script>
</body>
</html>
  `;
}

/**
 * Setup route handler to serve the client-side router and templates
 * @param {Object} app - Express app
 * @param {Object} options - Router options
 */
function setupClientRouting(app, options = {}) {
  const cfg = getConfig();

  // Serve the main router page
  app.get(options.entryPath || "/", (req, res) => {
    res.send(createRouterPage(options));
  });

  // Serve template fragments
  if (options.routes) {
    options.routes.forEach((route) => {
      if (route.handler) {
        // If route has a custom handler
        app.get(`/templates${route.path}`, route.handler);
      } else if (route.template) {
        // If route points to a template file
        app.get(`/templates${route.path}`, (req, res) => {
          res.sendFile(
            path.resolve(options.templateDir || "templates", route.template)
          );
        });
      } else if (route.content) {
        // If route has direct content
        app.get(`/templates${route.path}`, (req, res) => {
          res.send(route.content);
        });
      }
    });
  }

  // Serve the router.js script directly if needed
  app.get("/router.js", (req, res) => {
    res
      .type("application/javascript")
      .send(generateClientRouterScript(options));
  });
}

// === CLI === (continuing)
if (require.main === module) {
  program
    .option("-p, --port <n>", "port", 3000)
    .option("--period <ms>", "wave period")
    .option("--amplitude <n>", "max threads")
    .option("--worker-timeout <ms>", "max worker runtime")
    .option("--worker-retries <n>", "worker retry attempts")
    .option("--router-mode <mode>", "client router mode (hash or history)")
    .option("--static <dir>", "static files directory")
    .option("--templates <dir>", "template files directory")
    .parse(process.argv);

  const opts = program.opts();
  const app = express();
  app.use(express.json());

  // Configure wave controller
  const wave = new WaveController({
    period: opts.period,
    amplitude: opts.amplitude,
  });

  // Log worker failures
  wave.on("worker-failure-throttle", (data) => {
    console.warn(
      `Throttling due to worker failures: ${data.failures} failures, new amplitude: ${data.newAmplitude}`
    );
  });

  // Apply wave middleware
  app.use(waveMiddleware({ waveController: wave }));

  // Set up static file serving if specified
  if (opts.static) {
    app.use(express.static(path.resolve(process.cwd(), opts.static)));
  }

  // Include router script injection middleware
  app.use(
    injectClientRouter({
      mode: opts.routerMode || "hash",
      root: "/",
    })
  );

  // Setup default API routes
  autoMount(app, [
    { method: "get", path: "/compute", handler: (req, res, next) => next() },
    { method: "post", path: "/state", handler: (req, res, next) => next() },
  ]);

  // Setup client routing with example routes
  setupClientRouting(app, {
    templateDir: opts.templates || "templates",
    routes: [
      {
        path: "",
        title: "Home",
        content: "<h2>Home Page</h2><p>Welcome to Wave Threaded Router!</p>",
      },
      {
        path: "compute",
        title: "Compute",
        content:
          '<h2>Compute</h2><p>This page demonstrates the compute API</p><button onclick="testCompute()">Run Compute Test</button><pre id="result"></pre><script>function testCompute() { fetch("/compute").then(r => r.json()).then(data => { document.getElementById("result").textContent = JSON.stringify(data, null, 2); }); }</script>',
      },
      {
        path: "metrics",
        title: "Metrics",
        content:
          '<h2>Server Metrics</h2><div id="metrics"></div><script>setInterval(() => { fetch("/metrics").then(r => r.json()).then(data => { document.getElementById("metrics").innerHTML = "<pre>" + JSON.stringify(data, null, 2) + "</pre>"; }); }, 1000);</script>',
      },
    ],
    defaultRoute: "",
  });

  // Add metrics and health check endpoints
  exposeMetrics(app);
  exposeHealthCheck(app);

  // Start server
  const server = app.listen(opts.port, () =>
    console.log(`Wave Threaded Router server listening on port ${opts.port}`)
  );

  setupGracefulShutdown(app, server);
}

// =============================================
// === Additional Client-Side Router Helpers ===
// =============================================

/**
 * Create a middleware for handling SPA routing in history mode
 * Redirects all unmatched routes to the index page
 */
function spaRedirectMiddleware(options = {}) {
  const indexPath = options.indexPath || "/";
  const excludePaths = options.excludePaths || [
    "/api",
    "/compute",
    "/state",
    "/metrics",
    "/health",
  ];
  const excludeExts = options.excludeExts || [
    ".js",
    ".css",
    ".json",
    ".png",
    ".jpg",
    ".svg",
    ".ico",
  ];

  return (req, res, next) => {
    const path = req.path;

    // Skip API paths and static files with extensions
    if (
      excludePaths.some((p) => path.startsWith(p)) ||
      excludeExts.some((ext) => path.endsWith(ext))
    ) {
      return next();
    }

    // For all other routes in a SPA, redirect to index
    res.redirect(indexPath);
  };
}

/**
 * Helper to create a router-aware API client for the frontend
 * @returns {string} JavaScript code for API client
 */
function generateApiClientScript() {
  return `
// API Client for Wave Threaded Router
const WaveApi = {
  baseUrl: '',
  
  // Configure the API client
  config(options = {}) {
    if (options.baseUrl) this.baseUrl = options.baseUrl;
    return this;
  },
  
  // Execute a compute task
  async compute(data = {}) {
    const response = await fetch(this.baseUrl + '/compute', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: data ? JSON.stringify(data) : undefined
    });
    
    if (!response.ok) {
      if (response.status === 202) {
        // Request is accepted but queued - poll for results
        return this._pollForResults(response.headers.get('Location') || '/status');
      }
      throw new Error('Compute failed: ' + response.statusText);
    }
    
    return response.json();
  },
  
  // Execute a stateful request
  async updateState(data) {
    const response = await fetch(this.baseUrl + '/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    
    if (!response.ok) {
      if (response.status === 202) {
        // Request is accepted but queued - poll for results
        return this._pollForResults(response.headers.get('Location') || '/status');
      }
      throw new Error('State update failed: ' + response.statusText);
    }
    
    return response.json();
  },
  
  // Get server metrics
  async getMetrics() {
    const response = await fetch(this.baseUrl + '/metrics');
    if (!response.ok) throw new Error('Failed to fetch metrics');
    return response.json();
  },
  
  // Get server health status
  async getHealth() {
    const response = await fetch(this.baseUrl + '/health');
    if (!response.ok) throw new Error('Health check failed');
    return response.json();
  },
  
  // Private method to poll for queued results
  async _pollForResults(statusUrl, attempts = 10, delay = 500) {
    let attempt = 0;
    
    while (attempt < attempts) {
      await new Promise(resolve => setTimeout(resolve, delay));
      attempt++;
      
      const response = await fetch(this.baseUrl + statusUrl);
      if (response.ok) return response.json();
      if (response.status !== 202) throw new Error('Request failed: ' + response.statusText);
      
      // Increase delay with each attempt (exponential backoff)
      delay = Math.min(delay * 1.5, 5000);
    }
    
    throw new Error('Polling timeout - request is still processing');
  }
};
  `;
}

/**
 * Creates an HTML template with router for SPA
 * @param {Object} options - App configuration options
 * @returns {string} Complete HTML template
 */
function createSpaTemplate(options = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${options.title || "Wave Threaded Router SPA"}</title>
  <style>
    body { 
      font-family: system-ui, -apple-system, sans-serif; 
      line-height: 1.5; 
      margin: 0; 
      padding: 0;
      color: #333;
    }
    header {
      background: #1a1a2e;
      color: white;
      padding: 1rem 2rem;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    nav {
      display: flex;
      gap: 1.5rem;
      padding: 0.5rem 2rem;
      background: #16213e;
    }
    nav a {
      color: #e5e5e5;
      text-decoration: none;
      font-weight: 500;
      padding: 0.5rem 0;
    }
    nav a:hover {
      color: #ffffff;
      border-bottom: 2px solid #4361ee;
    }
    main {
      padding: 2rem;
      max-width: 1200px;
      margin: 0 auto;
    }
    .nav-active {
      border-bottom: 2px solid #4361ee;
      color: white;
    }
    .card {
      background: white;
      border-radius: 8px;
      padding: 1.5rem;
      box-shadow: 0 2px 4px rgba(0,0,0,0.05);
      margin-bottom: 1.5rem;
    }
    button {
      background: #4361ee;
      color: white;
      border: none;
      padding: 0.5rem 1rem;
      border-radius: 4px;
      cursor: pointer;
    }
    button:hover {
      background: #3a56d4;
    }
    .metrics-panel {
      font-family: monospace;
      background: #f5f5f5;
      padding: 1rem;
      border-radius: 4px;
      overflow: auto;
    }
    footer {
      text-align: center;
      padding: 1rem;
      margin-top: 2rem;
      font-size: 0.9rem;
      color: #666;
      border-top: 1px solid #eee;
    }
    #app {
      min-height: 400px;
    }
  </style>
</head>
<body>
  <div data-router-init data-router-mode="${
    options.mode || "hash"
  }" data-router-root="${options.root || "/"}">
    <header>
      <h1>${options.heading || "Wave Threaded Router"}</h1>
    </header>
    
    <nav id="main-nav">
      ${
        options.routes
          ? options.routes
              .map(
                (route) =>
                  `<a href="#${route.path}" data-nav-id="${
                    route.path || "home"
                  }" onclick="Router.navigate('${
                    route.path
                  }'); return false;">${route.title}</a>`
              )
              .join("\n      ")
          : ""
      }
    </nav>
    
    <main>
      <div id="app">
        <div class="card">
          <p>Loading application...</p>
        </div>
      </div>
    </main>
    
    <footer>
      &copy; ${new Date().getFullYear()} Wave Threaded Router - Server metrics available at <a href="#metrics">/metrics</a>
    </footer>
  </div>
  
  ${
    options.routes
      ? options.routes
          .map(
            (route) =>
              `<div style="display:none" data-route="${
                route.path
              }" data-template="${route.template || ""}"></div>`
          )
          .join("\n  ")
      : ""
  }
  
  <script>
    ${generateApiClientScript()}
    
    // Update active navigation item
    function updateNav(path) {
      const navLinks = document.querySelectorAll('#main-nav a');
      navLinks.forEach(link => {
        link.classList.remove('nav-active');
        if (link.getAttribute('data-nav-id') === (path || 'home')) {
          link.classList.add('nav-active');
        }
      });
    }
    
    // Load page content
    async function loadPageContent(path) {
      updateNav(path);
      
      // Define route-specific content
      const routes = {
        '': () => {
          return \`<div class="card">
            <h2>Home Page</h2>
            <p>Welcome to Wave Threaded Router - a combined server-side concurrency manager with client-side routing!</p>
            <p>This application demonstrates:</p>
            <ul>
              <li>Adaptive wave-based thread management on the server</li>
              <li>Client-side routing for SPA-like experience</li>
              <li>Intelligent backpressure and request queuing</li>
              <li>Worker thread lifecycle management</li>
            </ul>
          </div>\`;
        },
        
        'compute': () => {
          setTimeout(() => {
            // Setup compute test
            document.getElementById('run-compute').addEventListener('click', async () => {
              try {
                document.getElementById('compute-result').textContent = 'Computing...';
                const result = await WaveApi.compute();
                document.getElementById('compute-result').textContent = JSON.stringify(result, null, 2);
              } catch (err) {
                document.getElementById('compute-result').textContent = 'Error: ' + err.message;
              }
            });
          }, 100);
          
          return \`<div class="card">
            <h2>Compute Test</h2>
            <p>Test the server's compute capabilities by running a distributed calculation across worker threads.</p>
            <button id="run-compute">Run Compute Test</button>
            <pre id="compute-result" class="metrics-panel"></pre>
          </div>\`;
        },
        
        'metrics': () => {
          // Setup metrics polling
          let metricsInterval;
          setTimeout(() => {
            metricsInterval = setInterval(async () => {
              try {
                const metrics = await WaveApi.getMetrics();
                document.getElementById('metrics-display').textContent = JSON.stringify(metrics, null, 2);
              } catch (err) {
                document.getElementById('metrics-display').textContent = 'Error: ' + err.message;
                clearInterval(metricsInterval);
              }
            }, 1000);
          }, 100);
          
          // Clean up interval when leaving page
          Router.onLeave = () => {
            if (metricsInterval) clearInterval(metricsInterval);
          };
          
          return \`<div class="card">
            <h2>Server Metrics</h2>
            <p>Live server metrics updated every second:</p>
            <pre id="metrics-display" class="metrics-panel">Loading metrics...</pre>
          </div>\`;
        },
        
        'about': () => {
          return \`<div class="card">
            <h2>About Wave Threaded Router</h2>
            <p>This library combines:</p>
            <ul>
              <li>A wave-driven concurrency model for Express</li>
              <li>Worker thread management for CPU-intensive tasks</li>
              <li>Client-side routing for single page applications</li>
              <li>Adaptive performance tuning based on system load</li>
            </ul>
            <p>The wave model adjusts the number of concurrent worker threads based on a sine wave pattern,
            system load, and response latency metrics, ensuring optimal resource utilization.</p>
          </div>\`;
        }
      };
      
      // Render the appropriate content
      if (routes[path]) {
        document.getElementById('app').innerHTML = routes[path]();
      } else {
        document.getElementById('app').innerHTML = \`<div class="card">
          <h2>Page Not Found</h2>
          <p>The requested page "${path}" does not exist.</p>
          <button onclick="Router.navigate('')">Return Home</button>
        </div>\`;
      }
    }
    
    // Initialize router event handlers
    document.addEventListener("DOMContentLoaded", function() {
      // Custom route handling
      Router.add('', function() {
        loadPageContent('');
      });
      
      Router.add('compute', function() {
        loadPageContent('compute');
      });
      
      Router.add('metrics', function() {
        loadPageContent('metrics');
      });
      
      Router.add('about', function() {
        loadPageContent('about');
      });
      
      // Handle any other routes
      Router.add(/(.*?)/, function() {
        loadPageContent(Router.getFragment());
      });
      
      // Initialize API client
      WaveApi.config({
        baseUrl: ''
      });
      
      // Navigate to default route if needed
      setTimeout(() => {
        if (Router.getFragment() === '') {
          Router.navigate('${options.defaultRoute || ""}');
        }
        Router.check();
      }, 100);
    });
  </script>
</body>
</html>`;
}

/**
 * Setup a complete SPA with the Wave Threaded Router
 * @param {Object} app - Express app
 * @param {Object} options - SPA configuration options
 */
function setupSpa(app, options = {}) {
  // Add SPA middleware to handle HTML5 history API routing
  if (options.mode === "history") {
    app.use(spaRedirectMiddleware(options));
  }

  // Serve the SPA entry point
  app.get(options.entryPath || "/", (req, res) => {
    res.send(
      createSpaTemplate({
        title: options.title || "Wave Threaded Router App",
        heading: options.heading || "Wave Threaded Router",
        mode: options.mode || "hash",
        root: options.root || "/",
        routes: options.routes || [
          { path: "", title: "Home" },
          { path: "compute", title: "Compute" },
          { path: "metrics", title: "Metrics" },
          { path: "about", title: "About" },
        ],
        defaultRoute: options.defaultRoute || "",
      })
    );
  });

  // Serve API client script separately if needed
  app.get("/wave-api.js", (req, res) => {
    res.type("application/javascript").send(generateApiClientScript());
  });
}

// === Public Exports ===
module.exports = {
  // Original wave-threaded-server exports
  WaveController,
  waveMiddleware,
  runStatelessTask,
  defaultStatelessHandler,
  defaultStatefulHandler,
  autoMount,
  exposeMetrics,
  exposeHealthCheck,
  setupGracefulShutdown,
  WorkerManager,

  // New client-side router exports
  injectClientRouter,
  generateClientRouterScript,
  createRouterPage,
  setupClientRouting,
  generateApiClientScript,
  createSpaTemplate,
  setupSpa,
  spaRedirectMiddleware,
};
