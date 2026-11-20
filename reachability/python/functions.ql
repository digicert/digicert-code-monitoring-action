/**
 * @name STM reachability: functions
 * @kind table
 * @id stm/reachability/py/functions
 */

import Common

from Container c, File f
where isAppCode(c) and f = c.getLocation().getFile()
select f.getRelativePath(), c.startLine(), c.displayName(),
  any(boolean b | if isTestFile(f) then b = true else b = false)
