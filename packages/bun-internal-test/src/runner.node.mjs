import { spawn, spawnSync } from "node:child_process";
import {
  readFileSync,
  openSync,
  closeSync,
  mkdtempSync,
  existsSync,
  statSync,
  mkdirSync,
  accessSync,
  constants as fs,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { readdirSync } from "node:fs";
import { tmpdir, cpus, hostname } from "node:os";
import { join, resolve, basename, dirname, relative } from "node:path";
import { inspect } from "node:util";
import readline from "node:readline/promises";

const isLinux = process.platform === "linux";
const isMacOS = process.platform === "darwin";
const isWindows = process.platform === "win32";
const isGitHubAction = !!process.env["GITHUB_ACTIONS"];
const isBuildKite = !!process.env["BUILDKITE"];
const isBuildKiteTestSuite = !!process.env["BUILDKITE_ANALYTICS_TOKEN"];
const isCI = !!process.env["CI"] || isGitHubAction || isBuildKite;
const isInteractive = !isCI && process.argv.includes("-i") && process.stdout.isTTY;

const cwd = resolve(import.meta.dirname, "../../..");
const tmp = getTmpdir();
const spawnTimeout = 30_000;
const softTestTimeout = 60_000;
const hardTestTimeout = 3 * softTestTimeout;
const endOfLine = isWindows ? "\r\n" : "\n";

async function runTests(target) {
  const timestamp = new Date();
  println(`Timestamp: ${timestamp}`);
  println(`OS: ${getOsPrettyText()}`);
  println(`Arch: ${getArchText()}`);
  println(`Hostname: ${getHostname()}`);
  if (isCI) {
    println(`CI: ${getCI()}`);
    println(`Build URL: ${getBuildUrl()}`);
  }

  let execPath;
  if (isBuildKite) {
    execPath = await getExecPathFromBuildKite(target);
  } else {
    execPath = getExecPath(target);
  }
  println(`Bun: ${execPath}`);
  const revision = getRevision(execPath);
  println(`Revision: ${revision}`);

  const testsPath = join(cwd, "test");
  const installPaths = [dirname(import.meta.dirname), cwd, testsPath];
  for (const path of installPaths) {
    runInstall(execPath, path);
  }

  println("Finding tests...");
  const tests = getTests(testsPath);
  const changedFiles = getChangedFiles(testsPath);
  const changedTests = tests.filter(test => changedFiles.has(test));
  const unchangedTests = tests.filter(test => !changedFiles.has(test));
  println(`Found ${changedTests.length} changed tests`);
  const sequentialTests = unchangedTests.filter(isSequentialTest);
  println(`Found ${sequentialTests.length} sequential tests`);
  const parallelTests = unchangedTests.filter(path => !isSequentialTest(path));
  println(`Found ${parallelTests.length} parallel tests`);
  println(`Found ${tests.length} total tests`);

  println(`Running tests...`);
  const concurrency = getConcurrency();
  const { default: PQueue } = await import("p-queue");
  const sequentialQueue = new PQueue({ concurrency: 1 });
  const parallelQueue = concurrency === 1 ? sequentialQueue : new PQueue({ concurrency });

  const results = {};
  const createTest = testPath => async () => {
    const realPath = relative(cwd, join(testsPath, testPath));
    const result = await runAndReportTest({ cwd: testsPath, execPath, testPath, tmpPath: tmp });
    results[realPath] = result;
    return result;
  };

  for (const testPath of changedTests) {
    parallelQueue.add(createTest(testPath), {
      priority: 1,
    });
  }
  for (const testPath of sequentialTests) {
    sequentialQueue.add(createTest(testPath));
  }
  for (const testPath of parallelTests) {
    parallelQueue.add(createTest(testPath));
  }
  {
    parallelQueue.start();
    sequentialQueue.start();
    await Promise.all([parallelQueue.onIdle(), sequentialQueue.onIdle()]);
  }

  const summary = reportTestsToMarkdown(results);
  if (summary) {
    if (isGitHubAction) {
      const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
      if (summaryPath) {
        appendFileSync(summaryPath, summary);
      }
    } else if (isBuildKite) {
      spawnSync("buildkite-agent", ["annotate", "--append", "--style", "error", summary], {
        stdio: ["ignore", "inherit", "inherit"],
        cwd,
      });
    }
  }

  for (const { error } of Object.values(results)) {
    if (error) {
      return 1;
    }
  }

  return 0;
}

async function runTest({ cwd, execPath, testPath, tmpPath }) {
  let exitCode;
  let signalCode;
  let spawnError;
  let startedAt;
  let lastUpdated;
  let stdout = "";
  const timeout = isSequentialTest(testPath) ? softTestTimeout : spawnTimeout;
  await new Promise(resolve => {
    try {
      const tmp = mkdtempSync(join(tmpPath, "bun-test-"));
      const subprocess = spawn(execPath, ["test", testPath], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
        timeout: hardTestTimeout,
        env: {
          PATH: addPath(dirname(execPath), process.env.PATH),
          USER: process.env.USER,
          HOME: tmp,
          [isWindows ? "TEMP" : "TMPDIR"]: tmp,
          GITHUB_ACTIONS: "true", // always true so annotations are parsed
          FORCE_COLOR: "1",
          BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING: "1",
          BUN_DEBUG_QUIET_LOGS: "1",
          BUN_GARBAGE_COLLECTOR_LEVEL: "1",
          BUN_ENABLE_CRASH_REPORTING: "1",
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
          BUN_INSTALL_CACHE_DIR: join(tmp, "cache"),
        },
      });
      subprocess.on("spawn", () => {
        startedAt = Date.now();
        lastUpdated = startedAt;
      });
      subprocess.on("error", error => {
        lastUpdated = Date.now();
        spawnError = error;
        resolve();
      });
      subprocess.on("exit", (code, signal) => {
        lastUpdated = Date.now();
        exitCode = code;
        signalCode = signal;
        resolve();
      });
      subprocess.stdout.unref();
      subprocess.stdout.on("data", chunk => {
        lastUpdated = Date.now();
        stdout += chunk;
      });
      subprocess.stderr.unref();
      subprocess.stderr.on("data", chunk => {
        lastUpdated = Date.now();
        stdout += chunk;
      });
      subprocess.unref();
      const timeoutId = setInterval(() => {
        if (exitCode !== undefined || signalCode || spawnError) {
          clearInterval(timeoutId);
          return;
        }
        const remainingMs = timeout - (Date.now() - lastUpdated);
        if (remainingMs <= 0) {
          clearInterval(timeoutId);
          // reportError({
          //   message: `Test ${testPath} timed out after ${timeout}ms`,
          // });
          subprocess.kill();
          return;
        }
        const duration = Date.now() - startedAt;
        // reportWarning({
        //   message: `Test ${testPath} is still running after ${duration}ms`,
        // });
      }, spawnTimeout);
    } catch (error) {
      spawnError = error;
      resolve();
    }
  });
  const duration = Date.now() - startedAt;
  const ok = exitCode === 0 && !signalCode && !spawnError;
  const tests = [];
  let testError;
  for (const chunk of stdout.split(/\r?\n/)) {
    const string = stripAnsi(chunk);
    if (string.startsWith("::endgroup")) {
      break;
    }
    if (string.startsWith("::error")) {
      const eol = string.indexOf("::", 8);
      const message = unescapeGitHubAction(string.substring(eol + 2));
      const { file, line, col, title } = Object.fromEntries(
        string
          .substring(8, eol)
          .split(",")
          .map(entry => entry.split("=")),
      );
      testError ||= {
        file: join("test", file || testPath), // HACK
        line,
        col,
        name: title,
        stack: `${title}\n${message}`,
      };
      continue;
    }
    for (const { emoji, text } of [
      { emoji: "✓", text: "pass" },
      { emoji: "✗", text: "fail" },
      { emoji: "»", text: "skip" },
      { emoji: "✎", text: "todo" },
    ]) {
      if (!string.startsWith(emoji)) {
        continue;
      }
      const eol = string.lastIndexOf(" [") || undefined;
      const test = string.substring(1 + emoji.length, eol);
      const duration = eol ? string.substring(eol + 2, string.lastIndexOf("]")) : undefined;
      tests.push({
        file: join("test", testPath), // HACK
        test,
        status: text,
        error: testError,
        duration: parseDuration(duration),
      });
      testError = undefined;
    }
  }
  let error;
  if (spawnError) {
    const { message } = spawnError;
    if (/timed? ?out/.test(message)) {
      error = "timeout";
    } else {
      error = `error: ${message}`;
    }
  } else if (signalCode) {
    if (signalCode === "SIGTERM" && duration >= timeout) {
      error = "timeout";
    } else {
      error = signalCode;
    }
  } else if ((error = /thread \d+ panic: (.*)/.test(stdout))) {
    error = `panic: ${error[1]}`;
  } else if (exitCode === 1) {
    const match = stdout.match(/\x1b\[31m\s(\d+) fail/);
    if (match) {
      error = `${match[1]} failing`;
    } else {
      error = "code 1";
    }
  } else if (exitCode !== 0) {
    if (isWindows) {
      const winCode = getWindowsExitCode(exitCode);
      if (winCode) {
        exitCode = winCode;
      }
    }
    error = `code ${exitCode}`;
  }
  return {
    testPath,
    ok,
    status: ok ? "pass" : "fail",
    error,
    tests,
    stdout,
  };
}

async function runAndReportTest(options) {
  const result = await runTest(options);
  const { testPath, stdout, status, error } = result;

  const emoji = getTestEmoji(status);
  const color = getTestColor(status);
  const reset = ansiColor("reset");
  if (error) {
    printGroup(`${emoji} ${color}${testPath} - ${error}${reset}`);
  } else {
    printGroup(`${emoji} ${color}${testPath}${reset}`);
  }
  printStdout(stdout);
  printGroupEnd();

  if (isBuildKiteTestSuite) {
    await reportTestsToBuildKite({
      [testPath]: result,
    });
  }

  if (error && isInteractive) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await rl.question("Continue? [y] Retry? [r] Exit? [x/n]");
    switch (answer.toLowerCase()) {
      case "r":
        return runAndReportTest(options);
      case "x":
        process.exit(0);
    }
  }

  return result;
}

