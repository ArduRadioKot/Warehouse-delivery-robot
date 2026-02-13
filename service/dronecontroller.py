import base64
import json
import logging
import math
import threading
import time
import traceback
from pathlib import Path

_log = logging.getLogger(__name__)

try:
    from pioneer_sdk import Pioneer, Camera
    PIONEER_AVAILABLE = True
except ImportError:
    PIONEER_AVAILABLE = False
    Pioneer = None
    Camera = None

try:
    import cv2
    CV_AVAILABLE = True
except ImportError:
    CV_AVAILABLE = False
    cv2 = None

try:
    from pyzbar import pyzbar
    PYZBAR_AVAILABLE = True
except ImportError:
    PYZBAR_AVAILABLE = False
    pyzbar = None

_mission_active = False
_mission_thread = None
_pioneer = None
_camera = None
_current_waypoint_index = -1
_current_node_index = -1
_qr_results = {}
_qr_save_path = None
FLIGHT_HEIGHT = 1.5


def _get_pioneer():
    global _pioneer
    if _pioneer is None and PIONEER_AVAILABLE:
        _pioneer = Pioneer()
    return _pioneer


def _get_camera():
    global _camera
    if _camera is None and Camera is not None:
        try:
            _camera = Camera()
        except Exception:
            pass
    return _camera


