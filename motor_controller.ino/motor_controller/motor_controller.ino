#define IN1 5
#define IN2 6
#define IN3 9
#define IN4 10

#define in1 3
#define in2 2
#define in3 4
#define in4 7

int dl = 5;

void setMotor(int speed1, int speed2) {
  if (speed1 > 0) {
    analogWrite(IN1, abs(speed1));
    digitalWrite(IN2, LOW);
  } else if (speed1 < 0) {
    analogWrite(IN2, abs(speed1));
    digitalWrite(IN1, LOW);
  } else {
    digitalWrite(IN1, LOW);
    digitalWrite(IN2, LOW);
  }

  if (speed2 > 0) {
    analogWrite(IN3, abs(speed2));
    digitalWrite(IN4, LOW);
  } else if (speed2 < 0) {
    analogWrite(IN4, abs(speed2));
    digitalWrite(IN3, LOW);
  } else {
    digitalWrite(IN3, LOW);
    digitalWrite(IN4, LOW);
  }
}

void up() {
  digitalWrite(in1, HIGH);
  digitalWrite(in2, LOW);
  digitalWrite(in3, LOW);
  digitalWrite(in4, HIGH);
  delay(dl);

  digitalWrite(in1, HIGH);
  digitalWrite(in2, HIGH);
  digitalWrite(in3, LOW);
  digitalWrite(in4, LOW);
  delay(dl);

  digitalWrite(in1, LOW);
  digitalWrite(in2, HIGH);
  digitalWrite(in3, HIGH);
  digitalWrite(in4, LOW);
  delay(dl);

  digitalWrite(in1, LOW);
  digitalWrite(in2, LOW);
  digitalWrite(in3, HIGH);
  digitalWrite(in4, HIGH);
  delay(dl);
}

void down() {
  digitalWrite(in4, HIGH);
  digitalWrite(in3, LOW);
  digitalWrite(in2, LOW);
  digitalWrite(in1, HIGH);
  delay(dl);

  digitalWrite(in4, HIGH);
  digitalWrite(in3, HIGH);
  digitalWrite(in2, LOW);
  digitalWrite(in1, LOW);
  delay(dl);

  digitalWrite(in4, LOW);
  digitalWrite(in3, HIGH);
  digitalWrite(in2, HIGH);
  digitalWrite(in1, LOW);
  delay(dl);

  digitalWrite(in4, LOW);
  digitalWrite(in3, LOW);
  digitalWrite(in2, HIGH);
  digitalWrite(in1, HIGH);
  delay(dl);
}

void setup() {
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);
  pinMode(in1, OUTPUT);
  pinMode(in2, OUTPUT);
  pinMode(in3, OUTPUT);
  pinMode(in4, OUTPUT);

  Serial.begin(9600);
}

void loop() {
  if (Serial.available() > 0) {
    char cmd = Serial.read();

    switch (cmd) {
      case 'f':
        setMotor(200, 200);
        break;
      case 'b':
        setMotor(-200, -200);
        break;
      case 's':
        setMotor(0, 0);
        break;
      case 'u':
        for (int i = 0; i < 72; i++) up();  // как в вашем оригинальном коде
        break;
      case 'd':
        for (int i = 0; i < 72; i++) down();
        break;
      case 'r':
        setMotor(-200, 200);
        break;
      case 'l':
        setMotor(200, -200);
      default:
        // Игнорировать неизвестные команды
        break;
    }
  }
}