function runInstall(execPath, cwd) {
  printGroup(`Installing dependencies... ${cwd}`);
  try {
    const tmpPath = mkdtempSync(join(tmp, "bun-install-"));
    const { error, status, signal } = spawnSync(execPath, ["install"], {
      cwd,
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        PATH: process.env.PATH,
        [isWindows ? "TEMP" : "TMPDIR"]: tmpPath,
        BUN_INSTALL_CACHE_DIR: join(tmpPath, "cache"),
        BUN_DEBUG_QUIET_LOGS: "1",
        FORCE_COLOR: "1",
      },
    });
    if (error) {
      throw error;
    }
    if (status !== 0 || signal) {
      throw new Error(`Process exited with code ${signal || status}`);
    }
  } catch (cause) {
    throw new Error(`Could not install dependencies: ${cwd}`, { cause });
  } finally {
    printGroupEnd();
  }
}

function getGitSha() {
  const sha = process.env["GITHUB_SHA"] || process.env["BUILDKITE_COMMIT"];
  if (sha?.length === 40) {
    return sha;
  }
  try {
    const { stdout } = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" });
    return stdout.trim();
  } catch (error) {
    reportWarning(error);
    return "<unknown>";
  }
}

function getGitRef() {
  const ref = process.env["GITHUB_REF"];
  if (ref) {
    return ref;
  }
  try {
    const { stdout } = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8" });
    return stdout.trim();
  } catch (error) {
    reportWarning(error);
    return "<unknown>";
  }
}

