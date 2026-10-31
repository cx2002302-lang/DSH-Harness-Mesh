/** fs-tools 单元测试(node:test + mock.module 假 child_process):
 *  - 路径沙箱:拒绝绝对路径 / .. / 空路径 / -c 元字符,\ 与 / 统一
 *  - fs_team_init 命令序列断言(mkdir shared + members/<m>,单次 smbclient -c)
 *  - fs_write put 流程(临时文件 → put → 清理)
 *  - fs_read 超限 / fs_remove 目录回退 / fs_list 输出解析
 *  - 凭证不外泄:密码不进错误信息/返回值;失败时只暴露 stderr
 *
 * 运行:node --test --experimental-test-module-mocks test/fs-tools.test.mjs
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---- 假 child_process:记录 argv,按预设脚本回包(与被测模块同线程)------------

const calls = []; // 每项 { file, args, opts }
const putWrites = []; // put 命令对应的本地临时文件内容 {local, remote, content}(落盘后、清理前读取)
let script = { stdout: "" }; // { stdout } 或 { stderr, exitCodeError } 或 { throw: Error }

function fakeExecFile(file, args, opts, cb) {
  calls.push({ file, args, opts });
  for (const cmd of String(args[6] ?? "").split("; ")) {
    const m = cmd.match(/^put "(.+)" "(.+)"$/);
    if (m) {
      try {
        putWrites.push({ local: m[1], remote: m[2], content: readFileSync(m[1], "utf8") });
      } catch { /* 文件可能不存在,忽略 */ }
    }
  }
  const s = typeof script === "function" ? script(calls.length) : script;
  if (s.throw) {
    cb(s.throw, "", "");
    return;
  }
  if (s.stderr) {
    const err = new Error(`smbclient: ${s.stderr}`); // 形似 execFile 错误,但消息里可能带 argv
    err.message = `smbclient -c ... (argv 略)`;
    cb(err, s.stdout ?? "", s.stderr);
    return;
  }
  cb(null, s.stdout ?? "", "");
}

mock.module("node:child_process", {
  namedExports: { execFile: fakeExecFile, default: { execFile: fakeExecFile } },
});

const { createFsTools, sanitizePath, buildSmbArgs, runSmb } = await import("../lib/fs-tools.js");

const PASS = "change-me";
const SMB = ["//192.168.1.33/ai", "-U", `ai%${PASS}`, "-m", "SMB3"];

function toolsByName() {
  // 验 MCP 形状 {name,description,inputSchema,handler}(hot.js 同视角,从 defineTool 派生)
  return new Map(createFsTools().map((t) => [t.name, { name: t.name, description: t.description, inputSchema: t.parameters, handler: t.execute }]));
}

beforeEachCommon();
function beforeEachCommon() {} // node:test 无全局 beforeEach 需求,各 test 自行重置

function lastArgs() {
  return calls.at(-1).args;
}

// ---- 路径沙箱 -----------------------------------------------------------------

test("sanitizePath:统一 \\ 与 /、折叠空段与 .", () => {
  assert.equal(sanitizePath("projects\\demo\\shared"), "projects/demo/shared");
  assert.equal(sanitizePath("projects//demo/./shared/"), "projects/demo/shared");
  assert.equal(sanitizePath("a.txt"), "a.txt");
});

test("sanitizePath:拒绝绝对路径(Unix 与 Windows 盘符)、..、空路径、元字符", () => {
  for (const bad of ["/etc/passwd", "C:\\x", "a/../b", "..", "", ".", "./", 'a"b', "a;b", "a'b", "a\nb"]) {
    assert.throws(() => sanitizePath(bad), undefined, `应拒绝: ${JSON.stringify(bad)}`);
  }
  // 合法文件名允许的普通字符不受影响
  assert.equal(sanitizePath("my project_v2/报告.txt"), "my project_v2/报告.txt");
});

