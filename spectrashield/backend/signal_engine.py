import numpy as np
from scipy.fft import fft, fftfreq
from scipy.signal import welch
import time

# ─────────────────────────────────────────
#  CONFIGURATION
# ─────────────────────────────────────────

SAMPLE_RATE     = 1000      # samples per second (Hz)
FRAME_DURATION  = 0.1       # seconds per frame (100ms)
FRAME_SIZE      = int(SAMPLE_RATE * FRAME_DURATION)  # 100 samples per frame

# Clean signal parameters
BASE_FREQUENCY  = 10.0      # Hz  (represents e.g. 915 MHz IoT band)
SIGNAL_AMP      = 1.0       # amplitude of clean signal

# Jamming parameters
JAM_NOISE_STD   = 0.05      # noise std dev when NOT jamming (background noise)
JAM_NOISE_ATK   = 2.5       # noise std dev when jamming (attack noise)

# Frequency hopping sequence (Hz) — used during countermeasure
HOP_SEQUENCE    = [10, 14, 8, 17, 11, 19, 13, 7, 16, 12]


# ─────────────────────────────────────────
#  SIGNAL GENERATOR
# ─────────────────────────────────────────

class SignalEngine:
    def __init__(self):
        self.t          = 0.0           # running time counter
        self.attacking  = False         # is jamming active?
        self.hopping    = False         # is frequency hopping active?
        self.hop_index  = 0             # current position in hop sequence
        self.frame_count = 0

    # ── current active frequency ──────────────────────────────────────────────
    @property
    def current_frequency(self):
        if self.hopping:
            return HOP_SEQUENCE[self.hop_index % len(HOP_SEQUENCE)]
        return BASE_FREQUENCY

    # ── generate one frame of time-domain samples ─────────────────────────────
    def generate_frame(self):
        """
        Returns a numpy array of FRAME_SIZE samples representing
        the current signal (clean or jammed).
        """
        # time axis for this frame
        t_axis = np.linspace(
            self.t,
            self.t + FRAME_DURATION,
            FRAME_SIZE,
            endpoint=False
        )

        # clean sine wave at current frequency
        clean = SIGNAL_AMP * np.sin(2 * np.pi * self.current_frequency * t_axis)

        # noise level depends on attack state
        noise_std = JAM_NOISE_ATK if self.attacking else JAM_NOISE_STD
        noise     = np.random.normal(0, noise_std, FRAME_SIZE)

        # advance time
        self.t          += FRAME_DURATION
        self.frame_count += 1

        # advance hop index every frame when hopping
        if self.hopping:
            self.hop_index += 1

        return clean + noise, clean, noise

    # ── start / stop attack ───────────────────────────────────────────────────
    def start_attack(self):
        self.attacking = True
        self.hopping   = False          # stop hopping if it was on

    def stop_attack(self):
        self.attacking = False

    # ── deploy frequency hopping countermeasure ───────────────────────────────
    def deploy_countermeasure(self):
        self.attacking = False          # stop attack effect
        self.hopping   = True
        self.hop_index += 1             # immediately jump to next channel


# ─────────────────────────────────────────
#  FFT ANALYSIS
# ─────────────────────────────────────────

