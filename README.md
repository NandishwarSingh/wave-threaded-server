# Wave Threaded Server

A full-stack library combining wave-driven server concurrency with client-side routing for optimized application performance.

## Overview

Wave Threaded Router is a powerful, adaptive library that combines:

1. **Wave-driven concurrency model** - Dynamically adjusts worker thread count based on system load, response latency, and a sinusoidal pattern for optimal resource utilization
2. **Worker thread management** - Handles CPU-intensive tasks with intelligent lifecycle management
3. **Client-side routing** - Provides a smooth SPA-like experience
4. **Adaptive performance tuning** - Automatically adjusts to system conditions

Whether you're building a high-throughput API or a responsive full-stack application, Wave Threaded Router optimizes both server performance and client experience.

## Features

### Server-Side
- **Wave-driven concurrency** - Sine wave pattern governs thread allocation for consistent performance
- **Dynamic scaling** - Adapts to system load, response latency, and failure rates
- **Worker thread management** - Efficient handling of CPU-intensive tasks
- **Request queueing** - Smart backpressure handling for high-load scenarios
- **Health monitoring** - Built-in metrics endpoint for system monitoring

### Client-Side
- **SPA-like routing** - Both hash and history mode supported
- **Zero dependencies** - Pure JavaScript implementation
- **Automatic template loading** - Dynamic content without full page reloads
- **Adaptive API client** - Works with the wave server model, including handling queued requests

## Installation

```bash
npm install wave-threaded-router
```

## Basic Usage

### Server Setup

```javascript
const express = require('express');
const { waveMiddleware, setupSpa, exposeMetrics } = require('wave-threaded-router');

const app = express();

// Apply wave middleware to manage concurrency
app.use(waveMiddleware());

// Expose metrics endpoint
exposeMetrics(app);

// Set up a Single Page Application with client-side routing
setupSpa(app, {
  title: "My Wave App",
  mode: "hash", // or "history"
  routes: [
    { path: "", title: "Home" },
    { path: "metrics", title: "Metrics" },
    { path: "about", title: "About" }
  ]
});

// Add your API routes
app.get('/api/data', async (req, res) => {
  // Wave middleware will manage concurrency and worker allocation
  const data = await processData();
  res.json(data);
});

app.listen(3000, () => console.log('Server running on port 3000'));
```

### Client-Side Usage

The library automatically injects the router into your HTML responses:

```html
<!-- Your app's main div with router configuration -->
<div data-router-init data-router-mode="hash" data-router-root="/">
  <nav>
    <a href="#" onclick="Router.navigate(''); return false;">Home</a>
    <a href="#metrics" onclick="Router.navigate('metrics'); return false;">Metrics</a>
  </nav>
  
  <div id="app">
    <!-- Content will be loaded here -->
  </div>
</div>

<!-- Define your routes -->
<script>
  Router.add('', function() {
    // Load home page content
    document.getElementById('app').innerHTML = '<h1>Home Page</h1>';
  });
  
  Router.add('metrics', function() {
    // Load metrics page content
    fetch('/metrics')
      .then(res => res.json())
      .then(data => {
        document.getElementById('app').innerHTML = 
          '<h1>Metrics</h1><pre>' + JSON.stringify(data, null, 2) + '</pre>';
      });
  });
</script>
```

## Advanced Configuration

### Wave Controller Options

```javascript
const { WaveController, waveMiddleware } = require('wave-threaded-router');

// Custom wave controller
const wave = new WaveController({
  period: 15000,        // Wave cycle duration in ms
  amplitude: 8,         // Maximum number of worker threads
  offset: 1000,         // Wave phase offset in ms
  shapeFn: (phase) => {  // Custom wave shape function
    return (Math.sin(phase * 2 * Math.PI) + 1) / 2;
  }
});

// Use custom wave controller with middleware
app.use(waveMiddleware({ waveController: wave }));
```

### Single Page Application (SPA) Configuration

```javascript
const { setupSpa } = require('wave-threaded-router');

setupSpa(app, {
  title: "Dashboard Application",
  heading: "Analytics Dashboard",
  mode: "history",      // Use HTML5 History API
  root: "/dashboard",   // Base URL path
  routes: [
    { path: "", title: "Overview" },
    { path: "reports", title: "Reports" },
    { path: "settings", title: "Settings" },
    { path: "metrics", title: "System Metrics" }
  ],
  defaultRoute: ""      // Default route path
});
```

### Worker Thread Management

```javascript
const { runStatelessTask } = require('wave-threaded-router');

app.get('/api/compute', async (req, res) => {
  try {
    // Run CPU-intensive task in worker thread
    const result = await runStatelessTask({
      value: req.query.input || 42,
      fn: (value) => {
        // This function runs in a separate thread
        return Array.from({length: 1000000})
          .reduce((sum, _, i) => sum + Math.sqrt(value * i), 0);
      }
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

## Environment Variables

Configure the library behavior with these environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `WAVE_PERIOD` | Wave cycle duration in ms | 10000 |
| `WAVE_AMPLITUDE` | Maximum number of worker threads | CPU count |
| `WAVE_OFFSET` | Wave phase offset in ms | 0 |
| `WAVE_MIN_THREADS` | Minimum worker threads to maintain | 1 |
| `WAVE_LATENCY_TARGET_MS` | Target response latency | 200 |
| `WAVE_AMPLITUDE_STEP` | Adjustment step size | 1 |
| `WAVE_PERIOD_MIN` | Minimum period duration | 2000 |
| `WAVE_PERIOD_MAX` | Maximum period duration | 60000 |
| `CLIENT_ROUTER_MODE` | Routing mode ('hash' or 'history') | 'hash' |
| `CLIENT_ROUTER_ROOT` | Base URL path | '/' |

## API Reference

### Server Components

- `WaveController` - Manages the wave-driven concurrency model
- `waveMiddleware` - Express middleware that applies the wave concurrency model
- `runStatelessTask` - Executes a function in a worker thread
- `exposeMetrics` - Creates a metrics endpoint for monitoring
- `exposeHealthCheck` - Creates a health check endpoint
- `setupGracefulShutdown` - Handles graceful server shutdown

### Client-Side Components

- `injectClientRouter` - Middleware to inject the router into HTML responses
- `setupClientRouting` - Sets up client-side routing with template loading
- `setupSpa` - Creates a complete SPA with the Wave Threaded Router
- `generateApiClientScript` - Generates a client API for working with the server

## Use Cases

- **High-traffic web applications** - Optimized request handling
- **CPU-intensive APIs** - Efficient distribution of computational tasks
- **Interactive dashboards** - Smooth client experience with efficient server processing
- **Adaptive microservices** - Services that adjust to varying load conditions

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