function getConcurrency() {
  // Temporary until tests are less flaky
  if (isMacOS || isLinux) {
    return 1;
  }
  if (isInteractive) {
    return 1;
  }
  const cpuCount = cpus().length;
  return Math.max(1, Math.floor(cpuCount / 2));
}

function getTmpdir() {
  if (isMacOS) {
    if (existsSync("/tmp")) {
      return "/tmp";
    }
  }
  for (const key of ["TMPDIR", "TEMP", "TEMPDIR", "TMP", "RUNNER_TEMP"]) {
    const tmpdir = process.env[key];
    if (!tmpdir || !existsSync(tmpdir)) {
      continue;
    }
    if (isWindows) {
      if (!/^\/[a-zA-Z]\//.test(tmpdir)) {
        continue;
      }
      const driveLetter = tmpdir[1].toUpperCase();
      return path.win32.normalize(`${driveLetter}:${tmpdir.substring(2)}`);
    }
    return tmpdir;
  }
  return tmpdir();
}

function isJavaScript(path) {
  return /\.(c|m)?(j|t)sx?$/.test(basename(path));
}

function isTest(path) {
  return isJavaScript(path) && /\.test|spec\./.test(basename(path));
}

function isSequentialTest(path) {
  if (/\/(integration|io|net|spawn|shell|socket|tcp|udp|dgram|http|http2|server|listen|fs|fetch)\//.test(path)) {
    return true;
  }
  if (/stress|bench|leak/.test(path)) {
    return true;
  }
  return false;
}

