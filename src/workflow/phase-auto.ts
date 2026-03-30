/**
 * Auto phase — returns needs-planning if no tasks, otherwise delegates
 * to single (1 task) or parallel (multiple tasks) execution.
 */

export function executeAutoPhase({ tasks }: { tasks: readonly string[] | undefined }) {
  if (!tasks || tasks.length === 0) {
    return { type: "needs-planning" as const };
  }
  return { type: "has-tasks" as const, tasks };
}
