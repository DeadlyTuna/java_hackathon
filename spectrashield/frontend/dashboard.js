/* ═══════════════════════════════════════════════════════
   SPECTRASHIELD — dashboard.js
   Handles: WebSocket connection, Chart.js rendering,
            SNR gauge, waterfall, event log, state machine
   ═══════════════════════════════════════════════════════ */

'use strict';

// ══════════════════════════════════════
// CONFIG
// ══════════════════════════════════════
const CFG = {
  BACKEND_URL:    'http://localhost:5000',   // Flask-SocketIO server
  MAX_LOG_EVENTS: 120,
  WAVEFORM_POINTS: 120,
  WATERFALL_ROWS:  60,
  FFT_BINS:       64,
  SNR_MAX:        30,
  ALERT_THRESHOLD_SNR:     10,
  ALERT_THRESHOLD_ENTROPY: 0.65,
  HOP_SEQUENCE:   [10, 14, 8, 17, 11, 19, 7, 13, 16, 9],
  DEMO_MODE:      false,   // <-- set false when backend is running
};

// ══════════════════════════════════════
// STATE
// ══════════════════════════════════════
const STATE = {
  mode:           'NORMAL',       // NORMAL | ATTACK | HOPPING | RESTORED
  attackActive:   false,
  hopActive:      false,
  currentHopIdx:  0,
  noiseLevel:     0.5,
  frameCount:     0,
  alertCount:     0,
  hopCount:       0,
  snrHistory:     [],
  peakEntropy:    0,
  sessionStart:   Date.now(),
  lastFrameTime:  performance.now(),
  fps:            0,
  demoT:          0,                        // time accumulator for demo sine
  waterfallData:  [],                        // array of FFT row arrays
};

// ══════════════════════════════════════
// DOM REFS
// ══════════════════════════════════════
const $ = id => document.getElementById(id);

const DOM = {
  badge:        $('system-badge'),
  badgeLabel:   $('badge-label'),
  alertOverlay: $('alert-overlay'),
  overlayDetail:$('overlay-detail'),
  snrValue:     $('snr-value'),
  entropyValue: $('entropy-value'),
  entropyBar:   $('entropy-bar'),
  freqValue:    $('freq-value'),
  freqStatus:   $('freq-status'),
  modeValue:    $('mode-value'),
  fpsValue:     $('fps-value'),
  threatPct:    $('threat-pct'),
  threatFill:   $('threat-bar-fill'),
  attackBtn:    $('attack-btn'),
  defendBtn:    $('defend-btn'),
  resetBtn:     $('reset-btn'),
  noiseSlider:  $('noise-slider'),
  noiseDisplay: $('noise-display'),
  hopChips:     $('hop-chips'),
  eventLog:     $('event-log'),
  logCount:     $('log-count'),
  fftPeakBadge: $('fft-peak-badge'),
  fftFloorBadge:$('fft-floor-badge'),
  waveAmpBadge: $('wave-amp-badge'),
  waveRmsBadge: $('wave-rms-badge'),
  wsStatus:     $('ws-status'),
  utcClock:     $('utc-clock'),
  sessionTimer: $('session-timer'),
  statAlerts:   $('stat-alerts'),
  statAvgSnr:   $('stat-avg-snr'),
  statPeakEnt:  $('stat-peak-ent'),
  statHops:     $('stat-hops'),
  statFrames:   $('stat-frames'),
  statUptime:   $('stat-uptime'),
  nodeList:     $('node-list'),
};

// ══════════════════════════════════════
// CHART.JS — FFT SPECTRUM
// ══════════════════════════════════════
const FFT_CTX = $('fft-chart').getContext('2d');
const fftLabels = Array.from({ length: CFG.FFT_BINS }, (_, i) => `${Math.round(i * (100 / CFG.FFT_BINS))}`);