function isHidden(path) {
  return /node_modules|node.js/.test(dirname(path)) || /^\./.test(basename(path));
}

function getTests(cwd) {
  function* getFiles(cwd, path) {
    const dirname = join(cwd, path);
    for (const entry of readdirSync(dirname, { encoding: "utf-8", withFileTypes: true })) {
      const { name } = entry;
      const filename = join(path, name);
      if (isHidden(filename)) {
        continue;
      }
      if (entry.isFile() && isTest(filename)) {
        yield filename;
      } else if (entry.isDirectory()) {
        yield* getFiles(cwd, filename);
      }
    }
  }
  return [...getFiles(cwd, "")].sort();
}

let ntStatus;

function getWindowsExitCode(exitCode) {
  if (ntStatus === undefined) {
    const ntStatusPath = "C:\\Program Files (x86)\\Windows Kits\\10\\Include\\10.0.22621.0\\shared\\ntstatus.h";
    try {
      ntStatus = readFileSync(ntStatusPath, "utf-8");
    } catch (error) {
      reportWarning(error);
      ntStatus = "";
    }
  }
  const match = ntStatus.match(new RegExp(`(STATUS_\\w+).*0x${exitCode.toString(16)}`, "i"));
  return match?.[1];
}

function getMaxFd() {
  if (isWindows) {
    return -1;
  }
  if (isLinux) {
    let maxFd;
    try {
      for (const path of readdirSync("/proc/self/fd")) {
        const fd = parseInt(path.trim(), 10);
        if (!Number.isSafeInteger(fd)) {
          continue;
        }
        if (!maxFd || fd > maxFd) {
          maxFd = fd;
        }
      }
    } catch (error) {
      reportWarning(error);
    }
    if (maxFd) {
      return maxFd;
    }
  }
  try {
    const fd = openSync("/dev/null", "r");
    closeSync(fd);
    return fd + 1;
  } catch (error) {
    reportWarning(error);
  }
  return -1;
}

