#include "GyverPortal.h"

GyverPortal ui;

void build() {
  GP.BUILD_BEGIN(GP_DARK);
  GP.TITLE("FGSDrones", "t1");
  GP.HR();
  GP.BUTTON("up", "Start");    // → 'u'
  GP.BUTTON("frw", "Forward"); // → 'f'
  GP.BUTTON("dwn", "DOWN");   // → 's' (остановка одного мотора? или используем как поворот — но в вашем коде нет 'r')
  GP.BUTTON("lft", "stop");
  GP.BUTTON("rgh", "Rright") ;   // → 's' (аналогично)
  GP.BUTTON("bck", "Back");    // → 'b'
  GP.BUTTON("lnd", "stop"); // → 's' (стоп)
}

void action() {
  if (ui.click()) {
    if (ui.click("up"))   Serial.write('u');
    if (ui.click("frw"))  Serial.write('f');
    if (ui.click("bck"))  Serial.write('b');
    if (ui.click("lnd"))  Serial.write('s');
    if(ui.click("rgh"))   Serial.write('r');
    // Для поворотов: в вашем исходном коде нет 'r'/'l', но есть 'u' и 'd' (вероятно, подъём/спуск)
    // Если "Right"/"Left" должны крутить шаговик — можно использовать 'u'/'d', но это неочевидно.
    // Пока отправим 's' (стоп), чтобы не ломать логику.
    if (ui.click("dwn"))  Serial.write('d');
    if (ui.click("lft"))  Serial.write('l');
  }
}

void setup() {
  // Инициализируем Serial0 для связи с Arduino Nano (скорость 9600!)
  Serial.begin(9600);

  // Режим точки доступа
  WiFi.mode(WIFI_AP);
  WiFi.softAP("Drone");

  // Настройка GyverPortal
  ui.attachBuild(build);
  ui.attach(action);
  ui.start();
}

void loop() {
  ui.tick(); // Обработка веб-интерфейса
}