const fftChart = new Chart(FFT_CTX, {
  type: 'bar',
  data: {
    labels: fftLabels,
    datasets: [{
      label: 'Magnitude',
      data: new Array(CFG.FFT_BINS).fill(0),
      backgroundColor: ctx => {
        const v = ctx.dataset.data[ctx.dataIndex] || 0;
        const norm = v / 1.2;
        if (STATE.attackActive) return `rgba(255,${Math.round(45 + norm*50)},45,${0.4 + norm*0.5})`;
        if (STATE.hopActive)    return `rgba(0,${Math.round(150 + norm*80)},255,${0.4 + norm*0.5})`;
        return `rgba(0,${Math.round(180 + norm*49)},${Math.round(140 + norm*20)},${0.4 + norm*0.55})`;
      },
      borderColor: 'transparent',
      borderWidth: 0,
      barPercentage: 1.0,
      categoryPercentage: 1.0,
    }, {
      // noise floor reference line
      label: 'Noise Floor',
      data: new Array(CFG.FFT_BINS).fill(0.05),
      type: 'line',
      borderColor: 'rgba(58,85,102,0.5)',
      borderWidth: 1,
      borderDash: [4, 4],
      pointRadius: 0,
      fill: false,
      tension: 0,
    }],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: {
        display: false,
        grid: { display: false },
      },
      y: {
        min: 0, max: 1.4,
        grid: { color: 'rgba(0,200,160,0.05)', lineWidth: 1 },
        ticks: {
          color: '#3a5566', font: { family: 'Share Tech Mono', size: 9 },
          maxTicksLimit: 5,
          callback: v => v.toFixed(1),
        },
        border: { display: false },
      },
    },
  },
});

// ══════════════════════════════════════
// CHART.JS — WAVEFORM (scrolling)
// ══════════════════════════════════════
const WAVE_CTX = $('wave-chart').getContext('2d');
const waveData = new Array(CFG.WAVEFORM_POINTS).fill(0);
const waveLabels = new Array(CFG.WAVEFORM_POINTS).fill('');

const waveChart = new Chart(WAVE_CTX, {
  type: 'line',
  data: {
    labels: waveLabels,
    datasets: [{
      label: 'Signal',
      data: waveData,
      borderColor: '#00e5a0',
      borderWidth: 1.5,
      pointRadius: 0,
      fill: {
        target: 'origin',
        above: 'rgba(0,229,160,0.04)',
        below: 'rgba(0,229,160,0.02)',
      },
      tension: 0.3,
    }],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: { display: false },
      y: {
        min: -1.8, max: 1.8,
        grid: { color: 'rgba(0,200,160,0.05)', lineWidth: 1 },
        ticks: {
          color: '#3a5566', font: { family: 'Share Tech Mono', size: 9 },
          maxTicksLimit: 5,
          callback: v => v.toFixed(1),
        },
        border: { display: false },
      },
    },
  },
});

// ══════════════════════════════════════
// SNR GAUGE (canvas arc)
// ══════════════════════════════════════
const SNR_CVS = $('snr-gauge');
const SNR_CTX2 = SNR_CVS.getContext('2d');