function getExecPath(exe) {
  let execPath;
  let error;
  try {
    const { error, stdout } = spawnSync(exe, ["--print", "process.argv[0]"], {
      encoding: "utf-8",
      timeout: spawnTimeout,
      env: {
        PATH: process.env.PATH,
        BUN_DEBUG_QUIET_LOGS: 1,
      },
    });
    if (error) {
      throw error;
    }
    execPath = stdout.trim();
  } catch (cause) {
    error = cause;
  }
  if (execPath) {
    if (isExecutable(execPath)) {
      return execPath;
    }
    error = new Error(`File is not an executable: ${execPath}`);
  }
  throw new Error(`Could not find executable: ${exe}`, { cause: error });
}

async function getExecPathFromBuildKite(target) {
  const releasePath = join(cwd, "release");
  mkdirSync(releasePath, { recursive: true });
  spawnSync("buildkite-agent", ["artifact", "download", "**", releasePath, "--step", target], {
    stdio: ["ignore", "inherit", "inherit"],
    cwd,
  });
  const zipPath = join(releasePath, `${target}.zip`);
  if (isWindows) {
    spawnSync("powershell", ["-Command", `Expand-Archive -Path ${zipPath} -DestinationPath ${releasePath}`], {
      stdio: ["ignore", "inherit", "inherit"],
      cwd,
    });
  } else {
    spawnSync("unzip", ["-o", zipPath, "-d", releasePath], {
      stdio: ["ignore", "inherit", "inherit"],
      cwd,
    });
  }
  const execPath = join(releasePath, target, isWindows ? "bun.exe" : "bun");
  if (!isExecutable(execPath)) {
    throw new Error(`Could not find executable from BuildKite: ${execPath}`);
  }
  return execPath;
}

function getRevision(execPath) {
  try {
    const { error, stdout } = spawnSync(execPath, ["--revision"], {
      encoding: "utf-8",
      timeout: spawnTimeout,
      env: {
        PATH: process.env.PATH,
        BUN_DEBUG_QUIET_LOGS: 1,
      },
    });
    if (error) {
      throw error;
    }
    return stdout.trim();
  } catch (error) {
    reportWarning(error);
    return "<unknown>";
  }
}

function getOsText() {
  const { platform } = process;
  switch (platform) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return platform;
  }
}

function getOsPrettyText() {
  const { platform } = process;
  if (platform === "darwin") {
    const properties = {};
    for (const property of ["productName", "productVersion", "buildVersion"]) {
      try {
        const { error, stdout } = spawnSync("sw_vers", [`-${property}`], {
          encoding: "utf-8",
          timeout: spawnTimeout,
          env: {
            PATH: process.env.PATH,
          },
        });
        if (error) {
          throw error;
        }
        properties[property] = stdout.trim();
      } catch (error) {
        reportWarning(error);
      }
    }
    const { productName, productVersion, buildVersion } = properties;
    if (!productName) {
      return "macOS";
    }
    if (!productVersion) {
      return productName;
    }
    if (!buildVersion) {
      return `${productName} ${productVersion}`;
    }
    return `${productName} ${productVersion} (build: ${buildVersion})`;
  }
  if (platform === "linux") {
    try {
      const { error, stdout } = spawnSync("lsb_release", ["--description", "--short"], {
        encoding: "utf-8",
        timeout: spawnTimeout,
        env: {
          PATH: process.env.PATH,
        },
      });
      if (error) {
        throw error;
      }
      return stdout.trim();
    } catch (error) {
      reportWarning(error);
      return "Linux";
    }
  }
  if (platform === "win32") {
    try {
      const { error, stdout } = spawnSync("cmd", ["/c", "ver"], {
        encoding: "utf-8",
        timeout: spawnTimeout,
        env: {
          PATH: process.env.PATH,
        },
      });
      if (error) {
        throw error;
      }
      return stdout.trim();
    } catch (error) {
      reportWarning(error);
      return "Windows";
    }
  }
  return platform;
}

