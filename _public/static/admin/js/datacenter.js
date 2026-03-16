let apiKey = "";
let metricsTimer = null;
let logsTimer = null;

let hourlyChart = null;
let dailyChart = null;
let modelsChart = null;

function byId(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const element = byId(id);
  if (element) {
    element.textContent = value;
  }
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatPercent(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return "-";
  }
  return `${parsed.toFixed(1)}%`;
}

function formatCacheMetric(entry) {
  const count = toNumber(entry && entry.count);
  const size = toNumber(entry && entry.size_mb);
  return `${count} / ${size} MB`;
}

function isAutoRefreshEnabled() {
  return Boolean(byId("auto-refresh") && byId("auto-refresh").checked);
}

function destroyCharts() {
  [hourlyChart, dailyChart, modelsChart].forEach((chart) => {
    if (chart) {
      chart.destroy();
    }
  });
  hourlyChart = null;
  dailyChart = null;
  modelsChart = null;
}

function buildCharts() {
  if (typeof Chart === "undefined") {
    return;
  }

  destroyCharts();

  const hourlyCanvas = byId("chart-hourly");
  const dailyCanvas = byId("chart-daily");
  const modelsCanvas = byId("chart-models");
  if (!hourlyCanvas || !dailyCanvas || !modelsCanvas) {
    return;
  }

  const baseOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: {
        display: true,
      },
    },
    scales: {
      x: {
        grid: {
          color: "rgba(17, 17, 17, 0.06)",
        },
      },
      y: {
        beginAtZero: true,
        grid: {
          color: "rgba(17, 17, 17, 0.06)",
        },
      },
    },
  };

  hourlyChart = new Chart(hourlyCanvas, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "成功",
          data: [],
          borderColor: "#16a34a",
          backgroundColor: "rgba(22, 163, 74, 0.12)",
          tension: 0.35,
          fill: true,
        },
        {
          label: "失败",
          data: [],
          borderColor: "#ef4444",
          backgroundColor: "rgba(239, 68, 68, 0.10)",
          tension: 0.35,
          fill: true,
        },
      ],
    },
    options: baseOptions,
  });

  dailyChart = new Chart(dailyCanvas, {
    type: "bar",
    data: {
      labels: [],
      datasets: [
        {
          label: "成功",
          data: [],
          backgroundColor: "#16a34a",
        },
        {
          label: "失败",
          data: [],
          backgroundColor: "#ef4444",
        },
      ],
    },
    options: baseOptions,
  });

  modelsChart = new Chart(modelsCanvas, {
    type: "doughnut",
    data: {
      labels: [],
      datasets: [
        {
          data: [],
          backgroundColor: [
            "#2563eb",
            "#16a34a",
            "#f59e0b",
            "#ef4444",
            "#7c3aed",
            "#06b6d4",
            "#84cc16",
            "#f97316",
            "#64748b",
            "#ec4899",
          ],
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: {
          position: "right",
        },
      },
    },
  });
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: buildAuthHeaders(apiKey),
  });

  if (response.status === 401) {
    logout();
    return null;
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload && (payload.detail || payload.message || payload.error);
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return payload;
}

function renderMetrics(data) {
  const tokens = data && data.tokens ? data.tokens : {};
  const requestStats = data && data.request_stats ? data.request_stats : {};
  const summary = requestStats && requestStats.summary ? requestStats.summary : {};
  const cache = data && data.cache ? data.cache : {};

  setText("m-token-total", toNumber(tokens.total).toLocaleString());
  setText("m-token-active", toNumber(tokens.active).toLocaleString());
  setText("m-token-cooling", toNumber(tokens.cooling).toLocaleString());
  setText("m-token-invalid", (toNumber(tokens.expired) + toNumber(tokens.disabled)).toLocaleString());
  setText("m-total-calls", toNumber(tokens.total_calls).toLocaleString());

  setText("m-req-total", toNumber(summary.total).toLocaleString());
  setText("m-req-success", toNumber(summary.success).toLocaleString());
  setText("m-req-failed", toNumber(summary.failed).toLocaleString());
  setText("m-success-rate", formatPercent(summary.success_rate));

  setText("m-local-image", formatCacheMetric(cache.local_image));
  setText("m-local-video", formatCacheMetric(cache.local_video));

  const hourly = Array.isArray(requestStats.hourly) ? requestStats.hourly : [];
  const daily = Array.isArray(requestStats.daily) ? requestStats.daily : [];
  const models = Array.isArray(requestStats.models) ? requestStats.models : [];

  if (hourlyChart) {
    hourlyChart.data.labels = hourly.map((item) => item.hour || "");
    hourlyChart.data.datasets[0].data = hourly.map((item) => toNumber(item.success));
    hourlyChart.data.datasets[1].data = hourly.map((item) => toNumber(item.failed));
    hourlyChart.update();
  }

  if (dailyChart) {
    dailyChart.data.labels = daily.map((item) => item.date || "");
    dailyChart.data.datasets[0].data = daily.map((item) => toNumber(item.success));
    dailyChart.data.datasets[1].data = daily.map((item) => toNumber(item.failed));
    dailyChart.update();
  }

  if (modelsChart) {
    modelsChart.data.labels = models.map((item) => item.model || "");
    modelsChart.data.datasets[0].data = models.map((item) => toNumber(item.count));
    modelsChart.update();
  }
}

