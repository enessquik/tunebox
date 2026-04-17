const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");
require("dotenv").config();

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = __dirname;
const OUTPUT_DIR = path.join(ROOT_DIR, "downloads");
const JOB_TTL_MS = 60 * 60 * 1000;
const ZYLALABS_DOWNLOAD_ENDPOINT =
  process.env.ZYLALABS_DOWNLOAD_ENDPOINT ||
  "https://zylalabs.com/api/11016/youtube+download+and+info+api/20761/download";
const ZYLALABS_API_KEY = process.env.ZYLALABS_API_KEY || "";
const ZYLALABS_SOURCE_QUERY_PARAM = process.env.ZYLALABS_SOURCE_QUERY_PARAM || "url";
const ZYLALABS_FORMAT_QUERY_PARAM = process.env.ZYLALABS_FORMAT_QUERY_PARAM || "format";
const ZYLALABS_DEFAULT_FORMAT = process.env.ZYLALABS_DEFAULT_FORMAT || "mp3";
const ZYLALABS_PROGRESS_TIMEOUT_MS = Number(process.env.ZYLALABS_PROGRESS_TIMEOUT_MS || 120000);
const ZYLALABS_PROGRESS_POLL_MS = Number(process.env.ZYLALABS_PROGRESS_POLL_MS || 2000);
const ALLOWED_FORMATS = new Set([
  "mp3",
  "m4a",
  "flac",
  "opus",
  "wav",
  "360",
  "480",
  "720",
  "1080",
  "1440",
  "2160"
]);

const jobs = new Map();
const youtubeHosts = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "music.youtube.com"
]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4"
};

async function ensureDirs() {
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": MIME_TYPES[".json"] });
  res.end(JSON.stringify(payload));
}

function getFileExtensionForFormat(format) {
  if (["360", "480", "720", "1080", "1440", "2160"].includes(format)) {
    return "mp4";
  }
  return format;
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function validateSourceUrl(sourceUrl) {
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error("Geçerli bir URL girin.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Sadece http/https URL desteklenir.");
  }

  return parsed.toString();
}

function isYoutubeUrl(sourceUrl) {
  const parsed = new URL(sourceUrl);
  const host = parsed.hostname.toLowerCase();
  return youtubeHosts.has(host);
}

function normalizeFormat(inputFormat) {
  const cleaned = String(inputFormat || ZYLALABS_DEFAULT_FORMAT)
    .trim()
    .toLowerCase();
  if (!cleaned) return ZYLALABS_DEFAULT_FORMAT;
  if (!ALLOWED_FORMATS.has(cleaned)) {
    throw new Error("Geçersiz format değeri. Desteklenen: mp3, m4a, flac, opus, wav, 360, 480, 720, 1080, 1440, 2160");
  }
  return cleaned;
}

function findDownloadUrlDeep(value, parentKey = "") {
  if (!value) return null;

  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) return value;
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDownloadUrlDeep(item, parentKey);
      if (found) return found;
    }
    return null;
  }

  if (typeof value === "object") {
    const ignoredUrlKeys = new Set([
      "progress_url",
      "progressurl",
      "image",
      "thumbnail",
      "thumb",
      "preview"
    ]);

    const preferredKeys = [
      "download_url",
      "downloadUrl",
      "url",
      "link",
      "audio_url",
      "audioUrl",
      "file",
      "file_url",
      "stream_url"
    ];

    for (const key of preferredKeys) {
      if (key in value) {
        const found = findDownloadUrlDeep(value[key], key);
        if (found) return found;
      }
    }

    for (const [key, nested] of Object.entries(value)) {
      if (ignoredUrlKeys.has(String(key).toLowerCase())) {
        continue;
      }
      const found = findDownloadUrlDeep(nested, key);
      if (found) return found;
    }
  }

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollZylaProgress(progressUrl) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < ZYLALABS_PROGRESS_TIMEOUT_MS) {
    const response = await fetch(progressUrl, {
      headers: {
        Authorization: `Bearer ${ZYLALABS_API_KEY}`,
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `ZylaLabs progress isteği başarısız (${response.status}). ${errorText.slice(0, 200)}`.trim()
      );
    }

    const payload = await response.json().catch(() => ({}));
    if (payload && payload.success === false) {
      throw new Error(payload.message || "ZylaLabs progress işlemi başarısız.");
    }

    const resolvedUrl = findDownloadUrlDeep(payload);
    if (resolvedUrl && resolvedUrl !== progressUrl) {
      return resolvedUrl;
    }

    const state = String(
      payload?.status || payload?.state || payload?.job_status || payload?.jobState || ""
    ).toLowerCase();

    if (["error", "failed", "cancelled", "canceled"].includes(state)) {
      throw new Error(payload?.message || "ZylaLabs job başarısız.");
    }

    await sleep(ZYLALABS_PROGRESS_POLL_MS);
  }

  throw new Error("ZylaLabs progress zaman aşımına uğradı.");
}

