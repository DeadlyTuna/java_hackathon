/* ═══════════════════════════════════════════════════════
   SPECTRASHIELD — dashboard.js  (fixed)
   ═══════════════════════════════════════════════════════ */
'use strict';

// ══════════════════════════════════════
// CONFIG
// ══════════════════════════════════════
const CFG = {
  BACKEND_URL:     'http://localhost:5000',
  MAX_LOG_EVENTS:  120,
  WAVEFORM_POINTS: 300,    // show 300 samples = 0.3s of signal
  WATERFALL_ROWS:  60,
  // Show 0–30 Hz only — signal is at 10 Hz, this keeps the spike large and visible
  FFT_MAX_HZ:      30,
  SNR_MAX:         30,
  HOP_SEQUENCE:    [10, 14, 8, 17, 11, 19, 7, 13, 16, 9],
  DEMO_MODE:       false,
};

// ══════════════════════════════════════
// STATE
// ══════════════════════════════════════
const STATE = {
  mode:          'NORMAL',
  attackActive:  false,
  hopActive:     false,
  frameCount:    0,
  alertCount:    0,
  hopCount:      0,
  snrHistory:    [],
  peakEntropy:   0,
  sessionStart:  Date.now(),
  _lastEventTs:  null,
};

// ══════════════════════════════════════
// DOM REFS
// ══════════════════════════════════════
const $ = id => document.getElementById(id);
const DOM = {
  badge:         $('system-badge'),
  badgeLabel:    $('badge-label'),
  alertOverlay:  $('alert-overlay'),
  overlayDetail: $('overlay-detail'),
  snrValue:      $('snr-value'),
  entropyValue:  $('entropy-value'),
  entropyBar:    $('entropy-bar'),
  freqValue:     $('freq-value'),
  freqStatus:    $('freq-status'),
  modeValue:     $('mode-value'),
  fpsValue:      $('fps-value'),
  threatPct:     $('threat-pct'),
  threatFill:    $('threat-bar-fill'),
  attackBtn:     $('attack-btn'),
  defendBtn:     $('defend-btn'),
  resetBtn:      $('reset-btn'),
  noiseSlider:   $('noise-slider'),
  noiseDisplay:  $('noise-display'),
  hopChips:      $('hop-chips'),
  eventLog:      $('event-log'),
  logCount:      $('log-count'),
  fftPeakBadge:  $('fft-peak-badge'),
  fftFloorBadge: $('fft-floor-badge'),
  waveAmpBadge:  $('wave-amp-badge'),
  waveRmsBadge:  $('wave-rms-badge'),
  wsStatus:      $('ws-status'),
  utcClock:      $('utc-clock'),
  sessionTimer:  $('session-timer'),
  statAlerts:    $('stat-alerts'),
  statAvgSnr:    $('stat-avg-snr'),
  statPeakEnt:   $('stat-peak-ent'),
  statHops:      $('stat-hops'),
  statFrames:    $('stat-frames'),
  statUptime:    $('stat-uptime'),
  nodeList:      $('node-list'),
};

// ══════════════════════════════════════
// FFT CHART
// Key fix: only show 0–30 Hz so the 10 Hz spike fills the chart
// Y max = 1.5 for clean, 3.5 for attack
// ══════════════════════════════════════
const FFT_CTX = $('fft-chart').getContext('2d');

