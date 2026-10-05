import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { requireAuth } from "./auth.js";
import { config } from "./config.js";
import { ingestionRouter } from "./ingestion.js";
import { repository } from "./repository.js";
import { ingestionQueue } from "./queue.js";
import { apiRouter } from "./routes.js";
import { workspaceService } from "./workspace.js";
import { httpReplayService } from "./httpReplay.js";
import { caseworkService } from "./casework.js";
import { statusForError } from "./errors.js";
import { alertService } from "./alerts.js";
import { runMigrations } from "./migrations.js";
import { Pool } from "pg";

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(cors({ origin: config.webOrigin.split(",").map((origin) => origin.trim()), credentials: true, exposedHeaders: ["x-request-id"] }));

// Every response carries a request ID (reusing a safe caller-supplied one) so a UI error, an
// API log line, and a provider delivery can be correlated while debugging.
app.use((req, res, next) => {
  const incoming = req.get("x-request-id");
  const requestId = incoming && /^[\w.:-]{1,128}$/.test(incoming) ? incoming : randomUUID();
  res.locals.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  const started = process.hrtime.bigint();
  res.once("finish", () => {
    if (req.path === "/health") return;
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms req=${requestId}`);
  });
  next();
});
app.use(express.json({
  limit: "2mb",
  verify: (req, _res, buffer) => {
    (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
  }
}));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "replayops-api", demoMode: config.demoMode, automatedIngestion: Boolean(config.ingestionSigningSecret || process.env.NODE_ENV !== "production") });
});

app.use("/ingest", ingestionRouter);
app.use("/api", requireAuth, apiRouter);

app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}`, requestId: res.locals.requestId });
});

const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const status = statusForError(error);
  const requestId = res.locals.requestId as string | undefined;
  const parseFailure = (error as { type?: string }).type === "entity.parse.failed";
  if (status >= 500) console.error(`[${requestId}] ${req.method} ${req.originalUrl} failed`, error);
  res.status(status).json({
    error: parseFailure ? "The request body is not valid JSON." : error instanceof Error ? error.message : "An unexpected server error occurred.",
    requestId
  });
};

app.use(errorHandler);

await repository.initialize();
await workspaceService.initialize();
await httpReplayService.initialize();
await caseworkService.initialize();
await ingestionQueue.initialize();
await alertService.initialize();
if (config.databaseUrl) {
  const migrationPool = new Pool({ connectionString: config.databaseUrl, ssl: config.databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false }, max: 1 });
  try { await runMigrations(migrationPool); } finally { await migrationPool.end(); }
}
if (config.demoMode && config.databaseUrl) console.warn("ENABLE_DEMO_MODE is ignored for sign-in because DATABASE_URL is set; demo tokens only work with the in-memory API.");
app.listen(config.port, "0.0.0.0", () => {
  console.log(`ReplayOps API listening on http://localhost:${config.port}`);
});

const queueTimer = setInterval(() => void ingestionQueue.processReady(), 30_000);
queueTimer.unref();