async function resolveYoutubeDownloadUrl(sourceUrl, format) {
  if (!ZYLALABS_API_KEY) {
    throw new Error("YouTube indirme için ZYLALABS_API_KEY ortam değişkeni gerekli.");
  }

  const endpoint = new URL(ZYLALABS_DOWNLOAD_ENDPOINT);
  endpoint.searchParams.set(ZYLALABS_SOURCE_QUERY_PARAM, sourceUrl);
  endpoint.searchParams.set(ZYLALABS_FORMAT_QUERY_PARAM, normalizeFormat(format));

  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${ZYLALABS_API_KEY}`,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `ZylaLabs indirme isteği başarısız (${response.status}). ${errorText.slice(0, 200)}`.trim()
    );
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();

  if (!contentType.includes("application/json")) {
    const redirected = response.url;
    if (/^https?:\/\//i.test(redirected)) {
      return redirected;
    }
    throw new Error("ZylaLabs beklenmeyen yanıt döndürdü.");
  }

  const payload = await response.json().catch(() => ({}));

  if (payload && payload.success === false) {
    throw new Error(payload.message || "ZylaLabs indirme isteği başarısız.");
  }

  if (payload && payload.progress_url) {
    return pollZylaProgress(String(payload.progress_url));
  }

  const resolvedUrl = findDownloadUrlDeep(payload);

  if (!resolvedUrl) {
    throw new Error("ZylaLabs yanıtında indirilebilir bağlantı bulunamadı.");
  }

  return resolvedUrl;
}

async function downloadToFile(sourceUrl, outputPath, onProgress) {
  const response = await fetch(sourceUrl);
  if (!response.ok || !response.body) {
    throw new Error("Kaynak dosya indirilemedi.");
  }

  const total = Number(response.headers.get("content-length") || "0");
  const writeStream = fs.createWriteStream(outputPath);

  if (total > 0 && response.body.getReader) {
    const reader = response.body.getReader();
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      onProgress(Math.min(50, Math.round((received / total) * 50)));
      writeStream.write(Buffer.from(value));
    }
    writeStream.end();
    await new Promise((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });
    return;
  }

  await pipeline(response.body, writeStream);
}

async function processJob(jobId, sourceUrl, format) {
  const job = jobs.get(jobId);
  if (!job) return;

  const outputName = `track-${jobId.slice(0, 8)}.${getFileExtensionForFormat(format)}`;
  const outputFile = `${jobId}-${outputName}`;
  const outputPath = path.join(OUTPUT_DIR, outputFile);

  try {
    job.status = "downloading";
    job.message = "Kaynak hazırlanıyor...";
    job.progress = 5;

    let downloadableSourceUrl = sourceUrl;
    if (isYoutubeUrl(sourceUrl)) {
      job.message = "YouTube bağlantısı ZylaLabs ile çözülüyor...";
      job.progress = 12;
      downloadableSourceUrl = await resolveYoutubeDownloadUrl(sourceUrl, format);
    }

    job.message = "Kaynak indiriliyor...";
    job.progress = Math.max(job.progress, 20);

    await downloadToFile(downloadableSourceUrl, outputPath, (downloadProgress) => {
      job.progress = Math.max(job.progress, downloadProgress);
    });

    job.status = "done";
    job.progress = 100;
    job.message = "İndirme tamamlandı.";
    job.outputFile = outputFile;
    job.downloadUrl = `/downloads/${encodeURIComponent(outputFile)}`;
  } catch (error) {
    job.status = "failed";
    job.progress = 0;
    job.message = error instanceof Error ? error.message : "İşlem başarısız oldu.";
  }
}

function getJobResponse(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    downloadUrl: job.downloadUrl || null
  };
}

function resolveStaticPath(requestPath) {
  const target = requestPath === "/" ? "/index.html" : requestPath;
  const normalized = path.normalize(target).replace(/^(\.\.(\/|\\|$))+/, "");
  return path.join(ROOT_DIR, normalized);
}

async function serveStatic(req, res, requestPath) {
  const filePath = resolveStaticPath(requestPath);
  if (!filePath.startsWith(ROOT_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  if (!stat.isFile()) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  fs.createReadStream(filePath).pipe(res);
}

async function serveDownload(res, fileToken) {
  const fileName = decodeURIComponent(fileToken || "");
  const safeName = path.basename(fileName);
  const filePath = path.join(OUTPUT_DIR, safeName);

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    sendJson(res, 404, { error: "Dosya bulunamadı." });
    return;
  }

  if (!stat.isFile()) {
    sendJson(res, 404, { error: "Dosya bulunamadı." });
    return;
  }

  const ext = path.extname(safeName).toLowerCase();
  const type = MIME_TYPES[ext] || "application/octet-stream";

  res.writeHead(200, {
    "Content-Type": type,
    "Content-Disposition": `attachment; filename="${safeName}"`,
    "Content-Length": stat.size
  });
  fs.createReadStream(filePath).pipe(res);
}

function cleanupJobsAndFiles() {
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    if (now - job.createdAt > JOB_TTL_MS) {
      if (job.outputFile) {
        fsp.unlink(path.join(OUTPUT_DIR, job.outputFile)).catch(() => {});
      }
      jobs.delete(jobId);
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method || "GET";

  if (method === "POST" && url.pathname === "/api/jobs") {
    try {
      const body = await parseJsonBody(req);
      const sourceUrl = validateSourceUrl(body.sourceUrl || "");
      const format = normalizeFormat(body.format || ZYLALABS_DEFAULT_FORMAT);

      const jobId = crypto.randomUUID();
      const job = {
        id: jobId,
        createdAt: Date.now(),
        status: "queued",
        progress: 0,
        message: "İş kuyruğa alındı.",
        outputFile: null,
        downloadUrl: null
      };
      jobs.set(jobId, job);
      processJob(jobId, sourceUrl, format);

      sendJson(res, 202, { jobId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "İstek işlenemedi.";
      sendJson(res, 400, { error: message });
    }
    return;
  }

  if (method === "GET" && url.pathname.startsWith("/api/jobs/")) {
    const jobId = url.pathname.split("/").pop();
    const job = jobId ? jobs.get(jobId) : null;
    if (!job) {
      sendJson(res, 404, { error: "İş bulunamadı." });
      return;
    }
    sendJson(res, 200, getJobResponse(job));
    return;
  }

  if (method === "GET" && url.pathname.startsWith("/downloads/")) {
    const token = url.pathname.slice("/downloads/".length);
    await serveDownload(res, token);
    return;
  }

  if (method === "GET") {
    await serveStatic(req, res, url.pathname);
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
});

ensureDirs()
  .then(() => {
    setInterval(cleanupJobsAndFiles, 10 * 60 * 1000).unref();
    server.listen(PORT, HOST, () => {
      console.log(`TuneBox running on http://${HOST}:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Startup failed:", error);
    process.exit(1);
  });