async function refreshMetrics(silent) {
  try {
    const data = await fetchJson("/api/v1/admin/metrics");
    if (!data) {
      return;
    }
    renderMetrics(data);
  } catch (error) {
    if (!silent) {
      showToast(`刷新失败：${error.message || error}`, "error");
    }
  }
}

async function loadLogFiles() {
  const select = byId("log-file");
  if (!select) {
    return;
  }

  const previousValue = select.value;
  try {
    const data = await fetchJson("/api/v1/admin/logs/files");
    if (!data) {
      return;
    }

    const files = Array.isArray(data.files) ? data.files : [];
    select.innerHTML = "";

    if (!files.length) {
      const emptyOption = document.createElement("option");
      emptyOption.value = "";
      emptyOption.textContent = "暂无日志文件";
      select.appendChild(emptyOption);
      return;
    }

    files.forEach((file) => {
      const option = document.createElement("option");
      option.value = file.name;
      option.textContent = file.name;
      if (file.name === previousValue) {
        option.selected = true;
      }
      select.appendChild(option);
    });
  } catch (error) {
    showToast(`读取日志列表失败：${error.message || error}`, "error");
  }
}

function applyLogFilter(lines) {
  const filter = String((byId("log-filter") && byId("log-filter").value) || "").trim().toLowerCase();
  if (!filter) {
    return lines;
  }
  return lines.filter((line) => String(line).toLowerCase().includes(filter));
}

async function refreshLogs(silent) {
  const logContent = byId("log-content");
  if (!logContent) {
    return;
  }

  try {
    const wasAtBottom = logContent.scrollTop + logContent.clientHeight >= logContent.scrollHeight - 10;
    const params = new URLSearchParams();
    const fileName = byId("log-file") ? byId("log-file").value : "";
    const linesValue = byId("log-lines") ? byId("log-lines").value : "500";
    const lines = Math.max(50, Math.min(5000, toNumber(linesValue) || 500));

    if (fileName) {
      params.set("file", fileName);
    }
    params.set("lines", String(lines));

    const data = await fetchJson(`/api/v1/admin/logs/tail?${params.toString()}`);
    if (!data) {
      return;
    }

    const rawLines = Array.isArray(data.lines) ? data.lines : [];
    const visibleLines = applyLogFilter(rawLines);
    logContent.textContent = visibleLines.length ? visibleLines.join("\n") : "暂无日志";

    if (wasAtBottom) {
      logContent.scrollTop = logContent.scrollHeight;
    }
  } catch (error) {
    if (!silent) {
      showToast(`读取日志失败：${error.message || error}`, "error");
    }
  }
}

function stopTimers() {
  if (metricsTimer) {
    clearInterval(metricsTimer);
  }
  if (logsTimer) {
    clearInterval(logsTimer);
  }
  metricsTimer = null;
  logsTimer = null;
}

function startTimers() {
  stopTimers();

  metricsTimer = window.setInterval(() => {
    if (!isAutoRefreshEnabled()) {
      return;
    }
    refreshMetrics(true);
  }, 5000);

  logsTimer = window.setInterval(() => {
    if (!isAutoRefreshEnabled()) {
      return;
    }
    refreshLogs(true);
  }, 3000);
}

function setupEvents() {
  const refreshButton = byId("btn-refresh");
  if (refreshButton) {
    refreshButton.addEventListener("click", async () => {
      await refreshMetrics(false);
      await loadLogFiles();
      await refreshLogs(false);
    });
  }

  const logRefreshButton = byId("log-refresh");
  if (logRefreshButton) {
    logRefreshButton.addEventListener("click", () => refreshLogs(false));
  }

  const logFileSelect = byId("log-file");
  if (logFileSelect) {
    logFileSelect.addEventListener("change", () => refreshLogs(true));
  }

  const logLinesInput = byId("log-lines");
  if (logLinesInput) {
    logLinesInput.addEventListener("change", () => refreshLogs(true));
  }

  const logFilterInput = byId("log-filter");
  if (logFilterInput) {
    logFilterInput.addEventListener("input", () => refreshLogs(true));
  }

  window.addEventListener("beforeunload", stopTimers);
}

async function init() {
  apiKey = await ensureAdminKey();
  if (apiKey === null) {
    return;
  }

  buildCharts();
  setupEvents();
  await refreshMetrics(true);
  await loadLogFiles();
  await refreshLogs(true);
  startTimers();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
