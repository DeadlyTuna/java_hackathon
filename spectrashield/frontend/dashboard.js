console.log('FIXED DASHBOARD v3 — correct FFT freq mapping');
'use strict';

const BACKEND = 'http://localhost:5000';

let attacking     = false;
let hopping       = false;
let frameCount    = 0;
let alertCount    = 0;
let hopCount      = 0;
let snrHistory    = [];
let peakEntropy   = 0;
let sessionStart  = Date.now();
let prevAlertActive = false;

const $ = id => document.getElementById(id);

// ── Clock ────────────────────────────────────────────────
setInterval(() => {
  const e  = Math.floor((Date.now() - sessionStart) / 1000);
  const up = `${String(Math.floor(e/60)).padStart(2,'0')}:${String(e%60).padStart(2,'0')}`;
  const utcEl = $('utc-clock');     if (utcEl)  utcEl.textContent  = new Date().toUTCString().slice(17,25);
  const stEl  = $('session-timer'); if (stEl)   stEl.textContent   = up;
  const suEl  = $('stat-uptime');   if (suEl)   suEl.textContent   = up;
}, 1000);

// ── Event log ────────────────────────────────────────────
function log(severity, msg) {
  const el = $('event-log'); if (!el) return;
  const ts = new Date().toISOString().slice(11,22);
  const d  = document.createElement('div');
  d.className = `log-entry severity-${(severity||'info').toLowerCase()}`;
  d.innerHTML = `<span class="log-ts">${ts}</span>
    <div class="log-body">
      <div class="log-sev">${severity}</div>
      <div class="log-msg">${msg}</div>
    </div>`;
  el.prepend(d);
  while (el.children.length > 80) el.removeChild(el.lastChild);
  const lc = $('log-count'); if (lc) lc.textContent = `${el.children.length} events`;
}

// ── SNR Gauge ────────────────────────────────────────────
const snrCanvas = $('snr-gauge');
const snrCtx    = snrCanvas ? snrCanvas.getContext('2d') : null;

function drawGauge(snr) {
  if (!snrCtx) return;
  const W = snrCanvas.width, H = snrCanvas.height;
  const cx = W/2, cy = H - 14, r = Math.min(cx, cy+14) - 8;
  snrCtx.clearRect(0,0,W,H);
  const norm = Math.min(1, Math.max(0, snr / 30));
  snrCtx.beginPath();
  snrCtx.arc(cx,cy,r,Math.PI,2*Math.PI);
  snrCtx.strokeStyle = 'rgba(0,200,160,0.08)';
  snrCtx.lineWidth = 10; snrCtx.lineCap = 'round'; snrCtx.stroke();
  const g = snrCtx.createLinearGradient(cx-r,cy,cx+r,cy);
  g.addColorStop(0,'#ff2d2d'); g.addColorStop(0.5,'#ffb700'); g.addColorStop(1,'#00e5a0');
  snrCtx.beginPath();
  snrCtx.arc(cx,cy,r,Math.PI,Math.PI + norm*Math.PI);
  snrCtx.strokeStyle = g; snrCtx.lineWidth = 10; snrCtx.lineCap = 'round'; snrCtx.stroke();
}
drawGauge(0);

// ════════════════════════════════════════════════════════
//  FFT CHART
//  FIX: use actual fft_frequencies as labels (0-25 Hz slice)
//  so the 10 Hz spike appears in the correct position.
// ════════════════════════════════════════════════════════
const fftCtx = $('fft-chart').getContext('2d');
const fftChart = new Chart(fftCtx, {
  type: 'bar',
  data: {
    labels: [],
    datasets: [
      {
        label: 'Magnitude',
        data: [],
        backgroundColor: [],
        borderColor: 'transparent',
        borderWidth: 0,
        barPercentage: 0.95,
        categoryPercentage: 1.0,
      },
      {
        label: 'Floor',
        data: [],
        type: 'line',
        borderColor: 'rgba(80,120,100,0.55)',
        borderWidth: 1,
        borderDash: [3,4],
        pointRadius: 0,
        fill: false,
        tension: 0,
      }
    ]
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
          font: { family: 'Courier New', size: 9 },
          maxTicksLimit: 14,
          maxRotation: 0,
          callback: function(val, idx) {
            return this.getLabelForValue(val) + ' Hz';
          }
        }
      },
      y: {
        min: 0,
        max: 1.5,
        border: { display: false },
        grid: { color: 'rgba(0,200,160,0.06)' },
        ticks: {
          color: '#3a5566',
          font: { family: 'Courier New', size: 9 },
          maxTicksLimit: 5,
          callback: v => v.toFixed(1)
        }
      }
    }
  }
});

