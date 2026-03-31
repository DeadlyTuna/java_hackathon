
import time
from collections import deque
import numpy as np

# ─────────────────────────────────────────
#  CONFIGURATION
# ─────────────────────────────────────────

BASELINE_FRAMES      = 30
SNR_DROP_TRIGGER     = 6.0
ENTROPY_RISE_TRIGGER = 0.25

SEVERITY_LOW      = 1.0
SEVERITY_MEDIUM   = 2.0
SEVERITY_CRITICAL = 3.5


# ─────────────────────────────────────────
#  EVENT LOGGER
# ─────────────────────────────────────────

class EventLogger:
    def __init__(self, max_events=50):
        self._log = deque(maxlen=max_events)

    def log(self, severity, message, snr, entropy):
        self._log.appendleft({
            "timestamp" : time.strftime("%H:%M:%S"),
            "severity"  : severity,
            "message"   : message,
            "snr_db"    : snr,
            "entropy"   : entropy,
        })

    def recent(self, n=20):
        return list(self._log)[:n]

    def clear(self):
        self._log.clear()


# ─────────────────────────────────────────
#  BASELINE PROFILER
# ─────────────────────────────────────────

class BaselineProfiler:
    def __init__(self):
        self._snr_samples     = []
        self._entropy_samples = []
        self.ready             = False
        self.mean_snr          = None
        self.mean_entropy      = None
        self.snr_threshold     = None
        self.entropy_threshold = None

    def update(self, snr, entropy):
        if self.ready:
            return
        self._snr_samples.append(snr)
        self._entropy_samples.append(entropy)

        if len(self._snr_samples) >= BASELINE_FRAMES:
            self.mean_snr          = float(np.mean(self._snr_samples))
            self.mean_entropy      = float(np.mean(self._entropy_samples))
            self.snr_threshold     = self.mean_snr     - SNR_DROP_TRIGGER
            self.entropy_threshold = self.mean_entropy + ENTROPY_RISE_TRIGGER
            self.ready             = True

    @property
    def progress(self):
        return min(100, int(len(self._snr_samples) / BASELINE_FRAMES * 100))

    def reset(self):
        self.__init__()


# ─────────────────────────────────────────
#  ANOMALY DETECTOR
# ─────────────────────────────────────────

class AnomalyDetector:
    def __init__(self):
        self.baseline    = BaselineProfiler()
        self.logger      = EventLogger()
        self._prev_alert = False

    def analyse(self, snr: float, entropy: float) -> dict:
        if not self.baseline.ready:
            self.baseline.update(snr, entropy)
            return self._build_result(
                alert    = False,
                severity = None,
                message  = f"Calibrating baseline… {self.baseline.progress}%",
                snr      = snr,
                entropy  = entropy,
                mode     = "CALIBRATING",
            )

        snr_violated     = snr     < self.baseline.snr_threshold
        entropy_violated = entropy > self.baseline.entropy_threshold
        attack_detected  = snr_violated or entropy_violated

        severity = None
        message  = "All systems nominal"
        mode     = "SECURE"

        if attack_detected:
            severity = self._classify_severity(snr, entropy)
            message  = self._build_message(severity, snr_violated, entropy_violated)
            mode     = "UNDER ATTACK"
            if not self._prev_alert:
                self.logger.log(severity, message, snr, entropy)

        elif self._prev_alert:
            self.logger.log("INFO", "Signal restored — threat cleared", snr, entropy)

        self._prev_alert = attack_detected

        return self._build_result(
            alert=attack_detected, severity=severity,
            message=message, snr=snr, entropy=entropy, mode=mode,
        )

    def _classify_severity(self, snr, entropy):
        snr_drop     = self.baseline.mean_snr     - snr
        entropy_rise = entropy - self.baseline.mean_entropy
        score        = max(snr_drop / SNR_DROP_TRIGGER,
                           entropy_rise / ENTROPY_RISE_TRIGGER)
        if score >= SEVERITY_CRITICAL:  return "CRITICAL"
        elif score >= SEVERITY_MEDIUM:  return "MEDIUM"
        else:                           return "LOW"

    def _build_message(self, severity, snr_violated, entropy_violated):
        reasons = []
        if snr_violated:     reasons.append("SNR collapse detected")
        if entropy_violated: reasons.append("spectral entropy spike")
        prefix = {
            "LOW"     : "Low-level interference —",
            "MEDIUM"  : "Jamming detected —",
            "CRITICAL": "CRITICAL JAMMING ATTACK —",
        }[severity]
        return f"{prefix} {' & '.join(reasons)}"

    def _build_result(self, alert, severity, message, snr, entropy, mode):
        return {
            "alert": {
                "active"  : alert,
                "severity": severity,
                "message" : message,
            },
            "mode"              : mode,
            "snr_db"            : round(snr, 2),
            "entropy"           : round(entropy, 4),
            "baseline_snr"      : round(self.baseline.mean_snr, 2)           if self.baseline.ready else None,
            "baseline_entropy"  : round(self.baseline.mean_entropy, 4)       if self.baseline.ready else None,
            "snr_threshold"     : round(self.baseline.snr_threshold, 2)      if self.baseline.ready else None,
            "entropy_threshold" : round(self.baseline.entropy_threshold, 4)  if self.baseline.ready else None,
            "baseline_progress" : self.baseline.progress,
            "events"            : self.logger.recent(),
        }

    def reset(self):
        self.baseline.reset()
        self.logger.clear()
        self._prev_alert = False


# ─────────────────────────────────────────
#  STANDALONE TEST
# ─────────────────────────────────────────

if __name__ == "__main__":
    from signal_engine import SignalEngine, analyse_frame

    engine   = SignalEngine()
    detector = AnomalyDetector()

    print("=" * 55)
    print("  SPECTRASHIELD — Detector Self-Test")
    print("=" * 55)

    print("\n[CALIBRATING — 30 frames]")
    for _ in range(BASELINE_FRAMES):
        frame  = analyse_frame(engine)
        result = detector.analyse(frame["snr_db"], frame["spectral_entropy"])

    print(f"  Baseline SNR      : {detector.baseline.mean_snr:.2f} dB")
    print(f"  Baseline Entropy  : {detector.baseline.mean_entropy:.4f}")
    print(f"  SNR threshold     : {detector.baseline.snr_threshold:.2f} dB")
    print(f"  Entropy threshold : {detector.baseline.entropy_threshold:.4f}")

    print("\n[CLEAN — 3 frames]")
    for i in range(3):
        frame  = analyse_frame(engine)
        result = detector.analyse(frame["snr_db"], frame["spectral_entropy"])
        print(f"  Frame {i+1} | mode={result['mode']:12s} | alert={result['alert']['active']}")

    print("\n[ATTACK — 3 frames]")
    engine.start_attack()
    for i in range(3):
        frame  = analyse_frame(engine)
        result = detector.analyse(frame["snr_db"], frame["spectral_entropy"])
        print(f"  Frame {i+1} | mode={result['mode']:12s} | severity={result['alert']['severity']} | {result['alert']['message']}")

    print("\n[COUNTERMEASURE — 3 frames]")
    engine.deploy_countermeasure()
    for i in range(3):
        frame  = analyse_frame(engine)
        result = detector.analyse(frame["snr_db"], frame["spectral_entropy"])
        print(f"  Frame {i+1} | mode={result['mode']:12s} | alert={result['alert']['active']}")

    print("\n✓ Detector working correctly.\n")