function drawSNRGauge(snr) {
  const W = SNR_CVS.width, H = SNR_CVS.height;
  const cx = W / 2, cy = H - 14;
  const r = Math.min(cx, cy + 14) - 8;
  SNR_CTX2.clearRect(0, 0, W, H);

  const startAngle = Math.PI;
  const endAngle   = 2 * Math.PI;
  const norm = Math.min(1, Math.max(0, snr / CFG.SNR_MAX));
  const fillEnd = startAngle + norm * Math.PI;

  // Track
  SNR_CTX2.beginPath();
  SNR_CTX2.arc(cx, cy, r, startAngle, endAngle);
  SNR_CTX2.strokeStyle = 'rgba(0,200,160,0.08)';
  SNR_CTX2.lineWidth = 10; SNR_CTX2.lineCap = 'round';
  SNR_CTX2.stroke();

  // Tick marks
  SNR_CTX2.strokeStyle = 'rgba(0,200,160,0.15)';
  SNR_CTX2.lineWidth = 1;
  for (let i = 0; i <= 6; i++) {
    const a = Math.PI + (i / 6) * Math.PI;
    const inner = r - 8, outer = r + 2;
    SNR_CTX2.beginPath();
    SNR_CTX2.moveTo(cx + inner * Math.cos(a), cy + inner * Math.sin(a));
    SNR_CTX2.lineTo(cx + outer * Math.cos(a), cy + outer * Math.sin(a));
    SNR_CTX2.stroke();
  }

  // Colored fill arc
  const color = snr < 5  ? '#ff2d2d'
               : snr < 10 ? '#ff8c00'
               : snr < 18 ? '#ffb700'
               :             '#00e5a0';
  const grd = SNR_CTX2.createLinearGradient(cx - r, cy, cx + r, cy);
  grd.addColorStop(0, '#ff2d2d');
  grd.addColorStop(0.5, '#ffb700');
  grd.addColorStop(1, '#00e5a0');
  SNR_CTX2.beginPath();
  SNR_CTX2.arc(cx, cy, r, startAngle, fillEnd);
  SNR_CTX2.strokeStyle = grd;
  SNR_CTX2.lineWidth = 10; SNR_CTX2.lineCap = 'round';
  SNR_CTX2.shadowColor = color;
  SNR_CTX2.shadowBlur = 12;
  SNR_CTX2.stroke();
  SNR_CTX2.shadowBlur = 0;

  // Labels 0 / max
  SNR_CTX2.fillStyle = '#3a5566';
  SNR_CTX2.font = '8px "Share Tech Mono"';
  SNR_CTX2.textAlign = 'left';
  SNR_CTX2.fillText('0', cx - r - 2, cy + 14);
  SNR_CTX2.textAlign = 'right';
  SNR_CTX2.fillText(`${CFG.SNR_MAX}`, cx + r + 2, cy + 14);
}

// ══════════════════════════════════════
// WATERFALL CANVAS
// ══════════════════════════════════════
const WF_CVS = $('waterfall-canvas');
const WF_CTX = WF_CVS.getContext('2d');
let waterfallImageData = null;

function pushWaterfall(fftMagnitudes) {
  // Resize image data if needed
  if (!waterfallImageData || waterfallImageData.width !== WF_CVS.width) {
    WF_CVS.width = WF_CVS.offsetWidth || 240;
    waterfallImageData = WF_CTX.createImageData(WF_CVS.width, CFG.WATERFALL_ROWS);
    waterfallImageData.data.fill(0);
    for (let i = 3; i < waterfallImageData.data.length; i += 4)
      waterfallImageData.data[i] = 255;
  }
  const W = WF_CVS.width;
  const rowBytes = W * 4;

  // Scroll existing rows down by one
  const d = waterfallImageData.data;
  for (let row = CFG.WATERFALL_ROWS - 1; row > 0; row--) {
    const dst = row * rowBytes, src = (row - 1) * rowBytes;
    d.copyWithin(dst, src, src + rowBytes);
  }

  // Write new top row from FFT data
  for (let x = 0; x < W; x++) {
    const binIdx = Math.floor(x / W * fftMagnitudes.length);
    const v = Math.min(1, fftMagnitudes[binIdx] || 0);
    const i = x * 4;
    const [r, g, b] = thermalColor(v);
    d[i] = r; d[i+1] = g; d[i+2] = b;
  }

  WF_CTX.putImageData(waterfallImageData, 0, 0);

  // Scale to canvas display height
  WF_CTX.drawImage(WF_CVS, 0, 0, W, CFG.WATERFALL_ROWS,
                             0, 0, W, WF_CVS.offsetHeight || 180);
}

function thermalColor(v) {
  // black → blue → cyan → green → yellow → red
  if (v < 0.25) {
    const t = v / 0.25;
    return [0, 0, Math.round(t * 200)];
  } else if (v < 0.5) {
    const t = (v - 0.25) / 0.25;
    return [0, Math.round(t * 220), Math.round(200 * (1 - t))];
  } else if (v < 0.75) {
    const t = (v - 0.5) / 0.25;
    return [Math.round(t * 255), 220, 0];
  } else {
    const t = (v - 0.75) / 0.25;
    return [255, Math.round(220 * (1 - t)), 0];
  }
}

