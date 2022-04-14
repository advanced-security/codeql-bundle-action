import ruby
import codeql.ruby.DataFlow
import codeql.ruby.dataflow.RemoteFlowSources

class TestSource extends RemoteFlowSource::Range {
  TestSource() { this.(DataFlow::CallNode).getMethodName() = "source" }

  override string getSourceType() { result = "test" }
}