def compute_fft(signal, sample_rate=SAMPLE_RATE):
    """
    Compute the one-sided FFT magnitude spectrum of a signal frame.

    Returns:
        freqs      : frequency axis (Hz), positive side only
        magnitudes : magnitude at each frequency bin (absolute value)
    """
    N         = len(signal)
    raw_fft   = fft(signal)

    # one-sided spectrum: take first N//2 bins, double magnitude (except DC)
    magnitudes = (2.0 / N) * np.abs(raw_fft[:N // 2])
    freqs      = fftfreq(N, d=1.0 / sample_rate)[:N // 2]

    return freqs.tolist(), magnitudes.tolist()


# ─────────────────────────────────────────
#  SNR CALCULATION
# ─────────────────────────────────────────

def compute_snr(signal, noise, sample_rate=SAMPLE_RATE):
    """
    Signal-to-Noise Ratio in decibels.

        SNR (dB) = 10 * log10(P_signal / P_noise)

    P = mean squared amplitude (power)

    A healthy signal reads ~20–25 dB.
    Below ~10 dB the signal is degrading.
    Near 0 dB or negative → communication failure.
    """
    p_signal = np.mean(signal ** 2)
    p_noise  = np.mean(noise  ** 2)

    # avoid log(0)
    if p_noise < 1e-12:
        return 99.0   # essentially infinite SNR (perfect silence)

    snr_db = 10 * np.log10(p_signal / p_noise)
    return round(float(snr_db), 2)


# ─────────────────────────────────────────
#  SPECTRAL ENTROPY
# ─────────────────────────────────────────

def compute_spectral_entropy(magnitudes):
    """
    Shannon entropy of the FFT magnitude spectrum.

        H = -Σ p[k] * log(p[k])

    Treats the normalised magnitude spectrum as a probability distribution.

    Low  entropy (~0.0–0.3) → energy concentrated at one frequency (clean)
    High entropy (~0.7–1.0) → energy spread everywhere       (jammed)
    """
    mags = np.array(magnitudes)
    total = mags.sum()

    if total < 1e-12:
        return 0.0

    p = mags / total                        # normalise → probability distribution
    p = p[p > 0]                            # avoid log(0)

    # normalise by log(N) so entropy is in [0, 1]
    H = -np.sum(p * np.log(p))
    H_max = np.log(len(magnitudes))

    return round(float(H / H_max), 4) if H_max > 0 else 0.0


# ─────────────────────────────────────────
#  CONVENIENCE: FULL FRAME ANALYSIS
# ─────────────────────────────────────────

def analyse_frame(engine: SignalEngine):
    """
    Generate one frame and return all computed metrics as a dict.
    This is what server.py will call every 100 ms.
    """
    composite, clean, noise = engine.generate_frame()

    freqs, magnitudes = compute_fft(composite)
    snr               = compute_snr(clean, noise)
    entropy           = compute_spectral_entropy(magnitudes)

    return {
        "time_domain"      : composite.tolist(),
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
#  STANDALONE TEST  (run: python signal_engine.py)
# ─────────────────────────────────────────

if __name__ == "__main__":
    engine = SignalEngine()

    print("=" * 55)
    print("  SPECTRASHIELD — Signal Engine Self-Test")
    print("=" * 55)

    # ── 3 frames of clean signal ──────────────────────────────
    print("\n[PHASE 1] Clean signal (3 frames)")
    for i in range(3):
        data = analyse_frame(engine)
        print(f"  Frame {i+1:02d} | freq={data['current_frequency']} Hz "
              f"| SNR={data['snr_db']:>7.2f} dB "
              f"| Entropy={data['spectral_entropy']:.4f}")

    # ── inject attack ─────────────────────────────────────────
    print("\n[PHASE 2] Jamming attack (3 frames)")
    engine.start_attack()
    for i in range(3):
        data = analyse_frame(engine)
        print(f"  Frame {i+1:02d} | freq={data['current_frequency']} Hz "
              f"| SNR={data['snr_db']:>7.2f} dB "
              f"| Entropy={data['spectral_entropy']:.4f}  ⚠ ATTACKING")

    # ── deploy countermeasure ─────────────────────────────────
    print("\n[PHASE 3] Countermeasure — frequency hopping (3 frames)")
    engine.deploy_countermeasure()
    for i in range(3):
        data = analyse_frame(engine)
        print(f"  Frame {i+1:02d} | freq={data['current_frequency']} Hz "
              f"| SNR={data['snr_db']:>7.2f} dB "
              f"| Entropy={data['spectral_entropy']:.4f}  ↺ HOPPING")

    print("\n✓ Signal engine working correctly.\n")