// ══════════════════════════════════════
// HOP SEQUENCE CHIPS
// ══════════════════════════════════════
function renderHopChips(currentIdx, jammedIdx = -1) {
  DOM.hopChips.innerHTML = CFG.HOP_SEQUENCE.map((f, i) => {
    let cls = 'hop-chip';
    if (i === currentIdx) cls += ' current';
    if (i === jammedIdx)  cls += ' jammed';
    return `<span class="${cls}">${f}Hz</span>`;
  }).join('');
}
renderHopChips(0);

// ══════════════════════════════════════
// EVENT LOG
// ══════════════════════════════════════
const logEntries = [];

function addLogEntry(severity, message, metrics = null) {
  const ts = new Date().toISOString().slice(11, 22);
  logEntries.unshift({ severity, message, metrics, ts });
  if (logEntries.length > CFG.MAX_LOG_EVENTS) logEntries.pop();
  renderLog();
  DOM.logCount.textContent = `${logEntries.length} events`;
}

function renderLog() {
  DOM.eventLog.innerHTML = logEntries.slice(0, 60).map(e => `
    <div class="log-entry severity-${e.severity.toLowerCase()}">
      <span class="log-ts">${e.ts}</span>
      <div class="log-body">
        <div class="log-sev">${e.severity}</div>
        <div class="log-msg">${e.message}</div>
        ${e.metrics ? `<div class="log-metrics">${e.metrics}</div>` : ''}
      </div>
    </div>
  `).join('');
}

// ══════════════════════════════════════
// STATE MACHINE
// ══════════════════════════════════════
function applyMode(mode) {
  STATE.mode = mode;
  document.body.className = '';

  const badge = DOM.badge;
  const label = DOM.badgeLabel;

  switch (mode) {
    case 'NORMAL':
      badge.dataset.state = 'secure';
      label.textContent = 'SECURE';
      DOM.alertOverlay.classList.add('hidden');
      document.body.classList.remove('state-attack','state-hop');
      DOM.modeValue.style.color = '#00e5a0';
      setNodeStates('ok');
      break;

    case 'ATTACK':
      badge.dataset.state = 'attack';
      label.textContent = 'UNDER ATTACK';
      DOM.alertOverlay.classList.remove('hidden');
      document.body.classList.add('state-attack');
      DOM.modeValue.style.color = '#ff2d2d';
      setNodeStates('critical');
      // Play Web Audio alert beep
      playAlertBeep();
      break;

    case 'HOPPING':
      badge.dataset.state = 'hop';
      label.textContent = 'FREQ HOPPING';
      DOM.alertOverlay.classList.add('hidden');
      document.body.classList.add('state-hop');
      DOM.modeValue.style.color = '#00b8ff';
      setNodeStates('warning');
      break;

    case 'RESTORED':
      badge.dataset.state = 'secure';
      label.textContent = 'RESTORED';
      DOM.alertOverlay.classList.add('hidden');
      document.body.classList.remove('state-attack','state-hop');
      DOM.modeValue.style.color = '#00e5a0';
      setNodeStates('ok');
      break;
  }

  DOM.modeValue.textContent = mode;
}

function setNodeStates(s) {
  document.querySelectorAll('.node-dot').forEach(dot => {
    dot.dataset.state = s;
  });
}

// ══════════════════════════════════════
// WEB AUDIO — alert beep
// ══════════════════════════════════════
let audioCtx = null;
function playAlertBeep() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.type = 'square'; osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.06, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
    osc.start(); osc.stop(audioCtx.currentTime + 0.3);
    setTimeout(() => {
      const osc2 = audioCtx.createOscillator();
      const g2   = audioCtx.createGain();
      osc2.connect(g2); g2.connect(audioCtx.destination);
      osc2.type = 'square'; osc2.frequency.value = 660;
      g2.gain.setValueAtTime(0.06, audioCtx.currentTime);
      g2.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
      osc2.start(); osc2.stop(audioCtx.currentTime + 0.3);
    }, 320);
  } catch (_) {}
}

// ══════════════════════════════════════
// UI CONTROLS
// ══════════════════════════════════════
DOM.attackBtn.addEventListener('click', () => {
  if (!STATE.attackActive) startAttack();
  else stopAttack();
});

