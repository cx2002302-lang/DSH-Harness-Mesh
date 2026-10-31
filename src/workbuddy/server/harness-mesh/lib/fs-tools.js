/** 团队文件服务器工具组(Samba //192.168.1.33/ai,smbclient CLI 封装):
 *  - fs_team_init   建项目目录骨架 projects/<p>/{shared,members/<m>} + 团队文档(幂等,已存在不覆盖)
 *  - fs_team_verify 项目目录体检(shared/TEAM.md/成员对齐/README),结构化 checks 报告
 *  - fs_list / fs_read(≤256KB)/ fs_write / fs_upload / fs_download / fs_remove
 *
 * 设计要点:
 *  - 路径沙箱:统一 \→/ 后规范化,拒绝绝对路径 / .. / 空路径 / shell 元字符,
 *    规范化结果必须落在共享根内;本地路径(upload/download)不经沙箱。
 *  - 凭证:密码读 process.env.MESH_SMB_PASS(fallback 'change-me'),host/share 可用
 *    MESH_SMB_HOST / MESH_SMB_SHARE 覆盖;execFile 参数数组调用(无 shell),
 *    错误信息只取 stderr/stdout,绝不把含密码的 argv 写进日志/返回值。
 *  - 单命令单次调用 smbclient -c,超时 20s;错误统一 {ok:false,error:{code,message}}。
 */
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";

const READ_LIMIT = 256 * 1024; // fs_read 上限 256KB
const SMB_TIMEOUT_MS = 20_000;

function smbError(code, message) {
  return { ok: false, error: { code, message } };
}

/** 路径沙箱:\ 与 / 统一为 /,拒绝对路径、..、空路径与 smbclient -c 元字符;返回共享根内相对路径。 */
export function sanitizePath(raw, { what = "路径" } = {}) {
  const p = String(raw ?? "").replace(/\\/g, "/");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) {
    throw new Error(`${what}不允许绝对路径: ${raw}`);
  }
  const parts = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw new Error(`${what}不允许 .. 上跳: ${raw}`);
    if (/["';\r\n]/.test(seg)) throw new Error(`${what}含非法字符: ${seg}`);
    parts.push(seg);
  }
  if (parts.length === 0) throw new Error(`${what}为空`);
  return parts.join("/");
}

/** 组 smbclient argv(凭证只在 argv,经 execFile 传递,不进 shell/日志)。 */
export function buildSmbArgs(commands) {
  const host = process.env.MESH_SMB_HOST || "192.168.1.33";
  const share = process.env.MESH_SMB_SHARE || "ai";
  const user = process.env.MESH_SMB_USER || "ai";
  const pass = process.env.MESH_SMB_PASS || "change-me";
  return [
    `//${host}/${share}`,
    "-U", `${user}%${pass}`,
    "-m", "SMB3",
    "-c", commands.join("; "),
  ];
}

/** 跑一次 smbclient(单次 -c,超时 20s);非零退出只暴露 stderr/stdout,不暴露含密码的命令行。 */
export function runSmb(commands) {
  const args = buildSmbArgs(commands);
  return new Promise((resolve, reject) => {
    execFile("smbclient", args, { timeout: SMB_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || stdout || "").trim() || err.code || "smbclient failed";
        const e = new Error(detail);
        e.code = String(stderr || "").includes("NT_STATUS") ? "SMB_ERROR" : "EXEC_ERROR";
        reject(e);
        return;
      }
      resolve(String(stdout ?? ""));
    });
  });
}

/** 统一把内部异常折成 {ok:false,error:{code,message}}。 */
function guard(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (error) {
      return smbError(error?.code || "FS_ERROR", String(error?.message ?? error));
    }
  };
}

// ---- 内部动作 ---------------------------------------------------------------

/** 解析 smbclient ls 输出里的条目名(丢弃 . .. 与噪音行)。 */
export function parseLsNames(out) {
  const names = [];
  for (const line of String(out ?? "").split("\n")) {
    const m = line.match(/^ {2}(.+?)\s+([DAHRSN]*)\s+(\d+)\s+\w{3} \w{3}/);
    if (m && !/^\.{1,2}$/.test(m[1])) names.push(m[1]);
  }
  return names;
}