// Placeholder labels — replaced with real Hz values on first data frame
const fftChart = new Chart(FFT_CTX, {
  type: 'bar',
  data: {
    labels: [],
    datasets: [
      {
        label: 'Magnitude',
        data: [],
        backgroundColor: ctx => {
          const v   = ctx.dataset.data[ctx.dataIndex] || 0;
          const norm = Math.min(1, v / 1.0);
          if (STATE.attackActive)
            return `rgba(255,${Math.round(45 + norm * 60)},45,${0.5 + norm * 0.5})`;
          if (STATE.hopActive)
            return `rgba(0,${Math.round(150 + norm * 80)},255,${0.5 + norm * 0.5})`;
          return `rgba(0,${Math.round(180 + norm * 49)},${Math.round(120 + norm * 20)},${0.5 + norm * 0.5})`;
        },
        borderColor: 'transparent',
        borderWidth: 0,
        barPercentage: 1.0,
        categoryPercentage: 1.0,
      },
      {
        label: 'Noise Floor',
        data: [],
        type: 'line',
        borderColor: 'rgba(58,85,102,0.7)',
        borderWidth: 1,
        borderDash: [4, 4],
        pointRadius: 0,
        fill: false,
        tension: 0,
      },
    ],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: {
        display: true,
        grid: { display: false },
        ticks: {
          color: '#3a5566',
          font: { family: 'Share Tech Mono', size: 9 },
          maxTicksLimit: 8,
          callback: function(val, idx) {
            // Show Hz label every ~5 bins
            const label = this.getLabelForValue(val);
            return label + ' Hz';
          },
        },
      },
      y: {
        min: 0,
        max: 1.5,   // signal peak is ~1.0 with SIGNAL_AMP=1.0
        grid: { color: 'rgba(0,200,160,0.06)', lineWidth: 1 },
        ticks: {
          color: '#3a5566',
          font: { family: 'Share Tech Mono', size: 9 },
          maxTicksLimit: 6,
          callback: v => v.toFixed(1),
        },
        border: { display: false },
      },
    },
  },
});

// ══════════════════════════════════════
// WAVEFORM CHART
// Shows a scrolling oscilloscope view
// Y range -3 to +3 covers clean signal (±1) and light noise
// Attack mode auto-expands to ±5
// ══════════════════════════════════════
const WAVE_CTX   = $('wave-chart').getContext('2d');
const waveBuffer = new Array(CFG.WAVEFORM_POINTS).fill(0);

const waveChart = new Chart(WAVE_CTX, {
  type: 'line',
  data: {
    labels: new Array(CFG.WAVEFORM_POINTS).fill(''),
    datasets: [{
      label: 'Signal',
      data: [...waveBuffer],
      borderColor: '#00e5a0',
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.2,
      fill: false,
    }],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: { display: false, grid: { display: false } },
      y: {
        min: -3,
        max:  3,
        grid: { color: 'rgba(0,200,160,0.08)', lineWidth: 1 },
        ticks: {
          color: '#3a5566',
          font: { family: 'Share Tech Mono', size: 9 },
          maxTicksLimit: 7,
          callback: v => v.toFixed(1),
        },
        border: { display: false },
      },
    },
  },
});

// ══════════════════════════════════════
// SNR GAUGE
// ══════════════════════════════════════
const SNR_CVS  = $('snr-gauge');
const SNR_CTX2 = SNR_CVS.getContext('2d');

function drawSNRGauge(snr) {
  const W = SNR_CVS.width, H = SNR_CVS.height;
  const cx = W / 2, cy = H - 14;
  const r  = Math.min(cx, cy + 14) - 8;
  SNR_CTX2.clearRect(0, 0, W, H);

  const norm    = Math.min(1, Math.max(0, snr / CFG.SNR_MAX));
  const fillEnd = Math.PI + norm * Math.PI;

  // Track
  SNR_CTX2.beginPath();
  SNR_CTX2.arc(cx, cy, r, Math.PI, 2 * Math.PI);
  SNR_CTX2.strokeStyle = 'rgba(0,200,160,0.08)';
  SNR_CTX2.lineWidth   = 10;
  SNR_CTX2.lineCap     = 'round';
  SNR_CTX2.stroke();

  // Gradient fill
  const grd = SNR_CTX2.createLinearGradient(cx - r, cy, cx + r, cy);
  grd.addColorStop(0,   '#ff2d2d');
  grd.addColorStop(0.5, '#ffb700');
  grd.addColorStop(1,   '#00e5a0');
  SNR_CTX2.beginPath();
  SNR_CTX2.arc(cx, cy, r, Math.PI, fillEnd);
  SNR_CTX2.strokeStyle = grd;
  SNR_CTX2.lineWidth   = 10;
  SNR_CTX2.lineCap     = 'round';
  SNR_CTX2.stroke();

  // Min/max labels
  SNR_CTX2.fillStyle  = '#3a5566';
  SNR_CTX2.font       = '8px "Share Tech Mono"';
  SNR_CTX2.textAlign  = 'left';
  SNR_CTX2.fillText('0', cx - r - 2, cy + 14);
  SNR_CTX2.textAlign  = 'right';
  SNR_CTX2.fillText(CFG.SNR_MAX, cx + r + 2, cy + 14);
}