def set_qr_save_path(path):
    global _qr_save_path, _qr_results
    _qr_save_path = Path(path) if path else None
    if _qr_save_path and _qr_save_path.exists():
        try:
            with open(_qr_save_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                _qr_results = {k: v for k, v in (data if isinstance(data, dict) else {}).items()
                               if v and str(v).strip()}
        except Exception:
            _qr_results = {}


def get_qr_results():
    return dict(_qr_results)


def _save_qr_results():
    if _qr_save_path:
        try:
            _qr_save_path.parent.mkdir(parents=True, exist_ok=True)
            to_save = {k: v for k, v in _qr_results.items() if v and str(v).strip()}
            with open(_qr_save_path, 'w', encoding='utf-8') as f:
                json.dump(to_save, f, ensure_ascii=False, indent=2)
        except Exception:
            pass


def _decode_qr(frame):
    if frame is None:
        return ''
    if PYZBAR_AVAILABLE and pyzbar is not None:
        try:
            decoded = pyzbar.decode(frame)
            for obj in decoded:
                if obj.type == 'QRCODE' and obj.data:
                    return obj.data.decode('utf-8', errors='replace').strip()
        except Exception:
            pass
    if CV_AVAILABLE and cv2 is not None:
        try:
            gray = _frame_for_qr(frame)
            if gray is not None:
                det = cv2.QRCodeDetector()
                data, _, _ = det.detectAndDecode(gray)
                return (data or '').strip()
        except Exception:
            pass
    return ''


STREAM_MAX_WIDTH = 480
STREAM_JPEG_QUALITY = 75


def _frame_for_qr(frame):
    if frame is None or not CV_AVAILABLE or cv2 is None:
        return None
    if len(frame.shape) == 3:
        return cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return frame


def _detect_qr_pyzbar(frame, debug_out=None):
    if not PYZBAR_AVAILABLE or pyzbar is None or frame is None:
        if debug_out is not None:
            debug_out['pyzbar_available'] = PYZBAR_AVAILABLE
        return []
    try:
        decoded = pyzbar.decode(frame)
        if debug_out is not None:
            debug_out['pyzbar_count'] = len(decoded)
        out = []
        for obj in decoded:
            if obj.type != 'QRCODE':
                continue
            try:
                data = obj.data.decode('utf-8', errors='replace').strip()
            except Exception:
                data = ''
            points = []
            if hasattr(obj, 'polygon') and obj.polygon:
                for p in obj.polygon:
                    points.append([int(p.x), int(p.y)])
            if not points and hasattr(obj, 'rect'):
                r = obj.rect
                points = [[r.left, r.top], [r.left + r.width, r.top],
                          [r.left + r.width, r.top + r.height], [r.left, r.top + r.height]]
            if points:
                out.append({'data': data, 'points': points})
        return out
    except Exception as e:
        if debug_out is not None:
            debug_out['pyzbar_error'] = str(e)
            debug_out['pyzbar_traceback'] = traceback.format_exc()
        _log.exception('pyzbar decode failed')
        return []


def _detect_qr_opencv(frame, debug_out=None):
    if not CV_AVAILABLE or cv2 is None or frame is None:
        return []
    gray = _frame_for_qr(frame)
    if gray is None:
        return []
    try:
        det = cv2.QRCodeDetector()
        try:
            retval, decoded_info, points, _ = det.detectAndDecodeMulti(gray)
            if debug_out is not None:
                debug_out['opencv_detector'] = 'multi'
                debug_out['opencv_retval'] = bool(retval)
                debug_out['opencv_decoded_len'] = len(decoded_info) if decoded_info is not None else 0
                debug_out['opencv_points_len'] = len(points) if points is not None else 0
            if retval and decoded_info and points is not None:
                out = []
                for i, data in enumerate(decoded_info):
                    if i < len(points):
                        pts = points[i]
                        if hasattr(pts, 'tolist'):
                            pts = pts.tolist()
                        out.append({
                            'data': (data or '').strip(),
                            'points': [[round(float(p[0]), 1), round(float(p[1]), 1)] for p in pts]
                        })
                return out
        except Exception as e1:
            if debug_out is not None:
                debug_out['opencv_multi_error'] = str(e1)
        data, bbox, _ = det.detectAndDecode(gray)
        if debug_out is not None:
            debug_out['opencv_detector'] = 'single'
            debug_out['opencv_single_data'] = (data or '')[:80]
            debug_out['opencv_bbox_is_none'] = bbox is None
        if data and bbox is not None and bbox.size >= 8:
            pts = bbox.reshape(4, 2).tolist()
            return [{'data': (data or '').strip(), 'points': [[round(float(p[0]), 1), round(float(p[1]), 1)] for p in pts]}]
        return []
    except Exception as e:
        if debug_out is not None:
            debug_out['opencv_error'] = str(e)
        _log.exception('OpenCV QR detect failed')
        return []


def _detect_qr_multi(frame, debug_out=None):
    if debug_out is not None:
        debug_out['cv_available'] = CV_AVAILABLE
        debug_out['pyzbar_available'] = PYZBAR_AVAILABLE
        debug_out['frame_is_none'] = frame is None
        if frame is not None:
            try:
                debug_out['frame_shape'] = list(frame.shape)
            except Exception:
                debug_out['frame_shape'] = None
    if frame is None:
        if debug_out is not None:
            debug_out['skip_reason'] = 'no_frame'
        return []
    out = _detect_qr_pyzbar(frame, debug_out=debug_out)
    if out:
        if debug_out is not None:
            debug_out['detector_used'] = 'pyzbar'
            debug_out['qr_count'] = len(out)
        return out
    out = _detect_qr_opencv(frame, debug_out=debug_out)
    if debug_out is not None:
        debug_out['detector_used'] = 'opencv' if out else 'none'
        debug_out['qr_count'] = len(out)
    return out


def get_camera_frame_jpeg():
    cam = _get_camera()
    if cam is None:
        return None
    try:
        frame = cam.get_cv_frame()
        if frame is None:
            return None
        if CV_AVAILABLE and cv2 is not None:
            _, buf = cv2.imencode('.jpg', frame)
            return buf.tobytes()
        return None
    except Exception:
        return None


def get_camera_frame_with_qr(skip_qr=False):
    debug = {}
    cam = _get_camera()
    if cam is None:
        debug['camera'] = 'none'
        return {'image': None, 'width': 0, 'height': 0, 'qr': [], 'debug': debug}
    try:
        frame = cam.get_cv_frame()
        if frame is None:
            debug['frame'] = 'none'
            return {'image': None, 'width': 0, 'height': 0, 'qr': [], 'debug': debug}
        if not CV_AVAILABLE or cv2 is None:
            debug['cv'] = 'unavailable'
            return {'image': None, 'width': 0, 'height': 0, 'qr': [], 'debug': debug}
        try:
            debug['cv_version'] = cv2.__version__
        except Exception:
            pass
        h, w = frame.shape[:2]
        debug['original_size'] = [h, w]
        if w > STREAM_MAX_WIDTH:
            scale = STREAM_MAX_WIDTH / w
            new_w = STREAM_MAX_WIDTH
            new_h = int(h * scale)
            frame = cv2.resize(frame, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
            h, w = new_h, new_w
        debug['resized'] = [h, w]
        qr_list = [] if skip_qr else _detect_qr_multi(frame, debug_out=debug)
        encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), STREAM_JPEG_QUALITY]
        _, buf = cv2.imencode('.jpg', frame, encode_params)
        b64 = base64.b64encode(buf.tobytes()).decode('ascii')
        debug['jpeg_len'] = len(b64)
        if qr_list:
            _log.info('frame_with_qr: size=%s qr_count=%s', [h, w], len(qr_list))
        elif not skip_qr and (debug.get('no_codes') or debug.get('multi_error') or debug.get('single_error')):
            _log.debug('frame_with_qr: size=%s debug=%s', [h, w], debug)
        return {'image': b64, 'width': w, 'height': h, 'qr': qr_list, 'debug': debug}
    except Exception as e:
        debug['exception'] = str(e)
        debug['traceback'] = traceback.format_exc()
        _log.exception('get_camera_frame_with_qr failed')
        return {'image': None, 'width': 0, 'height': 0, 'qr': [], 'debug': debug}


