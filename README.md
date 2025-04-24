

# wave-threaded-server

A wave-driven concurrency controller for Node.js using Express and worker threads. Designed to adaptively manage load using a configurable wave shape, backpressure, and automatic worker scaling.

> Ideal for stateless task processing under fluctuating load using adaptive concurrency control.

---

## Features

- 🌊 **Wave-based concurrency**: Controls worker count using a sine wave model with load-aware shaping.
- 🔁 **Backpressure queueing**: Smoothly queues excess requests and avoids overload.
- ⚙️ **Stateless task execution**: Distributes tasks via worker threads with retries and failure tracking.
- 📈 **Adaptive tuning**: Adjusts wave amplitude/period based on latency feedback.
- 🔍 **Built-in metrics & healthcheck**: Easily monitor performance and status.

---

## Installation

```bash
npm install wave-threaded-server
```

---

## Usage

### 1. Setup an Express App

```js
const express = require('express');
const {
  WaveController,
  waveMiddleware,
  runStatelessTask,
  exposeMetrics,
  exposeHealthCheck
} = require('wave-threaded-server');

const app = express();
const wave = new WaveController();

app.locals.taskFn = async (x) => {
  // Simulate async computation
  await new Promise(r => setTimeout(r, 50));
  return x * 2;
};

app.use(waveMiddleware({ waveController: wave }));

// Stateless route (uses worker threads)
app.get('/compute', async (req, res, next) => next());

// Optional: Metrics and health endpoints
exposeMetrics(app);
exposeHealthCheck(app);

app.listen(3000, () => console.log('Server running on port 3000'));
```

### 2. Test It

```bash
curl http://localhost:3000/compute
```

---

## API

### `WaveController(options)`
Adaptive concurrency controller.
- `options.period`: Wave period in ms.
- `options.amplitude`: Maximum number of workers.
- `options.offset`: Phase offset in ms.
- `options.shapeFn(phase)`: Custom wave shape (optional).

### `waveMiddleware({ waveController, isStateless })`
Middleware that routes GET/POST differently and applies backpressure queueing.

### `runStatelessTask(data, waveController)`
Runs a task in a worker thread with retries and backoff.

```js
await runStatelessTask({ value: 10 }, wave);
```

### `exposeMetrics(app, path?)`
Adds a `/metrics` route returning wave and worker stats.

### `exposeHealthCheck(app, path?)`
Adds a `/health` route returning a basic health status.

---

## Environment Variables

| Name | Description | Default |
|------|-------------|---------|
| `WAVE_PERIOD` | Wave period in ms | `10000` |
| `WAVE_AMPLITUDE` | Max concurrency | `CPU count` |
| `WAVE_MIN_THREADS` | Minimum concurrency | `1` |
| `WAVE_LATENCY_TARGET_MS` | Target latency | `200` |
| `WAVE_QUEUE_MAX_SIZE` | Max queue size | `1000` |

---

## License

MIT

---