// ════════════════════════════════════════════════════════
//  WAVEFORM CHART
//  FIX: push ALL time_domain samples each frame into the
//  rolling buffer so the oscilloscope shows real sine shape.
// ════════════════════════════════════════════════════════
const WAVE_BUF_SIZE = 500;
const waveBuf = new Array(WAVE_BUF_SIZE).fill(0);

const waveCtx = $('wave-chart').getContext('2d');
const waveChart = new Chart(waveCtx, {
  type: 'line',
  data: {
    labels: new Array(WAVE_BUF_SIZE).fill(''),
    datasets: [{
      data: [...waveBuf],
      borderColor: '#00e5a0',
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.2,
      fill: false,
    }]
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
        border: { display: false },
        grid: { color: 'rgba(0,200,160,0.07)' },
        ticks: {
          color: '#3a5566',
          font: { family: 'Courier New', size: 9 },
          maxTicksLimit: 5,
          callback: v => v.toFixed(1)
        }
      }
    }
  }
});

// ── Waterfall ────────────────────────────────────────────
const wfCanvas = $('waterfall-canvas');
const wfCtx    = wfCanvas ? wfCanvas.getContext('2d') : null;

function pushWaterfall(mags) {
  if (!wfCtx || !wfCanvas) return;
  const W = wfCanvas.offsetWidth || 240;
  if (wfCanvas.width !== W) wfCanvas.width = W;
  const H = wfCanvas.height || 160;
  const rowH = Math.max(1, Math.ceil(H / 60));
  const img = wfCtx.getImageData(0, 0, W, H - rowH);
  wfCtx.putImageData(img, 0, rowH);
  const binW = W / mags.length;
  mags.forEach((m, i) => {
    const n = Math.min(1, m / 1.2);
    let r, g, b;
    if (attacking) { r = Math.round(180+n*75); g = Math.round(n*50); b = 0; }
    else           { r = 0; g = Math.round(80+n*175); b = Math.round(60+n*80); }
    wfCtx.fillStyle = `rgb(${r},${g},${b})`;
    wfCtx.fillRect(Math.round(i*binW), 0, Math.ceil(binW)+1, rowH);
  });
}

// ── Hop chips ────────────────────────────────────────────
const HOP_SEQ = [10,14,8,17,11,19,7,13,16,9];
function renderChips(currentFreq) {
  const el = $('hop-chips'); if (!el) return;
  el.innerHTML = HOP_SEQ.map(f =>
    `<span class="hop-chip${(f === currentFreq && hopping) ? ' current' : ''}">${f}Hz</span>`
  ).join('');
}
renderChips(10);