def is_available():
    return PIONEER_AVAILABLE


def is_mission_active():
    return _mission_active


def get_current_waypoint_index():
    return _current_waypoint_index


def get_current_node_index():
    return _current_node_index


HOVER_SEC = 0.5
POINT_WAIT_TIMEOUT = 90
TAKEOFF_PAUSE = 3.5


def _wait_point_reached(pioneer):
    start = time.time()
    while not pioneer.point_reached():
        if not _mission_active:
            return False
        if time.time() - start > POINT_WAIT_TIMEOUT:
            _log.warning('point_reached timeout (%.0fs), proceeding', POINT_WAIT_TIMEOUT)
            return True
        time.sleep(0.1)
    return True


def _cells_to_meters(route, scale_x, scale_y, axis_y=None):
    waypoints_grid = []
    for item in route:
        i = item.get('i', 0)
        j = item.get('j', 0)
        gx = (i + 0.5) * scale_x
        gy = (j + 0.5) * scale_y
        waypoints_grid.append((gx, gy))

    if not waypoints_grid:
        return []

    if axis_y is None or (axis_y.get('di') == 0 and axis_y.get('dj') == 0):
        return [(gx, gy) for gx, gy in waypoints_grid]

    di = int(axis_y.get('di', 0))
    dj = int(axis_y.get('dj', 1))
    gx0, gy0 = waypoints_grid[0]
    x_vec = (-dj * scale_x, di * scale_y)
    y_vec = (di * scale_x, dj * scale_y)
    lx = math.hypot(x_vec[0], x_vec[1]) or 1.0
    ly = math.hypot(y_vec[0], y_vec[1]) or 1.0
    points = []
    for gx, gy in waypoints_grid:
        vx = gx - gx0
        vy = gy - gy0
        local_x = (vx * x_vec[0] + vy * x_vec[1]) / lx
        local_y = (vx * y_vec[0] + vy * y_vec[1]) / ly
        points.append((local_x, local_y))
    return points


