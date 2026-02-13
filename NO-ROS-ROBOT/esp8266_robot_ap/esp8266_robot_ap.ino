/*
 * ESP8266 (ESP-01) — точка доступа Wi‑Fi для управления роботом.
 * Подключение: ESP TX → RX робота (Arduino pin 0), общий GND.
 * Робот должен работать на 115200 бод (test2.ino).
 * Команды: DRIVE_DIST, TURN, LIFT_UP, LIFT_DOWN, STOP — в формате Serial строки с \n.
 */

#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>

// Параметры точки доступа
const char* ap_ssid     = "RobotAP";
const char* ap_password = "12345678";  // минимум 8 символов

ESP8266WebServer server(80);

// Скорость Serial — как у робота
const unsigned long ROBOT_BAUD = 115200;

void sendToRobot(const char* cmd) {
  Serial.print(cmd);
  Serial.write('\n');  // только \n — робот читает до \n
  Serial.flush();      // дождаться отправки всех байт
  delay(20);           // дать роботу время принять строку
}

void handleRoot() {
  server.send(200, "text/html; charset=utf-8", getHtml());
}

void handleLiftUp() {
  sendToRobot("LIFT_UP");
  server.send(200, "text/plain", "LIFT_UP");
}

void handleLiftDown() {
  sendToRobot("LIFT_DOWN");
  server.send(200, "text/plain", "LIFT_DOWN");
}

void handleStop() {
  sendToRobot("STOP");
  server.send(200, "text/plain", "OK");
}

void handleDriveDist() {
  if (!server.hasArg("d")) {
    server.send(400, "text/plain", "d (meters) required");
    return;
  }
  float d = server.arg("d").toFloat();
  if (fabs(d) < 0.01f) {
    server.send(400, "text/plain", "|d| must be >= 0.01");
    return;
  }
  char buf[64];
  if (server.hasArg("pwm")) {
    int pwm = server.arg("pwm").toInt();
    pwm = constrain(pwm, 1, 255);
    snprintf(buf, sizeof(buf), "DRIVE_DIST %.2f %d", d, pwm);
  } else {
    snprintf(buf, sizeof(buf), "DRIVE_DIST %.2f", d);
  }
  sendToRobot(buf);
  server.send(200, "text/plain", buf);
}

void handleTurn() {
  if (!server.hasArg("angle")) {
    server.send(400, "text/plain", "angle (degrees) required");
    return;
  }
  float angle = server.arg("angle").toFloat();
  char buf[64];
  if (server.hasArg("pwm")) {
    int pwm = server.arg("pwm").toInt();
    pwm = constrain(pwm, 1, 255);
    snprintf(buf, sizeof(buf), "TURN %.0f %d", angle, pwm);
  } else {
    snprintf(buf, sizeof(buf), "TURN %.0f", angle);
  }
  sendToRobot(buf);
  server.send(200, "text/plain", buf);
}

void handlePwm() {
  if (!server.hasArg("la") || !server.hasArg("lb") || !server.hasArg("ra") || !server.hasArg("rb")) {
    server.send(400, "text/plain", "la lb ra rb required");
    return;
  }
  char buf[64];
  snprintf(buf, sizeof(buf), "SET_PWM %s %s %s %s",
           server.arg("la").c_str(), server.arg("lb").c_str(),
           server.arg("ra").c_str(), server.arg("rb").c_str());
  sendToRobot(buf);
  server.send(200, "text/plain", "OK");
}

