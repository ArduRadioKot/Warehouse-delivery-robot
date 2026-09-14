"""WDR adaptation of Hello-pioner's visual move/lift program workflow.

The ESP8266 bridge acknowledges receipt, not completion. Live programs therefore
advance one HTTP command at a time, after an operator confirms the previous one.
"""
import copy
import json
import math
import os
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Blueprint, jsonify, request
from robotcontroller import _build_adj, _dijkstra, _normalize_angle, _robot_request


def atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    name = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                         suffix='.tmp', delete=False) as stream:
            name = stream.name
            json.dump(data, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if name and os.path.exists(name):
            os.unlink(name)


def number(value, label, minimum=-100000, maximum=100000):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f'{label}: ожидается число')
    if not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError(f'{label}: недопустимое значение')
    return value


def validate_graph(graph):
    if not isinstance(graph, dict):
        raise ValueError('Ожидается объект графа')
    nodes, edges = graph.get('nodes'), graph.get('edges')
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise ValueError('Граф должен содержать списки nodes и edges')
    if len(nodes) > 10000 or len(edges) > 40000:
        raise ValueError('Граф слишком большой')
    ids = set()
    for n in nodes:
        if not isinstance(n, dict) or not isinstance(n.get('id'), str) or not n['id']:
            raise ValueError('Узел должен иметь непустой строковый id')
        if n['id'] in ids:
            raise ValueError('Идентификаторы узлов должны быть уникальны')
        ids.add(n['id'])
        number(n.get('i'), 'Координата i')
        number(n.get('j'), 'Координата j')
    for e in edges:
        if not isinstance(e, dict) or not isinstance(e.get('from'), str) or not isinstance(e.get('to'), str):
            raise ValueError('Некорректное ребро')
        if e['from'] not in ids or e['to'] not in ids or e['from'] == e['to']:
            raise ValueError('Ребро должно соединять два существующих узла')
        number(e.get('length'), 'Длина ребра, м', 0.01, 10000)
    return graph


def compile_program(data, graph):
    validate_graph(graph)
    if not isinstance(data, dict):
        raise ValueError('Ожидается объект программы')
    nodes = {n['id']: n for n in graph['nodes']}
    start = data.get('start_node')
    if not isinstance(start, str) or start not in nodes:
        raise ValueError('Выберите существующий стартовый узел')
    heading = number(data.get('start_heading', 90), 'Начальный курс', -180, 180)
    actions = data.get('actions')
    if not isinstance(actions, list) or not 1 <= len(actions) <= 200:
        raise ValueError('Программа должна содержать от 1 до 200 действий')
    adj = _build_adj(graph)
    commands, route, clean_actions = [], [start], []
    current, distance = start, 0.0
    for action in actions:
        if not isinstance(action, dict):
            raise ValueError('Некорректное действие')
        if action.get('type') == 'move':
            target = action.get('target_node')
            if not isinstance(target, str) or target not in nodes:
                raise ValueError('Целевой узел не найден')
            path = _dijkstra(adj, current, target)
            if not path:
                raise ValueError(f'Нет пути из {current} в {target}')
            for a, b in zip(path, path[1:]):
                di, dj = nodes[b]['i'] - nodes[a]['i'], nodes[b]['j'] - nodes[a]['j']
                if (di == 0) == (dj == 0):
                    raise ValueError('WDR поддерживает рёбра вдоль осей сетки')
                target_heading = (0 if di > 0 else 180) if di else (90 if dj > 0 else -90)
                delta = _normalize_angle(target_heading - heading)
                if abs(delta) > 0.01:
                    commands.append({'type': 'turn', 'angle': delta})
                heading = target_heading
                length = min(w for node_id, w in adj[a] if node_id == b)
                commands.append({'type': 'drive', 'distance': round(length, 4), 'target_node': b})
                distance += length
            route.extend(path[1:])
            current = target
            clean_actions.append({'type': 'move', 'target_node': target})
        elif action.get('type') == 'lift' and action.get('lift_action') in ('up', 'down'):
            lift = action['lift_action']
            commands.append({'type': 'lift', 'action': lift})
            clean_actions.append({'type': 'lift', 'lift_action': lift})
        else:
            raise ValueError('Неизвестное действие программы')
        if len(commands) > 5000:
            raise ValueError('Программа превышает 5000 команд')
    return {'start_node': start, 'start_heading': data.get('start_heading', 90),
            'actions': clean_actions, 'commands': commands, 'route': route,
            'distance_m': round(distance, 4), 'end_heading': heading}


class ProgramStore:
    def __init__(self, path):
        self.path, self.lock = Path(path), threading.RLock()

    def read(self):
        if not self.path.exists():
            return []
        with self.path.open(encoding='utf-8') as stream:
            data = json.load(stream)
        # Accept the old list shape, but always write the canonical object shape.
        programs = data if isinstance(data, list) else data.get('programs') if isinstance(data, dict) else None
        if not isinstance(programs, list) or any(not isinstance(p, dict) for p in programs):
            raise ValueError('Файл программ повреждён; восстановите его из резервной копии')
        return programs

    def save(self, data, graph):
        plan = compile_program(data, graph)
        name = data.get('name')
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 100:
            raise ValueError('Название должно содержать от 1 до 100 символов')
        with self.lock:
            programs = self.read()
            program = {k: plan[k] for k in ('start_node', 'start_heading', 'actions')}
            program.update(id=uuid.uuid4().hex, name=name.strip(),
                           created_at=datetime.now(timezone.utc).isoformat())
            programs.append(program)
            atomic_json(self.path, {'programs': programs})
            return program