// ══════════════════════════════════════
// WATERFALL
// ══════════════════════════════════════
const WF_CVS = $('waterfall-canvas');
const WF_CTX = WF_CVS.getContext('2d');

function pushWaterfall(magnitudes) {
  const W    = WF_CVS.width;
  const H    = WF_CVS.height;
  const rowH = Math.max(1, Math.ceil(H / CFG.WATERFALL_ROWS));

  // Scroll down
  const img = WF_CTX.getImageData(0, 0, W, H - rowH);
  WF_CTX.putImageData(img, 0, rowH);

  // New row at top
  const binW = W / magnitudes.length;
  magnitudes.forEach((mag, i) => {
    const norm = Math.min(1, mag / 1.2);
    let r, g, b;
    if (STATE.attackActive) {
      r = Math.round(180 + norm * 75); g = Math.round(norm * 50); b = Math.round(norm * 40);
    } else if (STATE.hopActive) {
      r = 0; g = Math.round(100 + norm * 120); b = Math.round(150 + norm * 105);
    } else {
      r = 0; g = Math.round(80 + norm * 175); b = Math.round(60 + norm * 80);
    }
    WF_CTX.fillStyle = `rgb(${r},${g},${b})`;
    WF_CTX.fillRect(Math.round(i * binW), 0, Math.ceil(binW) + 1, rowH);
  });
}

// ══════════════════════════════════════
// HOP CHIPS
// ══════════════════════════════════════
function renderHopChips(currentFreq) {
  if (!DOM.hopChips) return;
  DOM.hopChips.innerHTML = CFG.HOP_SEQUENCE.map(f => {
    const active = (f === currentFreq) && STATE.hopActive;
    return `<span class="hop-chip${active ? ' current' : ''}">${f}Hz</span>`;
  }).join('');
}
renderHopChips(10);

// ══════════════════════════════════════
// EVENT LOG
// ══════════════════════════════════════
function addLogEntry(severity, message) {
  if (!DOM.eventLog) return;
  const ts  = new Date().toISOString().slice(11, 22);
  const el  = document.createElement('div');
  el.className = `log-entry severity-${(severity || 'info').toLowerCase()}`;
  el.innerHTML = `
    <span class="log-ts">${ts}</span>
    <div class="log-body">
      <div class="log-sev">${severity}</div>
      <div class="log-msg">${message}</div>
    </div>`;
  DOM.eventLog.prepend(el);
  while (DOM.eventLog.children.length > CFG.MAX_LOG_EVENTS)
    DOM.eventLog.removeChild(DOM.eventLog.lastChild);
  if (DOM.logCount)
    DOM.logCount.textContent = `${DOM.eventLog.children.length} events`;
}

// ══════════════════════════════════════
// ALERT HANDLER
// ══════════════════════════════════════
let prevAlertActive = false;

