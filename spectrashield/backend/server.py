import numpy as np
from scipy.fft import fft, fftfreq

# ─────────────────────────────────────────
#  CONFIGURATION
# ─────────────────────────────────────────

SAMPLE_RATE    = 1000
FRAME_DURATION = 0.1
FRAME_SIZE     = int(SAMPLE_RATE * FRAME_DURATION)  # 100 samples

BASE_FREQUENCY = 10.0
SIGNAL_AMP     = 1.0

JAM_NOISE_STD  = 0.05   # background noise (clean)
JAM_NOISE_ATK  = 2.5    # noise during attack

HOP_SEQUENCE   = [10, 14, 8, 17, 11, 19, 13, 7, 16, 12]


# ─────────────────────────────────────────
#  SIGNAL ENGINE
# ─────────────────────────────────────────

class SignalEngine:
    def __init__(self):
        self.t           = 0.0
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
        t_axis = np.linspace(self.t, self.t + FRAME_DURATION, FRAME_SIZE, endpoint=False)
        clean  = SIGNAL_AMP * np.sin(2 * np.pi * self.current_frequency * t_axis)

        noise_std = JAM_NOISE_ATK if self.attacking else JAM_NOISE_STD
        noise     = np.random.normal(0, noise_std, FRAME_SIZE)

        self.t           += FRAME_DURATION
        self.frame_count += 1

        if self.hopping:
            self.hop_index += 1

        return clean + noise, clean, noise

    def start_attack(self):
        self.attacking = True
        self.hopping   = False

    def stop_attack(self):
        self.attacking = False

    def deploy_countermeasure(self):
        self.attacking = False
        self.hopping   = True
        self.hop_index += 1


# ─────────────────────────────────────────
#  FFT ANALYSIS
# ─────────────────────────────────────────

def compute_fft(signal, sample_rate=SAMPLE_RATE):
    N          = len(signal)
    raw_fft    = fft(signal)
    magnitudes = (2.0 / N) * np.abs(raw_fft[:N // 2])
    freqs      = fftfreq(N, d=1.0 / sample_rate)[:N // 2]
    return freqs.tolist(), magnitudes.tolist()


# ─────────────────────────────────────────
#  SNR
# ─────────────────────────────────────────

def compute_snr(signal, noise):
    p_signal = np.mean(signal ** 2)
    p_noise  = np.mean(noise  ** 2)
    if p_noise < 1e-12:
        return 99.0
    return round(float(10 * np.log10(p_signal / p_noise)), 2)


# ─────────────────────────────────────────
#  SPECTRAL ENTROPY
# ─────────────────────────────────────────

def compute_spectral_entropy(magnitudes):
    mags  = np.array(magnitudes)
    total = mags.sum()
    if total < 1e-12:
        return 0.0
    p     = mags / total
    p     = p[p > 0]
    H     = -np.sum(p * np.log(p))
    H_max = np.log(len(magnitudes))
    return round(float(H / H_max), 4) if H_max > 0 else 0.0


# ─────────────────────────────────────────
#  FULL FRAME ANALYSIS  (called by server.py)
# ─────────────────────────────────────────

def analyse_frame(engine: SignalEngine):
    composite, clean, noise = engine.generate_frame()
    freqs, magnitudes       = compute_fft(composite)
    snr                     = compute_snr(clean, noise)
    entropy                 = compute_spectral_entropy(magnitudes)

    return {
        "time_domain"       : composite.tolist(),
        "fft_frequencies"   : freqs,
        "fft_magnitudes"    : magnitudes,
        "snr_db"            : snr,
        "spectral_entropy"  : entropy,
        "current_frequency" : engine.current_frequency,
        "attacking"         : engine.attacking,
        "hopping"           : engine.hopping,
        "frame_index"       : engine.frame_count,
    }


# ─────────────────────────────────────────
#  STANDALONE TEST
# ─────────────────────────────────────────

if __name__ == "__main__":
    engine = SignalEngine()
    print("=" * 55)
    print("  SPECTRASHIELD — Signal Engine Self-Test")
    print("=" * 55)

    print("\n[PHASE 1] Clean signal (3 frames)")
    for i in range(3):
        d = analyse_frame(engine)
        print(f"  Frame {i+1} | freq={d['current_frequency']} Hz | SNR={d['snr_db']:>7.2f} dB | Entropy={d['spectral_entropy']:.4f}")

    print("\n[PHASE 2] Jamming attack (3 frames)")
    engine.start_attack()
    for i in range(3):
        d = analyse_frame(engine)
        print(f"  Frame {i+1} | freq={d['current_frequency']} Hz | SNR={d['snr_db']:>7.2f} dB | Entropy={d['spectral_entropy']:.4f}  ATTACKING")

    print("\n[PHASE 3] Countermeasure — frequency hopping (3 frames)")
    engine.deploy_countermeasure()
    for i in range(3):
        d = analyse_frame(engine)
        print(f"  Frame {i+1} | freq={d['current_frequency']} Hz | SNR={d['snr_db']:>7.2f} dB | Entropy={d['spectral_entropy']:.4f}  HOPPING")

    print("\n✓ Signal engine working correctly.\n")
