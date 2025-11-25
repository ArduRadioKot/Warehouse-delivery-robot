#include <Arduino.h>
#include <ESP32QRCodeReader.h>

/
ESP32QRCodeReader reader(CAMERA_MODEL_AI_THINKER);

void onQrCodeTask(void *pvParameters) {
  struct QRCodeData qrCodeData;

  while (true) {
    if (reader.receiveQrCode(&qrCodeData, 100)) {
      Serial.println("Scanned new QRCode");
      if (qrCodeData.valid) {
        const char* payload = (const char*)qrCodeData.payload;
        Serial.print("Valid payload: ");
        Serial.println(payload);

        // Отправка команды в зависимости от содержимого QR-кода
        if (strcmp(payload, "1") == 0) {
          Serial.write('f');  // Отправить 'f'
        } else if (strcmp(payload, "2") == 0) {
          Serial.write('s');  // Отправить 's'
        }
      } else {
        Serial.print("Invalid payload: ");
        Serial.println((const char *)qrCodeData.payload);
      }
    }
    vTaskDelay(100 / portTICK_PERIOD_MS);
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println();

  reader.setup();
  Serial.println("Setup QRCode Reader");

  reader.beginOnCore(1);
  Serial.println("Begin on Core 1");

  xTaskCreate(onQrCodeTask, "onQrCode", 4 * 1024, NULL, 4, NULL);
  pinMode(4, OUTPUT);
  digitalWrite(4, HIGH);
  delay(100);
  digitalWrite(4, LOW);
}

void loop() {
  delay(100);
}