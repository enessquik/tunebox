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

function sendJson(res, code, payload) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
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

function normalizeFormat(inputFormat) {
  const cleaned = String(inputFormat || ZYLALABS_DEFAULT_FORMAT)
    .trim()
    .toLowerCase();

  if (!cleaned || !ALLOWED_FORMATS.has(cleaned)) {
    throw new Error("Geçersiz format. mp3, m4a, flac, opus, wav, 360, 480, 720, 1080, 1440, 2160");
  }

  return cleaned;
}

function findDownloadUrlDeep(value) {
  if (!value) return null;

  if (typeof value === "string") {
    return /^https?:\/\//i.test(value) ? value : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDownloadUrlDeep(item);
      if (found) return found;
    }
    return null;
  }

  if (typeof value === "object") {
    const ignored = new Set(["progress_url", "progressurl", "image", "thumbnail", "thumb", "preview"]);
    const preferred = [
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

    for (const key of preferred) {
      if (key in value) {
        const found = findDownloadUrlDeep(value[key]);
        if (found) return found;
      }
    }

    for (const [key, nested] of Object.entries(value)) {
      if (ignored.has(String(key).toLowerCase())) continue;
      const found = findDownloadUrlDeep(nested);
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
  endpoint.searchParams.set(ZYLALABS_FORMAT_QUERY_PARAM, format);

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
    if (/^https?:\/\//i.test(redirected)) return redirected;
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

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  try {
    const body = parseBody(req);
    const sourceUrl = validateSourceUrl(body.sourceUrl || body.url || "");
    const format = normalizeFormat(body.format || ZYLALABS_DEFAULT_FORMAT);

    const downloadUrl = await resolveYoutubeDownloadUrl(sourceUrl, format);

    return sendJson(res, 200, {
      success: true,
      format,
      downloadUrl
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "İstek işlenemedi.";
    return sendJson(res, 400, { success: false, error: message });
  }
};