String getHtml() {
  return R"raw(
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Робот — управление</title>
  <style>
    body { font-family: sans-serif; max-width: 320px; margin: 20px auto; padding: 10px; }
    h1 { font-size: 1.2em; }
    label { display: block; margin-top: 10px; }
    input { width: 100%; padding: 8px; box-sizing: border-box; }
    button { margin-top: 12px; padding: 10px 16px; width: 100%; font-size: 1em; }
    .go { background: #2e7d32; color: white; border: none; }
    .stop { background: #c62828; color: white; border: none; margin-top: 8px; }
    .hint { font-size: 0.85em; color: #666; margin-top: 4px; }
  </style>
</head>
<body>
  <h1>На расстояние (по времени)</h1>
  <label>Расстояние (м): <input type="number" id="dist" step="0.1" value="1"></label>
  <p class="hint">>0 вперёд, &lt;0 назад.</p>
  <label>PWM (1–255, по умолч. 150): <input type="number" id="pwm" min="1" max="255" placeholder="150"></label>
  <p class="hint">При PWM 150: 1 м за ~2 с.</p>
  <div style="display: flex; gap: 8px;">
    <button class="go" style="flex: 1;" onclick="driveDist(1)">Вперёд</button>
    <button class="go" style="flex: 1;" onclick="driveDist(-1)">Назад</button>
  </div>
  <button class="go" style="margin-top: 8px;" onclick="driveDistFromInput()">Ехать на N м</button>

  <h1 style="margin-top: 24px;">Повороты</h1>
  <p class="hint">При 150/-150: 90° за 500 мс. &gt;0 влево, &lt;0 вправо.</p>
  <label>Угол (град): <input type="number" id="angle" step="15" value="90" placeholder="90"></label>
  <label>PWM (необяз.): <input type="number" id="turnPwm" min="1" max="255" placeholder="150"></label>
  <div style="display: flex; gap: 8px; margin-top: 8px;">
    <button class="go" style="flex: 1;" onclick="turn(-90)">→ 90°</button>
    <button class="go" style="flex: 1;" onclick="turn(90)">← 90°</button>
  </div>
  <div style="display: flex; gap: 8px; margin-top: 4px;">
    <button class="go" style="flex: 1;" onclick="turn(-45)">→ 45°</button>
    <button class="go" style="flex: 1;" onclick="turn(45)">← 45°</button>
  </div>
  <button class="go" style="margin-top: 8px;" onclick="turnByInput()">Повернуть на угол</button>

  <h1 style="margin-top: 24px;">Подъём груза</h1>
  <div style="display: flex; gap: 8px;">
    <button class="go" style="flex: 1;" onclick="liftUp()">Поднять</button>
    <button class="go" style="flex: 1;" onclick="liftDown()">Опустить</button>
  </div>

  <button class="stop" onclick="stop()">Стоп</button>
  <p id="msg"></p>
  <script>
    function liftUp() {
      document.getElementById('msg').textContent = 'Подъём...';
      fetch('/lift_up')
        .then(function(r){ if (!r.ok) throw new Error(r.status); return r.text(); })
        .then(function(t){ document.getElementById('msg').textContent = 'Отправлено: ' + t; })
        .catch(function(){ document.getElementById('msg').textContent = 'Ошибка связи'; });
    }
    function liftDown() {
      document.getElementById('msg').textContent = 'Опускание...';
      fetch('/lift_down')
        .then(function(r){ if (!r.ok) throw new Error(r.status); return r.text(); })
        .then(function(t){ document.getElementById('msg').textContent = 'Отправлено: ' + t; })
        .catch(function(){ document.getElementById('msg').textContent = 'Ошибка связи'; });
    }
    function driveDist(sign) {
      var d = document.getElementById('dist').value;
      var pwm = document.getElementById('pwm').value;
      var v = sign ? sign * Math.abs(parseFloat(d) || 1) : parseFloat(d);
      if (!isFinite(v) || Math.abs(v) < 0.01) { document.getElementById('msg').textContent = 'Расстояние |d| >= 0.01'; return; }
      document.getElementById('msg').textContent = 'Отправляю...';
      var url = '/drive_dist?d=' + encodeURIComponent(v);
      if (pwm) url += '&pwm=' + encodeURIComponent(pwm);
      fetch(url)
        .then(function(r){ if (!r.ok) throw new Error(r.status); return r.text(); })
        .then(function(t){ document.getElementById('msg').textContent = 'Отправлено: ' + t; })
        .catch(function(){ document.getElementById('msg').textContent = 'Ошибка связи'; });
    }
    function driveDistFromInput() { driveDist(0); }
    function turn(angle) {
      document.getElementById('msg').textContent = 'Поворот ' + angle + '°...';
      var url = '/turn?angle=' + angle;
      fetch(url)
        .then(function(r){ if (!r.ok) throw new Error(r.status); return r.text(); })
        .then(function(t){ document.getElementById('msg').textContent = 'Отправлено: ' + t; })
        .catch(function(){ document.getElementById('msg').textContent = 'Ошибка связи'; });
    }
    function turnByInput() {
      var angle = document.getElementById('angle').value;
      var pwm = document.getElementById('turnPwm').value;
      if (!angle) { document.getElementById('msg').textContent = 'Введите угол'; return; }
      document.getElementById('msg').textContent = 'Поворот...';
      var url = '/turn?angle=' + encodeURIComponent(angle);
      if (pwm) url += '&pwm=' + encodeURIComponent(pwm);
      fetch(url)
        .then(function(r){ if (!r.ok) throw new Error(r.status); return r.text(); })
        .then(function(t){ document.getElementById('msg').textContent = 'Отправлено: ' + t; })
        .catch(function(){ document.getElementById('msg').textContent = 'Ошибка связи'; });
    }
    function stop() {
      document.getElementById('msg').textContent = 'Отправляю STOP...';
      fetch('/stop').then(function(r){ return r.text(); })
        .then(function(t){ document.getElementById('msg').textContent = 'Отправлено: STOP'; })
        .catch(function(){ document.getElementById('msg').textContent = 'Ошибка связи'; });
    }
  </script>
</body>
</html>
)raw";
}

void setup() {
  Serial.begin(ROBOT_BAUD);
  delay(500);

  WiFi.mode(WIFI_AP);
  WiFi.softAP(ap_ssid, ap_password);
  IPAddress ip = WiFi.softAPIP();

  server.on("/", handleRoot);
  server.on("/drive_dist", handleDriveDist);
  server.on("/turn", handleTurn);
  server.on("/lift_up", handleLiftUp);
  server.on("/lift_down", handleLiftDown);
  server.on("/stop", handleStop);
  server.on("/pwm", handlePwm);
  server.begin();
}

void loop() {
  server.handleClient();
}
