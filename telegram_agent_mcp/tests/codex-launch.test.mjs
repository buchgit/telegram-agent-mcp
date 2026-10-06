import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { codexArgs, codexLaunch } from "../dist/codex-launch.js";

// Real subprocess round trip: protect paths with spaces/Cyrillic/& and the stdin prompt.
for (const mode of ["new", "fork", "resume"]) {
  test(`${mode}: argv and Russian stdin survive without shell parsing`, () => {
    const reply = "C:/TestProjects/Проект с пробелами/& report.txt";
    const args = codexArgs(reply, mode === "resume" ? "telegram-id" : null, mode === "fork" ? "source-id" : null);
    const prompt = "повтори вывод статистики\n$() & | >";
    const script = `let body=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',x=>body+=x); process.stdin.on('end',()=>console.log(JSON.stringify({args:process.argv.slice(1),body})));`;
    const result = spawnSync(process.execPath, ["-e", script, "--", ...args], {input:prompt,encoding:"utf8",shell:false,windowsHide:true});
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {args, body:prompt});
    assert.equal(args[args.indexOf("--output-last-message")+1], reply);
    assert.equal(args.at(-1), "-");
    if(mode!=="new") assert.equal(args[2], mode);
  });
}

test("installed Codex accepts the fork argv including spaced output path", {skip:process.platform!=="win32"}, () => {
  const launch=codexLaunch(codexArgs("C:/TestProjects/Проект с пробелами/reply.txt",null,"00000000-0000-0000-0000-000000000000"));
  const result=spawnSync(launch.executable,launch.args,{input:"",encoding:"utf8",shell:false,windowsHide:true,timeout:15000});
  assert.doesNotMatch(result.stderr ?? "", /unexpected argument/);
  assert.match(result.stderr ?? "", /No prompt provided via stdin/);
});
