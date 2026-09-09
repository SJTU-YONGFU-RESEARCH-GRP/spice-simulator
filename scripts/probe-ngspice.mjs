import createNgspiceModule from "../vendor/ngspice.js";

async function once(label) {
  const lines = [];
  const ng = await createNgspiceModule({
    print: (t) => lines.push(String(t)),
    printErr: (t) => lines.push("E:" + String(t)),
    noExitRuntime: true,
  });
  function ensureDir(p) {
    let cur = "";
    for (const part of p.split("/").filter(Boolean)) {
      cur += "/" + part;
      try {
        ng.FS.mkdir(cur);
      } catch {
        /* */
      }
    }
  }
  ensureDir("/proc/self");
  ensureDir("/usr/local/share/ngspice/scripts");
  ng.FS.writeFile(
    "/proc/meminfo",
    "MemTotal:       16777216 kB\nMemFree:        8388608 kB\nMemAvailable:   8388608 kB\n"
  );
  ng.FS.writeFile("/proc/self/statm", "0 0 0 0 0 0 0\n");
  ng.FS.writeFile(
    "/usr/local/share/ngspice/scripts/spinit",
    "set filetype=ascii\nset ngbehavior=lt\n"
  );
  ng.FS.writeFile(
    "/circuit.cir",
    `t
V1 in 0 DC 5
R1 in out 1k
R2 out 0 1k
.op
.end
`
  );
  function makeArgv(args) {
    const ptrs = args.map((a) => ng.stringToUTF8OnStack(a));
    const argv = ng.stackAlloc((args.length + 1) * 4);
    for (let i = 0; i < ptrs.length; i++) ng.HEAP32[(argv >> 2) + i] = ptrs[i];
    ng.HEAP32[(argv >> 2) + ptrs.length] = 0;
    return { argc: args.length, argv };
  }
  try {
    const { argc, argv } = makeArgv(["ngspice", "-b", "-r", "/out.raw", "/circuit.cir"]);
    ng._main(argc, argv);
  } catch (e) {
    console.log(label, "exit", e.message);
  }
  try {
    const raw = ng.FS.readFile("/out.raw", { encoding: "utf8" });
    console.log(label, "raw pts", /No\. Points:\s*(\d+)/.exec(raw)?.[1]);
    // second call on same module
    try {
      ng.FS.unlink("/out.raw");
    } catch {
      /* */
    }
    try {
      const { argc, argv } = makeArgv(["ngspice", "-b", "-r", "/out.raw", "/circuit.cir"]);
      ng._main(argc, argv);
    } catch (e) {
      console.log(label, "2nd exit", e.message);
    }
    try {
      const raw2 = ng.FS.readFile("/out.raw", { encoding: "utf8" });
      console.log(label, "2nd raw", /No\. Points:\s*(\d+)/.exec(raw2)?.[1]);
    } catch (e) {
      console.log(label, "2nd no raw", e.message);
    }
  } catch (e) {
    console.log(label, "fail", e.message);
  }
}

await once("run");