/** 解析 smbclient ls 输出为 {name,type,size}(丢弃 . .. 与噪音行)。 */
export function parseLsEntries(out) {
  const entries = [];
  for (const line of String(out ?? "").split("\n")) {
    const m = line.match(/^ {2}(.+?)\s+([DAHRSN]*)\s+(\d+)\s+\w{3} \w{3}/);
    if (m && !/^\.{1,2}$/.test(m[1])) {
      entries.push({ name: m[1], type: (m[2] || "").includes("D") ? "dir" : "file", size: Number(m[3]) });
    }
  }
  return entries;
}

const NOT_FOUND_RE = /OBJECT_NAME_NOT_FOUND|OBJECT_PATH_NOT_FOUND|NO_SUCH_FILE/i;

/** 列某个共享根内目录的条目名;目录不存在折成 {found:false}(其余错误原样抛出)。 */
async function lsNames(rel) {
  try {
    const out = await runSmb([`ls "${rel}/*"`]);
    return { found: true, names: parseLsNames(out) };
  } catch (error) {
    if (/OBJECT_NAME_NOT_FOUND|OBJECT_PATH_NOT_FOUND|NO_SUCH_FILE/i.test(String(error?.message ?? ""))) {
      return { found: false, names: [] };
    }
    throw error;
  }
}

const TEAM_RULE = "规约:公共文件写 shared/,私人文件只写 members/<你>/,不碰别人的工位,不越界。";

function teamMdRoster(proj, members) {
  const rows = members.map((m) => `| ${m} | projects/${proj}/members/${m} |`).join("\n");
  return [
    `# ${proj} 团队名册`,
    "",
    `- 公共区:projects/${proj}/shared —— 大家都能读写的共享文件放这里`,
    "- 私人区:每位成员一个工位,只写自己的目录",
    "",
    "| 成员 | 私人区 |",
    "|---|---|",
    rows || "| (暂无) | - |",
    "",
    TEAM_RULE,
    "",
  ].join("\n");
}

function memberReadme(proj, m) {
  return [
    `# ${m} 的工位`,
    "",
    `这是你在项目 ${proj} 的私人区,只有你写;公共区在 ../../shared(即 projects/${proj}/shared)。`,
    "",
    "常用命令:",
    `- fs_write:{"path":"projects/${proj}/members/${m}/notes.md","content":"..."} —— 写入你的私人区`,
    `- fs_list:{"path":"projects/${proj}/shared"} —— 看公共区有什么`,
    `- fs_read:{"path":"projects/${proj}/shared/TEAM.md"} —— 读团队名册与规约`,
    "",
    TEAM_RULE,
    "",
  ].join("\n");
}