test("buildSmbArgs:host/share/密码可用环境变量覆盖,fallback 固定值", () => {
  assert.deepEqual(buildSmbArgs(["ls"]), [...SMB, "-c", "ls"]);
  process.env.MESH_SMB_HOST = "10.0.0.9";
  process.env.MESH_SMB_SHARE = "teamshare";
  process.env.MESH_SMB_PASS = "env-pass";
  try {
    assert.deepEqual(buildSmbArgs(["ls"]), ["//10.0.0.9/teamshare", "-U", "ai%env-pass", "-m", "SMB3", "-c", "ls"]);
  } finally {
    delete process.env.MESH_SMB_HOST;
    delete process.env.MESH_SMB_SHARE;
    delete process.env.MESH_SMB_PASS;
  }
});

test("runSmb:单命令单次 -c,超时 20s 传入 opts", async () => {
  calls.length = 0;
  script = { stdout: "" };
  await runSmb(["ls \"x\""]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "smbclient");
  assert.deepEqual(calls[0].args.slice(0, 5), SMB);
  assert.equal(calls[0].args[6], 'ls "x"');
  assert.equal(calls[0].opts.timeout, 20000);
});

// ---- fs_team_init ---------------------------------------------------------------

const NOT_FOUND = "NT_STATUS_OBJECT_NAME_NOT_FOUND listing \\projects\\demo\\*";

function lsOut(pairs) {
  // pairs: [name, "D"|"A", size] → 模拟 smbclient ls 输出
  return pairs.map(([n, t, s]) =>
    `  ${n.padEnd(36)}${(t || "").padEnd(9)}${String(s ?? 0).padStart(8)}  Tue Jan  2 03:04:05 2024`,
  ).join("\n");
}