function handleAlert(alert) {
  if (!alert) return;
  const { active, severity, message } = alert;

  if (active && !prevAlertActive) {
    STATE.alertCount++;
    if (DOM.statAlerts) DOM.statAlerts.textContent = STATE.alertCount;
    addLogEntry(severity || 'CRITICAL', message || 'Jamming attack detected');
  }
  if (!active && prevAlertActive) {
    addLogEntry('INFO', 'Signal restored — threat cleared');
  }
  prevAlertActive = !!active;

  if (DOM.alertOverlay)  DOM.alertOverlay.style.display  = active ? 'flex' : 'none';
  if (DOM.overlayDetail && message) DOM.overlayDetail.textContent = message;
  document.body.classList.toggle('attacking', !!active);
}

// ══════════════════════════════════════
// CLOCK
// ══════════════════════════════════════
function updateClock() {
  const now     = new Date();
  const elapsed = Math.floor((Date.now() - STATE.sessionStart) / 1000);
  const mm      = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss      = String(elapsed % 60).padStart(2, '0');
  const upStr   = `${mm}:${ss}`;

  if (DOM.utcClock)    DOM.utcClock.textContent    = now.toUTCString().slice(17, 25);
  if (DOM.sessionTimer) DOM.sessionTimer.textContent = upStr;
  if (DOM.statUptime)  DOM.statUptime.textContent   = upStr;
}
setInterval(updateClock, 1000);

