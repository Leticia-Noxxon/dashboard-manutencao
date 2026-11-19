(function () {
  const PAGE = 20;
  const FAMILIES = [
    { key: "UCP NX6000", short: "UCP", color: "#2f95f4", kpi: "kpi-ucp" },
    { key: "TDM NX6010", short: "TDM", color: "#7ec8ff", kpi: "kpi-tdm" },
    { key: "SWITCH NX6020", short: "SWITCH", color: "#2456c9", kpi: "kpi-switch" },
    { key: "NOBREAK", short: "NOBREAK", color: "#f0a202", kpi: "kpi-nobreak" },
  ];
  const MONTHS = [
    ["jan", "janeiro"],
    ["fev", "fevereiro"],
    ["mar", "marco"],
    ["abr", "abril"],
    ["mai", "maio"],
    ["jun", "junho"],
    ["jul", "julho"],
    ["ago", "agosto"],
    ["set", "setembro"],
    ["out", "outubro"],
    ["nov", "novembro"],
    ["dez", "dezembro"],
  ];
  const MONTH_SHORT = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  const MONTH_LONG = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

  const fmt = new Intl.NumberFormat("pt-BR");
  const state = {
    events: [],
    filtered: [],
    stats: null,
    view: "dashboard",
    page: 1,
    year: null,
    query: "",
    familia: "",
    prefixo: "",
    diagnostico: "",
    chartMonth: null,
    chartBreak: [],
    skipped: 0,
  };
  let lineChart = null;
  let pieChart = null;
  let toastTimer = 0;

  const $ = (id) => document.getElementById(id);

  function fold(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase();
  }

  function squash(value) {
    return fold(value).replace(/[^a-z0-9]+/g, "");
  }

  function norm(value) {
    return fold(value).replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function tidy(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/\s+([,.;:)])/g, "$1")
      .replace(/\(\s+/g, "(")
      .trim();
  }

  function pick(row, name) {
    if (row[name] != null) return row[name];
    const wanted = fold(name);
    const key = Object.keys(row).find((item) => fold(item) === wanted);
    return key ? row[key] : "";
  }

  function parseDataBR(value) {
    const label = tidy(value);
    const match = label.toLowerCase().match(/(\d{1,2})\s+de\s+([a-zà-ÿ.]+)\s+de\s+(\d{4})/i);
    if (!match) return null;
    const token = fold(match[2].replace(/\./g, ""));
    const month = MONTHS.findIndex((names) => names.includes(token));
    if (month < 0) return null;
    const day = Number(match[1]);
    const year = Number(match[3]);
    const iso = year + "-" + String(month + 1).padStart(2, "0") + "-" + String(day).padStart(2, "0");
    return { iso, year, month, label };
  }

  function familiaDe(equipamento) {
    const key = squash(equipamento);
    if (key.includes("ucp") && key.includes("6000")) return "UCP NX6000";
    if (key.includes("tdm") && key.includes("6010")) return "TDM NX6010";
    if (key.includes("switch")) return "SWITCH NX6020";
    if (key.includes("nobreak")) return "NOBREAK";
    return "";
  }

  function parseMonthQuery(raw) {
    const text = norm(raw);
    if (!text) return null;
    let match = text.match(/^(\d{4}) (\d{1,2})$/);
    if (match) {
      const month = Number(match[2]) - 1;
      if (month >= 0 && month <= 11) return { year: Number(match[1]), month };
    }
    match = text.match(/^(\d{1,2}) (\d{4})$/);
    if (match) {
      const month = Number(match[1]) - 1;
      if (month >= 0 && month <= 11) return { year: Number(match[2]), month };
    }
    match = text.match(/^([a-z]+)(?: de)?(?: (\d{4}))?$/);
    if (match) {
      const month = MONTHS.findIndex((names) => names.includes(match[1]));
      if (month >= 0) return { month, year: match[2] ? Number(match[2]) : null };
    }
    return null;
  }

  function detectDelimiter(text) {
    const line = text.split(/\r?\n/, 1)[0] || "";
    const commas = (line.match(/,/g) || []).length;
    const semis = (line.match(/;/g) || []).length;
    return semis > commas ? ";" : ",";
  }

  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const delimiter = detectDelimiter(text);
    const rows = [];
    let field = "";
    let row = [];
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (quoted) {
        if (char === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 1;
          } else quoted = false;
        } else field += char;
        continue;
      }
      if (char === '"') {
        quoted = true;
        continue;
      }
      if (char === delimiter) {
        row.push(field);
        field = "";
        continue;
      }
      if (char === "\n" || char === "\r") {
        if (char === "\r" && text[i + 1] === "\n") i += 1;
        row.push(field);
        field = "";
        if (row.some((item) => item !== "")) rows.push(row);
        row = [];
        continue;
      }
      field += char;
    }
    if (field.length || row.length) {
      row.push(field);
      if (row.some((item) => item !== "")) rows.push(row);
    }
    const header = (rows.shift() || []).map((item) => item.trim());
    return rows.map((cells) => {
      const obj = {};
      header.forEach((name, index) => {
        obj[name] = cells[index] == null ? "" : cells[index];
      });
      return obj;
    });
  }

  function blankMonth() {
    const row = { total: 0 };
    FAMILIES.forEach((item) => {
      row[item.short] = 0;
    });
    return row;
  }

  function buildEvents(rows) {
    const events = [];
    let skipped = 0;
    rows.forEach((row) => {
      const date = parseDataBR(pick(row, "data"));
      const id = tidy(pick(row, "modulo_serial"));
      if (!date || !id) {
        skipped += 1;
        return;
      }
      const equipamento = tidy(pick(row, "equipamento"));
      const acao = tidy(pick(row, "acao")) || "Sem diagnóstico";
      events.push({
        iso: date.iso,
        year: date.year,
        month: date.month,
        dataLabel: date.label,
        id,
        equipamento,
        familia: familiaDe(equipamento),
        diag: acao,
        diagRaw: acao,
      });
    });
    events.sort((a, b) => b.iso.localeCompare(a.iso) || a.id.localeCompare(b.id, "pt-BR", { numeric: true }));
    return { events, skipped };
  }

  function matchEvent(event, query) {
    const text = query.trim();
    if (!text) return true;
    const month = parseMonthQuery(text);
    if (month) {
      if (event.month !== month.month) return false;
      if (month.year != null && event.year !== month.year) return false;
      return true;
    }
    const folded = fold(text);
    return (
      fold(event.equipamento).includes(folded) ||
      fold(event.familia).includes(folded) ||
      fold(event.id).includes(folded) ||
      fold(event.diag).includes(folded) ||
      fold(event.diagRaw).includes(folded) ||
      fold(event.dataLabel).includes(folded) ||
      event.iso.includes(text.trim())
    );
  }

  function focusMatch(event, flags) {
    if (flags.year && state.year && state.year !== "all" && event.year !== Number(state.year)) return false;
    if (flags.prefixo && state.prefixo && event.id !== state.prefixo) return false;
    if (flags.diagnostico && state.diagnostico && event.diag !== state.diagnostico) return false;
    if (flags.familia && state.familia && event.familia !== state.familia) return false;
    return true;
  }

  function compute(events) {
    const fam = {};
    FAMILIES.forEach((item) => {
      fam[item.key] = 0;
    });
    const diag = new Map();
    const byId = new Map();
    const years = new Map();
    const months = new Map();
    const ids = new Set();
    events.forEach((event) => {
      ids.add(event.id);
      if (fam[event.familia] != null) fam[event.familia] += 1;
      diag.set(event.diag, (diag.get(event.diag) || 0) + 1);
      let rec = byId.get(event.id);
      if (!rec) {
        rec = { id: event.id, n: 0, equipamento: event.equipamento };
        byId.set(event.id, rec);
      }
      rec.n += 1;
      rec.equipamento = event.equipamento;
      if (!years.has(event.year)) years.set(event.year, Array(12).fill(0));
      if (!months.has(event.year)) months.set(event.year, Array.from({ length: 12 }, blankMonth));
      const family = FAMILIES.find((item) => item.key === event.familia);
      if (family) {
        years.get(event.year)[event.month] += 1;
        const bucket = months.get(event.year)[event.month];
        bucket[family.short] += 1;
        bucket.total += 1;
      }
    });
    const reinc = Array.from(byId.values())
      .filter((item) => item.n > 1)
      .sort((a, b) => b.n - a.n || a.id.localeCompare(b.id, "pt-BR", { numeric: true }));
    const diags = Array.from(diag.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt-BR"));
    return { fam, totalEq: ids.size, totalEv: events.length, diags, reinc, years, months };
  }

  function themePalette() {
    const dark = document.documentElement.dataset.theme === "dark";
    return {
      tick: dark ? "#9aa3b8" : "#8b95a8",
      grid: dark ? "rgba(255,255,255,0.06)" : "rgba(28,36,52,0.08)",
      gap: dark ? "#242938" : "#ffffff",
    };
  }

  function monthsOf(stats, year) {
    return stats.months.get(year) || Array.from({ length: 12 }, blankMonth);
  }

  function addBreak(target, source) {
    FAMILIES.forEach((item) => {
      target[item.short] += source[item.short] || 0;
    });
    target.total += source.total || 0;
    return target;
  }

  function lastMonthOf(year) {
    const today = new Date();
    return year === today.getFullYear() ? today.getMonth() : 11;
  }

  function daysInChartMonth(month) {
    const today = new Date();
    if (state.year && state.year !== "all") {
      const year = Number(state.year);
      let last = new Date(year, month + 1, 0).getDate();
      if (year === today.getFullYear() && month === today.getMonth()) last = today.getDate();
      return last;
    }
    return new Date(today.getFullYear(), month + 1, 0).getDate();
  }

  function seriesFor(stats) {
    if (state.chartMonth != null) {
      const month = state.chartMonth;
      const year = state.year && state.year !== "all" ? Number(state.year) : null;
      const lastDay = daysInChartMonth(month);
      const breakdown = Array.from({ length: lastDay }, blankMonth);
      state.filtered.forEach((event) => {
        if (event.month !== month) return;
        if (year && event.year !== year) return;
        const day = Number(String(event.iso).slice(8, 10));
        if (day < 1 || day > lastDay) return;
        const family = FAMILIES.find((item) => item.key === event.familia);
        if (!family) return;
        breakdown[day - 1][family.short] += 1;
        breakdown[day - 1].total += 1;
      });
      return {
        labels: breakdown.map((_, index) => String(index + 1)),
        values: breakdown.map((item) => item.total),
        breakdown,
      };
    }
    if (state.year === "all") {
      const years = Array.from(stats.months.keys());
      const breakdown = MONTH_SHORT.map((_, index) => years.reduce((sum, year) => addBreak(sum, monthsOf(stats, year)[index]), blankMonth()));
      return { labels: MONTH_SHORT.slice(), values: breakdown.map((item) => item.total), breakdown };
    }
    const year = Number(state.year);
    const breakdown = monthsOf(stats, year).slice(0, lastMonthOf(year) + 1);
    return { labels: MONTH_SHORT.slice(0, lastMonthOf(year) + 1), values: breakdown.map((item) => item.total), breakdown };
  }

  function chartHeading() {
    if (state.chartMonth == null) return "Manutenção";
    const month = MONTH_LONG[state.chartMonth];
    return state.year && state.year !== "all" ? month + " de " + state.year : month;
  }

  function gradientFill(context) {
    const chart = context.chart;
    const area = chart.chartArea;
    if (!area) return "rgba(47,149,245,0.25)";
    const dark = document.documentElement.dataset.theme === "dark";
    const gradient = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
    gradient.addColorStop(0, dark ? "rgba(58,160,255,0.55)" : "rgba(47,149,245,0.38)");
    gradient.addColorStop(1, "rgba(47,149,245,0)");
    return gradient;
  }

  const hoverLine = {
    id: "hoverLine",
    afterDatasetsDraw(chart) {
      const active = chart.tooltip && chart.getActiveElements ? chart.getActiveElements() : [];
      if (!active.length) return;
      const x = active[0].element.x;
      const area = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(47,149,245,0.75)";
      ctx.beginPath();
      ctx.moveTo(x, area.top);
      ctx.lineTo(x, area.bottom);
      ctx.stroke();
      ctx.restore();
    },
  };

  const valueLabels = {
    id: "valueLabels",
    afterDatasetsDraw(chart) {
      const meta = chart.getDatasetMeta(0);
      if (!meta || meta.hidden) return;
      const dark = document.documentElement.dataset.theme === "dark";
      const ctx = chart.ctx;
      ctx.save();
      ctx.font = "600 11px 'Plus Jakarta Sans', 'Segoe UI', sans-serif";
      ctx.fillStyle = dark ? "rgba(244,247,251,0.78)" : "rgba(28,36,52,0.72)";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      let lastX = -999;
      meta.data.forEach((point, index) => {
        const value = chart.data.datasets[0].data[index];
        if (value == null || !point || !value) return;
        if (state.chartMonth != null && point.x - lastX < 28) return;
        lastX = point.x;
        ctx.fillText(fmt.format(value), point.x, point.y - 8);
      });
      ctx.restore();
    },
  };

  function renderLineTip(context) {
    const tip = $("chart-tip");
    const model = context.tooltip;
    const point = model && model.dataPoints && model.dataPoints[0];
    if (!model || model.opacity === 0 || !point) {
      tip.hidden = true;
      return;
    }
    const row = state.chartBreak[point.dataIndex] || blankMonth();
    let title = point.label;
    if (state.chartMonth != null) {
      const monthName = MONTH_LONG[state.chartMonth].toLowerCase();
      title = state.year && state.year !== "all"
        ? point.label + " de " + monthName + " de " + state.year
        : point.label + " de " + monthName;
    } else {
      const monthIndex = MONTH_SHORT.indexOf(point.label);
      const month = monthIndex >= 0 ? MONTH_LONG[monthIndex] : point.label;
      title = state.year && state.year !== "all" ? month + " de " + state.year : month;
    }
    tip.replaceChildren();
    const heading = document.createElement("strong");
    heading.className = "tip-title";
    heading.textContent = title;
    tip.appendChild(heading);
    FAMILIES.forEach((family) => {
      const line = document.createElement("div");
      line.className = "tip-row";
      const dot = document.createElement("i");
      dot.style.background = family.color;
      const name = document.createElement("span");
      name.textContent = family.short;
      const value = document.createElement("b");
      value.textContent = fmt.format(row[family.short] || 0);
      line.append(dot, name, value);
      tip.appendChild(line);
    });
    const total = document.createElement("div");
    total.className = "tip-total";
    const label = document.createElement("span");
    label.textContent = "Total";
    const value = document.createElement("b");
    value.textContent = fmt.format(row.total || 0);
    total.append(label, value);
    tip.appendChild(total);
    tip.hidden = false;
    const rect = context.chart.canvas.getBoundingClientRect();
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    let left = rect.left + model.caretX - width / 2;
    let top = rect.top + model.caretY - height - 16;
    if (top < 8) top = rect.top + model.caretY + 16;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }

  function ensureCharts() {
    const palette = themePalette();
    if (!lineChart) {
      lineChart = new Chart($("line-chart"), {
        type: "line",
        data: { labels: MONTH_SHORT, datasets: [{ data: [], borderColor: "#2f95f4", backgroundColor: gradientFill, fill: true, tension: 0.45, borderWidth: 3, pointRadius: 2.5, pointBackgroundColor: "#2f95f4", pointBorderWidth: 0, pointHoverRadius: 6, pointHoverBackgroundColor: "#fff", pointHoverBorderColor: "#2f95f4", pointHoverBorderWidth: 3 }] },
        plugins: [hoverLine, valueLabels],
        options: {
          responsive: true,
          maintainAspectRatio: false,
          layout: { padding: { top: 22 } },
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              enabled: false,
              external: renderLineTip,
            },
          },
          onClick(event, elements) {
            if (state.chartMonth != null) return;
            const points = elements && elements.length
              ? elements
              : lineChart.getElementsAtEventForMode(event, "index", { intersect: false }, true);
            if (!points.length) return;
            const month = MONTH_SHORT.indexOf(lineChart.data.labels[points[0].index]);
            if (month < 0) return;
            state.chartMonth = month;
            $("chart-tip").hidden = true;
            if (state.stats) paintCharts(state.stats);
          },
          onHover(event) {
            const canvas = event.native && event.native.target;
            if (canvas) canvas.style.cursor = state.chartMonth == null ? "pointer" : "default";
          },
          scales: {
            x: { grid: { display: false }, border: { display: false }, ticks: { color: palette.tick, maxRotation: 0, autoSkip: true } },
            y: { beginAtZero: true, border: { display: false }, grid: { color: palette.grid }, ticks: { color: palette.tick, maxTicksLimit: 5, callback: (value) => fmt.format(value) } },
          },
        },
      });
    }
    if (!pieChart) {
      pieChart = new Chart($("pie-chart"), {
        type: "doughnut",
        data: {
          labels: FAMILIES.map((item) => item.short),
          datasets: [{ data: [0, 0, 0, 0], backgroundColor: FAMILIES.map((item) => item.color), borderWidth: 0, hoverOffset: 4 }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "52%",
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: (item) => " " + item.label + ": " + fmt.format(item.parsed) } } },
        },
      });
    }
  }

  function paintCharts(stats) {
    ensureCharts();
    const palette = themePalette();
    const series = seriesFor(stats);
    state.chartBreak = series.breakdown;
    lineChart.data.labels = series.labels;
    lineChart.data.datasets[0].data = series.values;
    lineChart.options.scales.x.ticks.color = palette.tick;
    lineChart.options.scales.y.ticks.color = palette.tick;
    lineChart.options.scales.y.grid.color = palette.grid;
    $("chart-title").textContent = chartHeading();
    $("chart-back").hidden = state.chartMonth == null;
    lineChart.update();

    pieChart.data.datasets[0].data = FAMILIES.map((item) => stats.fam[item.key] || 0);
    pieChart.update();
  }

  function fillYears() {
    const years = Array.from(new Set(state.events.map((event) => event.year))).sort((a, b) => a - b);
    const select = $("year-select");
    select.replaceChildren();
    const all = document.createElement("option");
    all.value = "all";
    all.textContent = "Todos";
    select.appendChild(all);
    years.forEach((year) => {
      const option = document.createElement("option");
      option.value = String(year);
      option.textContent = String(year);
      select.appendChild(option);
    });
    const max = years.length ? String(years[years.length - 1]) : "all";
    if (state.year == null || (state.year !== "all" && years.indexOf(Number(state.year)) === -1)) state.year = max;
    select.value = String(state.year);
  }

  function renderDiagnosis(stats) {
    const body = $("diag-body");
    body.replaceChildren();
    const rows = stats.diags.slice();
    if (state.diagnostico && !rows.some(([name]) => name === state.diagnostico)) {
      rows.unshift([state.diagnostico, 0]);
    }
    if (!rows.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 2;
      cell.className = "empty";
      cell.textContent = "Nenhum diagnóstico no filtro.";
      row.appendChild(cell);
      body.appendChild(row);
      return;
    }
    rows.forEach(([name, count]) => {
      const row = document.createElement("tr");
      row.dataset.diag = name;
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      if (state.diagnostico === name) row.classList.add("is-active");
      const diag = document.createElement("td");
      const qty = document.createElement("td");
      diag.textContent = name;
      qty.textContent = fmt.format(count);
      row.append(diag, qty);
      body.appendChild(row);
    });
  }

  function renderReincidence(stats) {
    const list = $("reinc-list");
    list.replaceChildren();
    const rows = stats.reinc.slice();
    if (state.prefixo && !rows.some((item) => item.id === state.prefixo)) {
      rows.unshift({ id: state.prefixo, n: 0, equipamento: "" });
    }
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "Nenhum prefixo com reincidência no filtro.";
      list.appendChild(empty);
      return;
    }
    const max = Math.max(1, ...stats.reinc.map((item) => item.n));
    rows.forEach((item) => {
      const row = document.createElement("div");
      row.className = "reinc";
      row.dataset.id = item.id;
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.title = item.equipamento || "";
      if (state.prefixo === item.id) row.classList.add("is-active");
      const id = document.createElement("span");
      id.className = "reinc-id";
      id.textContent = item.id;
      const track = document.createElement("div");
      track.className = "track";
      const bar = document.createElement("div");
      bar.className = "bar";
      bar.style.width = Math.max(4, Math.round((item.n / max) * 100)) + "%";
      track.appendChild(bar);
      const count = document.createElement("span");
      count.className = "reinc-n";
      count.textContent = fmt.format(item.n);
      row.append(id, track, count);
      list.appendChild(row);
    });
  }

  function renderLegend(stats) {
    const legend = $("pie-legend");
    legend.replaceChildren();
    FAMILIES.forEach((item) => {
      const span = document.createElement("span");
      const dot = document.createElement("i");
      dot.style.background = item.color;
      const name = document.createElement("em");
      name.textContent = item.short;
      name.style.fontStyle = "normal";
      span.append(dot, name);
      legend.appendChild(span);
    });
  }

  function renderDashboard(stats) {
    const cards = state.cardStats || stats;
    FAMILIES.forEach((item) => {
      $(item.kpi).textContent = fmt.format(cards.fam[item.key] || 0);
    });
    $("wallet-total").textContent = fmt.format(stats.totalEq);
    renderDiagnosis(state.diagStats || stats);
    renderReincidence(state.idStats || stats);
    renderLegend(stats);
    paintCharts(stats);
  }

  function renderReport() {
    const body = $("report-body");
    body.replaceChildren();
    const total = state.filtered.length;
    const pages = Math.max(1, Math.ceil(total / PAGE));
    if (state.page > pages) state.page = pages;
    if (state.page < 1) state.page = 1;
    const start = (state.page - 1) * PAGE;
    const slice = state.filtered.slice(start, start + PAGE);
    if (!slice.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 4;
      cell.className = "empty";
      cell.textContent = "Nenhum registro encontrado.";
      row.appendChild(cell);
      body.appendChild(row);
    } else {
      slice.forEach((event) => {
        const row = document.createElement("tr");
        [
          [event.dataLabel, ""],
          [event.id, "id"],
          [event.equipamento, ""],
          [event.diag, "diag"],
        ].forEach(([value, filter]) => {
          const cell = document.createElement("td");
          if (filter && value) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "cell-hit";
            button.dataset.filter = filter;
            button.dataset.value = value;
            button.textContent = value;
            cell.appendChild(button);
          } else {
            cell.textContent = value;
          }
          row.appendChild(cell);
        });
        body.appendChild(row);
      });
    }
    const regLabel = total === 1 ? "1 registro" : fmt.format(total) + " registros";
    $("page-info").textContent = total
      ? "Página " + state.page + " de " + fmt.format(pages) + " · " + regLabel
      : "0 registros";
    $("page-prev").disabled = state.page <= 1;
    $("page-next").disabled = state.page >= pages;
  }

  function apply() {
    const searched = state.events.filter((event) => matchEvent(event, state.query));
    const forCards = searched.filter((event) => focusMatch(event, { year: true, prefixo: true, diagnostico: true }));
    const forDiag = searched.filter((event) => focusMatch(event, { year: true, prefixo: true, familia: true }));
    const forId = searched.filter((event) => focusMatch(event, { year: true, diagnostico: true, familia: true }));
    state.filtered = searched.filter((event) => focusMatch(event, { year: true, prefixo: true, diagnostico: true, familia: true }));
    state.cardStats = compute(forCards);
    state.diagStats = compute(forDiag);
    state.idStats = compute(forId);
    state.stats = compute(state.filtered);
    document.querySelectorAll(".kpi").forEach((el) => el.classList.toggle("active", el.dataset.familia === state.familia));
    if (state.view === "dashboard") renderDashboard(state.stats);
    else renderReport();
  }

  function setView(view) {
    state.view = view;
    const report = view === "report";
    $("view-dashboard").hidden = report;
    $("view-report").hidden = !report;
    $("rail").hidden = report;
    $("top").hidden = report;
    $("report-bar").hidden = !report;
    $("shell").classList.toggle("is-report", report);
    document.querySelectorAll(".nav-dashboard").forEach((el) => el.classList.toggle("active", !report));
    document.querySelectorAll(".nav-relatorio").forEach((el) => el.classList.toggle("active", report));
    if (report) renderReport();
    else if (state.stats) {
      renderDashboard(state.stats);
      if (lineChart) lineChart.resize();
      if (pieChart) pieChart.resize();
    }
  }

  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
  }

  function xmlEscape(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  }

  function downloadXls(events) {
    const header = ["Data", "ID", "Equipamento", "Diagnóstico"];
    const rows = [header].concat(events.map((event) => [event.dataLabel, event.id, event.equipamento, event.diag]));
    const xml = [];
    xml.push('<?xml version="1.0" encoding="UTF-8"?>');
    xml.push('<?mso-application progid="Excel.Sheet"?>');
    xml.push('<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">');
    xml.push('<Worksheet ss:Name="Relatorio"><Table>');
    xml.push('<Column ss:Width="150"/><Column ss:Width="90"/><Column ss:Width="160"/><Column ss:Width="420"/>');
    rows.forEach((row) => {
      xml.push("<Row>");
      row.forEach((cell) => {
        xml.push('<Cell><Data ss:Type="String">' + xmlEscape(cell) + "</Data></Cell>");
      });
      xml.push("</Row>");
    });
    xml.push("</Table></Worksheet></Workbook>");
    const blob = new Blob([xml.join("")], { type: "application/vnd.ms-excel" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "relatorio-manutencao.xls";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function showLoading(message) {
    const el = $("loading");
    el.hidden = false;
    el.querySelector("p").textContent = message;
  }

  function hideLoading() {
    $("loading").hidden = true;
  }

  async function loadData(isRefresh) {
    const button = $("btn-atualizar");
    button.disabled = true;
    button.classList.add("is-busy");
    if (!state.events.length) showLoading("Lendo a planilha…");
    try {
      if (location.protocol === "file:") {
        throw new Error("file");
      }
      const stamp = Date.now();
      const csvResponse = await fetch("dados.csv?v=" + stamp, { cache: "no-store" });
      if (!csvResponse.ok) throw new Error("csv");
      const csvText = await csvResponse.text();
      const built = buildEvents(parseCSV(csvText));
      state.events = built.events;
      state.skipped = built.skipped;
      fillYears();
      apply();
      const when = new Date().toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
      $("last-load").textContent = "Lido em " + when;
      hideLoading();
      if (isRefresh) toast("Dados atualizados");
    } catch (error) {
      if (state.events.length) {
        toast("Não foi possível atualizar. Os dados atuais foram mantidos.");
      } else {
        const el = $("loading");
        el.hidden = false;
        el.querySelector("p").textContent = error && error.message === "file"
          ? "Abra o painel pelo arquivo iniciar.bat para ler a planilha."
          : "Não foi possível ler dados.csv. Confira se o arquivo está na pasta e abra pelo iniciar.bat.";
      }
    } finally {
      button.disabled = false;
      button.classList.remove("is-busy");
    }
  }

  document.querySelectorAll(".nav-dashboard").forEach((el) => el.addEventListener("click", () => setView("dashboard")));
  document.querySelectorAll(".nav-relatorio").forEach((el) => el.addEventListener("click", () => setView("report")));
  document.querySelectorAll(".kpi").forEach((el) => {
    el.addEventListener("click", () => {
      const key = el.dataset.familia;
      state.familia = state.familia === key ? "" : key;
      state.page = 1;
      apply();
    });
  });
  $("btn-atualizar").addEventListener("click", async () => {
    const button = $("btn-atualizar");
    button.disabled = true;
    try {
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
      if (navigator.serviceWorker) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.unregister()));
      }
    } catch (error) {
      /* A limpeza do cache segue com a recarga da página. */
    }
    const url = new URL(location.href);
    url.searchParams.set("v", String(Date.now()));
    location.replace(url.toString());
  });
  $("chart-back").addEventListener("click", () => {
    state.chartMonth = null;
    $("chart-tip").hidden = true;
    if (state.stats) paintCharts(state.stats);
  });
  document.querySelectorAll(".theme-toggle").forEach((el) => {
    el.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      localStorage.setItem("gp-theme", next);
      if (state.stats && state.view === "dashboard") paintCharts(state.stats);
    });
  });
  function togglePrefixo(id) {
    state.prefixo = state.prefixo === id ? "" : id;
    state.page = 1;
    apply();
  }

  function toggleDiagnostico(name) {
    state.diagnostico = state.diagnostico === name ? "" : name;
    state.page = 1;
    apply();
  }

  function onActivate(event, handler) {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest("[data-diag], [data-id]");
    if (!row || event.target !== row) return;
    event.preventDefault();
    handler(row);
  }

  $("diag-body").addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-diag]");
    if (!row) return;
    toggleDiagnostico(row.dataset.diag);
  });
  $("diag-body").addEventListener("keydown", (event) => onActivate(event, (row) => toggleDiagnostico(row.dataset.diag)));
  $("reinc-list").addEventListener("click", (event) => {
    const row = event.target.closest("[data-id]");
    if (!row) return;
    togglePrefixo(row.dataset.id);
  });
  $("reinc-list").addEventListener("keydown", (event) => onActivate(event, (row) => togglePrefixo(row.dataset.id)));
  $("report-body").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-filter]");
    if (!button) return;
    if (button.dataset.filter === "id") togglePrefixo(button.dataset.value);
    if (button.dataset.filter === "diag") toggleDiagnostico(button.dataset.value);
  });
  $("line-chart").addEventListener("mouseleave", () => {
    $("chart-tip").hidden = true;
  });
  $("year-select").addEventListener("change", (event) => {
    state.year = event.target.value;
    if (state.chartMonth != null && state.year !== "all" && state.chartMonth > lastMonthOf(Number(state.year))) {
      state.chartMonth = null;
    }
    state.page = 1;
    apply();
  });
  let searchTimer = 0;
  $("search").addEventListener("input", (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = event.target.value;
      state.page = 1;
      apply();
    }, 140);
  });
  $("search").addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.target.value = "";
      state.query = "";
      state.page = 1;
      apply();
    }
  });
  $("page-prev").addEventListener("click", () => {
    state.page -= 1;
    renderReport();
  });
  $("page-next").addEventListener("click", () => {
    state.page += 1;
    renderReport();
  });
  $("btn-export").addEventListener("click", () => {
    if (!state.filtered.length) {
      toast("Nenhum registro para exportar.");
      return;
    }
    const button = $("btn-export");
    button.disabled = true;
    button.textContent = "Gerando…";
    setTimeout(() => {
      try {
        downloadXls(state.filtered);
        toast("Relatório exportado.");
      } catch (error) {
        toast("Não foi possível gerar o Excel.");
      } finally {
        button.disabled = false;
        button.textContent = "Exportar Excel";
      }
    }, 30);
  });

  loadData(false);
})();
