const ZYLALABS_API_KEY = process.env.ZYLALABS_API_KEY || "";

function sendJson(res, code, payload) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
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
    if (!ZYLALABS_API_KEY) {
      throw new Error("YouTube indirme için ZYLALABS_API_KEY ortam değişkeni gerekli.");
    }

    const body = parseBody(req);
    const progressUrl = String(body.progressUrl || "").trim();
    if (!/^https?:\/\//i.test(progressUrl)) {
      throw new Error("Geçerli bir progressUrl gerekli.");
    }

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

    const downloadUrl = findDownloadUrlDeep(payload);
    const state = String(
      payload?.status || payload?.state || payload?.job_status || payload?.jobState || ""
    ).toLowerCase();

    const failed = ["error", "failed", "cancelled", "canceled"].includes(state);

    return sendJson(res, 200, {
      success: !failed,
      done: Boolean(downloadUrl),
      failed,
      state,
      downloadUrl: downloadUrl || null,
      message: payload?.message || null
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "İstek işlenemedi.";
    return sendJson(res, 400, { success: false, error: message });
  }
};
