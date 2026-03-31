import numpy as np
from scipy.fft import fft, fftfreq

# ─────────────────────────────────────────
#  CONFIGURATION
# ─────────────────────────────────────────

SAMPLE_RATE    = 1000       # Hz  — gives clean FFT bins at every integer Hz
FRAME_DURATION = 0.5        # seconds per frame
FRAME_SIZE     = int(SAMPLE_RATE * FRAME_DURATION)   # 500 samples

BASE_FREQUENCY = 10.0       # Hz — the IoT signal frequency
SIGNAL_AMP     = 1.0        # amplitude (keep at 1.0 for sensible SNR)

JAM_NOISE_STD  = 0.05       # background noise  (clean state)
JAM_NOISE_ATK  = 2.0        # jamming noise     (attack state)

HOP_SEQUENCE   = [10, 14, 8, 17, 11, 19, 13, 7, 16, 12]


# ─────────────────────────────────────────
#  SIGNAL ENGINE
# ─────────────────────────────────────────

class SignalEngine:
    def __init__(self):
        self.t           = 0.0
        self.phase       = 0.0
        self.attacking   = False
        self.hopping     = False
        self.hop_index   = 0
        self.frame_count = 0

    @property
    def current_frequency(self):
        if self.hopping:
            return HOP_SEQUENCE[self.hop_index % len(HOP_SEQUENCE)]
        return BASE_FREQUENCY

    def generate_frame(self):
        # time axis always starts from 0 — phase continuity handled via self.phase
        t_axis = np.arange(FRAME_SIZE) / SAMPLE_RATE
        freq   = self.current_frequency

        # ── clean sine wave ───────────────────────────────
        clean = SIGNAL_AMP * np.sin(2 * np.pi * freq * t_axis + self.phase)

        # ── noise / jamming ───────────────────────────────
        if self.attacking:
            # wideband gaussian noise — the jammer
            noise = np.random.normal(0, JAM_NOISE_ATK, FRAME_SIZE)
        else:
            # small background noise only
            noise = np.random.normal(0, JAM_NOISE_STD, FRAME_SIZE)

        composite = clean + noise

        # advance phase so next frame continues the sine wave smoothly
        self.phase += 2 * np.pi * freq * (FRAME_SIZE / SAMPLE_RATE)
        self.phase %= (2 * np.pi)

        self.t           += FRAME_DURATION
        self.frame_count += 1
        if self.hopping:
            self.hop_index += 1

        return composite.tolist(), clean.tolist(), noise.tolist()

    def start_attack(self):
        self.attacking = True
        self.hopping   = False

    def stop_attack(self):
        self.attacking = False

    def deploy_countermeasure(self):
        self.attacking  = False
        self.hopping    = True
        self.hop_index += 1


# ─────────────────────────────────────────
#  FFT  — one-sided magnitude spectrum
# ─────────────────────────────────────────

def compute_fft(signal, sample_rate=SAMPLE_RATE):
    N          = len(signal)
    raw        = fft(np.array(signal))
    magnitudes = (2.0 / N) * np.abs(raw[:N // 2])
    freqs      = fftfreq(N, d=1.0 / sample_rate)[:N // 2]
    return freqs.tolist(), magnitudes.tolist()


# ─────────────────────────────────────────
#  SNR
# ─────────────────────────────────────────

def compute_snr(signal, noise):
    p_signal = float(np.mean(np.square(signal)))
    p_noise  = float(np.mean(np.square(noise)))
    if p_noise < 1e-12:
        return 99.0
    return round(10 * np.log10(p_signal / p_noise), 2)


# ─────────────────────────────────────────
#  SPECTRAL ENTROPY
# ─────────────────────────────────────────

def compute_spectral_entropy(magnitudes):
    mags  = np.array(magnitudes, dtype=float)
    total = mags.sum()
    if total < 1e-12:
        return 0.0
    p = mags / total
    p = p[p > 0]
    H = -np.sum(p * np.log(p))
    return round(float(H / np.log(len(magnitudes))), 4)


# ─────────────────────────────────────────
#  CONVENIENCE WRAPPER — called by server.py
# ─────────────────────────────────────────

def analyse_frame(engine: SignalEngine):
    composite, clean, noise = engine.generate_frame()
    freqs, magnitudes       = compute_fft(composite)
    snr                     = compute_snr(clean, noise)
    entropy                 = compute_spectral_entropy(magnitudes)

    return {
        "time_domain"      : composite,
        "fft_frequencies"  : freqs,
        "fft_magnitudes"   : magnitudes,
        "snr_db"           : snr,
        "spectral_entropy" : entropy,
        "current_frequency": engine.current_frequency,
        "attacking"        : engine.attacking,
        "hopping"          : engine.hopping,
        "frame_index"      : engine.frame_count,
    }


# ─────────────────────────────────────────
#  SELF TEST  (python signal_engine.py)
# ─────────────────────────────────────────

if __name__ == "__main__":
    eng = SignalEngine()
    print("Clean frames:")
    for _ in range(3):
        d = analyse_frame(eng)
        print(f"  SNR={d['snr_db']:6.2f} dB  entropy={d['spectral_entropy']:.4f}  freq={d['current_frequency']} Hz")

    eng.start_attack()
    print("Attack frames:")
    for _ in range(3):
        d = analyse_frame(eng)
        print(f"  SNR={d['snr_db']:6.2f} dB  entropy={d['spectral_entropy']:.4f}  freq={d['current_frequency']} Hz")

    eng.deploy_countermeasure()
    print("Hopping frames:")
    for _ in range(3):
        d = analyse_frame(eng)
        print(f"  SNR={d['snr_db']:6.2f} dB  entropy={d['spectral_entropy']:.4f}  freq={d['current_frequency']} Hz")