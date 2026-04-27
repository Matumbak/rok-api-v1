import "dotenv/config";
import express from "express";
import cors from "cors";

import requirementsRouter from "./routes/requirements.js";
import mediaRouter from "./routes/media.js";
import dkpRouter from "./routes/dkp.js";
import { errorHandler } from "./middleware/error.js";

const PORT = Number(process.env.PORT ?? 4000);
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();

app.use(
  cors({
    origin: CORS_ORIGINS.length === 0 ? true : CORS_ORIGINS,
    credentials: true,
  }),
);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.use("/api/requirements", requirementsRouter);
app.use("/api/media", mediaRouter);
app.use("/api/dkp", dkpRouter);

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`[rok-api] listening on http://localhost:${PORT}`);
});