DOM.defendBtn.addEventListener('click', () => {
  deployCountermeasure();
});

DOM.resetBtn.addEventListener('click', () => {
  resetBaseline();
});

DOM.noiseSlider.addEventListener('input', e => {
  STATE.noiseLevel = parseFloat(e.target.value);
  DOM.noiseDisplay.textContent = STATE.noiseLevel.toFixed(1);
  if (socket) socket.emit('set_noise_level', { level: STATE.noiseLevel });
});

function startAttack() {
  STATE.attackActive = true;
  STATE.alertCount++;
  DOM.attackBtn.classList.add('active');
  DOM.attackBtn.querySelector('.btn-text').textContent = 'STOP ATTACK';
  DOM.defendBtn.disabled = false;
  applyMode('ATTACK');
  addLogEntry('CRITICAL', 'Jamming attack initiated — broadband noise injection active', `Noise level: ${STATE.noiseLevel.toFixed(1)} | Freq: ${CFG.HOP_SEQUENCE[STATE.currentHopIdx]}Hz`);
  if (socket) socket.emit('attack_start', { noise_level: STATE.noiseLevel });
}

function stopAttack() {
  STATE.attackActive = false;
  DOM.attackBtn.classList.remove('active');
  DOM.attackBtn.querySelector('.btn-text').textContent = 'INITIATE ATTACK';
  DOM.defendBtn.disabled = !STATE.hopActive;
  if (!STATE.hopActive) applyMode('NORMAL');
  addLogEntry('INFO', 'Attack signal disabled — monitoring for residual interference');
  if (socket) socket.emit('attack_stop');
}

function deployCountermeasure() {
  // ── FIX: stop any active attack before deploying countermeasure ──
  if (STATE.attackActive) {
    STATE.attackActive = false;
    DOM.attackBtn.classList.remove('active');
    DOM.attackBtn.querySelector('.btn-text').textContent = 'INITIATE ATTACK';
    if (socket) socket.emit('attack_stop');
  }

  STATE.hopActive = true;
  STATE.hopCount++;
  const prevIdx = STATE.currentHopIdx;
  STATE.currentHopIdx = (STATE.currentHopIdx + 1) % CFG.HOP_SEQUENCE.length;
  const newFreq = CFG.HOP_SEQUENCE[STATE.currentHopIdx];
  applyMode('HOPPING');
  renderHopChips(STATE.currentHopIdx, prevIdx);
  DOM.freqValue.textContent = `${newFreq} Hz`;
  DOM.freqStatus.textContent = 'HOPPING';
  addLogEntry('HOP', `Frequency hopping activated — jumped to ${newFreq}Hz`, `From: ${CFG.HOP_SEQUENCE[prevIdx]}Hz → To: ${newFreq}Hz`);
  if (socket) socket.emit('countermeasure_deploy', { new_freq: newFreq });

  // After a brief transition, show RESTORED
  setTimeout(() => {
    if (STATE.mode === 'HOPPING') {
      STATE.hopActive = false;
      DOM.defendBtn.disabled = true;
      DOM.freqStatus.textContent = 'LOCKED';
      applyMode('RESTORED');
      addLogEntry('LOW', `Signal restored on clean channel — ${newFreq}Hz — SNR recovering`);
      setTimeout(() => { if (STATE.mode === 'RESTORED') applyMode('NORMAL'); }, 4000);
    }
  }, 2500);
}

function resetBaseline() {
  STATE.attackActive = false;
  STATE.hopActive = false;
  STATE.currentHopIdx = 0;
  DOM.attackBtn.classList.remove('active');
  DOM.attackBtn.querySelector('.btn-text').textContent = 'INITIATE ATTACK';
  DOM.defendBtn.disabled = true;
  DOM.freqValue.textContent = `${CFG.HOP_SEQUENCE[0]} Hz`;
  DOM.freqStatus.textContent = 'LOCKED';
  renderHopChips(0);
  applyMode('NORMAL');
  addLogEntry('INFO', 'System reset — recalibrating baseline spectral fingerprint');
  if (socket) socket.emit('reset_baseline');
}

