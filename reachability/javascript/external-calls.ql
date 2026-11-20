/**
 * @name STM reachability: calls into third-party packages
 * @kind table
 * @id stm/reachability/js/external-calls
 */

import Common

/** API nodes that represent a use of package `pkg`, labelled with the member used. */
API::Node packageUse(string pkg, string member) {
  result = API::moduleImport(pkg) and member = "(default)"
  or
  result = API::moduleImport(pkg).getMember(member)
  or
  result = API::moduleImport(pkg).getReturn().getMember(member)
  or
  result = API::moduleImport(pkg).getInstance().getMember(member)
  or
  result = API::moduleImport(pkg).getMember(_).getReturn().getMember(member)
}

from DataFlow::InvokeNode call, StmtContainer caller, string pkg, string member
where
  call = packageUse(pkg, member).getAnInvocation() and
  caller = call.getContainer() and
  isAppCode(caller)
select caller.getFile().getRelativePath(), caller.getLocation().getStartLine(), pkg, member,
  call.getStartLine()
