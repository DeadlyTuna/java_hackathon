import eventlet
eventlet.monkey_patch()

from flask import Flask
from flask_socketio import SocketIO, emit
from flask_cors import CORS
from signal_engine import SignalEngine, analyse_frame

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet", logger=False, engineio_logger=False)

engine = SignalEngine()
BROADCAST_HZ = 10

def broadcast_loop():
    while True:
        data = analyse_frame(engine)
        data["mode"] = "ATTACK" if engine.attacking else "HOPPING" if engine.hopping else "NORMAL"
        socketio.emit("signal_data", data)
        eventlet.sleep(1.0 / BROADCAST_HZ)

@socketio.on("connect")
def on_connect():
    print("[SERVER] Client connected")
    emit("alert", {"severity": "INFO", "message": "Backend connected — live signal streaming active"})

@socketio.on("disconnect")
def on_disconnect():
    print("[SERVER] Client disconnected")

@socketio.on("attack_start")
def on_attack_start(data):
    import signal_engine as se
    se.JAM_NOISE_ATK = float(data.get("noise_level", 2.5))
    engine.start_attack()
    emit("alert", {"severity": "CRITICAL", "message": "Jamming attack active"}, broadcast=True)

@socketio.on("attack_stop")
def on_attack_stop():
    engine.stop_attack()
    emit("alert", {"severity": "INFO", "message": "Attack disabled"}, broadcast=True)

@socketio.on("countermeasure_deploy")
def on_countermeasure(data):
    engine.deploy_countermeasure()
    emit("alert", {"severity": "HOP", "message": f"Hopped to {engine.current_frequency} Hz"}, broadcast=True)

@socketio.on("reset_baseline")
def on_reset():
    engine.stop_attack()
    engine.hopping = False
    engine.hop_index = 0
    engine.t = 0.0
    emit("alert", {"severity": "INFO", "message": "Baseline reset"}, broadcast=True)

@socketio.on("set_noise_level")
def on_set_noise(data):
    import signal_engine as se
    se.JAM_NOISE_ATK = float(data.get("level", 2.5))

if __name__ == "__main__":
    print("=" * 55)
    print("  SPECTRASHIELD — Flask-SocketIO Server")
    print("=" * 55)
    print("  Listening on  http://localhost:5000")
    print("  Press Ctrl+C  to stop")
    print("=" * 55)
    socketio.start_background_task(broadcast_loop)
    socketio.run(app, host="0.0.0.0", port=5000, debug=False)