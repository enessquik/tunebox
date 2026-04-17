const form = document.getElementById("download-form");
const urlInput = document.getElementById("mp3-url");
const formatInput = document.getElementById("download-format");
const statusBox = document.getElementById("status-box");
const progressBar = document.getElementById("progress-bar");
const progressWrap = document.querySelector(".progress");

let pollTimer = null;

const setStatus = (message, type = "") => {
  statusBox.textContent = message;
  statusBox.className = "status-box";
  if (type) statusBox.classList.add(type);
};

const setProgress = (value) => {
  const bounded = Math.max(0, Math.min(100, Number(value) || 0));
  progressBar.style.width = `${bounded}%`;
  progressWrap.setAttribute("aria-valuenow", String(bounded));
};

const isValidUrl = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const setFormDisabled = (disabled) => {
  form.querySelectorAll("button, input, select").forEach((el) => {
    el.disabled = disabled;
  });
};

const stopPolling = () => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
};

const pollJob = (jobId) => {
  pollTimer = setInterval(async () => {
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
      if (!response.ok) {
        throw new Error("İş durumu alınamadı.");
      }
      const job = await response.json();
      setProgress(job.progress || 0);
      setStatus(job.message || "İşleniyor...");

      if (job.status === "done" && job.downloadUrl) {
        stopPolling();
        setFormDisabled(false);
        setStatus("İndirme hazır, başlatılıyor.", "success");
        window.location.href = job.downloadUrl;
      } else if (job.status === "failed") {
        stopPolling();
        setFormDisabled(false);
        setStatus(job.message || "İndirme başarısız.", "error");
      }
    } catch (error) {
      stopPolling();
      setFormDisabled(false);
      const message = error instanceof Error ? error.message : "Durum takibi sırasında hata oluştu.";
      setStatus(message, "error");
      setProgress(0);
    }
  }, 1200);
};

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  stopPolling();

  const sourceUrl = urlInput.value.trim();
  const format = formatInput.value.trim();

  if (!sourceUrl) {
    setStatus("Lütfen bir kaynak URL girin.", "error");
    setProgress(0);
    return;
  }

  if (!isValidUrl(sourceUrl)) {
    setStatus("Geçerli bir http/https URL girin.", "error");
    setProgress(0);
    return;
  }

  if (!format) {
    setStatus("Lütfen bir format seçin.", "error");
    setProgress(0);
    return;
  }

  setFormDisabled(true);
  setStatus("İş kuyruğa alınıyor...");
  setProgress(3);

  try {
    const response = await fetch("/api/jobs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ sourceUrl, format })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "İş oluşturulamadı.");
    }

    setStatus("İş oluşturuldu, işleniyor...");
    pollJob(payload.jobId);
  } catch (error) {
    setFormDisabled(false);
    const message = error instanceof Error ? error.message : "İşlem başlatılamadı.";
    setStatus(message, "error");
    setProgress(0);
  }
});