// ════════════════════════════════════════════════════════
//  MAIN UPDATE
// ════════════════════════════════════════════════════════
function update(d) {
  attacking  = !!d.attacking;
  hopping    = !!d.hopping;
  frameCount++;

  // SNR
  const snr = +d.snr_db.toFixed(1);
  const sv  = $('snr-value');
  if (sv) {
    sv.textContent    = snr;
    sv.style.color    = snr < 5 ? '#ff2d2d' : snr < 12 ? '#ffb700' : '#00e5a0';
    sv.style.textShadow = snr < 5 ? '0 0 20px rgba(255,45,45,.5)' : '0 0 18px rgba(0,229,160,.4)';
  }
  drawGauge(snr);
  snrHistory.push(snr);
  if (snrHistory.length > 200) snrHistory.shift();
  const avg = (snrHistory.reduce((a,b)=>a+b,0)/snrHistory.length).toFixed(1);
  const sa = $('stat-avg-snr'); if (sa) sa.textContent = `${avg} dB`;

  // Entropy
  const ent = d.spectral_entropy;
  const ev  = $('entropy-value'); if (ev) ev.textContent = ent.toFixed(3);
  const eb  = $('entropy-bar');
  if (eb) {
    eb.style.width      = `${Math.min(100, ent*150)}%`;
    eb.style.background = ent > 0.65 ? '#ff2d2d' : ent > 0.4 ? '#ffb700' : '#00e5a0';
  }
  if (ent > peakEntropy) {
    peakEntropy = ent;
    const pe = $('stat-peak-ent'); if (pe) pe.textContent = ent.toFixed(3);
  }

  // Threat
  const snrDrop = Math.max(0, 25 - snr);
  const tpct    = Math.min(100, Math.round(snrDrop/25*70 + Math.min(1,ent)*30));
  const tp = $('threat-pct');
  if (tp) { tp.textContent = `${tpct}%`; tp.style.color = tpct>70?'#ff2d2d':tpct>40?'#ffb700':'#00e5a0'; }
  const tf = $('threat-bar-fill'); if (tf) tf.style.width = `${tpct}%`;

  // Freq / mode
  const freq = d.current_frequency;
  const fv   = $('freq-value');  if (fv) fv.textContent = `${freq} Hz`;
  const fs   = $('freq-status'); if (fs) fs.textContent = hopping ? 'HOPPING' : 'LOCKED';
  renderChips(freq);

  const modeStr = attacking ? 'UNDER ATTACK' : hopping ? 'HOPPING' : 'SECURE';
  const bl = $('badge-label'); if (bl) bl.textContent = modeStr;
  const mv = $('mode-value');
  if (mv) { mv.textContent = modeStr; mv.style.color = attacking?'#ff2d2d':hopping?'#00b8ff':'#00e5a0'; }

  // Badge
  const bd = $('sys-badge');
  if (bd) {
    bd.className    = 'sys-badge' + (attacking ? ' attack' : hopping ? ' hop' : '');
    bd.dataset.state = attacking ? 'attack' : hopping ? 'hop' : 'secure';
  }
  document.querySelectorAll('.node-dot').forEach(dot => {
    dot.dataset.state = attacking ? 'critical' : hopping ? 'warning' : 'ok';
  });

  // ══════════════════════════════════════════════════════
  //  FFT — correct frequency-to-bin mapping
  // ══════════════════════════════════════════════════════
  if (d.fft_frequencies && d.fft_magnitudes) {
    const freqs = d.fft_frequencies;
    const mags  = d.fft_magnitudes;

    // Slice to 0–25 Hz
    let cutoff = freqs.length;
    for (let i = 0; i < freqs.length; i++) {
      if (freqs[i] > 25) { cutoff = i; break; }
    }

    const fSlice = freqs.slice(0, cutoff).map(f => Math.round(f * 10) / 10);
    const mSlice = mags.slice(0, cutoff);

    // Noise floor = median of off-signal bins
    const offBins = mSlice.filter((_, i) => Math.abs(fSlice[i] - freq) > 2);
    const sorted  = [...offBins].sort((a,b) => a-b);
    const floor   = sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : 0;

    const peak  = Math.max(...mSlice);
    const peakF = fSlice[mSlice.indexOf(peak)];

    const fpb = $('fft-peak-badge');  if (fpb) fpb.textContent = `PEAK: ${peakF} Hz`;
    const ffb = $('fft-floor-badge'); if (ffb) ffb.textContent = `FLOOR: ${floor.toFixed(3)}`;

    const colors = mSlice.map(v => {
      const n = Math.min(1, v);
      if (attacking) return `rgba(255,${Math.round(45+n*60)},45,${0.45+n*0.55})`;
      if (hopping)   return `rgba(0,${Math.round(150+n*80)},255,${0.45+n*0.55})`;
      return `rgba(0,${Math.round(180+n*49)},${Math.round(120+n*20)},${0.5+n*0.5})`;
    });

    fftChart.data.labels                      = fSlice;
    fftChart.data.datasets[0].data            = mSlice;
    fftChart.data.datasets[0].backgroundColor = colors;
    fftChart.data.datasets[1].data            = new Array(cutoff).fill(floor);
    fftChart.options.scales.y.max             = attacking ? 4.0 : 1.5;
    fftChart.update('none');
    pushWaterfall(mSlice);
  }

  // ══════════════════════════════════════════════════════
  //  WAVEFORM — push full frame into rolling buffer
  // ══════════════════════════════════════════════════════
  if (d.time_domain && d.time_domain.length > 0) {
    for (const s of d.time_domain) {
      waveBuf.push(s);
      if (waveBuf.length > WAVE_BUF_SIZE) waveBuf.shift();
    }
    waveChart.data.datasets[0].data        = [...waveBuf];
    waveChart.data.datasets[0].borderColor = attacking ? '#ff4455' : hopping ? '#00b8ff' : '#00e5a0';
    waveChart.options.scales.y.min         = attacking ? -6   : -1.8;
    waveChart.options.scales.y.max         = attacking ?  6   :  1.8;

    const amp = Math.max(...d.time_domain.map(Math.abs));
    const rms = Math.sqrt(d.time_domain.reduce((s,v)=>s+v*v,0) / d.time_domain.length);
    const wa = $('wave-amp-badge'); if (wa) wa.textContent = `AMP: ${amp.toFixed(3)}`;
    const wr = $('wave-rms-badge'); if (wr) wr.textContent = `RMS: ${rms.toFixed(3)}`;
    waveChart.update('none');
  }

  // Alert overlay
  const al = d.alert;
  if (al) {
    if (al.active && !prevAlertActive) {
      alertCount++;
      const ac = $('stat-alerts'); if (ac) ac.textContent = alertCount;
      log(al.severity || 'CRITICAL', al.message || 'Jamming attack detected');
    }
    if (!al.active && prevAlertActive) log('INFO', 'Signal restored — threat cleared');
    prevAlertActive = !!al.active;
    const ao = $('alert-overlay'); if (ao) ao.style.display = al.active ? 'flex' : 'none';
    document.body.classList.toggle('attacking', !!al.active);
  }

  const sf = $('stat-frames'); if (sf) sf.textContent = frameCount.toLocaleString();
}

