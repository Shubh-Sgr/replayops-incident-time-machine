import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { requireAuth } from "./auth.js";
import { config } from "./config.js";
import { apiRouter } from "./routes.js";

const app = express();

app.disable("x-powered-by");
app.use(cors({ origin: config.webOrigin.split(",").map((origin) => origin.trim()), credentials: true }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "replayops-api", demoMode: config.demoMode });
});

app.use("/api", requireAuth, apiRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found." });
});

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({
    error: error instanceof Error ? error.message : "An unexpected server error occurred."
  });
};

app.use(errorHandler);

app.listen(config.port, "0.0.0.0", () => {
  console.log(`ReplayOps API listening on http://localhost:${config.port}`);
});