// ══════════════════════════════════════
// MAIN UPDATE — called every frame
// ══════════════════════════════════════
function updateDisplay(data) {
  const {
    snr_db, spectral_entropy,
    fft_frequencies, fft_magnitudes,
    time_domain,
    current_frequency,
    attacking, hopping,
    alert, mode,
  } = data;

  STATE.attackActive = !!attacking;
  STATE.hopActive    = !!hopping;
  STATE.frameCount++;

  // ── SNR ──────────────────────────────────────────────
  const snrVal = +snr_db.toFixed(1);
  if (DOM.snrValue) DOM.snrValue.textContent = snrVal;
  drawSNRGauge(snrVal);

  STATE.snrHistory.push(snrVal);
  if (STATE.snrHistory.length > 100) STATE.snrHistory.shift();
  const avgSnr = (STATE.snrHistory.reduce((a, b) => a + b, 0) / STATE.snrHistory.length).toFixed(1);
  if (DOM.statAvgSnr) DOM.statAvgSnr.textContent = `${avgSnr} dB`;

  // ── Entropy ───────────────────────────────────────────
  if (DOM.entropyValue) DOM.entropyValue.textContent = spectral_entropy.toFixed(3);
  const entNorm = Math.min(100, spectral_entropy * 150);
  if (DOM.entropyBar)  DOM.entropyBar.style.width    = `${entNorm}%`;
  if (spectral_entropy > STATE.peakEntropy) {
    STATE.peakEntropy = spectral_entropy;
    if (DOM.statPeakEnt) DOM.statPeakEnt.textContent = spectral_entropy.toFixed(3);
  }

  // ── Threat bar ────────────────────────────────────────
  const snrDrop   = Math.max(0, 25 - snrVal);
  const threatPct = Math.min(100, Math.round((snrDrop / 25) * 70 + entNorm * 0.3));
  if (DOM.threatPct)  DOM.threatPct.textContent  = `${threatPct}%`;
  if (DOM.threatFill) DOM.threatFill.style.width = `${threatPct}%`;

  // ── Frequency & hop chips ─────────────────────────────
  if (current_frequency !== undefined) {
    if (DOM.freqValue)  DOM.freqValue.textContent  = `${current_frequency} Hz`;
    if (DOM.freqStatus) DOM.freqStatus.textContent = hopping ? 'HOPPING' : 'LOCKED';
    renderHopChips(current_frequency);
  }

  // ── Mode badge ────────────────────────────────────────
  const modeStr = attacking ? 'UNDER ATTACK' : hopping ? 'HOPPING' : 'SECURE';
  if (DOM.modeValue)  DOM.modeValue.textContent  = modeStr;
  if (DOM.badgeLabel) DOM.badgeLabel.textContent = modeStr;
  if (DOM.badge) {
    DOM.badge.className = 'system-badge ' +
      (attacking ? 'badge-attack' : hopping ? 'badge-hop' : 'badge-secure');
  }

  // ── FFT CHART ─────────────────────────────────────────
  // Only render bins where frequency <= FFT_MAX_HZ (30 Hz)
  // This makes the 10 Hz spike large and prominent
  if (fft_frequencies && fft_magnitudes && fft_frequencies.length > 0) {
    // Find the cutoff index
    const cutoff = fft_frequencies.findIndex(f => f > CFG.FFT_MAX_HZ);
    const endIdx = cutoff > 0 ? cutoff : Math.min(60, fft_frequencies.length);

    const freqSlice = fft_frequencies.slice(0, endIdx).map(f => Math.round(f * 10) / 10);
    const magSlice  = fft_magnitudes.slice(0, endIdx);

    fftChart.data.labels                 = freqSlice;
    fftChart.data.datasets[0].data      = magSlice;

    // Peak frequency label
    const peak      = Math.max(...magSlice);
    const peakIdx   = magSlice.indexOf(peak);
    const peakFreq  = freqSlice[peakIdx];
    const noiseFloor = magSlice
      .filter((_, i) => Math.abs(freqSlice[i] - (current_frequency || 10)) > 2)
      .reduce((a, b) => a + b, 0) / Math.max(1, magSlice.length - 3);

    if (DOM.fftPeakBadge)  DOM.fftPeakBadge.textContent  = `PEAK: ${peakFreq} Hz`;
    if (DOM.fftFloorBadge) DOM.fftFloorBadge.textContent = `FLOOR: ${noiseFloor.toFixed(3)}`;

    // Noise floor line
    fftChart.data.datasets[1].data = new Array(endIdx).fill(noiseFloor);

    // Y-axis: expand during attack so noise floor rise is visible
    fftChart.options.scales.y.max = attacking ? 4.0 : 1.5;

    fftChart.update('none');
    pushWaterfall(magSlice);
  }

  // ── WAVEFORM ──────────────────────────────────────────
  // Push all samples from frame into rolling buffer
  if (time_domain && time_domain.length > 0) {
    for (const s of time_domain) {
      waveBuffer.push(s);
      if (waveBuffer.length > CFG.WAVEFORM_POINTS) waveBuffer.shift();
    }

    waveChart.data.datasets[0].data = [...waveBuffer];
    waveChart.data.datasets[0].borderColor =
      attacking ? '#ff4455' : hopping ? '#00b8ff' : '#00e5a0';

    // Auto-expand Y axis during attack — noise can hit ±4
    waveChart.options.scales.y.min = attacking ? -5 : -3;
    waveChart.options.scales.y.max = attacking ?  5 :  3;

    const amp = Math.max(...time_domain.map(Math.abs));
    const rms = Math.sqrt(time_domain.reduce((s, v) => s + v * v, 0) / time_domain.length);
    if (DOM.waveAmpBadge) DOM.waveAmpBadge.textContent = `AMP: ${amp.toFixed(3)}`;
    if (DOM.waveRmsBadge) DOM.waveRmsBadge.textContent = `RMS: ${rms.toFixed(3)}`;

    waveChart.update('none');
  }

  // ── Alert ─────────────────────────────────────────────
  handleAlert(alert);

  // ── Session stats ─────────────────────────────────────
  if (DOM.statFrames) DOM.statFrames.textContent = STATE.frameCount;
  if (hopping) {
    STATE.hopCount++;
    if (DOM.statHops) DOM.statHops.textContent = STATE.hopCount;
  }
}

