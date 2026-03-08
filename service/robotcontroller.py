"""
Управление наземным роботом по HTTP (ESP8266).
Робот доступен по IP 192.168.4.1 при подключении к его Wi‑Fi (RobotAP).
Команды: DRIVE_DIST, TURN, LIFT_UP, LIFT_DOWN, STOP.
"""
import logging
import time
import urllib.error
import urllib.parse
import urllib.request

_log = logging.getLogger(__name__)

ROBOT_DEFAULT_IP = "192.168.4.1"
ROBOT_TIMEOUT = 5


def _node_by_id(nodes, node_id):
    for n in nodes:
        if n.get("id") == node_id:
            return n
    return None


def _build_adj(graph):
    """Строит список смежности { from_id: [(to_id, length), ...] } (ненаправленный граф)."""
    adj = {}
    for n in graph.get("nodes", []):
        adj[n["id"]] = []
    for e in graph.get("edges", []):
        fr = e.get("from")
        to = e.get("to")
        ln = float(e.get("length", 1))
        if fr and to and fr in adj and to in adj:
            adj[fr].append((to, ln))
            adj[to].append((fr, ln))
    return adj


def _dijkstra(adj, start_id, target_id):
    """Дейкстра, возвращает путь [id, id, ...] или []."""
    import math
    dist = {nid: math.inf for nid in adj}
    prev = {nid: None for nid in adj}
    dist[start_id] = 0
    unvisited = set(adj.keys())
    while unvisited:
        u = min(unvisited, key=lambda x: dist[x])
        if dist[u] == math.inf or u == target_id:
            break
        unvisited.discard(u)
        for v, w in adj[u]:
            alt = dist[u] + w
            if alt < dist[v]:
                dist[v] = alt
                prev[v] = u
    path = []
    cur = target_id
    while cur:
        path.append(cur)
        cur = prev.get(cur)
    path.reverse()
    return path if path and path[0] == start_id else []


def _direction_to_angle(di, dj):
    """(di, dj) — смещение по сетке. Возвращает угол в градусах: 0°=вправо(+i), 90°=вверх(+j)."""
    if di == 1 and dj == 0:
        return 0
    if di == 0 and dj == 1:
        return 90
    if di == -1 and dj == 0:
        return 180
    if di == 0 and dj == -1:
        return -90
    return 0


def _normalize_angle(a):
    """Приводит угол к [-180, 180]."""
    while a > 180:
        a -= 360
    while a < -180:
        a += 360
    return a


def _path_to_commands(path, nodes, adj):
    """
    Преобразует путь [node_id, ...] в список команд (type, kwargs).
    type: 'turn' | 'drive'
    """
    if len(path) < 2:
        return []
    node_map = {n["id"]: n for n in nodes}
    commands = []
    heading = 90  # начальная ориентация: 90° = +j (вперёд по вертикали)
    for k in range(len(path) - 1):
        a_id = path[k]
        b_id = path[k + 1]
        na = node_map.get(a_id)
        nb = node_map.get(b_id)
        if not na or not nb:
            continue
        di = nb.get("i", 0) - na.get("i", 0)
        dj = nb.get("j", 0) - na.get("j", 0)
        length = 0.5
        for to_id, ln in adj.get(a_id, []):
            if to_id == b_id:
                length = ln
                break
        target_angle = _direction_to_angle(di, dj)
        delta = _normalize_angle(target_angle - heading)
        if abs(delta) > 1:
            commands.append(("turn", {"angle": delta}))
            heading = target_angle
        if length > 0.01:
            commands.append(("drive", {"d": round(length, 2)}))
    return commands


def _robot_request(base_url, path, params=None):
    """GET к роботу. base_url без http, например 192.168.4.1."""
    if not base_url:
        base_url = ROBOT_DEFAULT_IP
    if "://" not in base_url:
        base_url = "http://" + base_url
    url = base_url.rstrip("/") + path
    if params:
        q = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
        url = url + ("&" if "?" in url else "?") + q
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=ROBOT_TIMEOUT) as resp:
            return resp.read().decode("utf-8", errors="replace").strip(), None
    except urllib.error.URLError as e:
        return None, str(e)
    except Exception as e:
        return None, str(e)


def _execute_commands(commands, base_url):
    """Выполняет список команд (turn, drive) через HTTP."""
    for cmd_type, kwargs in commands:
        if cmd_type == "turn":
            _, err = _robot_request(base_url, "/turn", {"angle": kwargs["angle"]})
        elif cmd_type == "drive":
            _, err = _robot_request(base_url, "/drive_dist", {"d": kwargs["d"]})
        else:
            continue
        if err:
            return False, err
    return True, None


