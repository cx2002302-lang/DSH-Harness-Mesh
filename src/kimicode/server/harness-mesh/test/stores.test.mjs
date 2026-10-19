/** 三个小而纯的存储/配置模块单元测试(node:test + node:assert/strict):
 *  ① lib/config.js    —— validateNode 校验/归一化 + normalizeConfig 默认值/透传
 *  ② lib/nodes-store.js —— NodesStore load/save/remove(缺文件、坏 JSON、tombstone、并发写、符号链接)
 *  ③ lib/task-store.js  —— TaskStore CRUD/JSONL 持久化/重启恢复
 * 运行:cd harness-mesh && node --test test/stores.test.mjs
 * 约束:fs 只用 node:os.tmpdir() 下 mkdtemp 临时目录;不碰网络/子进程;无定长 sleep。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeConfig, validateNode } from "../lib/config.js";
import { NodesStore } from "../lib/nodes-store.js";
import { TaskStore } from "../lib/task-store.js";

// ---- 公共助手 ----

/** 每个 test 用例一个独立临时目录,用完即毁(t.after 钩子)。 */
function useTmpDir(t, prefix = "stores-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 合法 acp-stdio 节点(最小字段)。 */
const stdio = (name, command = "opencode") => ({ name, type: "acp-stdio", command });
/** 合法 acp-plug 节点。 */
const plug = (name, plugId = "kimi") => ({
  name,
  type: "acp-plug",
  address: "10.99.0.1:7080",
  plugId,
});

// =====================================================================
// ① lib/config.js
// =====================================================================

describe("lib/config.js validateNode", () => {
  it("acp-stdio 正常路径:全字段归一化 + 缺省补全", () => {
    const out = validateNode("n1", { type: "acp-stdio", command: "opencode" });
    assert.deepEqual(out, {
      name: "n1",
      type: "acp-stdio",
      command: "opencode",
      args: [],
      ssh: null,
      address: null,
      plugId: null,
      socks: null,
      cwd: null,
      env: {},
      model: null,
      description: "",
    });
  });

  it("acp-plug 正常路径:command 默认空串,address/plugId/socks/cwd/model/description 透传", () => {
    const out = validateNode("win", {
      type: "acp-plug",
      address: "10.99.0.9:7080",
      plugId: "kimi",
      command: "remote-cmd", // ?? 只在 null/undefined 时兜底,有值则保留
      args: ["-x", "--y"],
      socks: "127.0.0.1:11080",
      cwd: "/work",
      env: { A: "1" },
      model: "opencode/deepseek-v4.1-flash",
      description: "206 房",
    });
    assert.equal(out.name, "win");
    assert.equal(out.type, "acp-plug");
    assert.equal(out.command, "remote-cmd");
    assert.deepEqual(out.args, ["-x", "--y"]);
    assert.equal(out.address, "10.99.0.9:7080");
    assert.equal(out.plugId, "kimi");
    assert.equal(out.socks, "127.0.0.1:11080");
    assert.equal(out.cwd, "/work");
    assert.deepEqual(out.env, { A: "1" });
    assert.equal(out.model, "opencode/deepseek-v4.1-flash");
    assert.equal(out.description, "206 房");
    assert.equal(out.ssh, null); // 未提供 → null
  });

  it("acp-plug 省略 command 时归一化为空串", () => {
    const out = validateNode("win", plug("win"));
    assert.equal(out.command, "");
  });

  it("acp-ssh 正常路径:command + ssh 必留", () => {
    const out = validateNode("kimi-206", { type: "acp-ssh", command: "kimi", ssh: "user@192.168.100.200" });
    assert.equal(out.command, "kimi");
    assert.equal(out.ssh, "user@192.168.100.200");
    assert.equal(out.address, null);
  });

  it("cli-oneshot 正常路径", () => {
    const out = validateNode("once", { type: "cli-oneshot", command: "echo" });
    assert.equal(out.type, "cli-oneshot");
    assert.equal(out.command, "echo");
  });

  it("args/env 返回副本:改原对象不影响归一化结果,反之亦然", () => {
    const args = ["a"];
    const env = { K: "v" };
    const entry = { name: "n", type: "acp-stdio", command: "c", args, env };
    const out = validateNode("n", entry);
    args.push("b");
    env.K2 = "v2";
    assert.deepEqual(out.args, ["a"]);
    assert.deepEqual(out.env, { K: "v" });
    out.args.push("z");
    out.env.K3 = "v3";
    assert.deepEqual(entry.args, ["a", "b"]);
    assert.deepEqual(entry.env, { K: "v", K2: "v2" });
  });

  it("name 非法:空串 / 33 字符 / 含空格 / 含点 / 中文 均抛错", () => {
    for (const bad of ["", "a".repeat(33), "a b", "a.b", "节点", "a/b", "a:b"]) {
      assert.throws(() => validateNode(bad, stdio("x")), /非法/, `name=${JSON.stringify(bad)} 应抛错`);
    }
  });

  it("name 合法边界:1 字符与 32 字符通过,字母数字_- 混排通过", () => {
    for (const ok of ["a", "a".repeat(32), "A-b_9-z"]) {
      assert.equal(validateNode(ok, stdio(ok)).name, ok);
    }
  });

  it("type 缺失或不在白名单 → 抛错(错误信息含类型与可选列表)", () => {
    assert.throws(() => validateNode("n", { command: "c" }), /类型/);
    assert.throws(() => validateNode("n", { type: "acp-http", command: "c" }), /acp-stdio/);
    assert.throws(() => validateNode("n", { type: "acp-http", command: "c" }), /cli-oneshot/);
  });

  it("acp-plug 缺 address 或地址非法 → 抛错", () => {
    const base = { type: "acp-plug", plugId: "kimi" };
    assert.throws(() => validateNode("n", base), /address/);
    for (const bad of ["host", "host:abc", "host:70 80", " host:7080", ":7080", "a:b:1"]) {
      assert.throws(() => validateNode("n", { ...base, address: bad }), /address/, `address=${bad} 应抛错`);
    }
  });

  it("acp-plug 缺 plugId → 抛错", () => {
    assert.throws(() => validateNode("n", { type: "acp-plug", address: "h:7080" }), /plugId/);
  });

  it("非 acp-plug 类型缺 command → 抛错", () => {
    assert.throws(() => validateNode("n", { type: "acp-stdio" }), /command/);
    assert.throws(() => validateNode("n", { type: "cli-oneshot" }), /command/);
    // acp-plug 缺 command 不抛(由远端 plugs.json 定义)
    assert.doesNotThrow(() => validateNode("n", plug("n")));
  });

  it("acp-ssh 缺 ssh → 抛错;同时缺 command 时先报 command", () => {
    assert.throws(() => validateNode("n", { type: "acp-ssh", command: "kimi" }), /ssh/);
    assert.throws(() => validateNode("n", { type: "acp-ssh" }), /command/);
  });
});

describe("lib/config.js normalizeConfig", () => {
  it("空对象 → 全默认值(defaultTimeoutMs=600000 / harnesses={} / modelBridge.enable=false)", () => {
    assert.deepEqual(normalizeConfig({}), {
      defaultTimeoutMs: 600000,
      harnesses: {},
      modelBridge: { enable: false },
    });
  });

  it("undefined / null config → 同样默认值(不抛错)", () => {
    const expected = { defaultTimeoutMs: 600000, harnesses: {}, modelBridge: { enable: false } };
    assert.deepEqual(normalizeConfig(undefined), expected);
    assert.deepEqual(normalizeConfig(null), expected);
  });

  it("defaultTimeoutMs 透传", () => {
    assert.equal(normalizeConfig({ defaultTimeoutMs: 1234 }).defaultTimeoutMs, 1234);
    assert.equal(normalizeConfig({ defaultTimeoutMs: 0 }).defaultTimeoutMs, 0); // 0 是合法值(?? 非 ||)
  });

  it("modelBridge.enable 透传:仅严格 true 为 true", () => {
    assert.equal(normalizeConfig({ modelBridge: { enable: true } }).modelBridge.enable, true);
    assert.equal(normalizeConfig({ modelBridge: { enable: false } }).modelBridge.enable, false);
    assert.equal(normalizeConfig({ modelBridge: {} }).modelBridge.enable, false);
    assert.equal(normalizeConfig({}).modelBridge.enable, false);
    // 非布尔真值不猜昧:一律 false(=== true 严格判断)
    assert.equal(normalizeConfig({ modelBridge: { enable: "yes" } }).modelBridge.enable, false);
    assert.equal(normalizeConfig({ modelBridge: { enable: 1 } }).modelBridge.enable, false);
  });

  it("harnesses 多条全部规范化(与 validateNode 单条结果一致)", () => {
    const out = normalizeConfig({
      harnesses: {
        local: { type: "acp-stdio", command: "opencode" },
        win: { type: "acp-plug", address: "10.99.0.1:7080", plugId: "kimi" },
      },
    });
    assert.deepEqual(Object.keys(out.harnesses).sort(), ["local", "win"]);
    assert.deepEqual(out.harnesses.local, validateNode("local", { type: "acp-stdio", command: "opencode" }));
    assert.equal(out.harnesses.win.plugId, "kimi");
  });

  it("非法 harness 条目 → 加载期直接抛错(非静默剔除,错误信息含节点名)", () => {
    assert.throws(
      () => normalizeConfig({ harnesses: { good: stdio("good"), "bad name": stdio("bad name") } }),
      /bad name/,
    );
    assert.throws(() => normalizeConfig({ harnesses: { bad: { type: "nope" } } }), /类型/);
  });

  it("harnesses 为 null → 按空对象处理", () => {
    assert.deepEqual(normalizeConfig({ harnesses: null }).harnesses, {});
  });
});

// =====================================================================
// ② lib/nodes-store.js
// =====================================================================

describe("lib/nodes-store.js NodesStore", () => {
  it("缺文件 + 无种子 → 空存储,get 未命中返回 null", (t) => {
    const dir = useTmpDir(t);
    const store = new NodesStore(join(dir, "harness-mesh", "nodes.json"));
    assert.equal(store.load(), store); // 返回 this,可链式
    assert.deepEqual(store.list(), []);
    assert.equal(store.get("nope"), null);
    assert.ok(existsSync(join(dir, "harness-mesh"))); // 构造时已建目录
  });

  it("load 灌入 patch 种子:list/get 可用,文件仍不存在", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "nodes.json");
    const store = new NodesStore(file).load({ a: stdio("a"), b: plug("b") });
    assert.equal(store.get("a").command, "opencode");
    assert.equal(store.get("b").plugId, "kimi");
    assert.equal(store.list().length, 2);
    assert.equal(existsSync(file), false); // 只读种子不落盘
  });

  it("nodes.json 坏 JSON → 不抛错,忽略该文件继续用 patch 种子", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "nodes.json");
    writeFileSync(file, "{oops 这不是 JSON");
    const origLog = console.log;
    const logs = [];
    console.log = (...a) => logs.push(a.join(" "));
    try {
      const store = new NodesStore(file).load({ seed: stdio("seed") });
      assert.deepEqual(store.list().map((n) => n.name), ["seed"]);
    } finally {
      console.log = origLog;
    }
    assert.ok(logs.some((l) => l.includes("nodes.json 损坏")), "应打印损坏告警");
  });

  it("nodes.json 是合法 JSON 但非对象(null) → 不抛错,按空数据处理", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "nodes.json");
    writeFileSync(file, "null");
    const store = new NodesStore(file).load({ seed: stdio("seed") });
    assert.deepEqual(store.list().map((n) => n.name), ["seed"]);
  });

  it("nodes.json 的 nodes 不是数组 → 整个文件被忽略,种子保留", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "nodes.json");
    writeFileSync(file, JSON.stringify({ nodes: { not: "array" } }));
    const origLog = console.log;
    console.log = () => {};
    try {
      const store = new NodesStore(file).load({ seed: stdio("seed") });
      assert.deepEqual(store.list().map((n) => n.name), ["seed"]);
    } finally {
      console.log = origLog;
    }
  });

  it("nodes.json 覆盖 patch 种子:同名以 GUI 为准,异名合并", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "nodes.json");
    writeFileSync(file, JSON.stringify({
      nodes: [
        { name: "a", type: "acp-stdio", command: "gui-cmd" },
        stdio("g"),
      ],
    }));
    const store = new NodesStore(file).load({ a: stdio("a", "seed-cmd"), s: stdio("s") });
    assert.equal(store.get("a").command, "gui-cmd"); // GUI 赢
    assert.equal(store.get("s").command, "opencode"); // 种子仍在
    assert.equal(store.get("g").command, "opencode"); // GUI 新增
    assert.equal(store.list().length, 3);
  });

  it("tombstone:GUI 删除的种子不复活,且重启后持续有效", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "nodes.json");
    writeFileSync(file, JSON.stringify({ version: 1, nodes: [], deleted: ["seed"] }));
    const seeds = { seed: stdio("seed") };
    const first = new NodesStore(file).load(seeds);
    assert.equal(first.get("seed"), null);
    assert.equal(first.list().length, 0);
    // 再"重启"一次:tombstone 仍在文件里,种子不会复活
    const second = new NodesStore(file).load(seeds);
    assert.equal(second.get("seed"), null);
    // 期间 GUI 改动别的节点,tombstone 不会被冲掉
    second.save(stdio("g"));
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).deleted, ["seed"]);
    const third = new NodesStore(file).load(seeds);
    assert.equal(third.get("seed"), null);
    assert.equal(third.get("g").command, "opencode");
  });

  it("deleted 数组里的非字符串条目被过滤,只删字符串名", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "nodes.json");
    writeFileSync(file, JSON.stringify({ deleted: ["seedA", 7, null, {}, ["x"]] }));
    const store = new NodesStore(file).load({ seedA: stdio("seedA"), seedB: stdio("seedB") });
    assert.equal(store.get("seedA"), null);
    assert.equal(store.get("seedB").command, "opencode");
  });

  it("save 新增节点:进内存 + 落盘(payload 结构 version/nodes/deleted)+ 返回归一化对象", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "nodes.json");
    const store = new NodesStore(file).load({});
    const input = { name: "x", type: "acp-stdio", command: "c" };
    const out = store.save(input);
    assert.notEqual(out, input); // 返回的是归一化后的新对象
    assert.deepEqual(out, validateNode("x", input));
    assert.deepEqual(store.get("x"), out);
    const payload = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(payload.version, 1);
    assert.equal(payload.nodes.length, 1);
    assert.equal(payload.nodes[0].name, "x");
    assert.deepEqual(payload.deleted, []);
    assert.ok(readFileSync(file, "utf8").endsWith("\n"));
  });

  it("save 覆盖同名节点;name 前后空白被 trim", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "nodes.json");
    const store = new NodesStore(file).load({});
    store.save(stdio("x", "old"));
    store.save(stdio("x", "new"));
    assert.equal(store.get("x").command, "new");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).nodes.length, 1); // 覆盖而非追加
    const out = store.save({ name: "  spaced  ", type: "acp-stdio", command: "c" });
    assert.equal(out.name, "spaced");
    assert.equal(store.get("spaced").command, "c");
    assert.equal(store.get("  spaced  "), null);
  });

  it("save 非法节点 → 抛错,且不落盘(文件字节不变)、内存不变", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "nodes.json");
    const store = new NodesStore(file).load({});
    store.save(stdio("ok"));
    const before = readFileSync(file, "utf8");
    assert.throws(() => store.save({ name: "bad name", type: "acp-stdio", command: "c" }), /非法/);
    assert.throws(() => store.save({ name: "y", type: "nope" }), /类型/);
    assert.throws(() => store.save({ name: "z", type: "acp-plug", plugId: "k" }), /address/);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.deepEqual(store.list().map((n) => n.name), ["ok"]);
  });

  it("remove 已存在节点 → true 并从文件移除", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "nodes.json");
    const store = new NodesStore(file).load({});
    store.save(stdio("a"));
    store.save(stdio("b"));
    assert.equal(store.remove("a"), true);
    assert.equal(store.get("a"), null);
    const payload = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(payload.nodes.map((n) => n.name), ["b"]);
  });

  it("remove patch 种子节点 → true 并写入 tombstone(deleted)", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "nodes.json");
    const store = new NodesStore(file).load({ sd: stdio("sd") });
    assert.equal(store.remove("sd"), true);
    const payload = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(payload.nodes, []);
    assert.deepEqual(payload.deleted, ["sd"]);
  });

  it("remove 不存在节点 → false 且完全不写文件(内容不变)", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "nodes.json");
    const store = new NodesStore(file).load({});
    store.save(stdio("a"));
    const before = readFileSync(file, "utf8");
    assert.equal(store.remove("nope"), false);
    assert.equal(readFileSync(file, "utf8"), before);
  });

  it("单写者连续多次 save:文件始终是合法 JSON 且含全部节点", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "nodes.json");
    const store = new NodesStore(file).load({});
    for (let i = 0; i < 5; i += 1) store.save(stdio(`n${i}`));
    const payload = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(payload.nodes.length, 5);
    assert.deepEqual(payload.nodes.map((n) => n.name).sort(), ["n0", "n1", "n2", "n3", "n4"]);
  });

  it("多实例并发写:last-writer-wins,重新 load 以最后一次 flush 为准", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "nodes.json");
    const a = new NodesStore(file).load({});
    a.save(stdio("a1"));
    // 实例 B 读到 a1 后再写;此时 A 又在旧快照上 flush → B 的节点被冲掉(无读-改-写合并)
    const b = new NodesStore(file).load({});
    assert.equal(b.get("a1").command, "opencode");
    b.save(stdio("b1"));
    a.save(stdio("a2"));
    const reload = new NodesStore(file).load({});
    assert.equal(reload.get("a2").command, "opencode");
    assert.equal(reload.get("b1"), null); // 最后一把 flush 来自 A,冲掉了 b1
    // 无论怎么交错,文件必须是合法 JSON(不会写坏)
    assert.equal(JSON.parse(readFileSync(file, "utf8")).nodes.length, 2);
  });

  it("符号链接目标:save 透写到真实文件,load 从真实文件读", (t) => {
    const dir = useTmpDir(t);
    const target = join(dir, "real-nodes.json");
    const link = join(dir, "nodes.json");
    symlinkSync(target, link);
    const store = new NodesStore(link).load({});
    store.save(stdio("s1"));
    assert.ok(existsSync(target), "写入应落在符号链接目标上");
    assert.equal(JSON.parse(readFileSync(target, "utf8")).nodes[0].name, "s1");
    const reopened = new NodesStore(link).load({});
    assert.equal(reopened.get("s1").command, "opencode");
  });

  it("断链符号链接:load 当缺文件处理,save 自动创建目标文件", (t) => {
    const dir = useTmpDir(t);
    const target = join(dir, "gone.json");
    const link = join(dir, "nodes.json");
    symlinkSync(target, link);
    const store = new NodesStore(link).load({ sd: stdio("sd") });
    assert.deepEqual(store.list().map((n) => n.name), ["sd"]); // 断链 → existsSync false → 只有种子
    store.save(stdio("s2"));
    assert.ok(existsSync(target), "save 后目标文件应被创建");
    const reopened = new NodesStore(link).load({});
    assert.equal(reopened.get("s2").command, "opencode");
  });

  it("嵌套不存在目录:构造时自动创建,写读正常", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "a", "b", "nodes.json");
    const store = new NodesStore(file).load({});
    store.save(stdio("deep"));
    assert.equal(new NodesStore(file).load({}).get("deep").command, "opencode");
  });

  it("load 的 patch 种子非法 → 抛错(不被损坏文件的 catch 掩盖)", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "nodes.json");
    assert.throws(() => new NodesStore(file).load({ bad: { name: "bad", type: "acp-stdio" } }), /command/);
    assert.throws(() => new NodesStore(file).load({ bad: { name: "bad", type: "nope" } }), /类型/);
  });

  it("nodes.json 里单条非法条目 → 只丢自己,前后好条目都保留(2026-10-19 修复:原为部分应用)", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "nodes.json");
    writeFileSync(file, JSON.stringify({
      nodes: [
        stdio("good"),
        { name: "bad name", type: "acp-stdio", command: "c" }, // 非法:名字含空格
        stdio("after"), // 排在坏条目之后
      ],
    }));
    const origLog = console.log;
    const logged = [];
    console.log = (m) => logged.push(String(m));
    try {
      const store = new NodesStore(file).load({ sd: stdio("sd") });
      // 修复后行为:逐条校验,坏条目跳过并点名进日志,good/after 都不丢。
      assert.deepEqual(store.list().map((n) => n.name), ["sd", "good", "after"]);
      assert.ok(logged.some((m) => m.includes("bad name")), "日志必须指出被跳过的条目名");
    } finally {
      console.log = origLog;
    }
  });

  it("种子的 Record 键是权威 name:条目 name 字段与键不一致时以键为准", (t) => {
    const dir = useTmpDir(t);
    const store = new NodesStore(join(dir, "nodes.json")).load({ keyName: stdio("entryName") });
    assert.equal(store.get("keyName").name, "keyName");
    assert.equal(store.get("entryName"), null);
  });
});

