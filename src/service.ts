import { copyFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { CONFIG_FILE_NAME } from "./config/types.js";

export type ServicePlatform = "darwin" | "linux";

export type CliInvocation = {
  command: string;
  args: string[];
};

type ServiceDefinition = {
  platform: ServicePlatform;
  serviceName: string;
  serviceFilePath: string;
  logPath: string;
  content: string;
  launchTarget?: string;
};

type ServiceContext = {
  cwd: string;
  stdout: (message: string) => void;
};

type ServiceUninstallResult = {
  wasInstalled: boolean;
};

const defaultServicePort = 8787;

const isBunFsPath = (path?: string): boolean =>
  path?.startsWith("/$bunfs/") ?? false;

export const resolveServiceCliInvocation = (
  cwd: string,
  executable = process.argv[0] ?? Bun.argv[0] ?? "aimux",
  invokedCommand = process.argv[1] ?? Bun.argv[1],
  resolveCommand = (command: string): string | undefined => Bun.which(command) ?? undefined,
): CliInvocation => {
  const executableName = basename(executable);

  if (executableName === "bun") {
    if (invokedCommand && !isBunFsPath(invokedCommand)) {
      return {
        command: executable,
        args: [isAbsolute(invokedCommand) ? invokedCommand : resolve(cwd, invokedCommand)],
      };
    }

    return {
      command: resolveCommand("aimux") ?? "aimux",
      args: [],
    };
  }

  if (!invokedCommand || isBunFsPath(invokedCommand)) {
    return {
      command: executable.includes("/") ? resolve(cwd, executable) : resolveCommand(executable) ?? executable,
      args: [],
    };
  }

  const command = invokedCommand;
  const resolvedCommand = command.includes("/") ? resolve(cwd, command) : resolveCommand(command);

  return {
    command: resolvedCommand ?? command,
    args: [],
  };
};

const currentCliInvocation = (cwd: string): CliInvocation =>
  resolveServiceCliInvocation(cwd);

const servicePlatform = (): ServicePlatform => {
  if (process.platform === "darwin" || process.platform === "linux") {
    return process.platform;
  }

  throw new Error("aimux service management is only supported on macOS and Linux");
};

const shellEscape = (value: string): string =>
  `'${value.replace(/'/g, "'\\''")}'`;

const xmlEscape = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const macServicePlist = (
  serviceName: string,
  command: string,
  args: string[],
  cwd: string,
  logPath: string,
): string => {
  const programArguments = [command, ...args, "serve", "--port", String(defaultServicePort)];

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(serviceName)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((argument) => `    <string>${xmlEscape(argument)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(cwd)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(Bun.env.PATH ?? "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin")}</string>
  </dict>
</dict>
</plist>
`;
};

const linuxServiceUnit = (
  command: string,
  args: string[],
  cwd: string,
  logPath: string,
): string => {
  const execStart = [command, ...args, "serve", "--port", String(defaultServicePort)].map(shellEscape).join(" ");

  return `[Unit]
Description=aimux local LLM and MCP gateway
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${cwd}
ExecStart=${execStart}
Restart=on-failure
RestartSec=2
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
};

export const createServiceDefinition = (
  platform: ServicePlatform,
  cwd: string,
  home = homedir(),
  invocation: CliInvocation = currentCliInvocation(cwd),
): ServiceDefinition => {
  const serviceName = platform === "darwin" ? "dev.aimux" : "aimux.service";

  if (platform === "darwin") {
    const logPath = join(home, "Library", "Logs", "aimux", "aimux.log");
    const serviceFilePath = join(home, "Library", "LaunchAgents", "dev.aimux.plist");
    const launchTarget = `gui/${process.getuid?.() ?? 501}/${serviceName}`;

    return {
      platform,
      serviceName,
      serviceFilePath,
      logPath,
      launchTarget,
      content: macServicePlist(serviceName, invocation.command, invocation.args, cwd, logPath),
    };
  }

  const logPath = join(home, ".local", "state", "aimux", "aimux.log");
  const serviceFilePath = join(home, ".config", "systemd", "user", serviceName);

  return {
    platform,
    serviceName,
    serviceFilePath,
    logPath,
    content: linuxServiceUnit(invocation.command, invocation.args, cwd, logPath),
  };
};

export const serviceConfigPath = (home = homedir()): string =>
  join(home, CONFIG_FILE_NAME);

const resolveInputPath = (path: string, cwd: string, home = homedir()): string => {
  if (path === "~") {
    return home;
  }

  if (path.startsWith("~/")) {
    return join(home, path.slice(2));
  }

  return isAbsolute(path) ? path : resolve(cwd, path);
};

const runProcess = async (
  command: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const child = Bun.spawn({
    cmd: [command, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error([stderr, stdout].filter((value) => value.trim().length > 0).join("\n") || `${command} exited with ${exitCode}`);
  }

  return { exitCode, stdout, stderr };
};

const processOutput = (result: { stdout: string; stderr: string }): string =>
  [result.stderr, result.stdout].filter((value) => value.trim().length > 0).join("\n");

const assertUserServiceScope = (): void => {
  if (process.getuid?.() === 0) {
    throw new Error("aimux services are installed as user-level services. Run this command without sudo.");
  }
};

const installServiceDefinition = async (definition: ServiceDefinition): Promise<void> => {
  await mkdir(dirname(definition.serviceFilePath), { recursive: true });
  await mkdir(dirname(definition.logPath), { recursive: true });
  await Bun.write(definition.serviceFilePath, definition.content);

  if (definition.platform === "darwin") {
    await clearMacServiceFileAttributes(definition.serviceFilePath);
  }
};

const clearMacServiceFileAttributes = async (path: string): Promise<void> => {
  await runProcess("xattr", ["-d", "com.apple.quarantine", path], { allowFailure: true });
  await runProcess("xattr", ["-d", "com.apple.provenance", path], { allowFailure: true });
};

const serviceDefinitionForContext = (context: ServiceContext): ServiceDefinition => {
  const home = homedir();
  return createServiceDefinition(servicePlatform(), home, home, currentCliInvocation(context.cwd));
};

const loadServiceConfig = async (path: string, context: ServiceContext): Promise<string> => {
  const sourcePath = resolveInputPath(path, context.cwd);
  const targetPath = serviceConfigPath();

  if (!(await Bun.file(sourcePath).exists())) {
    throw new Error(`Config file does not exist: ${sourcePath}`);
  }

  await mkdir(dirname(targetPath), { recursive: true });

  if (sourcePath !== targetPath) {
    await copyFile(sourcePath, targetPath);
  }

  return targetPath;
};

export const runServiceAction = async (action: string, context: ServiceContext, path?: string): Promise<void> => {
  assertUserServiceScope();

  const definition = serviceDefinitionForContext(context);

  if (action === "load") {
    if (!path) {
      throw new Error("Missing config path. Usage: aimux service load <path>");
    }

    const targetPath = await loadServiceConfig(path, context);
    await installServiceDefinition(definition);
    await restartService(definition);
    context.stdout(`Loaded aimux service config: ${targetPath}`);
    context.stdout(`aimux service restart complete`);
    context.stdout(`Service file: ${definition.serviceFilePath}`);
    context.stdout(`Logs: ${definition.logPath}`);
    return;
  }

  if (action === "logs") {
    const file = Bun.file(definition.logPath);

    if (!(await file.exists())) {
      context.stdout(`No aimux service logs found at ${definition.logPath}`);
      return;
    }

    const lines = (await file.text()).trimEnd().split("\n");
    context.stdout(lines.slice(-200).join("\n"));
    return;
  }

  if (action === "start" || action === "enable") {
    await installServiceDefinition(definition);
  }

  if (action === "restart") {
    await installServiceDefinition(definition);
    await restartService(definition);
    context.stdout(`aimux service restart complete`);
    context.stdout(`Service file: ${definition.serviceFilePath}`);
    context.stdout(`Logs: ${definition.logPath}`);
    return;
  }

  if (action === "uninstall") {
    const result = await uninstallService(definition);
    context.stdout(result.wasInstalled ? `aimux service uninstall complete` : `aimux service was not installed`);
    context.stdout(result.wasInstalled ? `Removed service file: ${definition.serviceFilePath}` : `No service file found at: ${definition.serviceFilePath}`);
    context.stdout(`Logs kept at: ${definition.logPath}`);
    context.stdout(`Config kept at: ${serviceConfigPath()}`);
    return;
  }

  if (definition.platform === "darwin") {
    if (action === "start") {
      await startMacService(definition);
    } else if (action === "stop") {
      await stopMacService(definition);
    } else if (action === "enable") {
      await runProcess("launchctl", ["enable", macServiceTarget(definition)], { allowFailure: true });
      await startMacService(definition);
    } else if (action === "disable") {
      await runProcess("launchctl", ["disable", macServiceTarget(definition)], { allowFailure: true });
      await stopMacService(definition);
    } else {
      throw new Error(`Unknown service action: ${action}`);
    }
  } else {
    if (action === "start") {
      await runProcess("systemctl", ["--user", "daemon-reload"]);
      await runProcess("systemctl", ["--user", "start", definition.serviceName]);
    } else if (action === "stop") {
      await runProcess("systemctl", ["--user", "stop", definition.serviceName], { allowFailure: true });
    } else if (action === "enable") {
      await runProcess("systemctl", ["--user", "daemon-reload"]);
      await runProcess("systemctl", ["--user", "enable", "--now", definition.serviceName]);
    } else if (action === "disable") {
      await runProcess("systemctl", ["--user", "disable", "--now", definition.serviceName], { allowFailure: true });
    } else {
      throw new Error(`Unknown service action: ${action}`);
    }
  }

  context.stdout(`aimux service ${action} complete`);
  context.stdout(`Service file: ${definition.serviceFilePath}`);
  context.stdout(`Logs: ${definition.logPath}`);
};

const macServiceTarget = (definition: ServiceDefinition): string =>
  definition.launchTarget ?? `gui/${process.getuid?.() ?? 501}/${definition.serviceName}`;

const macServiceDomain = (definition: ServiceDefinition): string =>
  macServiceTarget(definition).split("/").slice(0, 2).join("/");

const stopMacService = async (definition: ServiceDefinition): Promise<void> => {
  const domain = macServiceDomain(definition);

  // Unloading by plist path avoids terminating a foreground `aimux service ...`
  // process that happens to use the same executable as the managed service.
  await runProcess("launchctl", ["bootout", domain, definition.serviceFilePath], { allowFailure: true });
};

const startMacService = async (definition: ServiceDefinition): Promise<void> => {
  const serviceTarget = macServiceTarget(definition);
  const domain = macServiceDomain(definition);

  await stopMacService(definition);
  const bootstrap = await runProcess("launchctl", ["bootstrap", domain, definition.serviceFilePath], { allowFailure: true });

  if (bootstrap.exitCode !== 0) {
    const loaded = await runProcess("launchctl", ["print", serviceTarget], { allowFailure: true });

    if (loaded.exitCode !== 0) {
      const details = processOutput(bootstrap);
      throw new Error(details.length > 0 ? details : `launchctl bootstrap failed with exit code ${bootstrap.exitCode}`);
    }
  }

  await runProcess("launchctl", ["kickstart", "-k", serviceTarget]);
};

const restartService = async (definition: ServiceDefinition): Promise<void> => {
  if (definition.platform === "darwin") {
    await startMacService(definition);
    return;
  }

  await runProcess("systemctl", ["--user", "daemon-reload"]);
  await runProcess("systemctl", ["--user", "restart", definition.serviceName]);
};

const uninstallService = async (definition: ServiceDefinition): Promise<ServiceUninstallResult> => {
  if (definition.platform === "darwin") {
    return uninstallMacService(definition);
  }

  const serviceFileExists = await Bun.file(definition.serviceFilePath).exists();
  await runProcess("systemctl", ["--user", "disable", "--now", definition.serviceName], { allowFailure: true });
  await rm(definition.serviceFilePath, { force: true });
  await runProcess("systemctl", ["--user", "daemon-reload"], { allowFailure: true });

  return { wasInstalled: serviceFileExists };
};

const uninstallMacService = async (definition: ServiceDefinition): Promise<ServiceUninstallResult> => {
  const loaded = await runProcess("launchctl", ["print", macServiceTarget(definition)], { allowFailure: true });
  const serviceFileExists = await Bun.file(definition.serviceFilePath).exists();

  await runProcess("launchctl", ["disable", macServiceTarget(definition)], { allowFailure: true });

  if (loaded.exitCode === 0) {
    await runProcess("launchctl", ["bootout", macServiceDomain(definition), definition.serviceFilePath]);
  }

  await rm(definition.serviceFilePath, { force: true });

  return { wasInstalled: loaded.exitCode === 0 || serviceFileExists };
};
