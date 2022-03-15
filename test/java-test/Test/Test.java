class Test {
  Test() {}
  String source() { return "untrusted data"; }

  void sink(String arg) {}

  void test() {
    String data = source();
    sink(data);
  }
}