def _invert_commands(commands):
    """Инвертирует команды для возврата обратно тем же путём.

    - drive(d)  -> drive(-d)
    - turn(a)   -> turn(-a)
    Порядок выполнения: в обратном порядке.
    """
    inv = []
    for cmd_type, kwargs in reversed(commands):
        if cmd_type == "drive":
            inv.append(("drive", {"d": -float(kwargs["d"])}))
        elif cmd_type == "turn":
            inv.append(("turn", {"angle": -float(kwargs["angle"])}))

    # Чтобы робот не делал "лишний" разворот после приезда в стартовую точку,
    # убираем завершающие повороты, которые только восстанавливают исходный heading.
    while inv and inv[-1][0] == "turn":
        inv.pop()
    return inv


def get_robot_position(base_url=None):
    """Получает текущую позицию робота."""
    base_url = base_url or ROBOT_DEFAULT_IP
    response, err = _robot_request(base_url, "/get_position")
    if err:
        return None, err
    return response, None


def reset_robot_position(base_url=None):
    """Сбрасывает позицию робота в исходную точку."""
    base_url = base_url or ROBOT_DEFAULT_IP
    response, err = _robot_request(base_url, "/reset_position")
    if err:
        return False, err
    return True, response


def return_robot_to_start(base_url=None):
    """Отправляет робота в исходную точку."""
    base_url = base_url or ROBOT_DEFAULT_IP
    # Получаем текущую позицию
    position, err = _robot_request(base_url, "/get_position")
    if err:
        return False, err
    
    # Парсим позицию для получения координат
    try:
        # Формат: "Position: X=1.23, Y=2.45, Angle=90.0°"
        if "X=" in position and "Y=" in position:
            x_str = position.split("X=")[1].split(",")[0].strip()
            y_str = position.split("Y=")[1].split(",")[0].strip()
            angle_str = position.split("Angle=")[1].replace("°", "").strip()
            
            x = float(x_str)
            y = float(y_str)
            current_angle = float(angle_str)
            
            # Расчет расстояния до исходной точки
            distance = (x**2 + y**2)**0.5
            
            if distance < 0.05:  # если уже у исходной точки
                return True, "Already at start position"
            
            # Расчет угла к исходной точке
            target_angle = (-y / distance) * 90  # упрощенный расчет
            if x < 0:
                target_angle = -target_angle
                
            angle_diff = target_angle - current_angle
            
            # Нормализация разницы углов
            while angle_diff > 180:
                angle_diff -= 360
            while angle_diff < -180:
                angle_diff += 360
            
            # Сначала поворачиваем к исходной точке
            if abs(angle_diff) > 1:
                _, err = _robot_request(base_url, "/turn", {"angle": angle_diff})
                if err:
                    return False, f"Turn error: {err}"
            
            # Затем едем НАЗАД к исходной точке (отрицательное расстояние)
            _, err = _robot_request(base_url, "/drive_dist", {"d": -distance})
            if err:
                return False, f"Drive error: {err}"
                
            return True, f"Returned to start: distance={distance:.2f}m back"
        else:
            return False, "Invalid position format"
    except Exception as e:
        return False, f"Position parsing error: {str(e)}"


def send_robot_to_node(
    graph,
    target_node_id,
    start_node_id=None,
    base_url=None,
    return_to_start=False,
    wait_at_target_sec=0,
):
    """
    Отправляет робота из start_node_id в target_node_id по графу.
    Если return_to_start=True, после приезда ждёт wait_at_target_sec и возвращается в start.
    Возвращает (success: bool, message: str).
    """
    nodes = graph.get("nodes", [])
    if not nodes:
        return False, "Граф пуст"
    if not _node_by_id(nodes, target_node_id):
        return False, f"Узел {target_node_id} не найден"
    start = start_node_id or (nodes[0]["id"] if nodes else None)
    if not start or not _node_by_id(nodes, start):
        return False, "Стартовый узел не найден"
    if start == target_node_id and not return_to_start:
        return True, "Робот уже в целевой точке"
    base_url = base_url or ROBOT_DEFAULT_IP
    adj = _build_adj(graph)

    path_to_target = _dijkstra(adj, start, target_node_id)
    if not path_to_target:
        return False, "Путь не найден"
    commands = _path_to_commands(path_to_target, nodes, adj)
    ok, err = _execute_commands(commands, base_url)
    if not ok:
        return False, f"Ошибка связи с роботом: {err}"

    if return_to_start and wait_at_target_sec > 0:
        time.sleep(wait_at_target_sec)
    if return_to_start and start != target_node_id:
        # Возвращаемся обратно тем же набором команд, но в обратном порядке.
        # Ключевое: движение назад делается через DRIVE_DIST с отрицательной дистанцией.
        commands_back = _invert_commands(commands)
        ok, err = _execute_commands(commands_back, base_url)
        if not ok:
            return False, f"Ошибка при возврате: {err}"
    return True, f"Робот доехал до {target_node_id}" + (
        " и вернулся в начало" if return_to_start else ""
    )