function getOsEmoji() {
  const { platform } = process;
  switch (platform) {
    case "darwin":
      return "";
    case "win32":
      return "🪟";
    case "linux":
      return "🐧";
    default:
      return "🔮";
  }
}

function getArchText() {
  const { arch } = process;
  switch (arch) {
    case "x64":
      return "x64";
    case "arm64":
      return "aarch64";
    default:
      return arch;
  }
}

function getArchEmoji() {
  const { arch } = process;
  switch (arch) {
    case "x64":
      return "🖥";
    case "arm64":
      return "💪";
    default:
      return "💻";
  }
}

function getBuildUrl() {
  let url;
  if (isBuildKite) {
    const buildUrl = process.env["BUILDKITE_BUILD_URL"];
    const jobId = process.env["BUILDKITE_JOB_ID"];
    if (buildUrl && jobId) {
      url = `${buildUrl}#${jobId}`;
    }
  } else if (isGitHubAction) {
    const baseUrl = process.env["GITHUB_SERVER_URL"];
    const repository = process.env["GITHUB_REPOSITORY"];
    const runId = process.env["GITHUB_RUN_ID"];
    if (baseUrl && repository && runId) {
      url = `${baseUrl}/${repository}/actions/runs/${runId}`;
    }
  }
  return url;
}

function getCI() {
  if (isBuildKite) {
    return "BuildKite";
  }
  if (isGitHubAction) {
    return "GitHub Actions";
  }
  if (isCI) {
    return "CI";
  }
  return "<unknown>";
}

function getHostname() {
  let name;
  if (isBuildKite) {
    name = process.env["BUILDKITE_AGENT_NAME"];
  } else {
    try {
      name = hostname();
    } catch (error) {
      reportWarning(error);
    }
  }
  return name || "<unknown>";
}

function getChangedFiles(cwd) {
  try {
    const { error, stdout } = spawnSync("git", ["diff", "--diff-filter=AM", "--name-only", "main"], {
      cwd,
      encoding: "utf-8",
      timeout: spawnTimeout,
      env: {
        PATH: process.env.PATH,
      },
    });
    if (error) {
      throw error;
    }
    const files = stdout.trim().split("\n");
    if (files) {
      return new Set(files);
    }
  } catch (error) {
    reportWarning(error);
  }
  return new Set();
}

function addPath(...paths) {
  if (isWindows) {
    return paths.join(";");
  }
  return paths.join(":");
}

function printStdout(stdout) {
  if (isGitHubAction) {
    print(stdout);
  } else {
    print(sanitizeStdout(stdout));
  }
}

function sanitizeStdout(stdout) {
  let sanitized = "";
  for (const line of stdout.split(endOfLine)) {
    if (line.startsWith("::")) {
      continue;
    } else {
      sanitized += line;
      sanitized += endOfLine;
    }
  }
  return sanitized;
}

function printGroup(title) {
  if (isGitHubAction) {
    println(`::group::${stripAnsi(title)}`);
  } else if (isBuildKite) {
    println(`--- ${title}`);
  } else {
    println(title);
  }
}

function printGroupEnd() {
  if (isGitHubAction) {
    println("::endgroup::");
  }
}

function reportWarning(warning) {
  reportError(warning, true);
}

function reportError(error, isWarning = false) {
  if (isGitHubAction) {
    const { name = "Error", message, stack = message } = error;
    const type = isWarning ? "warning" : "error";
    const title = escapeGitHubAction(`${name}: ${message}`);
    const expanded = escapeGitHubAction(stack);
    println(`::${type}::${title}::${expanded}::`);
  } else if (isBuildKite) {
    // Tells BuildKite to expand the current section,
    // which makes errors more visible in the build log.
    println("^^^ +++");
  }
  const errorText = inspect(error, { depth: 10 });
  const errorColor = isWarning ? "yellow" : "red";
  println(`${ansiColor(errorColor)}${stripAnsi(errorText)}${ansiColor("reset")}`);
}

