import json
import os
import tempfile
from pathlib import Path

from flask import Flask, render_template, send_from_directory, request, jsonify, Response

from cv_topology import detect_walls_and_shelves
from dronecontroller import (
    start_mission, land_manual, is_mission_active, is_available,
    get_current_waypoint_index, get_current_node_index,
    get_qr_results, set_qr_save_path, get_camera_frame_jpeg, get_camera_frame_with_qr,
)

app = Flask(__name__, template_folder='templates', static_folder='static')

DATA_DIR = Path(__file__).resolve().parent / 'data'
GRAPH_PATH = DATA_DIR / 'graph.json'
ROBOTS_PATH = DATA_DIR / 'robots.json'
NODES_QR_PATH = DATA_DIR / 'nodes_qr.json'

DATA_DIR.mkdir(parents=True, exist_ok=True)
set_qr_save_path(NODES_QR_PATH)

_DEFAULT_ROBOTS = [
    {"id": 1, "name": "Робот 1", "status": "В сети", "model": "Pioneer-1"},
    {"id": 2, "name": "Робот 2", "status": "Занят", "model": "Pioneer-1"},
    {"id": 3, "name": "Робот 3", "status": "В сети", "model": "Pioneer-2"},
]


def _load_robots():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not ROBOTS_PATH.exists():
        return _DEFAULT_ROBOTS
    try:
        with open(ROBOTS_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, list) else _DEFAULT_ROBOTS
    except Exception:
        return _DEFAULT_ROBOTS


@app.route('/')
def index():
    return render_template('index.html', robots=_load_robots())


@app.route('/new-task')
def new_task():
    return render_template('newtask.html')


@app.route('/api/analyze-topology', methods=['POST'])
def api_analyze_topology():
    if 'image' not in request.files:
        return jsonify({'error': 'Нет файла image'}), 400
    f = request.files['image']
    if not f.filename or not f.content_type.startswith('image/'):
        return jsonify({'error': 'Файл должен быть изображением'}), 400
    tmp_path = None
    try:
        suffix = os.path.splitext(f.filename)[1] or '.png'
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp_path = tmp.name
            f.save(tmp_path)
        result = detect_walls_and_shelves(image_path=tmp_path)
        if result is None:
            return jsonify({'error': 'Не удалось обработать изображение'}), 500
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


@app.route('/logo.png')
def logo():
    root = os.path.join(os.path.dirname(__file__), '..')
    return send_from_directory(root, 'logo.png')


@app.route('/drone-icon.png')
def drone_icon():
    root = os.path.join(os.path.dirname(__file__), '..')
    return send_from_directory(root, 'free-icon-drone-4056808.png')


def _ensure_data_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)


@app.route('/api/graph', methods=['GET'])
def api_graph_get():
    _ensure_data_dir()
    if not GRAPH_PATH.exists():
        return jsonify({'nodes': [], 'edges': [], 'meta': None})
    try:
        with open(GRAPH_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return jsonify(data)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/drone/start', methods=['POST'])
def api_drone_start():
    try:
        data = request.get_json()
        if data is None:
            return jsonify({'error': 'Ожидается JSON'}), 400
        route = data.get('route', [])
        meta = data.get('meta', {})
        height = data.get('height')
        axis_y = data.get('axisY')
        return_start_index = data.get('return_start_index')
        if not route:
            return jsonify({'error': 'Маршрут пуст'}), 400
        ok, msg = start_mission(route, meta, height=height, axis_y=axis_y, return_start_index=return_start_index)
        if ok:
            return jsonify({'ok': True, 'message': msg})
        return jsonify({'error': msg}), 400
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/drone/land', methods=['POST'])
def api_drone_land():
    try:
        land_manual()
        return jsonify({'ok': True, 'message': 'Посадка выполнена'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/drone/status')
def api_drone_status():
    return jsonify({
        'mission_active': is_mission_active(),
        'available': is_available(),
        'current_waypoint_index': get_current_waypoint_index(),
        'current_node_index': get_current_node_index(),
    })


@app.route('/api/nodes/qr')
def api_nodes_qr():
    result = {}
    if NODES_QR_PATH.exists():
        try:
            with open(NODES_QR_PATH, 'r', encoding='utf-8') as f:
                data = json.load(f)
                if isinstance(data, dict):
                    result = {k: v for k, v in data.items() if v and str(v).strip()}
        except Exception:
            pass
    mem = get_qr_results()
    if isinstance(mem, dict):
        for k, v in mem.items():
            if v and str(v).strip():
                result[k] = str(v).strip()
    return jsonify(result)


@app.route('/api/drone/frame')
def api_drone_frame():
    frame_bytes = get_camera_frame_jpeg()
    if frame_bytes is None:
        return '', 204
    return Response(frame_bytes, mimetype='image/jpeg')


@app.route('/api/drone/frame-with-qr')
def api_drone_frame_with_qr():
    fast = request.args.get('fast', '').lower() in ('1', 'true', 'yes')
    data = get_camera_frame_with_qr(skip_qr=fast)
    if data is None:
        return jsonify({'error': 'no_frame', 'debug': {}}), 200
    return jsonify(data)


@app.route('/api/graph', methods=['POST'])
def api_graph_post():
    _ensure_data_dir()
    try:
        data = request.get_json()
        if data is None:
            return jsonify({'error': 'Ожидается JSON'}), 400
        nodes = data.get('nodes', [])
        edges = data.get('edges', [])
        meta = data.get('meta')
        payload = {'nodes': nodes, 'edges': edges, 'meta': meta}
        with open(GRAPH_PATH, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    app.run(debug=True, port=5002)