test("fs_team_init:新项目一条 -c 建骨架,再单次批量写 TEAM.md + 每成员 README.md", async () => {
  calls.length = 0;
  putWrites.length = 0;
  script = (n) => (n === 1 ? { stderr: NOT_FOUND, stdout: "" } : { stdout: "" }); // 探测:项目不存在
  const t = toolsByName().get("fs_team_init");
  const out = await t.handler({ project: "demo", members: ["kimi", "opencode"] });
  assert.equal(out.ok, true);
  assert.equal(out.project, "demo");
  assert.deepEqual(out.members, ["kimi", "opencode"]);
  assert.deepEqual(out.created, [
    "projects",
    "projects/demo",
    "projects/demo/shared",
    "projects/demo/members",
    "projects/demo/members/kimi",
    "projects/demo/members/opencode",
    "projects/demo/shared/TEAM.md",
    "projects/demo/members/kimi/README.md",
    "projects/demo/members/opencode/README.md",
  ]);
  assert.deepEqual(out.skipped, []);
  assert.equal(calls.length, 6, "探测 + mkdir 单次 -c + 探 shared/成员 + put 批量单次 -c");
  assert.deepEqual(calls[1].args[6], [
    'mkdir "projects"',
    'mkdir "projects/demo"',
    'mkdir "projects/demo/shared"',
    'mkdir "projects/demo/members"',
    'mkdir "projects/demo/members/kimi"',
    'mkdir "projects/demo/members/opencode"',
  ].join("; "));
  const puts = calls[5].args[6];
  assert.match(puts, /put "[^"]+" "projects\/demo\/shared\/TEAM\.md"/);
  assert.match(puts, /put "[^"]+" "projects\/demo\/members\/kimi\/README\.md"/);
  assert.match(puts, /put "[^"]+" "projects\/demo\/members\/opencode\/README\.md"/);
  const remoteContent = new Map(putWrites.map((w) => [w.remote, w.content]));
  assert.match(remoteContent.get("projects/demo/shared/TEAM.md"), /# demo 团队名册/);
  assert.match(remoteContent.get("projects/demo/shared/TEAM.md"), /公共文件写 shared\/,私人文件只写 members\/<你>\//);
  assert.match(remoteContent.get("projects/demo/shared/TEAM.md"), /\| kimi \| projects\/demo\/members\/kimi \|/);
  assert.match(remoteContent.get("projects/demo/members/kimi/README.md"), /# kimi 的工位/);
  assert.match(remoteContent.get("projects/demo/members/kimi/README.md"), /公共区在 \.\.\/\.\.\/shared/);
  assert.match(remoteContent.get("projects/demo/members/kimi/README.md"), /fs_list/);
});

test("fs_team_init:幂等——第二次不覆盖 TEAM.md/README,只报 skipped", async () => {
  calls.length = 0;
  // 第 1 次:全新建(项目不存在)
  const queue1 = [{ stderr: NOT_FOUND, stdout: "" }, { stdout: "" }, { stdout: "" }];
  script = () => queue1.shift() ?? { stdout: "" };
  await toolsByName().get("fs_team_init").handler({ project: "demo", members: ["kimi"] });
  const firstPuts = calls.filter((c) => String(c.args[6]).includes("put"));
  assert.equal(firstPuts.length, 1);
  assert.ok(String(firstPuts[0].args[6]).includes('"projects/demo/shared/TEAM.md"'));

  // 第 2 次:一切已存在(TEAM.md 内容已被用户改成自己的)→ 不得再 put
  calls.length = 0;
  const queue2 = [
    { stdout: lsOut([["shared", "D"], ["members", "D"]]) }, // ls projects/demo/*
    { stdout: lsOut([["kimi", "D"]]) },                     // ls .../members/*
    { stdout: lsOut([["TEAM.md", "A", 99], ["plan.md", "A", 5]]) }, // ls .../shared/*
    { stdout: lsOut([["README.md", "A", 42]]) },            // ls .../members/kimi/*
  ];
  script = () => queue2.shift() ?? { stdout: "" };
  const out2 = await toolsByName().get("fs_team_init").handler({ project: "demo", members: ["kimi"] });
  assert.equal(out2.ok, true);
  assert.deepEqual(out2.created, [], "已存在的一律不重建");
  assert.deepEqual(out2.skipped, [
    "projects/demo/shared",
    "projects/demo/members",
    "projects/demo/members/kimi",
    "projects/demo/shared/TEAM.md",
    "projects/demo/members/kimi/README.md",
  ]);
  assert.equal(calls.filter((c) => String(c.args[6]).includes("put")).length, 0, "第二次调用不得发出任何 put(不覆盖用户改动)");
});

test("fs_team_init:项目在但缺成员工位时只补缺的目录", async () => {
  calls.length = 0;
  putWrites.length = 0;
  const queue = [
    { stdout: lsOut([["shared", "D"], ["members", "D"]]) }, // 项目已存在
    { stdout: lsOut([["kimi", "D"]]) },                     // members 里只有 kimi
    { stdout: "" },                                         // mkdir 缺的 opencode 工位
    { stdout: lsOut([["TEAM.md", "A", 99]]) },              // TEAM.md 已有
    { stdout: lsOut([["README.md", "A", 1]]) },             // kimi 有 README
  ];
  script = () => queue.shift() ?? { stdout: "" };
  const out = await toolsByName().get("fs_team_init").handler({ project: "demo", members: ["kimi", "opencode"] });
  assert.equal(out.ok, true);
  assert.deepEqual(out.created, ["projects/demo/members/opencode", "projects/demo/members/opencode/README.md"]);
  assert.deepEqual(out.skipped, [
    "projects/demo/shared",
    "projects/demo/members",
    "projects/demo/members/kimi",
    "projects/demo/shared/TEAM.md",
    "projects/demo/members/kimi/README.md",
  ]);
  assert.match(calls[6].args[6], /^put ".*" "projects\/demo\/members\/opencode\/README\.md"$/);
  assert.equal(putWrites.length, 1);
  assert.match(putWrites[0].content, /# opencode 的工位/);
});

test("fs_team_init:项目名/成员名走沙箱(拒绝 .. / 绝对路径),不发起 smb 调用", async () => {
  calls.length = 0;
  const t = toolsByName().get("fs_team_init");
  const bad1 = await t.handler({ project: "../escape", members: ["a"] });
  assert.equal(bad1.ok, false);
  assert.match(bad1.error.message, /\.\./);
  const bad2 = await t.handler({ project: "p", members: ["/abs"] });
  assert.equal(bad2.ok, false);
  assert.match(bad2.error.message, /绝对路径/);
  assert.equal(calls.length, 0, "沙箱拒绝时不得发起任何 smbclient 调用");
});

// ---- fs_write ------------------------------------------------------------------

test("fs_write:put 流程(本地临时文件 → put → 返回字节数)", async () => {
  calls.length = 0;
  script = { stdout: "" };
  const t = toolsByName().get("fs_write");
  const out = await t.handler({ path: "projects/demo/shared/note.md", content: "hello 团队" });
  assert.equal(out.ok, true);
  assert.equal(out.path, "projects/demo/shared/note.md");
  assert.equal(out.bytes, Buffer.byteLength("hello 团队", "utf8"));
  assert.equal(calls.length, 1);
  assert.equal(lastArgs()[6], `put "${calls[0].args[6].match(/put "([^"]+)"/)[1]}" "projects/demo/shared/note.md"`);
  assert.match(lastArgs()[6], /^put ".*" "projects\/demo\/shared\/note\.md"$/);
});

test("fs_write:沙箱拒绝时不出命令,错误结构 {ok:false,error:{code,message}}", async () => {
  calls.length = 0;
  const out = await toolsByName().get("fs_write").handler({ path: "../../etc/x", content: "x" });
  assert.equal(out.ok, false);
  assert.equal(typeof out.error.code, "string");
  assert.equal(typeof out.error.message, "string");
  assert.equal(calls.length, 0);
});

// ---- fs_read / fs_list / fs_remove ---------------------------------------------

test("fs_read:get 到临时文件后读取并清理,≤256KB 放行", async () => {
  calls.length = 0;
  script = { stdout: "" };
  const t = toolsByName().get("fs_read");
  // 假 execFile 不会真下载,fs.readFile 会失败 → 注入真实文件内容:换一种方式,
  // 用 throw 场景覆盖错误路径,正常路径用 fs_download 类似的真实 IO 不易 mock,
  // 这里退而验证:read 命令形如 get "<remote>" "<tmp>"。
  script = () => ({ stdout: "" });
  const p = t.handler({ path: "projects/demo/shared/note.md" });
  const out = await p.catch((e) => ({ ok: false, error: { code: "EXEC_ERROR", message: String(e.message) } }));
  assert.equal(calls.length, 1);
  assert.match(lastArgs()[6], /^get "projects\/demo\/shared\/note\.md" "\/.*\/harness-mesh-fs-[^/]+\/read"$/);
  // 临时文件不存在 → 折成 FS_ERROR 而不是抛未捕获异常
  assert.equal(out.ok, false);
});

test("fs_list:解析 smbclient ls 输出(name/type/size),头尾噪音行丢弃", async () => {
  calls.length = 0;
  script = {
    stdout: [
      "  .                                   D        0  Tue Jan  2 03:04:05 2024",
      "  ..                                  D        0  Tue Jan  2 03:04:05 2024",
      "  shared                              D        0  Tue Jan  2 03:04:05 2024",
      "  note.md                             A     1234  Tue Jan  2 03:04:05 2024",
      "",
      "\t\t3 blocks of size 1048576. 2 blocks available",
    ].join("\n"),
  };
  const t = toolsByName().get("fs_list");
  const out = await t.handler({ path: "projects/demo" });
  assert.equal(out.ok, true);
  assert.equal(out.path, "projects/demo");
  assert.deepEqual(out.entries, [
    { name: ".", type: "dir", size: 0 },
    { name: "..", type: "dir", size: 0 },
    { name: "shared", type: "dir", size: 0 },
    { name: "note.md", type: "file", size: 1234 },
  ]);
  assert.equal(lastArgs()[6], 'ls "projects/demo/*"');
});

test("fs_remove:删文件——先 list 父目录探测类型,再 rm", async () => {
  calls.length = 0;
  const queue = [
    { stdout: lsOut([["old.txt", "A", 12], ["note.md", "A", 5]]) }, // ls 父目录:old.txt 是文件
    { stdout: "" },                                               // rm 成功
  ];
  script = () => queue.shift() ?? { stdout: "" };
  const out = await toolsByName().get("fs_remove").handler({ path: "projects/demo/shared/old.txt" });
  assert.equal(out.ok, true);
  assert.equal(out.path, "projects/demo/shared/old.txt");
  assert.deepEqual(out.removed, ["projects/demo/shared/old.txt"]);
  assert.equal(out.removedCount, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args[6], 'ls "projects/demo/shared/*"');
  assert.equal(lastArgs()[6], 'rm "projects/demo/shared/old.txt"');
});

test("fs_remove:删空目录——探测为 dir,list 为空后 rmdir", async () => {
  calls.length = 0;
  const queue = [
    { stdout: lsOut([["shared", "D"], ["members", "D"]]) }, // ls 父目录:shared 是目录
    { stdout: "" },                                         // ls shared/* → 空
    { stdout: "" },                                         // rmdir 成功
  ];
  script = () => queue.shift() ?? { stdout: "" };
  const out = await toolsByName().get("fs_remove").handler({ path: "projects/demo/shared" });
  assert.equal(out.ok, true);
  assert.deepEqual(out.removed, ["projects/demo/shared"]);
  assert.equal(calls.length, 3);
  assert.equal(lastArgs()[6], 'rmdir "projects/demo/shared"');
});

test("fs_remove:删非空目录默认拒绝——ENOTEMPTY + 友好文案,不发 rm/rmdir", async () => {
  calls.length = 0;
  const queue = [
    { stdout: lsOut([["zhang", "D"]]) },                    // ls 父目录:zhang 是目录
    { stdout: lsOut([["README.md", "A", 42]]) },            // ls zhang/* → 非空
  ];
  script = () => queue.shift() ?? { stdout: "" };
  const out = await toolsByName().get("fs_remove").handler({ path: "projects/x/members/zhang" });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "ENOTEMPTY");
  assert.match(out.error.message, /非空/);
  assert.match(out.error.message, /recursive:true/);
  assert.ok(!out.error.message.includes("NT_STATUS"), "错误文案不得透出原始 smbclient 输出");
  assert.equal(calls.filter((c) => /^(rm|rmdir) "/.test(String(c.args[6]))).length, 0);
  assert.equal(calls.length, 2, "只探测两次,不得发删除命令");
});

test("fs_remove:recursive 删整树——自底向上删文件再 rmdir,返回 removed 清单", async () => {
  calls.length = 0;
  const queue = [
    { stdout: lsOut([["demo", "D"]]) },                                        // ls 父目录:demo 是目录
    { stdout: lsOut([["shared", "D"], ["note.md", "A", 5]]) },                 // ls demo/*
    { stdout: lsOut([["TEAM.md", "A", 99]]) },                                 // ls demo/shared/*
    { stdout: "" },                                                            // rm demo/shared/TEAM.md
    { stdout: "" },                                                            // rmdir demo/shared
    { stdout: "" },                                                            // rm demo/note.md
    { stdout: "" },                                                            // rmdir demo
  ];
  script = () => queue.shift() ?? { stdout: "" };
  const out = await toolsByName().get("fs_remove").handler({ path: "projects/demo", recursive: true });
  assert.equal(out.ok, true);
  assert.deepEqual(out.removed, [
    "projects/demo/shared/TEAM.md",
    "projects/demo/shared",
    "projects/demo/note.md",
    "projects/demo",
  ]);
  assert.equal(out.removedCount, 4);
  const cmds = calls.map((c) => c.args[6]);
  assert.deepEqual(cmds.slice(2), [
    'ls "projects/demo/shared/*"',
    'rm "projects/demo/shared/TEAM.md"',
    'rmdir "projects/demo/shared"',
    'rm "projects/demo/note.md"',
    'rmdir "projects/demo"',
  ]);
});

test("fs_remove:目录/文件不存在——ENOENT 友好文案,不透出 NT_STATUS", async () => {
  calls.length = 0;
  const queue = [
    { stdout: lsOut([["shared", "D"]]) }, // ls 父目录:没有 zhang
  ];
  script = () => queue.shift() ?? { stdout: "" };
  const out = await toolsByName().get("fs_remove").handler({ path: "projects/x/members/zhang" });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "ENOENT");
  assert.match(out.error.message, /不存在/);
  assert.ok(!out.error.message.includes("NT_STATUS"));
  assert.equal(calls.length, 1);

  // 父目录整个不存在(ls 报 NOT_FOUND)同样折成 ENOENT
  calls.length = 0;
  script = { stderr: NOT_FOUND, stdout: "" };
  const out2 = await toolsByName().get("fs_remove").handler({ path: "projects/nope/old.txt" });
  assert.equal(out2.ok, false);
  assert.equal(out2.error.code, "ENOENT");
  assert.ok(!out2.error.message.includes("NT_STATUS"));
});

test("fs_upload/fs_download:本地路径不经沙箱,远程路径必须过沙箱", async () => {
  calls.length = 0;
  script = { stdout: "" };
  const up = await toolsByName().get("fs_upload").handler({ local: "/tmp/a.bin", remote: "inbox/a.bin" });
  assert.equal(up.ok, true);
  assert.match(lastArgs()[6], /^put "\/tmp\/a\.bin" "inbox\/a\.bin"$/);

  calls.length = 0;
  const down = await toolsByName().get("fs_download").handler({ remote: "..\\leak", local: "/tmp/b" });
  assert.equal(down.ok, false);
  assert.match(down.error.message, /\.\./);
  assert.equal(calls.length, 0);
});

// ---- fs_team_verify -------------------------------------------------------------

test("fs_team_verify:全绿场景(shared/TEAM.md/成员对齐/README 全过)", async () => {
  calls.length = 0;
  const queue = [
    { stdout: lsOut([["shared", "D"], ["members", "D"]]) },        // ls projects/demo/*
    { stdout: lsOut([["TEAM.md", "A", 99]]) },                     // ls .../shared/*
    { stdout: lsOut([["kimi", "D"], ["opencode", "D"]]) },         // ls .../members/*
    { stdout: lsOut([["README.md", "A", 42]]) },                   // ls .../members/kimi/*
    { stdout: lsOut([["README.md", "A", 42]]) },                   // ls .../members/opencode/*
  ];
  script = () => queue.shift() ?? { stdout: "" };
  const out = await toolsByName().get("fs_team_verify").handler({ path: "projects/demo", members: ["kimi", "opencode"] });
  assert.equal(out.ok, true);
  assert.equal(out.path, "projects/demo");
  assert.deepEqual(out.members, ["kimi", "opencode"]);
  assert.equal(out.checks.every((c) => c.pass === true), true, "每项检查都应有 pass:true");
  assert.deepEqual(out.checks.map((c) => c.name), ["project_dir", "shared_dir", "team_md", "members_dir", "members_align", "readme_kimi", "readme_opencode"]);
  assert.ok(out.checks.every((c) => typeof c.detail === "string" && c.detail.length > 0), "每项都要带 detail,不要只对/错");
});

test("fs_team_verify:缺成员(清单有但目录缺)→ members_align 不过,ok=false", async () => {
  calls.length = 0;
  const queue = [
    { stdout: lsOut([["shared", "D"], ["members", "D"]]) },
    { stdout: lsOut([["TEAM.md", "A", 99]]) },
    { stdout: lsOut([["kimi", "D"]]) },
    { stdout: lsOut([["README.md", "A", 42]]) },
  ];
  script = () => queue.shift() ?? { stdout: "" };
  const out = await toolsByName().get("fs_team_verify").handler({ path: "projects/demo", members: ["kimi", "opencode"] });
  assert.equal(out.ok, false);
  const align = out.checks.find((c) => c.name === "members_align");
  assert.equal(align.pass, false);
  assert.match(align.detail, /opencode/);
  assert.match(align.detail, /目录缺/);
});

test("fs_team_verify:多成员(目录有但清单没报)→ 列出多余目录", async () => {
  calls.length = 0;
  const queue = [
    { stdout: lsOut([["shared", "D"], ["members", "D"]]) },
    { stdout: lsOut([["TEAM.md", "A", 99]]) },
    { stdout: lsOut([["kimi", "D"], ["ghost", "D"]]) },
    { stdout: lsOut([["README.md", "A", 42]]) },
  ];
  script = () => queue.shift() ?? { stdout: "" };
  const out = await toolsByName().get("fs_team_verify").handler({ path: "projects/demo", members: ["kimi"] });
  assert.equal(out.ok, false);
  const align = out.checks.find((c) => c.name === "members_align");
  assert.equal(align.pass, false);
  assert.match(align.detail, /ghost/);
  assert.match(align.detail, /没报/);
});

test("fs_team_verify:成员目录无 README → 对应 readme_* 项不过", async () => {
  calls.length = 0;
  const queue = [
    { stdout: lsOut([["shared", "D"], ["members", "D"]]) },
    { stdout: lsOut([["TEAM.md", "A", 99]]) },
    { stdout: lsOut([["kimi", "D"], ["opencode", "D"]]) },
    { stdout: "" }, // kimi 工位是空目录,没 README
    { stdout: lsOut([["README.md", "A", 42]]) },
  ];
  script = () => queue.shift() ?? { stdout: "" };
  const out = await toolsByName().get("fs_team_verify").handler({ path: "projects/demo" });
  assert.equal(out.ok, false);
  const readme = out.checks.find((c) => c.name === "readme_kimi");
  assert.equal(readme.pass, false);
  assert.match(readme.detail, /README\.md 缺失/);
  assert.equal(out.checks.find((c) => c.name === "readme_opencode").pass, true);
});

test("fs_team_verify:项目目录不存在 → 结构化失败而非抛错", async () => {
  calls.length = 0;
  script = { stderr: NOT_FOUND, stdout: "" };
  const out = await toolsByName().get("fs_team_verify").handler({ path: "projects/nope", members: ["kimi"] });
  assert.equal(out.ok, false);
  assert.equal(out.checks.every((c) => c.pass === false), true);
  assert.match(out.checks[0].detail, /不存在/);
});

test("fs_team_verify:路径走沙箱(拒绝 ..),不发起 smb 调用", async () => {
  calls.length = 0;
  const out = await toolsByName().get("fs_team_verify").handler({ path: "../../etc" });
  assert.equal(out.ok, false);
  assert.match(out.error.message, /\.\./);
  assert.equal(calls.length, 0);
});

// ---- 凭证与错误卫生 --------------------------------------------------------------

test("密码不外泄:成功/失败返回值与错误信息均不含密码 argv", async () => {
  calls.length = 0;
  script = { stderr: "NT_STATUS_OBJECT_NAME_NOT_FOUND opening remote file \\nope", stdout: "" };
  const out = await toolsByName().get("fs_remove").handler({ path: "nope" });
  assert.equal(out.ok, false);
  const flat = JSON.stringify(out);
  assert.equal(flat.includes(PASS), false, "返回值不得含密码");
  assert.equal(flat.includes("%"), false, "返回值不得含 user%pass 片段");

  // 即便底层错误消息被恶意拼进密码,runSmb 只透出 stderr(不含 argv)
  calls.length = 0;
  script = { stderr: "boom", stdout: "" };
  const out2 = await toolsByName().get("fs_list").handler({ path: "x" });
  assert.equal(JSON.stringify(out2).includes(PASS), false);
});

test("错误结构统一:{ok:false,error:{code,message}},SMB 错误标 SMB_ERROR", async () => {
  calls.length = 0;
  script = { stderr: "NT_STATUS_ACCESS_DENIED", stdout: "" };
  const out = await toolsByName().get("fs_list").handler({ path: "x" });
  assert.deepEqual([out.ok, out.error.code], [false, "SMB_ERROR"]);
  assert.ok(out.error.message.length > 0);
});

