import python

/** A function or module body, i.e. a node in the call graph. */
class Container extends Scope {
  Container() { this instanceof Function or this instanceof Module }

  string displayName() {
    result = "function " + this.(Function).getQualifiedName()
    or
    result = "module " + this.(Module).getName()
  }

  int startLine() {
    result = this.(Function).getLocation().getStartLine()
    or
    this instanceof Module and result = 1
  }
}

/** The innermost function or module containing scope `s`; class bodies collapse into their module. */
Container containerOf(Scope s) {
  result = s and s instanceof Container
  or
  not s instanceof Container and result = containerOf(s.getScope())
}

predicate isTestFile(File f) {
  f.getRelativePath().regexpMatch("(?i).*(^|/)(test|tests)/.*")
  or
  f.getBaseName().regexpMatch("(?i)(test_.*|.*_test|conftest)\\.py")
}

predicate isAppCode(Container c) {
  exists(c.getLocation().getFile().getRelativePath()) and
  not c.getLocation().getFile().getRelativePath().regexpMatch(".*(site-packages|\\.venv|venv)/.*")
}