// ══════════════════════════════════════
// UPDATE DISPLAY
// ══════════════════════════════════════
function updateDisplay(data) {
  const { snr_db, spectral_entropy, fft_magnitudes, time_domain, current_frequency, mode } = data;

  // SNR
  const snrRounded = +snr_db.toFixed(1);
  DOM.snrValue.textContent = snrRounded;
  DOM.snrValue.style.color = snrRounded < 5 ? '#ff2d2d' : snrRounded < 12 ? '#ffb700' : '#00e5a0';
  DOM.snrValue.style.textShadow = snrRounded < 5
    ? '0 0 20px rgba(255,45,45,0.6)'
    : '0 0 20px rgba(0,229,160,0.5)';
  drawSNRGauge(snrRounded);
  STATE.snrHistory.push(snrRounded);
  if (STATE.snrHistory.length > 200) STATE.snrHistory.shift();

  // Entropy
  const entFmt = (+spectral_entropy).toFixed(3);
  DOM.entropyValue.textContent = entFmt;
  const entNorm = Math.min(1, spectral_entropy / 1.0) * 100;
  DOM.entropyBar.style.width = `${entNorm}%`;
  DOM.entropyBar.style.background = spectral_entropy > 0.65 ? '#ff2d2d' : spectral_entropy > 0.4 ? '#ffb700' : '#00e5a0';
  if (spectral_entropy > STATE.peakEntropy) STATE.peakEntropy = spectral_entropy;

  // Threat level: composite score
  const snrThreat     = Math.max(0, 1 - snrRounded / CFG.SNR_MAX);
  const entThreat     = Math.min(1, spectral_entropy / 1.0);
  const threatScore   = Math.min(100, Math.round((snrThreat * 0.6 + entThreat * 0.4) * 100));
  DOM.threatFill.style.width = `${threatScore}%`;
  DOM.threatPct.textContent  = `${threatScore}%`;
  DOM.threatPct.style.color  = threatScore > 70 ? '#ff2d2d' : threatScore > 40 ? '#ffb700' : '#00e5a0';

  // Frequency
  if (current_frequency !== undefined) {
    DOM.freqValue.textContent = `${current_frequency} Hz`;
  }

  // Mode sync (from backend) — only when frontend is idle
  if (mode && mode !== STATE.mode && !STATE.attackActive && !STATE.hopActive) {
    applyMode(mode);
  }

  // Auto-trigger alert from data
  if (snrRounded < CFG.ALERT_THRESHOLD_SNR && spectral_entropy > CFG.ALERT_THRESHOLD_ENTROPY) {
    if (STATE.mode === 'NORMAL' && !STATE.attackActive) {
      applyMode('ATTACK');
      STATE.alertCount++;
      addLogEntry('CRITICAL', 'Anomaly auto-detected — SNR below threshold + entropy spike', `SNR: ${snrRounded}dB | Entropy: ${entFmt}`);
    }
  }

  // FFT chart
  if (fft_magnitudes && fft_magnitudes.length > 0) {
    const resampledFFT = resampleArray(fft_magnitudes, CFG.FFT_BINS);
    fftChart.data.datasets[0].data = resampledFFT;

    // Noise floor estimate
    const sorted = [...resampledFFT].sort((a,b)=>a-b);
    const floorEst = sorted[Math.floor(sorted.length * 0.2)];
    fftChart.data.datasets[1].data = new Array(CFG.FFT_BINS).fill(floorEst);

    const peak = Math.max(...resampledFFT);
    const peakBin = resampledFFT.indexOf(peak);
    const peakHz = Math.round(peakBin * (100 / CFG.FFT_BINS));
    DOM.fftPeakBadge.textContent = `PEAK: ${peakHz}Hz`;
    DOM.fftFloorBadge.textContent = `FLOOR: ${floorEst.toFixed(3)}`;

    fftChart.update('none');
    pushWaterfall(resampledFFT);
  }

  // Waveform chart (scrolling)
  if (time_domain && time_domain.length > 0) {
    const sample = time_domain[time_domain.length - 1];
    waveData.push(sample);
    if (waveData.length > CFG.WAVEFORM_POINTS) waveData.shift();
    waveChart.data.datasets[0].data = [...waveData];
    // Color waveform by state
    waveChart.data.datasets[0].borderColor =
      STATE.attackActive ? '#ff5555'
      : STATE.hopActive  ? '#00b8ff'
      :                    '#00e5a0';
    const amp = Math.max(...time_domain.map(Math.abs));
    const rms = Math.sqrt(time_domain.reduce((s,v)=>s+v*v,0)/time_domain.length);
    DOM.waveAmpBadge.textContent = `AMP: ${amp.toFixed(3)}`;
    DOM.waveRmsBadge.textContent = `RMS: ${rms.toFixed(3)}`;
    waveChart.update('none');
  }

  // Stats
  STATE.frameCount++;
  const avgSNR = STATE.snrHistory.length
    ? (STATE.snrHistory.reduce((a,b)=>a+b,0)/STATE.snrHistory.length).toFixed(1)
    : '--';
  DOM.statAlerts.textContent  = STATE.alertCount;
  DOM.statAvgSnr.textContent  = `${avgSNR} dB`;
  DOM.statPeakEnt.textContent = STATE.peakEntropy.toFixed(3);
  DOM.statHops.textContent    = STATE.hopCount;
  DOM.statFrames.textContent  = STATE.frameCount.toLocaleString();

  // FPS
  const now = performance.now();
  STATE.fps = Math.round(1000 / (now - STATE.lastFrameTime));
  STATE.lastFrameTime = now;
  DOM.fpsValue.textContent = STATE.fps;
}

