import eventlet
eventlet.monkey_patch()

from flask import Flask, send_from_directory
from flask_socketio import SocketIO, emit
from flask_cors import CORS
from signal_engine import SignalEngine, analyse_frame
import os

# ─────────────────────────────────────────
#  APP SETUP
# ─────────────────────────────────────────

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode="eventlet",
    logger=False,
    engineio_logger=False,
)

engine       = SignalEngine()
BROADCAST_HZ = 8   # 8 frames per second — smooth but not heavy

# ─────────────────────────────────────────
#  FRONTEND SERVING
# ─────────────────────────────────────────

BASE_DIR     = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(BASE_DIR, '..', 'frontend')

@app.route('/')
def index():
    return send_from_directory(FRONTEND_DIR, 'index.html')

@app.route('/<path:filename>')
def static_files(filename):
    return send_from_directory(FRONTEND_DIR, filename)


# ─────────────────────────────────────────
#  BACKGROUND STREAMING LOOP
# ─────────────────────────────────────────

def broadcast_loop():
    while True:
        data = analyse_frame(engine)

        if engine.frame_count % 30 == 0:
            print(
                f"[{engine.frame_count:05d}] "
                f"SNR={data['snr_db']:6.1f} dB  "
                f"Entropy={data['spectral_entropy']:.3f}  "
                f"Freq={data['current_frequency']} Hz  "
                f"Attack={engine.attacking}"
            )

        data["mode"] = (
            "ATTACK"  if engine.attacking else
            "HOPPING" if engine.hopping   else
            "NORMAL"
        )

        # include alert block so dashboard.js handleAlert() works
        data["alert"] = {
            "active"  : engine.attacking,
            "severity": "CRITICAL" if engine.attacking else None,
            "message" : "Jamming attack detected" if engine.attacking else None,
        }

        socketio.emit("signal_data", data)
        eventlet.sleep(1.0 / BROADCAST_HZ)


# ─────────────────────────────────────────
#  SOCKET EVENTS
# ─────────────────────────────────────────

@socketio.on("connect")
def on_connect():
    print("[WS] Client connected")
    emit("alert", {"severity": "INFO", "message": "Backend connected — live signal streaming active"})


@socketio.on("disconnect")
def on_disconnect():
    print("[WS] Client disconnected")


@socketio.on("attack_start")
def on_attack_start(data):
    engine.start_attack()
    print("[WS] Attack started")
    emit("alert", {"severity": "CRITICAL", "message": "Jamming attack initiated"}, broadcast=True)


@socketio.on("attack_stop")
def on_attack_stop():
    engine.stop_attack()
    print("[WS] Attack stopped")
    emit("alert", {"severity": "INFO", "message": "Attack disabled — signal restored"}, broadcast=True)


@socketio.on("countermeasure_deploy")
def on_countermeasure(data):
    engine.deploy_countermeasure()
    print(f"[WS] Countermeasure deployed — hopped to {engine.current_frequency} Hz")
    emit("alert", {"severity": "HOP", "message": f"Frequency hopped to {engine.current_frequency} Hz"}, broadcast=True)


@socketio.on("reset_baseline")
def on_reset():
    engine.stop_attack()
    engine.hopping   = False
    engine.hop_index = 0
    engine.t         = 0.0
    engine.phase     = 0.0
    print("[WS] System reset")
    emit("alert", {"severity": "INFO", "message": "Baseline reset — recalibrating"}, broadcast=True)


@socketio.on("set_noise_level")
def on_set_noise(data):
    import signal_engine as se
    try:
        se.JAM_NOISE_ATK = float(data.get("level", 2.0))
        print(f"[WS] Noise level set to {se.JAM_NOISE_ATK}")
    except Exception as e:
        print(f"[WS] set_noise_level error: {e}")


# ─────────────────────────────────────────
#  REST ENDPOINTS (for dashboard buttons via fetch)
# ─────────────────────────────────────────

from flask import jsonify

@app.route("/api/attack/start", methods=["POST"])
def api_attack_start():
    engine.start_attack()
    return jsonify({"status": "ok", "mode": "ATTACKING"})

@app.route("/api/attack/stop", methods=["POST"])
def api_attack_stop():
    engine.stop_attack()
    return jsonify({"status": "ok", "mode": "SECURE"})

@app.route("/api/countermeasure/deploy", methods=["POST"])
def api_countermeasure():
    engine.deploy_countermeasure()
    return jsonify({"status": "ok", "mode": "HOPPING"})

@app.route("/api/reset", methods=["POST"])
def api_reset():
    engine.stop_attack()
    engine.hopping   = False
    engine.hop_index = 0
    engine.t         = 0.0
    engine.phase     = 0.0
    return jsonify({"status": "ok", "mode": "RESET"})


# ─────────────────────────────────────────
#  ENTRY POINT
# ─────────────────────────────────────────

if __name__ == "__main__":
    print()
    print("╔══════════════════════════════════════════╗")
    print("║       SPECTRASHIELD  SERVER              ║")
    print(f"║  Frontend : {os.path.abspath(FRONTEND_DIR)[:30]}")
    print("║  URL      : http://localhost:5000        ║")
    print("║  Stream   : 8 fps                        ║")
    print("╚══════════════════════════════════════════╝")
    print()

    socketio.start_background_task(broadcast_loop)
    socketio.run(app, host="0.0.0.0", port=5000, debug=False)