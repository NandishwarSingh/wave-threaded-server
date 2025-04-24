#!/usr/bin/env node
// wave-threaded-server.js
// Single-file library: wave-driven concurrency for Express with adaptive wave shape & back-pressure

/**
 * @module wave-threaded-server
 */
const express = require("express");
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

// === CLI ===
if (require.main === module) {
  program
    .option("-p, --port <n>", "port", 3000)
    .option("--period <ms>", "wave period")
    .option("--amplitude <n>", "max threads")
    .option("--worker-timeout <ms>", "max worker runtime")
    .option("--worker-retries <n>", "worker retry attempts")
    .parse(process.argv);

  const opts = program.opts();
  const app = express();
  app.use(express.json());

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

  app.use(waveMiddleware({ waveController: wave }));
  autoMount(app, [
    { method: "get", path: "/compute", handler: (req, res, next) => next() },
    { method: "post", path: "/state", handler: (req, res, next) => next() },
  ]);

  exposeMetrics(app);
  exposeHealthCheck(app);

  const server = app.listen(opts.port, () =>
    console.log(`Listening on ${opts.port}`)
  );
  setupGracefulShutdown(app, server);
}

// === Exports ===
module.exports = {
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
};
