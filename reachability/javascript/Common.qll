import javascript

/** Name shown for a function or module body in the call graph. */
string containerName(StmtContainer c) {
  result = c.(Function).describe()
  or
  c instanceof TopLevel and result = "module " + c.getFile().getBaseName()
}

/** True for code that only runs in tests, so paths starting there can be flagged. */
predicate isTestFile(File f) {
  f.getRelativePath().regexpMatch("(?i).*(^|/)(test|tests|__tests__|spec|__mocks__)/.*")
  or
  f.getBaseName().regexpMatch("(?i).*\\.(test|spec)\\.[cm]?[jt]sx?")
}

predicate isAppCode(StmtContainer c) {
  exists(c.getFile().getRelativePath()) and
  not c.getFile().getRelativePath().matches("%node_modules/%")
}
