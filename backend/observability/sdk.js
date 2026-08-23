'use strict';

/**
 * observability/sdk.js — Phase 6.1. THE BOOTSTRAP, AND IT IS OFF BY DEFAULT.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DEFAULT-OFF IS A DECISION WITH A RECORDED REJECTION, NOT AN ACCIDENT.
 *
 * A tracer that initialises on every `npm test` run, or in CI, changes what a
 * green tick covers. §31 made that sentence load-bearing after the workflow
 * written at 4.5 produced exactly one run in five phases and it FAILED; 5.4
 * refused to add `eval:gen` to ci.yml for the same reason. So with DSB_TRACING
 * unset:
 *
 *   - not one module below is require()d, so no SDK, no exporter, no
 *     instrumentation and no socket exists in the process;
 *   - `trace.getTracer()` in observability/index.js returns the API package's
 *     NoopTracer, so every withSpan() call site runs its callback and records
 *     nothing.
 *
 * `npm test` and CI run the identical process they ran before this file
 * existed. ci.yml is untouched.
 *
 * REJECTED: `OTEL_SDK_DISABLED`, the standard variable. Its polarity is
 * opt-OUT — the SDK is enabled unless it is set — which is precisely the
 * default this file refuses. Adopting the standard name would mean CI and
 * `npm test` trace unless every environment remembers to disable them, and a
 * safety property held by every caller remembering is not held.
 *
 * REJECTED: initialising inside server.js only. That leaves `npm test` alone,
 * but makes "is tracing on?" a property of which entry point ran rather than of
 * the environment, and 6.3 needs to trace a background job that no entry point
 * calls directly.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS IS require()d FIRST IN server.js.
 *
 * The HTTP and Express instrumentations work by patching those modules as they
 * load. Patching after `require('express')` silently produces no server spans —
 * a failure that looks like a working install with an empty UI. dotenv is
 * allowed to run before it, because it loads only fs/path and reading
 * backend/.env is what lets DSB_TRACING live there.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DEPENDENCY CLASS. The four packages below are devDependencies, and the
 * Dockerfile's api stage installs with `--omit=dev`. That is deliberate: this
 * is an instrument, not a product feature, and the deployed image is unchanged
 * by construction. Setting DSB_TRACING=1 in a container built that way is
 * therefore a legible failure rather than a crash — see the catch below.
 */

const ENV_FLAG = 'DSB_TRACING';

/** The Jaeger container docker-compose.yml pins. OTLP/HTTP, not the old agent. */
const DEFAULT_OTLP_ENDPOINT = 'http://localhost:4318/v1/traces';

const DEFAULT_SERVICE_NAME = 'digital-second-brain-api';

function isEnabled() {
  const raw = String(process.env[ENV_FLAG] || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * Start the SDK if and only if the flag is set.
 *
 * Returns a small record rather than nothing, so a caller — and the test suite
 * — can assert WHY tracing is off without reading the environment a second
 * time and reaching a different answer.
 */
function startTracing() {
  if (!isEnabled()) {
    return { enabled: false, reason: `${ENV_FLAG} is not set` };
  }

  let NodeSDK;
  let OTLPTraceExporter;
  let HttpInstrumentation;
  let ExpressInstrumentation;

  try {
    ({ NodeSDK } = require('@opentelemetry/sdk-node'));
    ({ OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http'));
    ({ HttpInstrumentation } = require('@opentelemetry/instrumentation-http'));
    ({ ExpressInstrumentation } = require('@opentelemetry/instrumentation-express'));
  } catch (err) {
    // The devDependency case: an image built with --omit=dev, or a clone that
    // ran `npm ci --production`. Say so in one line and keep serving. Tracing
    // is a diagnostic; refusing to boot the API because it is unavailable
    // would make the instrument more dangerous than the thing it measures.
    console.error(
      `⚠️  ${ENV_FLAG}=1 but the OpenTelemetry SDK is not installed ` +
      '(it is a devDependency; the api image is built with --omit=dev). ' +
      'Tracing is OFF. Run `npm install` in backend/ to enable it.'
    );
    return { enabled: false, reason: 'sdk not installed', error: err.message };
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || DEFAULT_OTLP_ENDPOINT;
  const serviceName = process.env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME;

  const sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    instrumentations: [
      // ROADMAP 6.1 says "auto-instrument Express". Two named instrumentations
      // rather than @opentelemetry/auto-instrumentations-node, which is a
      // meta-package pulling dozens (kafka, redis, graphql, aws) for a stack
      // that has none of them. http supplies the ROOT server span every manual
      // span below hangs off; express supplies the route layer.
      new HttpInstrumentation(),
      new ExpressInstrumentation()
    ]
  });

  sdk.start();
  console.log(`📡 tracing ON — ${serviceName} -> ${endpoint}`);

  // Spans are batched and exported asynchronously. Without a flush on the way
  // out, the last request of a session is the one you were trying to look at
  // and the one Jaeger never receives.
  const shutdown = () => {
    sdk.shutdown()
      .catch((err) => console.error('tracing shutdown error:', err.message))
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  return { enabled: true, serviceName, endpoint, sdk };
}

module.exports = { startTracing, isEnabled, ENV_FLAG, DEFAULT_OTLP_ENDPOINT, DEFAULT_SERVICE_NAME };
