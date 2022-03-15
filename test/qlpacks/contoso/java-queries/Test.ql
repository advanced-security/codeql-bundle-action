import java
import semmle.code.java.dataflow.DataFlow
import semmle.code.java.dataflow.FlowSources

class TestConfig extends DataFlow::Configuration {
  TestConfig() { this = "test" }

  override predicate isSource(DataFlow::Node n) { n instanceof RemoteFlowSource }

  override predicate isSink(DataFlow::Node n) {
    exists(MethodAccess ma | ma.getMethod().hasName("sink") | ma.getAnArgument() = n.asExpr())
  }
}

from TestConfig config, DataFlow::Node source, DataFlow::Node sink
where config.hasFlow(source, sink)
select sink, "Found flow from $@", source, "source"
