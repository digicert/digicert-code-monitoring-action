/**
 * @name STM reachability: internal call edges
 * @kind table
 * @id stm/reachability/js/edges
 */

import Common

from DataFlow::InvokeNode call, StmtContainer caller, Function callee
where
  caller = call.getContainer() and
  callee = call.getACallee() and
  isAppCode(caller) and
  isAppCode(callee)
select caller.getFile().getRelativePath(), caller.getLocation().getStartLine(),
  callee.getFile().getRelativePath(), callee.getLocation().getStartLine(), call.getStartLine()
