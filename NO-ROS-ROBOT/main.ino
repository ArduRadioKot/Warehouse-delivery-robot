#include <GyverStepper.h>

#define LEFT_MOTOR_A 8     // Цифровой выход (левый мотор). Если 0 - едем вперед
#define LEFT_MOTOR_B 12    // Цифровой выход (левый мотор). Если 0 - едем назад
#define RIGHT_MOTOR_A 7    // Цифровой выход (правый мотор). Если 0 - едем вперед
#define RIGHT_MOTOR_B 5    // Цифровой выход (правый мотор). Если 0 - едем назад

#define LEFT_ENCODER_A 0   // Цифровой вход, канал A энкодера левого колеса
#define LEFT_ENCODER_B 2   // Цифровой вход, канал B энкодера левого колеса
#define RIGHT_ENCODER_A 4 // Цифровой вход, канал A энкодера правого колеса
#define RIGHT_ENCODER_B 6 // Цифровой вход, канал B энкодера правого колеса

// Шаговый мотор подъёма груза (200 шагов/об, пины STEP, DIR, EN или инвертированные)
GStepper<STEPPER2WIRE> stepper(200, 35, 33, 31);
const long LIFT_UP_POS = 400;    // целевая позиция при подъёме (шаги)
const long LIFT_DOWN_POS = 0;    // целевая позиция при опускании

volatile long left_encoder_value = 0;
volatile long right_encoder_value = 0;

long last_left_encoder = 0;
long last_right_encoder = 0;

// Одометрия: положение в метрах и радианах
float xPos = 0.0f;   // м
float yPos = 0.0f;   // м
float theta = 0.0f;  // рад (курс)

// Целевая точка в метрах и флаг режима "ехать к точке"
float targetX = 0.0f;
float targetY = 0.0f;
bool movingToTarget = false;

// Движение на расстояние по времени: при PWM 150 робот проезжает 1 м за 2 с
bool drivingDist = false;
uint32_t driveEndTime = 0;
const int DRIVE_DIST_PWM_DEFAULT = 150;  // ШИМ по умолчанию для DRIVE_DIST
const float DRIVE_DIST_M_PER_2S_AT_150 = 1.0f;  // 1 м за 2 с при PWM 150

// Поворот на месте: при PWM 150/-150 робот поворачивается на 90° за 500 мс
bool turning = false;
uint32_t turnEndTime = 0;
const int TURN_PWM_DEFAULT = 150;
const float TURN_90_DEG_MS_AT_150 = 400.0f;  // 90° за 500 мс при PWM 150

// Параметры колёс (как в других скетчах)
const float WHEEL_DIAMETER_MM = 68.0f;
const float WHEEL_BASE_MM = 185.0f;
const float ENCODER_RESOLUTION = 330.0f;
const float TICKS_TO_MM = (3.14159265f * WHEEL_DIAMETER_MM) / ENCODER_RESOLUTION;
const float WHEEL_BASE_M = WHEEL_BASE_MM / 1000.0f;

// Регулятор движения к точке
const float KP_ANGLE = 2.0f;   // по углу (подбери по роботу)
const float KP_DIST   = 0.5f;  // по расстоянию
const float MAX_LIN_M_S = 0.25f;   // макс. линейная скорость м/с
const float MAX_ANG_RAD_S = 1.2f;  // макс. угловая скорость рад/с
const float ARRIVAL_DIST_M = 0.03f; // считаем "приехали", если осталось < 3 см

void left_interrupt() {
  digitalRead(LEFT_ENCODER_B) ? left_encoder_value++ : left_encoder_value--;
}
void right_interrupt() {
  digitalRead(RIGHT_ENCODER_B) ? right_encoder_value++ : right_encoder_value--;
}