function reportTestsToMarkdown(results) {
  const baseUrl = process.env["GITHUB_SERVER_URL"] || "https://github.com";
  const repository = process.env["GITHUB_REPOSITORY"] || "oven-sh/bun";
  const pullRequest = /^pull\/(\d+)$/.exec(process.env["GITHUB_REF"])?.[1];
  const gitSha = getGitSha();

  let markdown = "";
  let fileCount = 0;
  let testCount = 0;
  let failCount = 0;
  for (const [testPath, { tests, error, stdout }] of Object.entries(results)) {
    fileCount++;
    testCount += tests.length;
    failCount += error ? 1 : 0;
    if (!error) {
      continue;
    }

    let errorLine;
    for (const { error } of tests) {
      if (!error) {
        continue;
      }
      const { line } = error;
      if (line) {
        errorLine = line;
        break;
      }
    }

    let testUrl;
    if (pullRequest) {
      const testPathMd5 = crypto.createHash("md5").update(testPath).digest("hex");
      testUrl = `${baseUrl}/${repository}/pull/${pullRequest}/files#diff-${testPathMd5}`;
      if (errorLine) {
        testUrl += `L${errorLine}`;
      }
    } else {
      testUrl = `${baseUrl}/${repository}/blob/${gitSha}/${testPath}`;
      if (errorLine) {
        testUrl += `#L${errorLine}`;
      }
    }

    markdown += `<details><summary><a href="${testUrl}"><code>${testPath}</code></a> - ${error}</summary>\n\n`;
    markdown += `<pre><code>${stripAnsi(sanitizeStdout(stdout))}</code></pre>\n\n`;
    markdown += `</details>\n\n`;
  }

  if (!markdown) {
    return "";
  }

  let summary = "## ";

  const title = `${getOsEmoji()} ${getArchEmoji()}`;
  const buildUrl = getBuildUrl();
  if (buildUrl) {
    summary += `[${title}](${buildUrl})`;
  } else {
    summary += title;
  }

  summary += ` - ${failCount} failing\n\n`;
  summary += markdown;

  return summary;
}

async function reportTestsToBuildKite(results) {
  const entries = Object.entries(results);
  if (entries.length > 5000) {
    const chunks = [];
    for (let i = 0; i < entries.length; i += 5000) {
      chunks.push(Object.fromEntries(entries.slice(i, i + 5000)));
    }
    return Promise.all(chunks.map(chunk => reportTestsToBuildKite(chunk)));
  }
  const tests = entries.flatMap(([_, { tests }]) => tests);
  const formData = new FormData();
  formData.append("data", JSON.stringify(tests.map(getBuildKiteResult)));
  formData.append("format", "json");
  for (const [key, value] of Object.entries(getBuildKiteEnvironment())) {
    if (value) {
      formData.append(`run_env[${key}]`, value);
    }
  }
  try {
    const response = await fetch("https://analytics-api.buildkite.com/v1/uploads", {
      method: "POST",
      headers: {
        "Authorization": `Token token="${process.env["BUILDKITE_ANALYTICS_TOKEN"]}"`,
      },
      body: formData,
    });
    const { ok, status, statusText } = response;
    if (!ok) {
      const body = await response.text();
      throw new Error(`Failed to upload test results to BuildKite: ${status} ${statusText}`, { cause: body });
    }
  } catch (error) {
    reportWarning(error);
  }
}

