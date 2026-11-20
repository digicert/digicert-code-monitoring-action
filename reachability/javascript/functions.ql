/**
 * @name STM reachability: functions
 * @kind table
 * @id stm/reachability/js/functions
 */

import Common

from StmtContainer c
where isAppCode(c) and (c instanceof Function or c instanceof TopLevel)
select c.getFile().getRelativePath(), c.getLocation().getStartLine(), containerName(c),
  any(boolean b | if isTestFile(c.getFile()) then b = true else b = false)