void updateOdometry() {
  long dL = left_encoder_value - last_left_encoder;
  long dR = right_encoder_value - last_right_encoder;
  last_left_encoder = left_encoder_value;
  last_right_encoder = right_encoder_value;

  float distL_mm = dL * TICKS_TO_MM;
  float distR_mm = dR * TICKS_TO_MM;
  float distL_m = distL_mm / 1000.0f;
  float distR_m = distR_mm / 1000.0f;

  float deltaS = (distL_m + distR_m) * 0.5f;
  float deltaTheta = (distR_m - distL_m) / WHEEL_BASE_M;

  theta += deltaTheta;
  xPos += deltaS * cos(theta);
  yPos += deltaS * sin(theta);
}

// Нормализация угла в [-PI, PI]
float normalizeAngle(float a) {
  while (a > 3.14159265f) a -= 6.28318531f;
  while (a < -3.14159265f) a += 6.28318531f;
  return a;
}

// Управление моторами по линейной (м/с) и угловой (рад/с) скорости
void setVelocity(float vLin, float vAng) {
  float vL = vLin - vAng * (WHEEL_BASE_M * 0.5f);
  float vR = vLin + vAng * (WHEEL_BASE_M * 0.5f);

  // Переводим в ШИМ (примерно: 0.2 м/с -> ~150)
  const float gain = 255.0f / 0.25f;
  int leftPwm = (int)(vL * gain);
  int rightPwm = (int)(vR * gain);
  leftPwm = constrain(leftPwm, -255, 255);
  rightPwm = constrain(rightPwm, -255, 255);

  int leftA = 0, leftB = 0, rightA = 0, rightB = 0;
  if (leftPwm >= 0) { leftB = leftPwm;  leftA = 0; } else { leftA = -leftPwm; leftB = 0; }
  if (rightPwm >= 0) { rightB = rightPwm; rightA = 0; } else { rightA = -rightPwm; rightB = 0; }

  setMotorsPWM(leftA, leftB, rightA, rightB);
}

void driveToTarget() {
  float dx = targetX - xPos;
  float dy = targetY - yPos;
  float dist = sqrt(dx * dx + dy * dy);

  if (dist < ARRIVAL_DIST_M) {
    setMotorsPWM(0, 0, 0, 0);
    movingToTarget = false;
    Serial.println("OK: Arrived");
    return;
  }

  float angleToTarget = atan2(dy, dx);
  float angleErr = normalizeAngle(angleToTarget - theta);

  float w = KP_ANGLE * angleErr;
  w = constrain(w, -MAX_ANG_RAD_S, MAX_ANG_RAD_S);

  float v = KP_DIST * dist;
  v = constrain(v, 0.0f, MAX_LIN_M_S);

  setVelocity(v, w);
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("System started");

  attachInterrupt(digitalPinToInterrupt(LEFT_ENCODER_A), left_interrupt, RISING);
  attachInterrupt(digitalPinToInterrupt(RIGHT_ENCODER_A), right_interrupt, RISING);

  pinMode(LEFT_MOTOR_A, OUTPUT);
  pinMode(LEFT_MOTOR_B, OUTPUT);
  pinMode(RIGHT_MOTOR_A, OUTPUT);
  pinMode(RIGHT_MOTOR_B, OUTPUT);

  pinMode(LEFT_ENCODER_A, INPUT);
  pinMode(LEFT_ENCODER_B, INPUT);
  pinMode(RIGHT_ENCODER_A, INPUT);
  pinMode(RIGHT_ENCODER_B, INPUT);

  // Степпер подъёма: режим следования к позиции, плавный разгон
  stepper.setRunMode(FOLLOW_POS);
  stepper.setMaxSpeed(400);
  stepper.setAcceleration(500);
  stepper.setTarget(0);  // стартовая позиция — опущено
}

void loop() {
  if (Serial.available()) {
    String command = Serial.readStringUntil('\n');
    processCommand(command);
  }

  updateOdometry();

  if (movingToTarget) {
    driveToTarget();
  }

  // Останов по таймеру после DRIVE_DIST
  if (drivingDist && millis() >= driveEndTime) {
    setMotorsPWM(0, 0, 0, 0);
    drivingDist = false;
  }

  // Останов по таймеру после TURN
  if (turning && millis() >= turnEndTime) {
    setMotorsPWM(0, 0, 0, 0);
    turning = false;
  }

  // Обновление степпера подъёма (плавное движение с ускорением)
  stepper.tick();

  static uint32_t printTimer = 0;
  if (millis() - printTimer > 100) {
    Serial.print(" x=");  Serial.print(xPos, 3);
    Serial.print(" y=");  Serial.print(yPos, 3);
    Serial.print(" th="); Serial.print(theta, 3);
    Serial.print(" L=");  Serial.print(left_encoder_value);
    Serial.print(" R=");  Serial.println(right_encoder_value);
    printTimer = millis();
  }
}

