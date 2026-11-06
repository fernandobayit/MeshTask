'use strict';
class TaskError extends Error {
  constructor(code, message) { super(message); this.name = 'TaskError'; this.code = code; }
}
function ensure(condition, code, message) { if (!condition) throw new TaskError(code, message); }
module.exports = { TaskError, ensure };
