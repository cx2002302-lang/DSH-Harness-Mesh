/** 节点存储:nodes.json(GUI 可写)+ patch 配置种子合并。
 *
 *  合并规则:启动时先灌 patch 种子,再用 nodes.json 覆盖(同名以 nodes.json 为准);
 *  GUI 删除 patch 种子节点时记 tombstone(否则重启后种子会把它复活);
 *  GUI 的增改删只写 nodes.json,不碰 profile patch。
 *  路径:$DSH_HOME/harness-mesh/nodes.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateNode } from "./config.js";

export class NodesStore {
  constructor(file) {
    this.file = file;
    /** @type {Map<string, object>} */
    this.nodes = new Map();
    /** patch 种子名(删除时要记 tombstone) */
    this.seeds = new Set();
    mkdirSync(dirname(file), { recursive: true });
  }

  /** @param seeds patch 配置里的节点(Record<name, node>) */
  load(seeds = {}) {
    this.nodes.clear();
    this.seeds.clear();
    // 1) patch 种子为底(全部记入 seeds,tombstone 才能在多次重启后持续生效)
    for (const [name, node] of Object.entries(seeds)) {
      this.seeds.add(name);
      this.nodes.set(name, validateNode(name, node));
    }
    // 2) nodes.json 覆盖:先应用 tombstone 删除,再灌 GUI 节点(同名以 GUI 为准)
    if (existsSync(this.file)) {
      try {
        const data = JSON.parse(readFileSync(this.file, "utf8"));
        const deleted = Array.isArray(data?.deleted) ? data.deleted.filter((n) => typeof n === "string") : [];
        for (const name of deleted) this.nodes.delete(name);
        for (const node of data?.nodes ?? []) {
          this.nodes.set(node.name, validateNode(node.name, node));
        }
      } catch (error) {
        console.log(`[harness-mesh] nodes.json 损坏,已忽略(继续用 patch 种子): ${String(error)}`);
      }
    }
    return this;
  }

  list() {
    return [...this.nodes.values()];
  }

  get(name) {
    return this.nodes.get(name) ?? null;
  }

  /** 新增或覆盖(校验 + 落盘)。 */
  save(node) {
    const name = typeof node?.name === "string" ? node.name.trim() : "";
    const normalized = validateNode(name, node);
    this.nodes.set(name, normalized);
    this.#flush();
    return normalized;
  }

  remove(name) {
    const existed = this.nodes.delete(name);
    if (existed) this.#flush();
    return existed;
  }

  #flush() {
    const payload = { version: 1, nodes: this.list(), deleted: [...this.seeds].filter((n) => !this.nodes.has(n)) };
    writeFileSync(this.file, `${JSON.stringify(payload, null, 2)}\n`);
  }
}