bool parseGoTo(const String& cmd, float* x, float* y) {
  int i1 = cmd.indexOf(' ');
  if (i1 < 0) return false;
  int i2 = cmd.indexOf(' ', i1 + 1);
  if (i2 < 0) return false;
  *x = cmd.substring(i1 + 1, i2).toFloat();
  *y = cmd.substring(i2 + 1).toFloat();
  return true;
}

// DRIVE_DIST distance_m [pwm] — ехать на distance_m метров по времени. >0 вперёд, <0 назад.
bool parseDriveDist(const String& cmd, float* dist_m, int* pwm) {
  int i1 = cmd.indexOf(' ');
  if (i1 < 0) return false;
  int i2 = cmd.indexOf(' ', i1 + 1);
  *dist_m = cmd.substring(i1 + 1, i2 > 0 ? i2 : cmd.length()).toFloat();
  *pwm = DRIVE_DIST_PWM_DEFAULT;
  if (i2 > 0) {
    String rest = cmd.substring(i2 + 1);
    rest.trim();
    if (rest.length() > 0) *pwm = rest.toInt();
  }
  *pwm = constrain(*pwm, 1, 255);
  return (*dist_m > 0.01f || *dist_m < -0.01f);
}

// TURN angle_deg [pwm] — поворот на месте. angle > 0 = влево (CCW), angle < 0 = вправо (CW). 90° за 500 мс при PWM 150.
bool parseTurn(const String& cmd, float* angle_deg, int* pwm) {
  int i1 = cmd.indexOf(' ');
  if (i1 < 0) return false;
  int i2 = cmd.indexOf(' ', i1 + 1);
  *angle_deg = cmd.substring(i1 + 1, i2 > 0 ? i2 : cmd.length()).toFloat();
  *pwm = TURN_PWM_DEFAULT;
  if (i2 > 0) {
    String rest = cmd.substring(i2 + 1);
    rest.trim();
    if (rest.length() > 0) *pwm = rest.toInt();
  }
  *pwm = constrain(*pwm, 1, 255);
  return (*angle_deg > 0.1f || *angle_deg < -0.1f);
}