function getBuildKiteEnvironment() {
  if (isGitHubAction) {
    const baseUrl = process.env["GITHUB_SERVER_URL"] || "https://github.com";
    const repositoryUrl = `${baseUrl}/${process.env["GITHUB_REPOSITORY"]}`;
    const runId = process.env["GITHUB_RUN_ID"];
    const runUrl = `${repositoryUrl}/actions/runs/${runId}`;
    const runNumber = process.env["GITHUB_RUN_NUMBER"];
    const runAttempt = process.env["GITHUB_RUN_ATTEMPT"];
    const actionName = process.env["GITHUB_ACTION"];
    return {
      CI: "github_actions",
      key: `${actionName}-${runNumber}-${runAttempt}`,
      url: runUrl,
      job_id: runId,
      number: runNumber,
      repository: repositoryUrl,
      branch: getGitRef(),
      commit_sha: getGitSha(),
    };
  }
  if (isBuildKite) {
    return {
      CI: "buildkite",
      key: process.env["BUILDKITE_BUILD_ID"],
      number: process.env["BUILDKITE_BUILD_NUMBER"],
      branch: process.env["BUILDKITE_BRANCH"],
      commit_sha: process.env["BUILDKITE_COMMIT"],
      url: process.env["BUILDKITE_BUILD_URL"],
      job_id: process.env["BUILDKITE_JOB_ID"],
      message: process.env["BUILDKITE_MESSAGE"],
    };
  }
  return {
    key: runId,
    branch: getGitRef(),
    commit_sha: getGitSha(),
  };
}

function getBuildKiteResult({ file, test, status, duration, error }) {
  let location;
  let errorText;
  let errorStack;
  if (error) {
    const { name, stack, file: errorFile, line } = error;
    location = `${errorFile}:${line}`;
    errorText = name;
    errorStack = stack?.split("\n");
  }
  return {
    id: crypto.randomUUID(),
    file_name: file,
    location,
    name: test,
    result: status === "pass" ? "passed" : status === "fail" ? "failed" : "skipped",
    failure_reason: errorText,
    failure_expanded: {
      backtrace: errorStack,
    },
    history: {
      started_at: performance.now(), // must be monotonic, not accurate
      duration: duration / 1000 || 0, // in seconds
    },
  };
}

function print(...args) {
  for (const arg of args) {
    if (typeof arg === "string") {
      process.stdout.write(arg);
    } else if (arg) {
      process.stdout.write(inspect(arg, { depth: 10 }));
    }
  }
}

function println(text) {
  if (text) print(text);
  print(endOfLine);
}

function ansiColor(color) {
  switch (color) {
    case "red":
      return "\x1b[31m";
    case "green":
      return "\x1b[32m";
    case "yellow":
      return "\x1b[33m";
    case "blue":
      return "\x1b[34m";
    case "reset":
      return "\x1b[0m";
    case "gray":
      return "\x1b[90m";
    default:
      return "";
  }
}

function stripAnsi(string) {
  return string.replace(/\u001b\[\d+m/g, "");
}

function escapeGitHubAction(string) {
  return string.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function unescapeGitHubAction(string) {
  return string.replace(/%25/g, "%").replace(/%0D/g, "\r").replace(/%0A/g, "\n");
}

function parseDuration(duration) {
  const match = /(\d+\.\d+)(m?s)/.exec(duration);
  if (!match) {
    return undefined;
  }
  const [, value, unit] = match;
  return parseFloat(value) * (unit === "ms" ? 1 : 1000);
}

function getTestEmoji(status) {
  switch (status) {
    case "pass":
      return "✅";
    case "fail":
      return "❌";
    case "skip":
      return "⏭";
    case "todo":
      return "✏️";
    default:
      return "🔮";
  }
}

function getTestColor(status) {
  switch (status) {
    case "pass":
      return ansiColor("green");
    case "fail":
      return ansiColor("red");
    case "skip":
    case "todo":
    default:
      return ansiColor("gray");
  }
}

function isExecutable(path) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    return false;
  }
  try {
    accessSync(path, fs.X_OK);
  } catch {
    return false;
  }
  return true;
}

const [target] = process.argv.slice(2);
if (!target) {
  const filename = relative(cwd, import.meta.filename);
  throw new Error(`Usage: ${process.argv0} ${filename} <target>`);
}

const exitCode = await runTests(target);
process.exit(exitCode);