/** 批量 put 文本文件(本地临时目录逐个落盘,合并为单次 smbclient -c)。 */
async function putFiles(files) {
  if (!files.length) return;
  const dir = await mkdtemp(join(tmpdir(), "harness-mesh-fs-"));
  try {
    const cmds = [];
    for (const [i, f] of files.entries()) {
      const local = join(dir, `f${i}`);
      await writeFile(local, Buffer.from(f.content, "utf8"));
      cmds.push(`put "${local}" "${f.rel}"`);
    }
    await runSmb(cmds);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function doTeamInit({ project, members }) {
  const proj = sanitizePath(project, { what: "项目名" });
  const list = (Array.isArray(members) ? members : []).map((m) => sanitizePath(m, { what: "成员名" }));
  const base = `projects/${proj}`;
  const created = [];
  const skipped = [];

  // 1) 目录骨架:先探明现状,只建缺的(幂等,已存在不覆盖)
  const root = await lsNames(base);
  if (!root.found) {
    const dirs = ["projects", base, `${base}/shared`, `${base}/members`, ...list.map((m) => `${base}/members/${m}`)];
    await runSmb(dirs.map((d) => `mkdir "${d}"`));
    created.push(...dirs);
  } else {
    if (root.names.includes("shared")) skipped.push(`${base}/shared`);
    else created.push(`${base}/shared`);
    const memLs = await lsNames(`${base}/members`);
    if (!memLs.found) {
      await runSmb([`mkdir "${base}/members"`]);
      created.push(`${base}/members`);
    } else {
      skipped.push(`${base}/members`);
      const missing = list.filter((m) => !memLs.names.includes(m));
      for (const m of memLs.names.filter((m) => list.includes(m))) skipped.push(`${base}/members/${m}`);
      if (missing.length) {
        await runSmb(missing.map((m) => `mkdir "${base}/members/${m}"`));
        created.push(...missing.map((m) => `${base}/members/${m}`));
      }
    }
  }

  // 2) 团队文档:TEAM.md + 每成员 README.md,仅在不存在时创建(保护用户改动)
  const sharedLs = await lsNames(`${base}/shared`);
  const files = [];
  if (sharedLs.names.includes("TEAM.md")) skipped.push(`${base}/shared/TEAM.md`);
  else files.push({ rel: `${base}/shared/TEAM.md`, content: teamMdRoster(proj, list) });
  for (const m of list) {
    const mLs = await lsNames(`${base}/members/${m}`);
    if (mLs.names.includes("README.md")) skipped.push(`${base}/members/${m}/README.md`);
    else files.push({ rel: `${base}/members/${m}/README.md`, content: memberReadme(proj, m) });
  }
  await putFiles(files);
  created.push(...files.map((f) => f.rel));

  return { ok: true, project: proj, members: list, created, skipped };
}

async function doVerify({ path, members }) {
  const proj = sanitizePath(path, { what: "项目路径" });
  const base = proj;
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: String(detail ?? "") });

  const root = await lsNames(base);
  if (!root.found) {
    add("project_dir", false, `projects/${base.split("/").pop()} 不存在,先 fs_team_init`);
    add("shared_dir", false, "无法检查:项目目录不存在");
    add("team_md", false, "无法检查:shared/ 不存在");
    add("members_dir", false, "无法检查:项目目录不存在");
    if (Array.isArray(members) && members.length) add("members_align", false, "无法检查:项目目录不存在");
    return { ok: false, path: proj, members: [], checks };
  }

  add("project_dir", true, `${base} 存在(${root.names.length} 项)`);

  // shared/ 与 TEAM.md
  const hasShared = root.names.includes("shared");
  add("shared_dir", hasShared, hasShared ? "shared/ 存在" : "shared/ 缺失");
  const sharedLs = hasShared ? await lsNames(`${base}/shared`) : { found: false, names: [] };
  const hasTeamMd = sharedLs.names.includes("TEAM.md");
  add("team_md", hasTeamMd, hasTeamMd ? "TEAM.md 存在" : "shared/TEAM.md 缺失(团队名册/规约)");

  // members/ 目录与清单对齐
  const memLs = await lsNames(`${base}/members`);
  add("members_dir", memLs.found, memLs.found ? `members/ 存在(${memLs.names.length} 个成员目录)` : "members/ 缺失");
  const dirMembers = memLs.names;
  let finalMembers = dirMembers;
  if (Array.isArray(members) && members.length) {
    const want = members.map((m) => sanitizePath(m, { what: "成员名" }));
    const missing = want.filter((m) => !dirMembers.includes(m));
    const extra = dirMembers.filter((m) => !want.includes(m));
    const bits = [];
    if (missing.length) bits.push(`清单有但目录缺: ${missing.join(", ")}`);
    if (extra.length) bits.push(`目录有但清单没报: ${extra.join(", ")}`);
    add("members_align", missing.length === 0 && extra.length === 0,
      bits.length ? bits.join(";") : `清单与目录对齐(${want.length} 人)`);
    finalMembers = want;
  } else {
    add("members_align", true, `未提供 members 清单,按现有目录核对: ${dirMembers.join(", ") || "(空)"}`);
  }

  // 每个成员工位要有 README.md
  for (const m of finalMembers) {
    const mLs = memLs.names.includes(m) ? await lsNames(`${base}/members/${m}`) : { names: [] };
    const hasReadme = mLs.names.includes("README.md");
    add(`readme_${m}`, hasReadme, hasReadme ? "README.md 存在" : `members/${m}/README.md 缺失`);
  }

  return { ok: checks.every((c) => c.pass), path: proj, members: finalMembers, checks };
}

async function doList({ path }) {
  const rel = sanitizePath(path);
  const out = await runSmb([`ls "${rel}/*"`]);
  const entries = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^ {2}(.+?)\s+([DAHRSN]*)\s+(\d+)\s+\w{3} \w{3}/);
    if (m) {
      entries.push({ name: m[1], type: (m[2] || "").includes("D") || m[1].match(/^\.{1,2}$/) ? "dir" : "file", size: Number(m[3]) });
    } else if (/^(NT_STATUS|smb:)/.test(line.trim()) || !line.trim()) {
      continue;
    }
  }
  return { ok: true, path: rel, entries };
}