// =====================================================================
// ③ lib/task-store.js
// =====================================================================

describe("lib/task-store.js TaskStore", () => {
  it("create/get/list + JSONL 追加落盘", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "tasks.jsonl");
    const store = new TaskStore(file);
    const entry = { task_id: "t1", harness: "h1", state: "queued", prompt: "p" };
    assert.equal(store.create(entry), entry); // 原样返回(不做拷贝)
    assert.equal(store.get("t1"), entry);
    assert.deepEqual(store.list(), [entry]);
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), entry);
    assert.ok(readFileSync(file, "utf8").endsWith("\n"));
  });

  it("create 同 task_id 重复 → 覆盖(upsert),重启后后者赢", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "tasks.jsonl");
    const store = new TaskStore(file);
    store.create({ task_id: "t2", harness: "h", state: "queued", prompt: "first" });
    store.create({ task_id: "t2", harness: "h", state: "running", prompt: "second" });
    assert.equal(store.get("t2").prompt, "second");
    const reboot = new TaskStore(file);
    assert.equal(reboot.get("t2").prompt, "second"); // latest-wins
    assert.equal(readFileSync(file, "utf8").split("\n").filter(Boolean).length, 2);
  });

  it("update 合并 patch、强制 task_id 不被篡改、打 updated_at(ISO)", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "tasks.jsonl");
    const store = new TaskStore(file);
    store.create({ task_id: "t1", harness: "h1", state: "queued", prompt: "p" });
    const next = store.update("t1", { state: "running", task_id: "HACKED", result: "ok" });
    assert.equal(next.task_id, "t1"); // patch 里的 task_id 被强制忽略
    assert.equal(next.state, "running");
    assert.equal(next.result, "ok");
    assert.equal(next.prompt, "p"); // 原字段保留
    assert.equal(next.harness, "h1");
    assert.match(next.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(store.get("t1"), next);
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 2); // 追加而非重写
    assert.deepEqual(JSON.parse(lines[1]), next);
  });

  it("update 空 patch → 原字段保留,只追加 updated_at", (t) => {
    const dir = useTmpDir(t);
    const store = new TaskStore(join(dir, "tasks.jsonl"));
    store.create({ task_id: "t1", state: "queued" });
    const next = store.update("t1", {});
    assert.equal(next.state, "queued");
    assert.ok(next.updated_at);
  });

  it("update 不存在的 task_id → 抛错(信息含 id)", (t) => {
    const dir = useTmpDir(t);
    const store = new TaskStore(join(dir, "tasks.jsonl"));
    assert.throws(() => store.update("nope", { state: "running" }), /nope/);
    assert.throws(() => store.update("nope", { state: "running" }), /不存在/);
    assert.equal(store.list().length, 0); // 抛错前不写任何东西
  });

  it("countRunning:只计 queued/running,按 harness 过滤", (t) => {
    const dir = useTmpDir(t);
    const store = new TaskStore(join(dir, "tasks.jsonl"));
    store.create({ task_id: "a", harness: "h1", state: "queued" });
    store.create({ task_id: "b", harness: "h1", state: "running" });
    store.create({ task_id: "c", harness: "h1", state: "done" });
    store.create({ task_id: "d", harness: "h1", state: "failed" });
    store.create({ task_id: "e", harness: "h1", state: "cancelled" });
    store.create({ task_id: "f", harness: "h1" }); // 无 state 字段
    store.create({ task_id: "g", harness: "h2", state: "running" });
    assert.equal(store.countRunning("h1"), 2);
    assert.equal(store.countRunning("h2"), 1);
    assert.equal(store.countRunning("h3"), 0); // 未知 harness
  });

  it("重启恢复:多任务 + 多次状态跳变,新实例 latest-wins", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "tasks.jsonl");
    const store = new TaskStore(file);
    store.create({ task_id: "t1", harness: "h1", state: "queued", prompt: "p1" });
    store.create({ task_id: "t2", harness: "h2", state: "queued", prompt: "p2" });
    store.update("t1", { state: "running" });
    store.update("t1", { state: "done", result: "ok" });
    store.update("t2", { state: "running" });
    const reboot = new TaskStore(file);
    assert.equal(reboot.list().length, 2);
    assert.equal(reboot.get("t1").state, "done");
    assert.equal(reboot.get("t1").result, "ok");
    assert.equal(reboot.get("t1").prompt, "p1");
    assert.equal(reboot.get("t1").harness, "h1");
    assert.ok(reboot.get("t1").updated_at);
    assert.equal(reboot.get("t2").state, "running");
    assert.equal(reboot.countRunning("h2"), 1);
  });

  it("坏行/空行/缺 task_id/task_id 非字符串 → 跳过,好行保留", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "tasks.jsonl");
    writeFileSync(file, [
      JSON.stringify({ task_id: "ok1", state: "queued" }),
      "",
      "   ",
      "{truncated 坏行", // 模拟崩溃截断的尾行
      JSON.stringify({ no_id: true }), // 缺 task_id
      JSON.stringify({ task_id: 42 }), // task_id 非字符串
      JSON.stringify({ task_id: "ok2", state: "running" }),
      "",
    ].join("\n"));
    const store = new TaskStore(file);
    assert.deepEqual(store.list().map((x) => x.task_id).sort(), ["ok1", "ok2"]);
    assert.equal(store.get("ok1").state, "queued");
  });

  it("空文件 → 空存储", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "tasks.jsonl");
    writeFileSync(file, "");
    const store = new TaskStore(file);
    assert.deepEqual(store.list(), []);
    assert.equal(store.get("x"), undefined);
  });

  it("嵌套不存在目录:构造时自动创建,create 可写", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "x", "y", "tasks.jsonl");
    const store = new TaskStore(file);
    store.create({ task_id: "t1", state: "queued" });
    assert.equal(new TaskStore(file).get("t1").state, "queued");
  });

  it("list() 返回数组副本:改返回值不影响内部存储", (t) => {
    const dir = useTmpDir(t);
    const store = new TaskStore(join(dir, "tasks.jsonl"));
    store.create({ task_id: "t1", state: "queued" });
    const snapshot = store.list();
    snapshot.push("junk");
    snapshot[0].state = "hacked"; // 元素是同一引用,但 push 不影响内部
    assert.equal(store.list().length, 1);
  });

  it("create 缺 task_id → 入口即拒(2026-10-19 修复:原为静默丢失的幽灵记录)", (t) => {
    const dir = useTmpDir(t);
    const file = join(dir, "tasks.jsonl");
    const store = new TaskStore(file);
    assert.throws(() => store.create({ prompt: "no-id" }), /task_id/);
    assert.throws(() => store.create(null), /task_id/);
    assert.throws(() => store.create({ task_id: "" }), /task_id/);
    assert.equal(store.list().length, 0, "被拒的记录不进内存");
    const reboot = new TaskStore(file);
    assert.equal(reboot.list().length, 0, "被拒的记录不落盘");
  });
});
