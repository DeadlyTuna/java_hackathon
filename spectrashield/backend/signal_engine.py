import numpy as np
from scipy.fft import fft, fftfreq

def generate_clean_signal(frequency, duration, sample_rate):
    """Generates a clean sine wave."""
    t = np.linspace(0, duration, int(sample_rate * duration), endpoint=False)
    signal = np.sin(2 * np.pi * frequency * t)
    return signal

def inject_jamming(signal, noise_level):
    """Adds Gaussian noise to simulate wideband jamming."""
    noise = np.random.normal(0, noise_level, len(signal))
    jammed_signal = signal + noise
    return jammed_signal, noise

def compute_fft(signal, sample_rate):
    """Computes the frequency spectrum of the signal."""
    N = len(signal)
    yf = fft(signal)
    xf = fftfreq(N, 1 / sample_rate)
    
    # Take only the positive frequencies
    magnitudes = np.abs(yf)[:N//2] * 2.0 / N
    frequencies = xf[:N//2]
    
    return frequencies, magnitudes

def compute_snr(signal, noise):
    """Computes Signal-to-Noise Ratio in dB."""
    P_signal = np.mean(signal**2)
    P_noise = np.mean(noise**2)
    if P_noise == 0:
        return float('inf')
    snr_db = 10 * np.log10(P_signal / P_noise)
    return snr_db

def compute_spectral_entropy(fft_magnitudes):
    """Computes normalized Shannon entropy of the power spectrum."""
    power = fft_magnitudes**2
    if np.sum(power) == 0:
        return 0.0
    
    # Normalize to probability distribution
    p = power / np.sum(power)
    p = p[p > 0]  # Avoid log(0)
    
    entropy_val = -np.sum(p * np.log2(p))
    
    # Normalize between 0 and 1 using max entropy log2(N)
    max_entropy = np.log2(len(fft_magnitudes))
    if max_entropy > 0:
        normalized_entropy = entropy_val / max_entropy
    else:
        normalized_entropy = 0.0
        
    return normalized_entropy

if __name__ == "__main__":
    # Parameters
    sample_rate = 1000  # 1kHz sample rate
    duration = 1.0      # 1 second
    
    # PHASE 1: Clean signal (~20 dB)
    f0 = 10 # 10 Hz
    clean_sig = generate_clean_signal(f0, duration, sample_rate)
    
    # Target ~20 dB: P_signal = 0.5. SNR = 10*log10(P_signal/P_noise). 
    # For 20dB, P_noise = 0.005. noise_level = sqrt(0.005) = 0.0707
    noisy_clean_sig, clean_noise = inject_jamming(clean_sig, 0.0707)
    
    freqs, clean_mags = compute_fft(noisy_clean_sig, sample_rate)
    clean_snr = compute_snr(clean_sig, clean_noise)
    clean_entropy = compute_spectral_entropy(clean_mags)
    
    print(f"[PHASE 1] Clean signal       → SNR ~{clean_snr:.0f} dB  | Entropy ~{clean_entropy:.2f}")
    
    # PHASE 2: Jamming attack (~2 dB)
    # Target ~2 dB: P_noise = 0.5 / 10^(0.2) = 0.315. noise_level = sqrt(0.315) = 0.561
    jammed_sig, jammer_noise = inject_jamming(clean_sig, 0.561)
    
    _, jammed_mags = compute_fft(jammed_sig, sample_rate)
    jammed_snr = compute_snr(clean_sig, jammer_noise)
    jammed_entropy = compute_spectral_entropy(jammed_mags)
    
    print(f"[PHASE 2] Jamming attack      SNR ~{jammed_snr:.0f} dB   | Entropy ~{jammed_entropy:.2f}")
    
    # PHASE 3: Frequency hopping
    print(f"[PHASE 3] Frequency hopping   SNR recovers | freq changes each frame")