class ProgramRunner:
    def __init__(self):
        self.lock = threading.RLock()
        self.run = None

    def active(self):
        return self.run is not None and self.run['status'] not in ('completed', 'stopped')

    def snapshot(self):
        return copy.deepcopy(self.run)

    def start(self, plan, base_url):
        if self.active():
            raise ValueError('Сначала завершите или остановите текущую программу')
        if not isinstance(base_url, str) or not base_url.strip():
            raise ValueError('Укажите адрес робота')
        self.run = {'id': uuid.uuid4().hex, 'status': 'ready', 'next_index': 0,
                    'base_url': base_url.strip(), 'plan': plan, 'error': None}
        return self.snapshot()

    def step(self, data):
        run = self.run
        if not run or data.get('run_id') != run['id']:
            raise ValueError('Сессия запуска не найдена')
        index = data.get('expected_index')
        if isinstance(index, bool) or not isinstance(index, int) or index != run['next_index']:
            raise ValueError('Состояние изменилось; обновите страницу')
        if run['status'] not in ('ready', 'waiting'):
            raise ValueError('Продолжение недоступно; остановите программу')
        if run['status'] == 'waiting' and data.get('confirm_completed') is not True:
            raise ValueError('Подтвердите завершение предыдущей команды')
        if index == len(run['plan']['commands']):
            run['status'] = 'completed'
            return self.snapshot()
        command = run['plan']['commands'][index]
        if command['type'] == 'turn':
            path, params = '/turn', {'angle': command['angle']}
        elif command['type'] == 'drive':
            path, params = '/drive_dist', {'d': command['distance']}
        else:
            path, params = '/lift_' + command['action'], None
        _, error = _robot_request(run['base_url'], path, params)
        if error:
            run.update(status='error', error=error)
        else:
            run.update(status='waiting', next_index=index + 1, error=None)
        return self.snapshot()


def register_programs(app, graph_path, data_dir):
    bp = Blueprint('programs', __name__)
    store = ProgramStore(Path(data_dir) / 'robot_programs.json')
    runner = ProgramRunner()
    app.extensions['program_store'] = store
    app.extensions['program_runner'] = runner

    def graph():
        if not Path(graph_path).exists():
            raise ValueError('Сначала создайте и сохраните граф склада')
        with Path(graph_path).open(encoding='utf-8') as stream:
            return json.load(stream)

    def body():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            raise ValueError('Ожидается JSON-объект')
        return data

    @bp.errorhandler(ValueError)
    def bad_request(error):
        return jsonify(error=str(error)), 400

    @bp.errorhandler(OSError)
    def storage_error(error):
        app.logger.exception('Program storage failure')
        return jsonify(error='Не удалось прочитать или сохранить данные'), 500

    @bp.route('/api/robot/programs', methods=['GET', 'POST'])
    def programs():
        if request.method == 'GET':
            with store.lock:
                return jsonify(programs=store.read())
        return jsonify(ok=True, program=store.save(body(), graph())), 201

    @bp.delete('/api/robot/programs/<program_id>')
    def delete_program(program_id):
        with store.lock:
            programs = store.read()
            remaining = [p for p in programs if str(p.get('id')) != program_id]
            if len(remaining) == len(programs):
                return jsonify(error='Программа не найдена'), 404
            atomic_json(store.path, {'programs': remaining})
        return jsonify(ok=True)

    @bp.post('/api/robot/programs/preview')
    def preview():
        return jsonify(ok=True, plan=compile_program(body(), graph()))

    @bp.post('/api/robot/execute-current-program')
    @bp.post('/api/robot/execute-program')
    def execute():
        data = body()
        program = data
        if request.path.endswith('/execute-program'):
            with store.lock:
                program = next((p for p in store.read() if str(p.get('id')) == str(data.get('program_id'))), None)
            if program is None:
                return jsonify(error='Программа не найдена'), 404
        plan = compile_program(program, graph())
        dry_run = data.get('dry_run', True)
        if not isinstance(dry_run, bool):
            raise ValueError('dry_run должен быть логическим значением')
        if dry_run:
            return jsonify(ok=True, dry_run=True, plan=plan)
        with runner.lock:
            run = runner.start(plan, data.get('base_url', '192.168.4.1'))
        return jsonify(ok=True, run=run)

    @bp.get('/api/robot/program-run')
    def run_status():
        with runner.lock:
            return jsonify(run=runner.snapshot())

    @bp.post('/api/robot/program-run/step')
    def step():
        with runner.lock:
            run = runner.step(body())
        return jsonify(ok=run['status'] != 'error', run=run), (502 if run['status'] == 'error' else 200)

    @bp.post('/api/robot/stop')
    def stop():
        data = body()
        with runner.lock:
            active = runner.active()
            base_url = runner.run['base_url'] if active else data.get('base_url', '192.168.4.1')
            _, error = _robot_request(base_url, '/stop')
            if active:
                runner.run.update(status='stop_failed' if error else 'stopped', error=error)
            if error:
                return jsonify(error=error, run=runner.snapshot()), 502
            return jsonify(ok=True, message='STOP передан роботу', run=runner.snapshot())

    @bp.post('/api/robot/lift/<action>')
    def lift(action):
        data = body()
        if action not in ('up', 'down'):
            raise ValueError('Допустимы up и down')
        with runner.lock:
            if runner.active():
                return jsonify(error='Подъёмник занят программой'), 409
            _, error = _robot_request(data.get('base_url', '192.168.4.1'), '/lift_' + action)
        return (jsonify(error=error), 502) if error else jsonify(ok=True, message='Команда подъёмника передана')

    app.register_blueprint(bp)
