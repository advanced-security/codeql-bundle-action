import java
/* Use a private import to prevent conflicting declarations (e.g., StrutsXMLFile both defined in frameworks and experimental).*/
private import semmle.code.java.dataflow.FlowSources

class TestSource extends RemoteFlowSource {
  TestSource() { exists(MethodAccess ma | ma.getMethod().hasName("source") | this.asExpr() = ma) }

  override string getSourceType() { result = "TestSource" }
}