function resampleArray(arr, targetLen) {
  if (arr.length === targetLen) return arr;
  return Array.from({ length: targetLen }, (_, i) => {
    const src = Math.floor(i / targetLen * arr.length);
    return arr[src] || 0;
  });
}

// ══════════════════════════════════════
// CLOCKS
// ══════════════════════════════════════
function updateClocks() {
  const now = new Date();
  DOM.utcClock.textContent =
    `${String(now.getUTCHours()).padStart(2,'0')}:`+
    `${String(now.getUTCMinutes()).padStart(2,'0')}:`+
    `${String(now.getUTCSeconds()).padStart(2,'0')}`;

  const elapsed = Math.floor((Date.now() - STATE.sessionStart) / 1000);
  const m = String(Math.floor(elapsed/60)).padStart(2,'0');
  const s = String(elapsed%60).padStart(2,'0');
  DOM.sessionTimer.textContent = `${m}:${s}`;
  DOM.statUptime.textContent   = `${m}:${s}`;
}
setInterval(updateClocks, 1000);
updateClocks();

// ══════════════════════════════════════
// DEMO MODE (runs when no backend)
// ══════════════════════════════════════
function generateDemoFrame() {
  STATE.demoT += 0.05;
  const t = STATE.demoT;
  const noiseAmp = STATE.attackActive ? STATE.noiseLevel : 0.05;

  // Clean signal: 10 Hz sine
  const SAMPLES = 128;
  const time_domain = Array.from({ length: SAMPLES }, (_, i) => {
    const clean = Math.sin(2 * Math.PI * 10 * (i / SAMPLES) + t);
    const noise = (Math.random() - 0.5) * 2 * noiseAmp;
    return clean + noise;
  });

  // FFT: simplified magnitude via DFT on key bins
  const fft_magnitudes = Array.from({ length: CFG.FFT_BINS }, (_, k) => {
    let re = 0, im = 0;
    const stride = Math.floor(SAMPLES / CFG.FFT_BINS);
    for (let n = 0; n < SAMPLES; n += stride) {
      const angle = 2 * Math.PI * k * n / SAMPLES;
      re += time_domain[n] * Math.cos(angle);
      im -= time_domain[n] * Math.sin(angle);
    }
    return Math.sqrt(re*re + im*im) / (SAMPLES / stride);
  });

  // SNR
  const signalBin  = Math.round(10 / (1000 / (CFG.FFT_BINS * 2)));  // ~ bin for 10Hz
  const peakPower  = (fft_magnitudes[Math.max(0,signalBin)] || 0) ** 2;
  const noisePow   = fft_magnitudes.reduce((s,v,i)=> Math.abs(i-signalBin)>2 ? s+v*v:s, 0)
                     / (CFG.FFT_BINS - 5);
  const snr_db = noisePow > 0
    ? Math.min(30, Math.max(-5, 10 * Math.log10(peakPower / noisePow + 1e-9)))
    : 25;

  // Spectral entropy
  const total = fft_magnitudes.reduce((a,b)=>a+b,0) + 1e-9;
  const probs  = fft_magnitudes.map(v=>v/total);
  const spectral_entropy = -probs.reduce((s,p)=>p>0?s+p*Math.log(p):s, 0) / Math.log(CFG.FFT_BINS);

  return {
    time_domain,
    fft_magnitudes,
    snr_db: STATE.attackActive ? Math.max(0, snr_db - 15 + Math.random()*3) : Math.min(28, snr_db + 5),
    spectral_entropy: STATE.attackActive ? Math.min(0.95, spectral_entropy + 0.4) : spectral_entropy,
    current_frequency: CFG.HOP_SEQUENCE[STATE.currentHopIdx],
    mode: STATE.mode,
  };
}

