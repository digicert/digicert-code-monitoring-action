/**
 * @name STM reachability: internal call edges
 * @kind table
 * @id stm/reachability/py/edges
 */

import Common
import semmle.python.dataflow.new.internal.DataFlowDispatch as Dispatch

from CallNode call, Container caller, Function callee
where
  Dispatch::resolveCall(call, callee, _) and
  caller = containerOf(call.getScope()) and
  isAppCode(caller) and
  isAppCode(callee)
select caller.getLocation().getFile().getRelativePath(), caller.startLine(),
  callee.getLocation().getFile().getRelativePath(), callee.getLocation().getStartLine(),
  call.getLocation().getStartLine()
