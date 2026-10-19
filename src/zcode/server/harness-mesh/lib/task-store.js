/** 任务注册表:JSONL 追加写,latest-wins,启动时重建内存索引。
 *
 *  为什么不引 SQLite:零新依赖(方案 §2.6);任务量级(百/千条)JSONL 完全够用,
 *  崩溃最多丢最后一条未刷盘记录,任务语义上可接受。
 *  路径:$DSH_HOME/harness-mesh/tasks.jsonl
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const ACTIVE_STATES = new Set(["queued", "running"]);

export class TaskStore {
  constructor(file) {
    this.file = file;
    /** @type {Map<string, object>} */
    this.tasks = new Map();
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed);
          if (entry && typeof entry.task_id === "string") this.tasks.set(entry.task_id, entry);
        } catch { /* 跳过坏行(截断的尾行) */ }
      }
    }
  }

  create(entry) {
    this.tasks.set(entry.task_id, entry);
    this.#append(entry);
    return entry;
  }

  update(task_id, patch) {
    const prev = this.tasks.get(task_id);
    if (!prev) throw new Error(`harness-mesh: 任务 ${task_id} 不存在`);
    const next = { ...prev, ...patch, task_id, updated_at: new Date().toISOString() };
    this.tasks.set(task_id, next);
    this.#append(next);
    return next;
  }

  get(task_id) {
    return this.tasks.get(task_id);
  }

  list() {
    return [...this.tasks.values()];
  }

  /** 某节点在跑/排队的任务数(供 harness_list 展示负载)。 */
  countRunning(harness) {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.harness === harness && ACTIVE_STATES.has(task.state)) count++;
    }
    return count;
  }

  #append(entry) {
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
  }
}