// ══════════════════════════════════════
// CONTROLS — REST + SocketIO events
// ══════════════════════════════════════
async function apiCall(endpoint) {
  try {
    return await fetch(`${CFG.BACKEND_URL}${endpoint}`, { method: 'POST' });
  } catch (e) {
    addLogEntry('ERROR', `API call failed: ${endpoint}`);
  }
}

if (DOM.attackBtn) {
  DOM.attackBtn.addEventListener('click', async () => {
    if (!STATE.attackActive) {
      await apiCall('/api/attack/start');
      addLogEntry('CRITICAL', 'Manual attack simulation initiated');
      DOM.attackBtn.textContent = '■ STOP ATTACK';
      if (DOM.defendBtn) DOM.defendBtn.disabled = false;
    } else {
      await apiCall('/api/attack/stop');
      addLogEntry('INFO', 'Attack simulation stopped');
      DOM.attackBtn.textContent = '▶ INITIATE ATTACK';
      if (DOM.defendBtn) DOM.defendBtn.disabled = true;
    }
  });
}

if (DOM.defendBtn) {
  DOM.defendBtn.addEventListener('click', async () => {
    await apiCall('/api/countermeasure/deploy');
    addLogEntry('INFO', 'Frequency hopping countermeasure deployed');
    DOM.attackBtn.textContent = '▶ INITIATE ATTACK';
    DOM.defendBtn.disabled    = true;
  });
}

if (DOM.resetBtn) {
  DOM.resetBtn.addEventListener('click', async () => {
    await apiCall('/api/reset');
    STATE.attackActive = false;
    STATE.hopActive    = false;
    STATE.frameCount   = 0;
    STATE.alertCount   = 0;
    STATE.hopCount     = 0;
    STATE.snrHistory   = [];
    STATE.peakEntropy  = 0;
    waveBuffer.fill(0);
    waveChart.data.datasets[0].data = [...waveBuffer];
    waveChart.update('none');
    addLogEntry('INFO', 'System reset — recalibrating baseline');
    if (DOM.attackBtn) DOM.attackBtn.textContent = '▶ INITIATE ATTACK';
    if (DOM.defendBtn) DOM.defendBtn.disabled    = true;
  });
}

if (DOM.noiseSlider) {
  DOM.noiseSlider.addEventListener('input', e => {
    const val = parseFloat(e.target.value);
    if (DOM.noiseDisplay) DOM.noiseDisplay.textContent = val.toFixed(1);
  });
}

// ══════════════════════════════════════
// WEBSOCKET
// ══════════════════════════════════════
let socket = null;

function connectBackend() {
  socket = io(CFG.BACKEND_URL, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
  });

  socket.on('connect', () => {
    if (DOM.wsStatus) DOM.wsStatus.textContent = '⬤ BACKEND: CONNECTED';
    addLogEntry('INFO', 'WebSocket connected to Flask-SocketIO backend');
  });

  socket.on('disconnect', () => {
    if (DOM.wsStatus) DOM.wsStatus.textContent = '⬤ BACKEND: DISCONNECTED';
    addLogEntry('ERROR', 'WebSocket disconnected — attempting reconnect');
  });

  socket.on('connect_error', err => {
    if (DOM.wsStatus) DOM.wsStatus.textContent = '⬤ BACKEND: ERROR';
    console.error('Socket error:', err.message);
  });

  socket.on('signal_data', data => updateDisplay(data));

  socket.on('alert', data => {
    if (data && data.message)
      addLogEntry(data.severity || 'INFO', data.message);
  });
}

// ══════════════════════════════════════
// BOOT
// ══════════════════════════════════════
(function boot() {
  addLogEntry('INFO', 'SpectraShield RF-IDS initializing…');
  addLogEntry('INFO', 'FFT engine ready — 64-bin resolution');
  addLogEntry('INFO', 'Baseline spectral fingerprint recording…');

  updateClock();
  drawSNRGauge(0);
  renderHopChips(10);

  if (!CFG.DEMO_MODE) connectBackend();
})();