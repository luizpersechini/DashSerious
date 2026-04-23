// Shared bootstrap for detail pages (gold.html, silver.html, ...). Each page calls
// DashDetail.init({ key, format, ... }) after DashChart is loaded.
(function (global) {
  'use strict';

  const nf2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  const nf0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  const DEFAULT_FORMATS = {
    gold:      (d) => `${nf2.format(d.usdPerOunce)} <span class="unit">USD/oz</span>`,
    silver:    (d) => `${nf2.format(d.usdPerOunce)} <span class="unit">USD/oz</span>`,
    platinum:  (d) => `${nf2.format(d.usdPerOunce)} <span class="unit">USD/oz</span>`,
    palladium: (d) => `${nf2.format(d.usdPerOunce)} <span class="unit">USD/oz</span>`,
    copper:    (d) => `${nf2.format(d.usdPerPound ?? 0)} <span class="unit">USD/lb</span>`,
    nickel:    (d) => `${nf2.format(d.usdPerPound ?? 0)} <span class="unit">USD/lb</span>`,
    cobalt:    (d) => `${nf0.format(d.usdPerMetricTon ?? 0)} <span class="unit">USD/ton</span>`,
    brl:       (d) => `${Number(d.fxUsdBrl ?? 0).toFixed(4)} <span class="unit">BRL per USD</span>`,
  };

  function showError(spot, message, onRetry) {
    spot.innerHTML = '<span class="muted" style="font-size:1rem">Unavailable</span>';
    const parent = spot.parentElement;
    let errEl = parent.querySelector('.card-error');
    if (!errEl) {
      errEl = document.createElement('div');
      errEl.className = 'card-error';
      spot.after(errEl);
    }
    errEl.innerHTML = `<span>Couldn't load — ${message || 'network error'}</span><button type="button">Retry</button>`;
    errEl.querySelector('button').addEventListener('click', () => {
      errEl.remove();
      spot.innerHTML = '<span class="skeleton"></span>';
      onRetry();
    });
  }

  async function init(opts) {
    const key = opts.key;
    const metalKey = opts.metalKey || key;
    const format = opts.format || DEFAULT_FORMATS[key] || DEFAULT_FORMATS.gold;
    const chartHeight = opts.chartHeight || 400;

    const spot = document.getElementById('spot');
    const tfSel = document.getElementById('tf');
    const perSel = document.getElementById('per');
    const chartEl = document.getElementById('chart');
    const lastUpdatedEl = document.getElementById('lastUpdated');

    if (spot) spot.innerHTML = '<span class="skeleton" style="width:40%"></span>';

    async function loadSpot() {
      try {
        const data = await DashChart.fetchWithRetry(`/api/${key}/latest`);
        const d = data.data;
        spot.innerHTML = format(d);
        if (lastUpdatedEl) lastUpdatedEl.textContent = new Date(d.timestamp).toLocaleString();
      } catch (err) {
        showError(spot, err && err.message, loadSpot);
      }
    }

    async function loadChart() {
      const tfVal = tfSel?.value || '360';
      const isAll = tfVal === 'all';
      const days = isAll ? 0 : (Number(tfVal) || 360);
      const periodicity = String(perSel?.value || 'daily');
      try {
        const url = isAll
          ? `/api/${key}/timeseries?limit=9999`
          : `/api/${key}/timeseries?since_ts=${Date.now() - days * 86400000}`;
        const ts = await DashChart.fetchWithRetry(url, { retries: 0 });
        let points = (ts.data.points || []).slice().sort((a, b) => a.t - b.t);
        points = DashChart.applyPeriodicity(points, periodicity);
        DashChart.renderChart(chartEl, points, { metalKey, height: chartHeight });
      } catch { /* chart optional on error */ }
    }

    loadSpot();
    loadChart();
    tfSel?.addEventListener('change', loadChart);
    perSel?.addEventListener('change', loadChart);
  }

  function ready(fn) {
    if (typeof LightweightCharts !== 'undefined' && window.DashChart) fn();
    else setTimeout(() => ready(fn), 100);
  }

  global.DashDetail = { init, ready };
})(window);