// ── API helpers ──────────────────────────────────────────
async function api(path) {
  try { await fetch(BACKEND + path, { method: 'POST' }); }
  catch(e) { log('ERROR', `API call failed: ${path}`); }
}

// ── Controls ─────────────────────────────────────────────
const attackBtn = $('attack-btn');
const defendBtn = $('defend-btn');
const resetBtn  = $('reset-btn');

if (attackBtn) attackBtn.addEventListener('click', async () => {
  if (!attacking) {
    await api('/api/attack/start');
    log('CRITICAL', 'Manual attack simulation initiated');
    const txt = $('attack-btn-text') || attackBtn;
    if (txt) txt.textContent = 'Stop Attack';
    attackBtn.classList.add('active');
    if (defendBtn) defendBtn.disabled = false;
  } else {
    await api('/api/attack/stop');
    log('INFO', 'Attack simulation stopped');
    const txt = $('attack-btn-text') || attackBtn;
    if (txt) txt.textContent = 'Initiate Attack';
    attackBtn.classList.remove('active');
    if (defendBtn) defendBtn.disabled = true;
  }
});

if (defendBtn) defendBtn.addEventListener('click', async () => {
  await api('/api/countermeasure/deploy');
  hopCount++;
  const sh = $('stat-hops'); if (sh) sh.textContent = hopCount;
  log('HOP', 'Frequency hopping countermeasure deployed');
  const txt = $('attack-btn-text') || attackBtn;
  if (txt) txt.textContent = 'Initiate Attack';
  if (attackBtn) attackBtn.classList.remove('active');
  defendBtn.disabled = true;
});

if (resetBtn) resetBtn.addEventListener('click', async () => {
  await api('/api/reset');
  attacking = false; hopping = false;
  frameCount = 0; alertCount = 0; hopCount = 0;
  snrHistory = []; peakEntropy = 0;
  waveBuf.fill(0);
  waveChart.data.datasets[0].data = [...waveBuf];
  waveChart.update('none');
  log('INFO', 'System reset — recalibrating baseline');
  const txt = $('attack-btn-text') || attackBtn;
  if (txt) txt.textContent = 'Initiate Attack';
  if (attackBtn) attackBtn.classList.remove('active');
  if (defendBtn) defendBtn.disabled = true;
  const ao = $('alert-overlay'); if (ao) ao.style.display = 'none';
});

const ns = $('noise-slider');
if (ns) ns.addEventListener('input', e => {
  const nd = $('noise-display'); if (nd) nd.textContent = (+e.target.value).toFixed(1);
});

// ── WebSocket ────────────────────────────────────────────
const socket = io(BACKEND, { transports: ['websocket','polling'], reconnection: true });

socket.on('connect', () => {
  const ws = $('ws-status');
  if (ws) { ws.textContent = '⬤ BACKEND: CONNECTED'; ws.className = 'fi conn'; }
  log('INFO', 'WebSocket connected to Flask-SocketIO backend');
});
socket.on('disconnect', () => {
  const ws = $('ws-status');
  if (ws) { ws.textContent = '⬤ BACKEND: DISCONNECTED'; ws.className = 'fi disc'; }
  log('ERROR', 'WebSocket disconnected');
});
socket.on('connect_error', () => {
  const ws = $('ws-status');
  if (ws) { ws.textContent = '⬤ BACKEND: ERROR'; ws.className = 'fi disc'; }
});
socket.on('signal_data', update);
socket.on('alert', d => { if (d && d.message) log(d.severity || 'INFO', d.message); });

// ── Boot ─────────────────────────────────────────────────
(function boot() {
  drawGauge(0);
  log('INFO', 'SpectraShield RF-IDS initializing…');
  log('INFO', 'FFT engine ready — 0–25 Hz display window');
  log('INFO', 'Awaiting backend WebSocket connection…');
})();