def _run_mission_impl(points, height=None, return_start_index=None, route=None):
    global _mission_active, _current_waypoint_index, _current_node_index, _qr_results
    z = height if height is not None else FLIGHT_HEIGHT
    pioneer = _get_pioneer()
    camera = _get_camera()
    if not pioneer or not PIONEER_AVAILABLE:
        return
    try:
        _mission_active = True
        _current_waypoint_index = -1
        pioneer.arm()
        time.sleep(1)
        pioneer.takeoff()
        time.sleep(TAKEOFF_PAUSE)
        if points:
            pioneer.go_to_local_point(x=points[0][0], y=points[0][1], z=z, yaw=0)
            if not _wait_point_reached(pioneer):
                pioneer.land()
                return
            _current_waypoint_index = 0
            _current_node_index = 0
            if route and len(route) > 0 and camera:
                frame = camera.get_cv_frame()
                node_id = route[0].get('id', '0_0')
                decoded = _decode_qr(frame) if frame is not None else ''
                if decoded and decoded.strip():
                    _qr_results[node_id] = decoded.strip()
                    _save_qr_results()
            if not _mission_active:
                pioneer.land()
                return
            if return_start_index is None or 0 < return_start_index:
                x0, y0 = points[0]
                pioneer.go_to_local_point(x=x0, y=y0, z=z, yaw=0)
                time.sleep(HOVER_SEC)

        for idx in range(1, len(points)):
            if not _mission_active:
                break
            x, y = points[idx]
            pioneer.go_to_local_point(x=x, y=y, z=z, yaw=0)
            if not _wait_point_reached(pioneer):
                pioneer.land()
                return
            _current_waypoint_index = idx
            _current_node_index = idx
            if route and idx < len(route) and camera:
                frame = camera.get_cv_frame()
                node_id = route[idx].get('id', '0_0')
                decoded = _decode_qr(frame) if frame is not None else ''
                if decoded and decoded.strip():
                    _qr_results[node_id] = decoded.strip()
                    _save_qr_results()
            if not _mission_active:
                break
            on_return = return_start_index is not None and idx >= return_start_index
            if not on_return:
                pioneer.go_to_local_point(x=x, y=y, z=z, yaw=0)
                time.sleep(HOVER_SEC)

        if _mission_active:
            pioneer.land()
            _wait_point_reached(pioneer)
    except Exception as e:
        if pioneer:
            try:
                pioneer.land()
            except Exception:
                pass
        raise e
    finally:
        _mission_active = False
        _current_waypoint_index = -1
        _current_node_index = -1


def start_mission(route, meta, height=None, axis_y=None, return_start_index=None):
    global _mission_thread, _mission_active
    if _mission_active:
        return False, "Миссия уже выполняется"
    if not route or len(route) == 0:
        return False, "Маршрут пуст"
    scale_x = float(meta.get('scaleX', 1))
    scale_y = float(meta.get('scaleY', 1))
    points = _cells_to_meters(route, scale_x, scale_y, axis_y=axis_y)
    z = float(height) if height is not None else FLIGHT_HEIGHT
    z = max(0.5, min(10.0, z))
    _mission_thread = threading.Thread(
        target=_run_mission_impl,
        args=(points, z),
        kwargs={'return_start_index': return_start_index, 'route': route},
        daemon=True
    )
    _mission_thread.start()
    return True, "Миссия запущена"


_land_last_time = 0
LAND_COOLDOWN = 2.0


def land_manual():
    global _mission_active, _land_last_time
    _mission_active = False
    now = time.time()
    if now - _land_last_time < LAND_COOLDOWN:
        return
    _land_last_time = now
    pioneer = _get_pioneer()
    if pioneer and PIONEER_AVAILABLE:
        try:
            pioneer.land()
        except Exception:
            pass


def takeoff():
    pioneer = _get_pioneer()
    if pioneer and PIONEER_AVAILABLE:
        pioneer.takeoff()
        while not pioneer.point_reached():
            time.sleep(0.1)
        time.sleep(2)


def land():
    pioneer = _get_pioneer()
    if pioneer and PIONEER_AVAILABLE:
        pioneer.land()
        while not pioneer.point_reached():
            time.sleep(0.1)


def go_to_local_point(x, y, z, yaw=0):
    pioneer = _get_pioneer()
    if pioneer and PIONEER_AVAILABLE:
        pioneer.go_to_local_point(x=x, y=y, z=z, yaw=yaw)
        while not pioneer.point_reached():
            time.sleep(0.1)
