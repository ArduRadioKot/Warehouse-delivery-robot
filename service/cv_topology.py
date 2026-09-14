"""
Распознавание топологии плана склада: стены (внешний прямоугольник) и стелажи (внутренние прямоугольники).
Ожидается изображение: чёрные линии на белом фоне (как example.png).
"""
import cv2
import numpy as np
from typing import Optional


def _is_inside(inner: tuple, outer: tuple) -> bool:
    """Проверяет, что прямоугольник inner целиком внутри outer. (x, y, w, h)."""
    ix, iy, iw, ih = inner
    ox, oy, ow, oh = outer
    return (
        ix >= ox and iy >= oy
        and ix + iw <= ox + ow
        and iy + ih <= oy + oh
    )


def detect_walls_and_shelves(
    image_path: Optional[str] = None,
    image_array: Optional[np.ndarray] = None,
) -> Optional[dict]:
    """
    Находит стены (внешний прямоугольник) и стелажи (внутренние прямоугольники).

    Можно передать либо image_path, либо image_array (BGR или grayscale).

    Возвращает:
    {
        "image_width": int,
        "image_height": int,
        "walls": [x, y, width, height] | null,
        "shelves": [[x, y, width, height], ...]
    }
    или None при ошибке.
    """
    if image_path is not None:
        img = cv2.imread(image_path)
    elif image_array is not None:
        img = np.asarray(image_array)
        if len(img.shape) == 2:
            img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    else:
        return None

    if img is None or img.size == 0:
        return None

    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img

    # Сглаживание для устойчивости контуров
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)
    # Порог: линии (тёмные) становятся белыми для findContours
    _, thresh = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    contours, hierarchy = cv2.findContours(
        thresh, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE
    )

    # Собираем прямоугольники по площади
    rects = []
    for index, c in enumerate(contours):
        area = cv2.contourArea(c)
        if area < 200:  # отсекаем мелкий шум
            continue
        x, y, rw, rh = cv2.boundingRect(c)
        rects.append((area, (x, y, rw, rh), index))

    rects.sort(key=lambda r: r[0], reverse=True)

    if not rects:
        return {
            "image_width": w,
            "image_height": h,
            "walls": None,
            "shelves": [],
        }

    walls = list(rects[0][1])
    shelves = []
    # In a line drawing, the wall encloses a white floor contour. Its children
    # are the outer shelf contours; their own holes must not become duplicates.
    wall_index = rects[0][2]
    floor_candidates = [r for r in rects[1:] if hierarchy[0][r[2]][3] == wall_index]
    floor_index = floor_candidates[0][2] if floor_candidates else None

    for area, (x, y, rw, rh), index in rects[1:]:
        if floor_index is None or hierarchy[0][index][3] != floor_index:
            continue
        # Только контуры целиком внутри стен
        if not _is_inside((x, y, rw, rh), tuple(walls)):
            continue
        # Относительно крупные внутренние объекты считаем стелажами
        if area < 500:
            continue
        shelves.append([int(x), int(y), int(rw), int(rh)])

    return {
        "image_width": w,
        "image_height": h,
        "walls": walls,
        "shelves": shelves,
    }