async function withTempFile(prefix, writeFn, action) {
  const dir = await mkdtemp(join(tmpdir(), "harness-mesh-fs-"));
  const local = join(dir, prefix);
  try {
    await writeFn(local);
    return await action(local);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function doRead({ path }) {
  const rel = sanitizePath(path);
  const content = await withTempFile("read", () => Promise.resolve(), (local) =>
    runSmb([`get "${rel}" "${local}"`]).then(() => readFile(local)),
  );
  if (content.length > READ_LIMIT) {
    throw Object.assign(new Error(`文件超过 256KB 上限(${content.length} bytes),请用 fs_download`), { code: "ETOOLARGE" });
  }
  return { ok: true, path: rel, bytes: content.length, content: content.toString("utf8") };
}

async function doWrite({ path, content }) {
  const rel = sanitizePath(path);
  const data = Buffer.from(String(content ?? ""), "utf8");
  const bytes = await withTempFile("write", (local) => writeFile(local, data), (local) =>
    runSmb([`put "${local}" "${rel}"`]).then(() => data.length),
  );
  return { ok: true, path: rel, bytes };
}

async function doUpload({ local, remote }) {
  const rel = sanitizePath(remote, { what: "远程路径" });
  await runSmb([`put "${local}" "${rel}"`]);
  return { ok: true, remote: rel, local: "" };
}

async function doDownload({ remote, local }) {
  const rel = sanitizePath(remote, { what: "远程路径" });
  await runSmb([`get "${rel}" "${local}"`]);
  return { ok: true, remote: rel, local };
}

/** 探测共享根内路径类型:list 父目录看条目 attr 是否带 D。返回 {found,type:"dir"|"file"}。 */
async function statPath(rel) {
  const idx = rel.lastIndexOf("/");
  const parent = idx === -1 ? "" : rel.slice(0, idx);
  const name = rel.slice(idx + 1);
  try {
    const out = await runSmb([`ls "${parent ? `${parent}/` : ""}*"`]);
    const hit = parseLsEntries(out).find((e) => e.name === name);
    return hit ? { found: true, type: hit.type } : { found: false, type: null };
  } catch (error) {
    if (NOT_FOUND_RE.test(String(error?.message ?? ""))) return { found: false, type: null };
    throw error;
  }
}

/** 把底层 smbclient 错误转成友好 message(不透出原始 NT_STATUS 输出)。 */
function friendlyRemoveError(action, rel, error) {
  const raw = String(error?.message ?? "");
  let reason;
  if (NOT_FOUND_RE.test(raw)) reason = "路径不存在(可能刚被其他人删除)";
  else if (/ACCESS_DENIED/i.test(raw)) reason = "没有权限";
  else if (/DIRECTORY_NOT_EMPTY/i.test(raw)) reason = "目录非空";
  else reason = "共享服务器操作失败";
  const e = new Error(`${action} ${rel} 失败:${reason}`);
  e.code = error?.code || "FS_ERROR";
  return e;
}

/** 递归删除目录树:自底向上(删文件 → 递归子目录 → rmdir);返回实际删除的路径列表。entries 为该目录已有清单。 */
async function removeDirTree(rel, entries) {
  const removed = [];
  for (const entry of entries) {
    const child = `${rel}/${entry.name}`;
    if (entry.type === "dir") {
      let childEntries;
      try {
        childEntries = parseLsEntries(await runSmb([`ls "${child}/*"`]));
      } catch (error) {
        throw friendlyRemoveError("列目录", child, error);
      }
      removed.push(...await removeDirTree(child, childEntries));
    } else {
      try {
        await runSmb([`rm "${child}"`]);
      } catch (error) {
        throw friendlyRemoveError("删除文件", child, error);
      }
      removed.push(child);
    }
  }
  try {
    await runSmb([`rmdir "${rel}"`]);
  } catch (error) {
    throw friendlyRemoveError("删除目录", rel, error);
  }
  removed.push(rel);
  return removed;
}

async function doRemove({ path, recursive }) {
  const rel = sanitizePath(path);
  const st = await statPath(rel);
  if (!st.found) {
    throw Object.assign(new Error(`路径不存在: ${rel}(请先用 fs_list 确认路径)`), { code: "ENOENT" });
  }
  if (st.type === "file") {
    try {
      await runSmb([`rm "${rel}"`]);
    } catch (error) {
      throw friendlyRemoveError("删除文件", rel, error);
    }
    return { ok: true, path: rel, removed: [rel], removedCount: 1 };
  }
  // 目录:非空时默认拒绝,recursive:true 才递归删
  let entries;
  try {
    entries = parseLsEntries(await runSmb([`ls "${rel}/*"`]));
  } catch (error) {
    throw friendlyRemoveError("列目录", rel, error);
  }
  if (entries.length && !recursive) {
    throw Object.assign(
      new Error(`目录 ${rel} 非空(${entries.length} 项),默认拒绝删除;确认要整树删除请加 recursive:true`),
      { code: "ENOTEMPTY" },
    );
  }
  const removed = await removeDirTree(rel, entries);
  return { ok: true, path: rel, removed, removedCount: removed.length };
}

// ---- 工具注册表(dsh-tools defineTool,风格对齐 lib/tools.js)------------------

const FSPATH_PROP = (desc) => ({ type: "string", required: true, description: desc });

export function createFsTools() {
  return [
    defineFsTool({
      name: "fs_team_init",
      description: "在团队文件服务器上建项目目录骨架:projects/<project>/{shared,members/<member>…},并自动写 shared/TEAM.md 名册与每成员 README.md(幂等:已存在的目录/文件不覆盖,只建缺的;返回 created/skipped 清单)。",
      parameters: {
        project: { type: "string", description: "项目名(单段路径,不允许 / 或 ..)" },
        members: { type: "array", required: true, items: { type: "string" }, description: "成员 harness 名列表,每人一个私人区 members/<member>" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            project: { type: "string" },
            members: { type: "array", items: { type: "string" } },
            created: { type: "array", items: { type: "string" }, description: "本次实际创建的目录/文件" },
            skipped: { type: "array", items: { type: "string" }, description: "已存在因而跳过(未覆盖)的目录/文件" },
            error: { type: "object", additionalProperties: true, description: "失败时的 {code,message}" },
          },
        },
        render: (_a, v) => [{ type: "text", text: v.ok
          ? `项目 ${v.project} 骨架已就绪:新建 ${v.created.length} 项、跳过已存在 ${v.skipped.length} 项(成员: ${v.members.join(", ") || "无"})。`
          : `fs_team_init 失败[${v.error?.code}]: ${v.error?.message}` }],
      },
      handler: doTeamInit,
    }),

    defineFsTool({
      name: "fs_team_verify",
      description: "给项目目录做体检:projects/<p> 的 shared/、TEAM.md、members/ 与成员清单对齐(多报/少报都列出)、每成员 README.md。返回 {ok, checks:[{name,pass,detail}]} 结构化报告。",
      parameters: {
        path: FSPATH_PROP("项目目录,形如 projects/<p>"),
        members: { type: "array", items: { type: "string" }, description: "可选成员清单;不给则按 members/ 现有目录核对" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            path: { type: "string" },
            members: { type: "array", items: { type: "string" } },
            checks: { type: "array", required: true, items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string", required: true },
                pass: { type: "boolean", required: true },
                detail: { type: "string", required: true },
              },
            } },
            error: { type: "object", additionalProperties: true },
          },
        },
        render: (_a, v) => {
          if (!v.ok && v.error) return [{ type: "text", text: `fs_team_verify 失败[${v.error?.code}]: ${v.error?.message}` }];
          const bad = v.checks.filter((c) => !c.pass);
          return [{ type: "text", text: `项目 ${v.path} 体检:${bad.length ? `${bad.length} 项不通过` : "全部通过"}(${v.checks.length} 项检查)\n${v.checks.map((c) => `- [${c.pass ? "✓" : "✗"}] ${c.name}: ${c.detail}`).join("\n")}` }];
        },
      },
      handler: doVerify,
    }),

    defineFsTool({
      name: "fs_list",
      description: "列团队文件服务器上某个目录(共享根内相对路径,如 projects/demo/shared)。",
      parameters: { path: FSPATH_PROP("共享根内相对路径") },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            path: { type: "string" },
            entries: { type: "array", items: {
              type: "object",
              additionalProperties: false,
              properties: { name: { type: "string", required: true }, type: { type: "string", required: true, enum: ["dir", "file"] }, size: { type: "integer", required: true } },
            } },
            error: { type: "object", additionalProperties: true },
          },
        },
        render: (_a, v) => [{ type: "text", text: v.ok
          ? `${v.path}(${v.entries.length} 项):\n${v.entries.map((e) => `- ${e.name} [${e.type}] ${e.size}`).join("\n") || "(空目录)"}`
          : `fs_list 失败[${v.error?.code}]: ${v.error?.message}` }],
      },
      handler: doList,
    }),

    defineFsTool({
      name: "fs_read",
      description: "读团队文件服务器上的文本文件,上限 256KB(更大用 fs_download)。",
      parameters: { path: FSPATH_PROP("共享根内相对路径(文件)") },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            path: { type: "string" },
            bytes: { type: "integer" },
            content: { type: "string" },
            error: { type: "object", additionalProperties: true },
          },
        },
        render: (_a, v) => [{ type: "text", text: v.ok ? v.content : `fs_read 失败[${v.error?.code}]: ${v.error?.message}` }],
      },
      handler: doRead,
    }),

    defineFsTool({
      name: "fs_write",
      description: "把文本内容写到团队文件服务器(覆盖写;父目录需已存在,没有先 fs_team_init 或让管理员建)。",
      parameters: {
        path: FSPATH_PROP("共享根内相对路径(文件)"),
        content: { type: "string", description: "要写入的 UTF-8 文本" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            path: { type: "string" },
            bytes: { type: "integer" },
            error: { type: "object", additionalProperties: true },
          },
        },
        render: (_a, v) => [{ type: "text", text: v.ok ? `已写入 ${v.path}(${v.bytes} bytes)。` : `fs_write 失败[${v.error?.code}]: ${v.error?.message}` }],
      },
      handler: doWrite,
    }),

    defineFsTool({
      name: "fs_upload",
      description: "把本机文件上传到团队文件服务器。",
      parameters: {
        local: { type: "string", description: "本机文件路径" },
        remote: FSPATH_PROP("共享根内相对路径(目标文件)"),
      },
      output: uploadDownloadSchema("fs_upload"),
      render: (_a, v) => [{ type: "text", text: v.ok ? `已上传 ${v.local} → ${v.remote}。` : `fs_upload 失败[${v.error?.code}]: ${v.error?.message}` }],
      handler: doUpload,
    }),

    defineFsTool({
      name: "fs_download",
      description: "从团队文件服务器下载文件到本机(大文件也走这里)。",
      parameters: {
        remote: FSPATH_PROP("共享根内相对路径(源文件)"),
        local: { type: "string", description: "本机目标路径" },
      },
      output: uploadDownloadSchema("fs_download"),
      render: (_a, v) => [{ type: "text", text: v.ok ? `已下载 ${v.remote} → ${v.local}。` : `fs_download 失败[${v.error?.code}]: ${v.error?.message}` }],
      handler: doDownload,
    }),

    defineFsTool({
      name: "fs_remove",
      description: "删除团队文件服务器上的文件或目录:先探测类型,文件用 del、目录用 rmdir;空目录直接删,非空目录默认拒绝(报 ENOTEMPTY),recursive:true 时自底向上递归整树删除。删除不可恢复,调用前向用户确认。",
      parameters: {
        path: FSPATH_PROP("共享根内相对路径(文件或目录)"),
        recursive: { type: "boolean", description: "可选,允许递归删除非空目录(默认 false:非空目录拒绝并报错)" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            path: { type: "string" },
            removed: { type: "array", items: { type: "string" }, description: "实际删除的文件/目录清单(递归时为整树)" },
            removedCount: { type: "integer", description: "删除项数" },
            error: { type: "object", additionalProperties: true },
          },
        },
        render: (_a, v) => [{ type: "text", text: v.ok ? `已删除 ${v.path}(共 ${v.removedCount} 项)。` : `fs_remove 失败[${v.error?.code}]: ${v.error?.message}` }],
      },
      handler: doRemove,
    }),
  ];
}

function uploadDownloadSchema(name) {
  return {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean", required: true },
        remote: { type: "string" },
        local: { type: "string", required: true, description: `${name} 本地路径(另一方向为空串)` },
        error: { type: "object", additionalProperties: true },
      },
    },
  };
}

/** 与 lib/tools.js 同款注册:dsh-tools defineTool(name/description/parameters/output + execute)。
 *  注意:createFsTools() 返回完整 defineTool 形状(lib/tools.js 直接展开用);
 *  MCP/hot.js 需要的 {name,description,inputSchema,handler} 形状从它派生,
 *  定义唯一来源在这里,不两处抄。 */
function defineFsTool({ name, description, parameters, output, handler }) {
  return defineTool({
    name,
    description,
    parameters,
    output,
    execute: guard(handler),
  });
}

/** 纯定义(仅 name/description/inputSchema,无 handler):供 hot.js 的 MCP tools/list 复用。
 *  inputSchema 即 defineTool 编译好的 JSON Schema(parameters)。 */
export const FS_TOOL_DEFS = createFsTools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }));
