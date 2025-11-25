import cv2

STREAM_URL = "http://192.168.4.1/stream"

cap = cv2.VideoCapture(STREAM_URL)

if not cap.isOpened():
    print(f"Ошибка: не удалось подключиться к потоку {STREAM_URL}")
    exit()

print("Подключено к видеопотоку. Нажмите 'q' для выхода.")

# Создаём детектор QR-кода
qr_decoder = cv2.QRCodeDetector()

while True:
    ret, frame = cap.read()
    if not ret:
        print("Не удалось получить кадр.")
        break

    # Декодируем QR-код
    data, bbox, _ = qr_decoder.detectAndDecode(frame)

    if data:
        print(f"QR-код распознан: {data}")
        # Рисуем рамку, если есть координаты
        if bbox is not None:
            bbox = bbox[0].astype(int)
            for i in range(len(bbox)):
                pt1 = tuple(bbox[i])
                pt2 = tuple(bbox[(i + 1) % len(bbox)])
                cv2.line(frame, pt1, pt2, (0, 255, 0), 3)

    cv2.imshow("QR Scanner - ESP32-CAM", frame)

    if cv2.waitKey(1) & 0xFF == ord('q'):
        break

cap.release()
cv2.destroyAllWindows()