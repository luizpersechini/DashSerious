// Shared chart helpers — reused by index.html (card charts) and the per-metal detail pages.
// Exposed on window.DashChart so classic <script> includes can pick them up without module loaders.
(function (global) {
  'use strict';

  const METAL_COLORS = {
    gold:      { line: '#fbbf24', top: 'rgba(251, 191, 36, 0.4)', bottom: 'rgba(251, 191, 36, 0.0)' },
    silver:    { line: '#cbd5e1', top: 'rgba(203, 213, 225, 0.4)', bottom: 'rgba(203, 213, 225, 0.0)' },
    platinum:  { line: '#d4d4d8', top: 'rgba(212, 212, 216, 0.4)', bottom: 'rgba(212, 212, 216, 0.0)' },
    palladium: { line: '#22d3ee', top: 'rgba(34, 211, 238, 0.4)',  bottom: 'rgba(34, 211, 238, 0.0)' },
    copper:    { line: '#fb923c', top: 'rgba(251, 146, 60, 0.4)',  bottom: 'rgba(251, 146, 60, 0.0)' },
    nickel:    { line: '#34d399', top: 'rgba(52, 211, 153, 0.4)',  bottom: 'rgba(52, 211, 153, 0.0)' },
    cobalt:    { line: '#60a5fa', top: 'rgba(96, 165, 250, 0.4)',  bottom: 'rgba(96, 165, 250, 0.0)' },
    brl:       { line: '#22d3ee', top: 'rgba(34, 211, 238, 0.4)',  bottom: 'rgba(34, 211, 238, 0.0)' },
  };

  function getMetalColors(key) { return METAL_COLORS[key] || METAL_COLORS.gold; }

  function startOfDay(ts) { const d = new Date(ts); d.setHours(0,0,0,0); return d.getTime(); }
  function startOfWeek(ts) {
    const d = new Date(startOfDay(ts));
    const day = d.getDay();
    const diff = (day + 6) % 7; // Monday start
    d.setDate(d.getDate() - diff);
    return d.getTime();
  }
  function startOfMonth(ts) { const d = new Date(startOfDay(ts)); d.setDate(1); return d.getTime(); }

  function aggregateBy(points, bucketFn) {
    const map = new Map();
    for (const p of points) {
      const k = bucketFn(p.t);
      const arr = map.get(k) || [];
      arr.push(p.v);
      map.set(k, arr);
    }
    const out = [];
    for (const [k, arr] of Array.from(map.entries()).sort((a, b) => a[0] - b[0])) {
      const avg = arr.reduce((s, x) => s + x, 0) / arr.length;
      out.push({ t: Number(k), v: avg });
    }
    return out;
  }
  const aggregateWeekly  = (points) => aggregateBy(points, startOfWeek);
  const aggregateMonthly = (points) => aggregateBy(points, startOfMonth);

  function applyPeriodicity(points, periodicity) {
    if (periodicity === 'weekly') return aggregateWeekly(points);
    if (periodicity === 'monthly') return aggregateMonthly(points);
    return points;
  }

  const DEFAULT_PRICE_FORMATTER = (price) => {
    const abs = Math.abs(price);
    if (abs >= 1000) return new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(price);
    if (abs >= 1)    return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(price);
    return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(price);
  };

  const chartInstances = new WeakMap();

  function renderChart(container, points, opts) {
    opts = opts || {};
    const metalKey = opts.metalKey || 'gold';
    const height = opts.height || 140;
    const widthPaddingPx = opts.widthPaddingPx != null ? opts.widthPaddingPx : 44;
    const priceFormatter = opts.priceFormatter || DEFAULT_PRICE_FORMATTER;
    const timeVisible = !!opts.timeVisible;

    if (!points || points.length < 2) {
      container.innerHTML = '<div style="text-align:center;padding:20px;color:#94a3b8;">No data</div>';
      return;
    }
    if (typeof LightweightCharts === 'undefined') {
      container.innerHTML = '<div style="text-align:center;padding:20px;color:#94a3b8;">Loading chart library...</div>';
      return;
    }

    const existing = chartInstances.get(container);
    if (existing) {
      try {
        if (existing.observer) existing.observer.disconnect();
        if (existing.chart) existing.chart.remove();
      } catch (e) { console.warn('Error removing old chart:', e); }
    }
    container.innerHTML = '';

    try {
      if (container.clientWidth === 0 || container.clientHeight === 0) {
        setTimeout(() => renderChart(container, points, opts), 100);
        return;
      }
      const card = container.closest('.card');
      const chartWidth = card ? card.clientWidth - widthPaddingPx : container.clientWidth;
      const colors = getMetalColors(metalKey);

      const chart = LightweightCharts.createChart(container, {
        width: chartWidth,
        height,
        layout: {
          background: { type: 'solid', color: 'transparent' },
          textColor: '#94a3b8',
          fontSize: 11,
          fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
        },
        grid: {
          vertLines: { visible: false },
          horzLines: { color: '#1f2937', style: 0, visible: true },
        },
        crosshair: {
          mode: LightweightCharts.CrosshairMode.Normal,
          vertLine: { color: '#94a3b8', width: 1, style: 3, labelBackgroundColor: '#1f2937' },
          horzLine: { color: '#94a3b8', width: 1, style: 3, labelBackgroundColor: '#1f2937' },
        },
        leftPriceScale:  { visible: true, borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } },
        rightPriceScale: { visible: false },
        localization: { priceFormatter },
        timeScale: { borderVisible: false, timeVisible, secondsVisible: false },
        handleScroll: false,
        handleScale: false,
        watermark: { visible: false },
      });

      const series = chart.addAreaSeries({
        lineColor: colors.line,
        topColor: colors.top,
        bottomColor: colors.bottom,
        lineWidth: 2,
        crosshairMarkerVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
      });

      const data = points
        .filter(p => p && typeof p.t === 'number' && typeof p.v === 'number' && !isNaN(p.v))
        .map(p => ({ time: Math.floor(p.t / 1000), value: Number(p.v) }))
        .sort((a, b) => a.time - b.time);

      if (data.length < 2) throw new Error('Not enough valid data points after filtering');
      series.setData(data);
      chart.timeScale().fitContent();

      let resizeFrame = null;
      const resizeObserver = new ResizeObserver(() => {
        if (resizeFrame) cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(() => {
          if (!chart) return;
          const target = card || container;
          const newWidth = (card ? card.clientWidth - widthPaddingPx : target.clientWidth);
          const currentWidth = chart.options().width;
          if (newWidth > 0 && newWidth !== currentWidth) chart.applyOptions({ width: newWidth });
        });
      });
      resizeObserver.observe(card || container);
      chartInstances.set(container, { chart, observer: resizeObserver });
    } catch (error) {
      console.error('Error rendering chart for', metalKey, ':', error);
      container.innerHTML = '<div style="text-align:center;padding:20px;color:#ef4444;">Chart error: ' + (error && error.message) + '</div>';
    }
  }

  // Fetch helper with timeout + single retry — used by card and detail pages.
  async function fetchWithRetry(url, { timeoutMs = 8000, retries = 1, retryDelayMs = 500 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        const data = await res.json();
        if (!res.ok || data.success === false) {
          throw new Error(data.error || ('HTTP ' + res.status));
        }
        return data;
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        if (attempt < retries) await new Promise(r => setTimeout(r, retryDelayMs));
      }
    }
    throw lastErr;
  }

  global.DashChart = {
    getMetalColors,
    startOfDay, startOfWeek, startOfMonth,
    aggregateWeekly, aggregateMonthly, applyPeriodicity,
    renderChart,
    fetchWithRetry,
    DEFAULT_PRICE_FORMATTER,
  };
})(window);
