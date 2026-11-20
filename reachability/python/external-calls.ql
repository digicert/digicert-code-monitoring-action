/**
 * @name STM reachability: calls into third-party packages
 * @kind table
 * @id stm/reachability/py/external-calls
 */

import Common
import semmle.python.ApiGraphs

/** API nodes that represent a use of top-level module `pkg`, labelled with the member used. */
API::Node packageUse(string pkg, string member) {
  result = API::moduleImport(pkg) and member = "(default)"
  or
  result = API::moduleImport(pkg).getMember(member)
  or
  result = API::moduleImport(pkg).getMember(_).getMember(member)
  or
  result = API::moduleImport(pkg).getMember(_).getReturn().getMember(member)
}

from API::CallNode call, Container caller, string pkg, string member
where
  call = packageUse(pkg, member).getACall() and
  not pkg.matches("%.%") and
  caller = containerOf(call.getScope()) and
  isAppCode(caller)
select caller.getLocation().getFile().getRelativePath(), caller.startLine(), pkg, member,
  call.getLocation().getStartLine()