// ══════════════════════════════════════
// WEBSOCKET (Flask-SocketIO)
// ══════════════════════════════════════
let socket = null;
let demoInterval = null;

function connectBackend() {
  try {
    socket = io(CFG.BACKEND_URL, {
      transports: ['websocket'],
      reconnectionAttempts: 5,
      timeout: 3000,
    });

    socket.on('connect', () => {
      DOM.wsStatus.textContent = '⬤ BACKEND: CONNECTED';
      DOM.wsStatus.className = 'footer-item connected';
      addLogEntry('INFO', 'WebSocket connection established to Flask-SocketIO backend');
      if (demoInterval) { clearInterval(demoInterval); demoInterval = null; }
    });

    socket.on('disconnect', () => {
      DOM.wsStatus.textContent = '⬤ BACKEND: DISCONNECTED';
      DOM.wsStatus.className = 'footer-item disconnected';
      addLogEntry('MEDIUM', 'Backend connection lost — falling back to demo mode');
      startDemoMode();
    });

    socket.on('connect_error', () => {
      DOM.wsStatus.textContent = '⬤ BACKEND: OFFLINE — DEMO MODE';
      DOM.wsStatus.className = 'footer-item disconnected';
      socket.disconnect();
      startDemoMode();
    });

    socket.on('signal_data', data => {
      updateDisplay(data);
    });

    socket.on('alert', data => {
      const sev = data.severity || 'MEDIUM';
      addLogEntry(sev, data.message, data.metrics);
      // ── FIX: only switch to ATTACK mode from backend alert if we didn't
      //    trigger it ourselves (prevents echo from our own attack_start emit)
      if (sev === 'CRITICAL' && STATE.mode !== 'ATTACK' && !STATE.attackActive) {
        applyMode('ATTACK');
        STATE.alertCount++;
      }
    });

  } catch (e) {
    startDemoMode();
  }
}

function startDemoMode() {
  if (demoInterval) return;
  DOM.wsStatus.textContent = '⬤ DEMO MODE — no backend';
  DOM.wsStatus.className = 'footer-item disconnected';
  addLogEntry('INFO', 'Running in demo mode — set CFG.BACKEND_URL and connect Flask-SocketIO to receive live data');

  const DEMO_FPS = 10;
  demoInterval = setInterval(() => {
    const frame = generateDemoFrame();
    updateDisplay(frame);
  }, 1000 / DEMO_FPS);
}

// ══════════════════════════════════════
// BOOT
// ══════════════════════════════════════
(function boot() {
  addLogEntry('INFO', 'SpectraShield RF-IDS initializing…');
  addLogEntry('INFO', 'FFT engine ready — 1024-bin resolution');
  addLogEntry('INFO', 'Baseline spectral fingerprint recording…');
  setTimeout(() => addLogEntry('LOW', 'Baseline calibrated — monitoring active'), 1200);

  drawSNRGauge(0);

  if (CFG.DEMO_MODE) {
    startDemoMode();
  } else {
    connectBackend();
  }
})();