void processCommand(String command) {
  command.trim();
  if (command.startsWith("SET_PWM")) {
    int leftA_PWM = 0, leftB_PWM = 0, rightA_PWM = 0, rightB_PWM = 0;
    if (parseSetPWM(command, &leftA_PWM, &leftB_PWM, &rightA_PWM, &rightB_PWM)) {
      setMotorsPWM(leftA_PWM, leftB_PWM, rightA_PWM, rightB_PWM);
      movingToTarget = false;
      drivingDist = false;
      turning = false;
      Serial.println("OK: Set PWM");
    }
    return;
  }
  if (command.startsWith("TURN")) {
    float angle = 0.0f;
    int pwm = TURN_PWM_DEFAULT;
    if (parseTurn(command, &angle, &pwm)) {
      movingToTarget = false;
      drivingDist = false;
      // 90° за 500 мс при pwm 150 → время = |angle|/90 * 500 * (150/pwm)
      unsigned long time_ms = (unsigned long)(fabs(angle) / 90.0f * TURN_90_DEG_MS_AT_150 * (float)TURN_PWM_DEFAULT / (float)pwm);
      if (angle > 0) {
        setMotorsPWM(pwm, 0, 0, pwm);  // влево: левое назад, правое вперёд
      } else {
        setMotorsPWM(0, pwm, pwm, 0);  // вправо: левое вперёд, правое назад
      }
      turnEndTime = millis() + time_ms;
      turning = true;
      Serial.print("OK: TURN "); Serial.print(angle, 0); Serial.print(" deg, "); Serial.print(time_ms); Serial.println(" ms");
    } else {
      Serial.println("ERROR: TURN angle_deg [pwm]  (angle >0 left, <0 right)");
    }
    return;
  }
  if (command.startsWith("DRIVE_DIST")) {
    float d = 0.0f;
    int pwm = DRIVE_DIST_PWM_DEFAULT;
    if (parseDriveDist(command, &d, &pwm)) {
      movingToTarget = false;
      turning = false;
      float abs_d = fabs(d);
      // При PWM 150: 1 м за 2 с → время = |d| * 2 * (150/pwm) с
      unsigned long time_ms = (unsigned long)(abs_d * 2000.0f * (float)DRIVE_DIST_PWM_DEFAULT / (float)pwm);
      if (d >= 0) {
        setMotorsPWM(0, pwm, 0, pwm);  // вперёд
      } else {
        setMotorsPWM(pwm, 0, pwm, 0);  // назад
      }
      driveEndTime = millis() + time_ms;
      drivingDist = true;
      Serial.print("OK: DRIVE_DIST "); Serial.print(d, 2); Serial.print(" m, PWM "); Serial.print(pwm); Serial.print(", "); Serial.print(time_ms / 1000.0f, 1); Serial.println(" s");
    } else {
      Serial.println("ERROR: DRIVE_DIST distance_m [pwm]");
    }
    return;
  }
  if (command.startsWith("GO_TO")) {
    float x = 0, y = 0;
    if (parseGoTo(command, &x, &y)) {
      targetX = x;
      targetY = y;
      movingToTarget = true;
      drivingDist = false;
      turning = false;
      Serial.print("OK: Going to "); Serial.print(x, 3); Serial.print(" "); Serial.println(y, 3);
    } else {
      Serial.println("ERROR: GO_TO x y (meters)");
    }
    return;
  }
  if (command.startsWith("LIFT_UP")) {
    stepper.setTarget(LIFT_UP_POS);
    Serial.println("OK: Lift up");
    return;
  }
  if (command.startsWith("LIFT_DOWN")) {
    stepper.setTarget(LIFT_DOWN_POS);
    Serial.println("OK: Lift down");
    return;
  }
  if (command.startsWith("STOP")) {
    movingToTarget = false;
    drivingDist = false;
    turning = false;
    setMotorsPWM(0, 0, 0, 0);
    Serial.println("OK: Stopped");
    return;
  }
  Serial.println("ERROR: Unknown command");
}

bool parseSetPWM(const String& command, int* leftA_PWM, int* leftB_PWM, int* rightA_PWM, int* rightB_PWM) {
  int index = command.indexOf(' ');
  if (index == -1) return false;
  String params = command.substring(index + 1);
  params.trim();

  int idx1 = params.indexOf(' ');
  if (idx1 == -1) return false;
  int idx2 = params.indexOf(' ', idx1 + 1);
  if (idx2 == -1) return false;
  int idx3 = params.indexOf(' ', idx2 + 1);
  if (idx3 == -1) return false;

  *leftA_PWM  = params.substring(0, idx1).toInt();
  *leftB_PWM  = params.substring(idx1 + 1, idx2).toInt();
  *rightA_PWM = params.substring(idx2 + 1, idx3).toInt();
  *rightB_PWM = params.substring(idx3 + 1).toInt();
  return true;
}

void setMotorsPWM(int leftA, int leftB, int rightA, int rightB) {
  leftA  = constrain(leftA, 0, 255);
  leftB  = constrain(leftB, 0, 255);
  rightA = constrain(rightA, 0, 255);
  rightB = constrain(rightB, 0, 255);
  analogWrite(LEFT_MOTOR_A,  leftA);
  analogWrite(LEFT_MOTOR_B,  leftB);
  analogWrite(RIGHT_MOTOR_A, rightA);
  analogWrite(RIGHT_MOTOR_B, rightB);
}
